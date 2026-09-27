-- News (2026-09-27): RSS / Atom feeds read by trading-suite's news job, and their items
-- tagged with the assets they mention (BTC, ETH, AAPL, ...).
--
-- news_feeds  kind 'feed' is one URL; kind 'per_symbol' is a URL template with {ticker},
--             fetched for each active TradFi instrument (Yahoo Finance headlines).
-- news_items  one row per article; title_hash drops the same headline from another feed;
--             tone is a keyword score (-1, 0, 1), not a model.

CREATE TABLE IF NOT EXISTS news_feeds (
    id             SERIAL PRIMARY KEY,
    name           TEXT NOT NULL UNIQUE,
    url            TEXT NOT NULL UNIQUE CHECK (url ~ '^https://'),
    kind           TEXT NOT NULL DEFAULT 'feed' CHECK (kind IN ('feed', 'per_symbol')),
    category       TEXT NOT NULL DEFAULT 'crypto' CHECK (category IN ('crypto', 'markets', 'other')),
    enabled        BOOLEAN NOT NULL DEFAULT TRUE,
    last_fetch_at  TIMESTAMPTZ,
    last_ok_at     TIMESTAMPTZ,
    last_error     TEXT,
    last_items     INTEGER,
    created_at     TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS news_items (
    id            BIGSERIAL PRIMARY KEY,
    feed_id       INTEGER NOT NULL REFERENCES news_feeds(id) ON DELETE CASCADE,
    guid          TEXT NOT NULL,
    title         TEXT NOT NULL,
    title_hash    TEXT NOT NULL,
    url           TEXT,
    summary       TEXT,
    published_at  TIMESTAMPTZ NOT NULL,
    fetched_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    assets        TEXT[] NOT NULL DEFAULT '{}',
    tone          SMALLINT NOT NULL DEFAULT 0,
    UNIQUE (feed_id, guid)
);
CREATE UNIQUE INDEX IF NOT EXISTS news_items_title ON news_items (title_hash);
CREATE INDEX IF NOT EXISTS news_items_published ON news_items (published_at DESC);
CREATE INDEX IF NOT EXISTS news_items_assets ON news_items USING GIN (assets);

INSERT INTO news_feeds (name, url, kind, category) VALUES
    ('CoinDesk', 'https://www.coindesk.com/arc/outboundfeeds/rss/', 'feed', 'crypto'),
    ('Cointelegraph', 'https://cointelegraph.com/rss', 'feed', 'crypto'),
    ('Decrypt', 'https://decrypt.co/feed', 'feed', 'crypto'),
    ('The Block', 'https://www.theblock.co/rss.xml', 'feed', 'crypto'),
    ('Investing.com crypto', 'https://www.investing.com/rss/news_301.rss', 'feed', 'crypto'),
    ('CNBC markets', 'https://www.cnbc.com/id/10000664/device/rss/rss.html', 'feed', 'markets'),
    ('Yahoo Finance headlines', 'https://feeds.finance.yahoo.com/rss/2.0/headline?s={ticker}&region=US&lang=en-US', 'per_symbol', 'markets')
ON CONFLICT (name) DO NOTHING;
