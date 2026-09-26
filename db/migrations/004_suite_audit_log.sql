-- Audit log for changes made through the trading-suite UI (2026-09-26): settings,
-- data providers and instruments. The kill switch keeps its own trading_control_audit.
-- actor is "login (node, ip)" from Tailscale whois, or "unknown (ip)".

BEGIN;

CREATE TABLE IF NOT EXISTS suite_audit_log (
    id          BIGSERIAL PRIMARY KEY,
    at          TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    actor       TEXT NOT NULL,
    action      TEXT NOT NULL,
    entity      TEXT NOT NULL,
    entity_id   TEXT,
    before      JSONB,
    after       JSONB
);

CREATE INDEX IF NOT EXISTS suite_audit_log_at_idx ON suite_audit_log (at DESC);

COMMIT;
