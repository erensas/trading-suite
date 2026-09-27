-- Trading venues (2026-09-27): exchange and broker accounts the suite knows about.
--
-- kind 'cex'     a crypto exchange through Freqtrade / ccxt (exchange = ccxt id, e.g. binance).
-- kind 'broker'  a stock broker; only Alpaca's paper-trading API for now (mode 'paper').
-- API keys never go in the database: they are written to
-- ~/.openclaw/credentials/venues/<id>.env (0600) and only their last four characters are shown.
-- The last connection test is kept with the venue.

CREATE TABLE IF NOT EXISTS trading_venues (
    id                 SERIAL PRIMARY KEY,
    name               TEXT NOT NULL UNIQUE CHECK (length(name) BETWEEN 1 AND 60),
    kind               TEXT NOT NULL CHECK (kind IN ('cex', 'broker')),
    exchange           TEXT NOT NULL CHECK (exchange ~ '^[a-z0-9]{2,30}$'),
    trading_mode       TEXT NOT NULL DEFAULT 'spot' CHECK (trading_mode IN ('spot', 'futures')),
    mode               TEXT NOT NULL DEFAULT 'read_only' CHECK (mode IN ('read_only', 'paper', 'live')),
    notes              TEXT,
    enabled            BOOLEAN NOT NULL DEFAULT TRUE,
    last_test_at       TIMESTAMPTZ,
    last_test_ok       BOOLEAN,
    last_test_message  TEXT,
    last_test_detail   JSONB,
    created_by         TEXT,
    created_at         TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at         TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
