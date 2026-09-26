-- Trading control plane: kill switch state and per-engine mode heartbeat (2026-09-26).
--
-- Shared contract in trade_db:
--   trading-suite  writes trading_control / trading_control_audit (kill switch UI).
--   web3-dex-bot   reads trading_control, writes its engine_status row.
--   freqtrade      reads trading_control in confirm_trade_entry (strategy) and the bridge.
-- Readers treat a missing table or an unreachable database as "halted" (fail closed).

BEGIN;

CREATE TABLE IF NOT EXISTS trading_control (
    id          SMALLINT PRIMARY KEY DEFAULT 1 CHECK (id = 1),
    halted      BOOLEAN NOT NULL DEFAULT FALSE,
    reason      TEXT,
    changed_by  TEXT,
    changed_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

INSERT INTO trading_control (id) VALUES (1) ON CONFLICT (id) DO NOTHING;

CREATE TABLE IF NOT EXISTS trading_control_audit (
    id          SERIAL PRIMARY KEY,
    halted      BOOLEAN NOT NULL,
    reason      TEXT,
    changed_by  TEXT,
    changed_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS engine_status (
    engine      TEXT PRIMARY KEY,
    mode        TEXT NOT NULL CHECK (mode IN ('DRY_RUN', 'LIVE')),
    state       TEXT NOT NULL,
    detail      JSONB,
    last_seen   TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

COMMIT;
