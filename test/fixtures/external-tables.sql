-- Tables that trade_db gets from other components (web3-dex-bot, Freqtrade, the economist
-- and news agents), reduced to the columns trading-suite uses. The database tests load this
-- into an empty database before running db/migrations. Source: pg_dump --schema-only of
-- trade_db, 2026-09-26.

CREATE TABLE economist_signals (
    symbol               VARCHAR(50) PRIMARY KEY,
    profit_score         NUMERIC(5,2),
    score_grade          VARCHAR(50),
    confidence_pct       NUMERIC(5,2),
    min_profit_threshold NUMERIC(10,2),
    recommendation       TEXT,
    risk_level           VARCHAR(50),
    updated_at           TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE instrument_registry (
    symbol           VARCHAR(50) PRIMARY KEY,
    name             VARCHAR(100),
    category         VARCHAR(30),
    base_asset       VARCHAR(20),
    quote_asset      VARCHAR(20),
    contract_address TEXT,
    exchange         VARCHAR(50),
    is_active        BOOLEAN DEFAULT TRUE,
    last_price       NUMERIC(18,6),
    change_24h_pct   NUMERIC(8,2),
    volume_24h_usd   NUMERIC(18,2),
    updated_at       TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    tv_ticker        VARCHAR(100),
    route_type       VARCHAR(50) DEFAULT 'CEX',
    chain_id         INTEGER DEFAULT 1
);

CREATE TABLE manual_orders (
    id         SERIAL PRIMARY KEY,
    symbol     VARCHAR(50) NOT NULL,
    side       VARCHAR(10) NOT NULL,
    order_type VARCHAR(20) DEFAULT 'MARKET',
    amount     NUMERIC(18,6) NOT NULL,
    price      NUMERIC(18,6),
    status     VARCHAR(20) DEFAULT 'EXECUTED',
    pnl_usd    NUMERIC(18,4) DEFAULT 0.00,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE market_news_cache (
    id           SERIAL PRIMARY KEY,
    symbol       VARCHAR(50),
    title        TEXT NOT NULL,
    summary      TEXT,
    source       VARCHAR(50),
    url          TEXT,
    published_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE trade_logs (
    id            SERIAL PRIMARY KEY,
    tx_hash       TEXT,
    token_address TEXT,
    action        TEXT,
    amount_in     NUMERIC,
    amount_out    NUMERIC,
    gas_used      BIGINT,
    status        TEXT,
    created_at    TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

-- Freqtrade's table, only the columns the suite reads.
CREATE TABLE trades (
    id               SERIAL PRIMARY KEY,
    exchange         VARCHAR(25) NOT NULL DEFAULT 'binance',
    pair             VARCHAR(25) NOT NULL,
    is_open          BOOLEAN NOT NULL,
    open_rate        DOUBLE PRECISION NOT NULL,
    close_rate       DOUBLE PRECISION,
    realized_profit  DOUBLE PRECISION,
    close_profit_abs DOUBLE PRECISION,
    stake_amount     DOUBLE PRECISION NOT NULL,
    amount           DOUBLE PRECISION NOT NULL DEFAULT 0,
    open_date        TIMESTAMP NOT NULL,
    close_date       TIMESTAMP,
    exit_reason      VARCHAR(255),
    strategy         VARCHAR(100),
    enter_tag        VARCHAR(255)
);
