-- Market data providers, per-instrument provider routing and persistent suite settings (2026-09-26).
--
-- market_providers   one row per configured data source. `kind` selects the adapter in
--                    lib/providers.js; `config` holds adapter options. No secrets here:
--                    `credential_env` names a variable in ~/.openclaw/credentials/market-providers.env.
-- instrument_registry.provider_id / provider_symbol / network
--                    route an instrument's candles, ticker and order book to one provider.
-- suite_settings     trading-suite settings that used to live only in memory.

BEGIN;

CREATE TABLE IF NOT EXISTS market_providers (
    id              SERIAL PRIMARY KEY,
    name            TEXT NOT NULL UNIQUE,
    kind            TEXT NOT NULL,
    base_url        TEXT,
    enabled         BOOLEAN NOT NULL DEFAULT TRUE,
    config          JSONB NOT NULL DEFAULT '{}'::jsonb,
    credential_env  TEXT,
    last_test_ok    BOOLEAN,
    last_test_at    TIMESTAMPTZ,
    last_test_msg   TEXT,
    created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

ALTER TABLE instrument_registry ADD COLUMN IF NOT EXISTS provider_id INTEGER REFERENCES market_providers(id) ON DELETE SET NULL;
ALTER TABLE instrument_registry ADD COLUMN IF NOT EXISTS provider_symbol TEXT;
ALTER TABLE instrument_registry ADD COLUMN IF NOT EXISTS network TEXT;
-- numeric(18,6) rounds sub-cent tokens (PEPE) to zero.
ALTER TABLE instrument_registry ALTER COLUMN last_price TYPE NUMERIC;

CREATE TABLE IF NOT EXISTS suite_settings (
    key         TEXT PRIMARY KEY,
    value       JSONB NOT NULL,
    updated_by  TEXT,
    updated_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

INSERT INTO market_providers (name, kind, base_url, config) VALUES
    ('Binance Spot',          'binance',         'https://api.binance.com',   '{}'),
    ('Binance USD-M Futures', 'binance_futures', 'https://fapi.binance.com',  '{}'),
    ('OKX',                   'okx',             'https://www.okx.com',       '{"instType": "SWAP"}'),
    ('Bybit',                 'bybit',           'https://api.bybit.com',     '{"category": "spot"}'),
    ('GeckoTerminal (DEX)',   'geckoterminal',   'https://api.geckoterminal.com/api/v2', '{}'),
    ('Yahoo Finance',         'yahoo',           'https://query1.finance.yahoo.com', '{}'),
    ('Freqtrade Bot',         'freqtrade',       'http://127.0.0.1:8080',     '{}')
ON CONFLICT (name) DO NOTHING;

-- Route the existing instruments to the matching provider (only where none is set yet).
UPDATE instrument_registry SET provider_id = (SELECT id FROM market_providers WHERE name = 'Binance Spot')
 WHERE provider_id IS NULL AND category = 'CEX';
UPDATE instrument_registry SET provider_id = (SELECT id FROM market_providers WHERE name = 'Binance USD-M Futures')
 WHERE provider_id IS NULL AND category = 'CEX_FUTURES' AND lower(exchange) = 'binance';
UPDATE instrument_registry SET provider_id = (SELECT id FROM market_providers WHERE name = 'OKX')
 WHERE provider_id IS NULL AND category = 'CEX_FUTURES' AND lower(exchange) = 'okx';
UPDATE instrument_registry SET provider_id = (SELECT id FROM market_providers WHERE name = 'GeckoTerminal (DEX)')
 WHERE provider_id IS NULL AND category = 'DEX';
UPDATE instrument_registry SET provider_id = (SELECT id FROM market_providers WHERE name = 'Yahoo Finance')
 WHERE provider_id IS NULL AND category = 'TRADFI';

COMMIT;
