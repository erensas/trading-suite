-- Pine editor (2026-09-27): Pine Script sources saved from the chart's Pine panel, with a
-- few examples. The scripts run in the browser (public/pine.js); strategies can be
-- converted into the Freqtrade strategy library.

CREATE TABLE IF NOT EXISTS pine_scripts (
    id          SERIAL PRIMARY KEY,
    name        TEXT NOT NULL UNIQUE CHECK (length(name) BETWEEN 1 AND 80),
    source      TEXT NOT NULL CHECK (length(source) <= 200000),
    example     BOOLEAN NOT NULL DEFAULT FALSE,
    created_by  TEXT,
    created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

INSERT INTO pine_scripts (name, example, created_by, source) VALUES
('Example: EMA cross strategy', TRUE, 'migration 008', $pine$//@version=5
strategy("EMA cross", overlay=true, initial_capital=1000, default_qty_type=strategy.percent_of_equity, default_qty_value=100, commission_value=0.1)
fastLen = input.int(12, "Fast EMA", minval=2)
slowLen = input.int(26, "Slow EMA", minval=3)
trendLen = input.int(200, "Trend EMA")
fast = ta.ema(close, fastLen)
slow = ta.ema(close, slowLen)
trend = ta.ema(close, trendLen)
if ta.crossover(fast, slow) and close > trend
    strategy.entry("Long", strategy.long)
if ta.crossunder(fast, slow)
    strategy.close("Long")
plot(fast, "Fast", color=color.orange)
plot(slow, "Slow", color=color.blue)
plot(trend, "Trend", color=color.gray, linewidth=2)
$pine$),
('Example: RSI + Bollinger mean reversion', TRUE, 'migration 008', $pine$//@version=5
strategy("RSI + Bollinger", overlay=true, initial_capital=1000, default_qty_type=strategy.percent_of_equity, default_qty_value=100, commission_value=0.1)
len = input.int(20, "BB length")
mult = input.float(2.0, "BB width")
rsiLen = input.int(14, "RSI length")
oversold = input.int(30, "Oversold")
[basis, upper, lower] = ta.bb(close, len, mult)
r = ta.rsi(close, rsiLen)
if close < lower and r < oversold
    strategy.entry("Long", strategy.long)
if close > basis
    strategy.close("Long")
plot(basis, "Basis", color=color.orange)
plot(upper, "Upper", color=color.blue)
plot(lower, "Lower", color=color.blue)
plotshape(close < lower and r < oversold, "Oversold", style=shape.triangleup, location=location.belowbar, color=color.green)
$pine$),
('Example: Supertrend', TRUE, 'migration 008', $pine$//@version=5
indicator("Supertrend", overlay=true)
factor = input.float(3.0, "Factor")
atrLen = input.int(10, "ATR length")
[st, dir] = ta.supertrend(factor, atrLen)
plot(st, "Supertrend", color=dir < 0 ? color.green : color.red, linewidth=2)
plotshape(ta.change(dir) < 0, "Turns up", style=shape.labelup, location=location.belowbar, color=color.green, text="Up")
plotshape(ta.change(dir) > 0, "Turns down", style=shape.labeldown, location=location.abovebar, color=color.red, text="Down")
$pine$),
('Example: MACD histogram', TRUE, 'migration 008', $pine$//@version=5
indicator("MACD histogram", overlay=false)
[m, sig, hist] = ta.macd(close, 12, 26, 9)
plot(hist, "Histogram", style=plot.style_histogram, color=hist >= 0 ? (hist > hist[1] ? #26a69a : #b2dfdb) : (hist < hist[1] ? #ff5252 : #ffcdd2))
plot(m, "MACD", color=color.blue)
plot(sig, "Signal", color=color.orange)
hline(0, "Zero", color=color.gray)
$pine$)
ON CONFLICT (name) DO NOTHING;
