-- Strategy center (2026-09-27): trading bots, the strategy library and backtests.
--
-- bots               every trading engine the suite shows. 'main' is freqtrade.service (system
--                    unit, config in the freqtrade repo); managed bots are Freqtrade instances
--                    the suite creates and runs as user units (freqtrade-bot@<name>); the Web3
--                    DEX bot is listed read-only. dry_run_since counts how long the current
--                    strategy has run in dry-run, one of the checks before going live.
-- bot_events         what was done to a bot, by whom (start, stop, strategy, mode changes).
-- strategies         Freqtrade strategies written or imported through the suite, with the
--                    result of the last check (static rules, load, indicators on sample data).
-- strategy_versions  every saved version of a strategy.
-- backtests          queued and finished backtest runs with their key results.

CREATE TABLE IF NOT EXISTS bots (
    name              TEXT PRIMARY KEY CHECK (name ~ '^[a-z0-9][a-z0-9-]{1,29}$'),
    engine            TEXT NOT NULL CHECK (engine IN ('freqtrade', 'web3')),
    managed           BOOLEAN NOT NULL DEFAULT FALSE,
    unit              TEXT NOT NULL,
    api_url           TEXT,
    api_port          INTEGER UNIQUE,
    config_path       TEXT,
    credentials_file  TEXT,
    description       TEXT,
    exchange          TEXT,
    trading_mode      TEXT NOT NULL DEFAULT 'spot',
    strategy          TEXT,
    dry_run           BOOLEAN NOT NULL DEFAULT TRUE,
    dry_run_since     TIMESTAMPTZ,
    capital_limit     NUMERIC,
    live_since        TIMESTAMPTZ,
    live_approved_by  TEXT,
    created_by        TEXT,
    created_at        TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at        TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

INSERT INTO bots (name, engine, managed, unit, api_url, api_port, config_path, credentials_file, description, exchange, trading_mode, strategy, dry_run, dry_run_since)
VALUES
    ('main', 'freqtrade', FALSE, 'freqtrade.service', 'http://127.0.0.1:8080', 8080,
     '/home/openclaw/.openclaw/workspace/freqtrade/user_data/config.json', '/home/openclaw/.openclaw/credentials/freqtrade.env',
     'Main Freqtrade bot (system unit, trades stored in trade_db)', 'binance', 'spot', 'LLMAgentStrategy', TRUE, NOW()),
    ('web3-dex-bot', 'web3', FALSE, 'web3-dex-bot.service', NULL, NULL, NULL, NULL,
     'Web3 DEX arbitrage scanner (read-only here; mode from its engine_status heartbeat)', NULL, 'dex', 'arbitrage scanner', TRUE, NULL)
ON CONFLICT (name) DO NOTHING;

CREATE TABLE IF NOT EXISTS bot_events (
    id      BIGSERIAL PRIMARY KEY,
    bot     TEXT NOT NULL,
    at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    actor   TEXT,
    action  TEXT NOT NULL,
    detail  JSONB
);
CREATE INDEX IF NOT EXISTS bot_events_bot_at ON bot_events (bot, at DESC);

CREATE TABLE IF NOT EXISTS strategies (
    name           TEXT PRIMARY KEY CHECK (name ~ '^[A-Za-z_][A-Za-z0-9_]{2,60}$'),
    source         TEXT NOT NULL,
    sha            TEXT NOT NULL,
    origin         TEXT NOT NULL DEFAULT 'editor',
    description    TEXT,
    timeframe      TEXT,
    can_short      BOOLEAN,
    check_status   TEXT NOT NULL DEFAULT 'unchecked' CHECK (check_status IN ('unchecked', 'ok', 'failed')),
    check_message  TEXT,
    check_detail   JSONB,
    checked_at     TIMESTAMPTZ,
    created_by     TEXT,
    created_at     TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at     TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS strategy_versions (
    id          BIGSERIAL PRIMARY KEY,
    name        TEXT NOT NULL REFERENCES strategies(name) ON UPDATE CASCADE ON DELETE CASCADE,
    sha         TEXT NOT NULL,
    source      TEXT NOT NULL,
    created_by  TEXT,
    created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS strategy_versions_name ON strategy_versions (name, id DESC);

CREATE TABLE IF NOT EXISTS backtests (
    id            SERIAL PRIMARY KEY,
    strategy      TEXT NOT NULL,
    strategy_sha  TEXT,
    params        JSONB NOT NULL,
    status        TEXT NOT NULL DEFAULT 'queued' CHECK (status IN ('queued', 'running', 'done', 'failed', 'cancelled')),
    summary       JSONB,
    per_pair      JSONB,
    trades        JSONB,
    daily         JSONB,
    error         TEXT,
    log_tail      TEXT,
    created_by    TEXT,
    created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    started_at    TIMESTAMPTZ,
    finished_at   TIMESTAMPTZ
);
CREATE INDEX IF NOT EXISTS backtests_recent ON backtests (created_at DESC);
CREATE INDEX IF NOT EXISTS backtests_strategy ON backtests (strategy, created_at DESC);
