-- Chart layouts (indicators and their settings) and price / indicator alerts (2026-09-27).
--
-- chart_layouts  scope 'default' applies to every chart; a symbol scope overrides it.
--                layout = { indicators: [{ uid, id, params, colors, visible }], showVolume }
-- alerts         price above/below, 24 h change above/below, or an indicator value
--                above/below a level on a timeframe. One-shot alerts disable themselves
--                when they fire; repeating ones re-arm when the condition turns false.
-- alert_events   every time an alert fired, for the UI notifications.

CREATE TABLE IF NOT EXISTS chart_layouts (
    scope       TEXT PRIMARY KEY,
    layout      JSONB NOT NULL,
    updated_by  TEXT,
    updated_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS alerts (
    id            SERIAL PRIMARY KEY,
    symbol        VARCHAR(50) NOT NULL REFERENCES instrument_registry(symbol) ON UPDATE CASCADE ON DELETE CASCADE,
    kind          TEXT NOT NULL CHECK (kind IN ('price_above', 'price_below', 'change_above', 'change_below', 'indicator_above', 'indicator_below')),
    value         NUMERIC NOT NULL,
    indicator     JSONB,
    timeframe     TEXT,
    note          TEXT,
    enabled       BOOLEAN NOT NULL DEFAULT TRUE,
    repeat        BOOLEAN NOT NULL DEFAULT FALSE,
    armed         BOOLEAN NOT NULL DEFAULT TRUE,
    last_value    NUMERIC,
    last_checked  TIMESTAMPTZ,
    triggered_at  TIMESTAMPTZ,
    created_by    TEXT,
    created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS alerts_enabled ON alerts (enabled, kind);

CREATE TABLE IF NOT EXISTS alert_events (
    id        BIGSERIAL PRIMARY KEY,
    alert_id  INTEGER REFERENCES alerts(id) ON DELETE SET NULL,
    symbol    VARCHAR(50) NOT NULL,
    at        TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    value     NUMERIC,
    message   TEXT NOT NULL,
    seen      BOOLEAN NOT NULL DEFAULT FALSE
);

CREATE INDEX IF NOT EXISTS alert_events_recent ON alert_events (at DESC);
