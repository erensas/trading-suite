-- Portfolio, EVM wallets and per-pair controls of the Web3 engine (2026-09-27).
--
-- wallets              EVM wallets the suite created or imported (or only watches). Keys and
--                      recovery phrases are never stored here: they live in
--                      ~/.openclaw/credentials/wallets/<id>.env (0600).
-- portfolio_accounts   what the Portfolio tab tracks: manual holdings (stocks, ETFs, cash, a
--                      paper portfolio), an Alpaca paper venue, a Freqtrade bot, a wallet. The
--                      last valuation is kept on the row.
-- portfolio_holdings   the positions of manual accounts.
-- portfolio_snapshots  total value over time (every refresh, hourly by the job).
-- dex_pair_controls    token pairs the Web3 engine scans, per network, reported by the engine;
--                      arbitrage and flash loans switched on or off per pair (UI and API). The
--                      engine reads the flags every cycle.

CREATE TABLE IF NOT EXISTS wallets (
    id               SERIAL PRIMARY KEY,
    name             TEXT NOT NULL UNIQUE,
    chain            TEXT NOT NULL DEFAULT 'evm' CHECK (chain IN ('evm')),
    address          TEXT NOT NULL,
    origin           TEXT NOT NULL CHECK (origin IN ('generated', 'private_key', 'mnemonic', 'watch')),
    derivation_path  TEXT,
    networks         TEXT[] NOT NULL DEFAULT ARRAY['eth', 'arbitrum', 'base'],
    notes            TEXT,
    created_by       TEXT,
    created_at       TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at       TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE UNIQUE INDEX IF NOT EXISTS wallets_address_unique ON wallets (lower(address));

CREATE TABLE IF NOT EXISTS portfolio_accounts (
    id               SERIAL PRIMARY KEY,
    name             TEXT NOT NULL UNIQUE,
    kind             TEXT NOT NULL CHECK (kind IN ('manual', 'alpaca', 'freqtrade', 'wallet')),
    ref              TEXT,
    mode             TEXT NOT NULL DEFAULT 'real' CHECK (mode IN ('real', 'paper')),
    enabled          BOOLEAN NOT NULL DEFAULT TRUE,
    notes            TEXT,
    last_value_usd   NUMERIC,
    last_positions   JSONB NOT NULL DEFAULT '[]'::jsonb,
    last_refresh_at  TIMESTAMPTZ,
    last_error       TEXT,
    created_by       TEXT,
    created_at       TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at       TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE UNIQUE INDEX IF NOT EXISTS portfolio_accounts_source_unique ON portfolio_accounts (kind, ref) WHERE ref IS NOT NULL;

CREATE TABLE IF NOT EXISTS portfolio_holdings (
    id          SERIAL PRIMARY KEY,
    account_id  INTEGER NOT NULL REFERENCES portfolio_accounts(id) ON DELETE CASCADE,
    kind        TEXT NOT NULL DEFAULT 'asset' CHECK (kind IN ('asset', 'cash')),
    symbol      TEXT NOT NULL,
    quantity    NUMERIC NOT NULL,
    cost_basis  NUMERIC,
    note        TEXT,
    created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    UNIQUE (account_id, symbol)
);

CREATE TABLE IF NOT EXISTS portfolio_snapshots (
    id          BIGSERIAL PRIMARY KEY,
    at          TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    total_usd   NUMERIC NOT NULL,
    real_usd    NUMERIC NOT NULL,
    paper_usd   NUMERIC NOT NULL,
    by_account  JSONB NOT NULL DEFAULT '{}'::jsonb
);
CREATE INDEX IF NOT EXISTS portfolio_snapshots_at ON portfolio_snapshots (at);

CREATE TABLE IF NOT EXISTS dex_pair_controls (
    id                 SERIAL PRIMARY KEY,
    network            TEXT NOT NULL,
    token_a            TEXT NOT NULL,
    token_b            TEXT NOT NULL,
    token_a_address    TEXT,
    token_b_address    TEXT,
    pool_count         INTEGER NOT NULL DEFAULT 0,
    dexes              TEXT[] NOT NULL DEFAULT '{}',
    arbitrage_enabled  BOOLEAN NOT NULL DEFAULT TRUE,
    flashloan_enabled  BOOLEAN NOT NULL DEFAULT TRUE,
    last_seen_at       TIMESTAMPTZ,
    updated_by         TEXT,
    updated_at         TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    created_at         TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    UNIQUE (network, token_a, token_b)
);
