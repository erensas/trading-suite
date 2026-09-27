-- Several data providers per instrument, and user-defined watchlists (2026-09-27).
--
-- instrument_listings  where an instrument can be fetched: one row per provider (and
--                      provider symbol), tried in `priority` order (lowest first). The
--                      primary listing is mirrored into instrument_registry.provider_id /
--                      provider_symbol, which other scripts still read.
-- watchlists           named, ordered lists with their own columns and sort order.
-- watchlist_items      the instruments of a list, in manual order.

CREATE TABLE IF NOT EXISTS instrument_listings (
    id              SERIAL PRIMARY KEY,
    symbol          VARCHAR(50) NOT NULL REFERENCES instrument_registry(symbol) ON UPDATE CASCADE ON DELETE CASCADE,
    provider_id     INTEGER NOT NULL REFERENCES market_providers(id) ON DELETE CASCADE,
    provider_symbol TEXT,
    network         TEXT,
    priority        INTEGER NOT NULL DEFAULT 100,
    enabled         BOOLEAN NOT NULL DEFAULT TRUE,
    created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE UNIQUE INDEX IF NOT EXISTS instrument_listings_unique
    ON instrument_listings (symbol, provider_id, COALESCE(provider_symbol, ''));
CREATE INDEX IF NOT EXISTS instrument_listings_symbol_priority
    ON instrument_listings (symbol, priority, id);

-- Every instrument that has a provider today gets it as its primary listing.
INSERT INTO instrument_listings (symbol, provider_id, provider_symbol, network, priority)
    SELECT symbol, provider_id, NULLIF(provider_symbol, ''), NULLIF(network, ''), 0
    FROM instrument_registry
    WHERE provider_id IS NOT NULL
ON CONFLICT DO NOTHING;

CREATE TABLE IF NOT EXISTS watchlists (
    id          SERIAL PRIMARY KEY,
    name        TEXT NOT NULL UNIQUE,
    position    INTEGER NOT NULL DEFAULT 0,
    is_default  BOOLEAN NOT NULL DEFAULT FALSE,
    columns     JSONB NOT NULL DEFAULT '["price", "change", "volume"]'::jsonb,
    sort        JSONB NOT NULL DEFAULT '{"by": "manual", "dir": "asc"}'::jsonb,
    created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- At most one default list.
CREATE UNIQUE INDEX IF NOT EXISTS watchlists_single_default ON watchlists (is_default) WHERE is_default;

CREATE TABLE IF NOT EXISTS watchlist_items (
    watchlist_id INTEGER NOT NULL REFERENCES watchlists(id) ON DELETE CASCADE,
    symbol       VARCHAR(50) NOT NULL REFERENCES instrument_registry(symbol) ON UPDATE CASCADE ON DELETE CASCADE,
    position     INTEGER NOT NULL DEFAULT 0,
    added_at     TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    PRIMARY KEY (watchlist_id, symbol)
);

CREATE INDEX IF NOT EXISTS watchlist_items_order ON watchlist_items (watchlist_id, position);

-- Starter lists from today's categories, only on a database without lists.
DO $$
BEGIN
    IF NOT EXISTS (SELECT 1 FROM watchlists) THEN
        INSERT INTO watchlists (name, position, is_default) VALUES
            ('Main', 0, TRUE),
            ('Crypto spot', 1, FALSE),
            ('Crypto futures', 2, FALSE),
            ('DEX pools', 3, FALSE),
            ('Stocks & ETFs', 4, FALSE);

        INSERT INTO watchlist_items (watchlist_id, symbol, position)
            SELECT w.id, r.symbol,
                   row_number() OVER (PARTITION BY w.id ORDER BY r.category, r.volume_24h_usd DESC NULLS LAST, r.symbol)
            FROM instrument_registry r
            JOIN watchlists w ON w.name = CASE r.category
                                            WHEN 'CEX' THEN 'Crypto spot'
                                            WHEN 'CEX_FUTURES' THEN 'Crypto futures'
                                            WHEN 'DEX' THEN 'DEX pools'
                                            WHEN 'TRADFI' THEN 'Stocks & ETFs'
                                          END
            WHERE r.is_active IS NOT FALSE;

        -- Main: the ten largest spot pairs by volume, plus every stock.
        INSERT INTO watchlist_items (watchlist_id, symbol, position)
            SELECT (SELECT id FROM watchlists WHERE name = 'Main'), symbol, row_number() OVER (ORDER BY ord, vol DESC NULLS LAST)
            FROM (
                SELECT symbol, 0 AS ord, volume_24h_usd AS vol FROM instrument_registry
                 WHERE category = 'CEX' AND is_active IS NOT FALSE ORDER BY volume_24h_usd DESC NULLS LAST LIMIT 10
            ) s
            UNION ALL
            SELECT (SELECT id FROM watchlists WHERE name = 'Main'), symbol, 100 + row_number() OVER (ORDER BY symbol)
            FROM instrument_registry WHERE category = 'TRADFI' AND is_active IS NOT FALSE;
    END IF;
END $$;
