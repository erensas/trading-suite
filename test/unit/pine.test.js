const test = require('node:test');
const assert = require('node:assert/strict');
const Pine = require('../../public/pine');
const I = require('../../public/indicators');

// Deterministic candles: a trend, a range and a sell-off with noise.
function candles(n = 600) {
  let seed = 11;
  const rnd = () => ((seed = (seed * 16807) % 2147483647) / 2147483647) - 0.5;
  let p = 100;
  const out = [];
  for (let i = 0; i < n; i++) {
    const o = p;
    const drift = i < n / 3 ? 0.002 : i < (2 * n) / 3 ? 0 : -0.002;
    p = p * (1 + drift + rnd() * 0.02);
    out.push({ time: 1_700_000_000 + i * 3600, open: o, high: Math.max(o, p) * (1 + Math.abs(rnd()) * 0.01), low: Math.min(o, p) * (1 - Math.abs(rnd()) * 0.01), close: p, volume: 50 + Math.abs(rnd()) * 100 });
  }
  return out;
}
const C = candles();
const script = (body, kind = "indicator('t')") => `//@version=5\n${kind}\n${body}\n`;
const plotValues = (body) => Pine.run(script(body), C).plots.map((p) => p.values);
// Same values as the chart indicators (which follow Pine's definitions) wherever both exist.
function sameAs(values, series, eps = 1e-8) {
  let compared = 0;
  series.forEach((pt, k) => {
    const idx = C.findIndex((c) => c.time === pt.time);
    const v = values[idx];
    if (pt.value === null || !Number.isFinite(pt.value)) return;
    assert.ok(Math.abs(v - pt.value) < eps * Math.max(1, Math.abs(pt.value)), `bar ${idx}: ${v} != ${pt.value}`);
    compared++;
  });
  assert.ok(compared > 100, `only ${compared} values compared`);
}

test('pine ta.* match the chart indicators', () => {
  const [sma, ema, wma, hma, rsi, atr, cci, mfi, obv, vwap] = plotValues(
    ['sma', 'ema', 'wma', 'hma'].map((f) => `plot(ta.${f}(close, 21))`).join('\n') + '\nplot(ta.rsi(close, 14))\nplot(ta.atr(14))\nplot(ta.cci(hlc3, 20))\nplot(ta.mfi(hlc3, 14))\nplot(ta.obv)\nplot(ta.vwap)'
  );
  sameAs(sma, I.compute('sma', C, { length: 21 }).ma);
  sameAs(ema, I.compute('ema', C, { length: 21 }).ma);
  sameAs(wma, I.compute('wma', C, { length: 21 }).ma);
  sameAs(hma, I.compute('hma', C, { length: 21 }).ma);
  sameAs(rsi, I.compute('rsi', C, { length: 14 }).rsi);
  sameAs(atr, I.compute('atr', C, { length: 14 }).atr);
  sameAs(cci, I.compute('cci', C, { length: 20 }).cci, 1e-6);
  sameAs(mfi, I.compute('mfi', C, { length: 14 }).mfi, 1e-6);
  sameAs(obv, I.compute('obv', C, {}).obv);
  sameAs(vwap, I.compute('vwap', C, {}).vwap);

  const [m, s, h, up, basis, low] = plotValues('[m, s, h] = ta.macd(close, 12, 26, 9)\nplot(m)\nplot(s)\nplot(h)\n[mid, u, l] = ta.bb(close, 20, 2)\nplot(u)\nplot(mid)\nplot(l)');
  const macd = I.compute('macd', C, { fast: 12, slow: 26, signal: 9 });
  sameAs(m, macd.macd);
  sameAs(s, macd.signal);
  sameAs(h, macd.hist);
  const bb = I.compute('bb', C, { length: 20, mult: 2 });
  sameAs(up, bb.upper);
  sameAs(basis, bb.basis);
  sameAs(low, bb.lower);

  const [st, plus, minus, adx] = plotValues('[st, d] = ta.supertrend(3, 10)\nplot(st)\n[p, mi, a] = ta.dmi(14, 14)\nplot(p)\nplot(mi)\nplot(a)');
  sameAs(st, I.compute('supertrend', C, { length: 10, mult: 3 }).line);
  const dmi = I.compute('adx', C, { length: 14 });
  sameAs(plus, dmi.plus, 1e-6);
  sameAs(minus, dmi.minus, 1e-6);
  sameAs(adx, dmi.adx, 1e-6);
});

test('pine language: var, :=, +=, if / else if / else, for, functions, tuples, history, ternary', () => {
  const out = Pine.run(
    script(`var int ups = 0
streak = 0
if close > close[1]
    ups += 1
    streak := nz(streak[1]) + 1
else if close < close[1]
    streak := 0
else
    streak := streak[1]
total = 0.0
for k = 0 to 2
    total += close[k]
avg3(src) => math.avg(src, src[1], src[2])
minmax(a, b) =>
    lo = math.min(a, b)
    [lo, math.max(a, b)]
[lo, hi] = minmax(open, close)
plot(ups, 'ups')
plot(total / 3 - avg3(close), 'zero')
plot(hi - lo - math.abs(close - open), 'zero2')
plot(close > open ? 1 : -1, 'dir')
plot(bar_index, 'bar')`),
    C
  );
  const byTitle = Object.fromEntries(out.plots.map((p) => [p.title, p.values]));
  const expectedUps = C.reduce((acc, c, i) => (i > 0 && c.close > C[i - 1].close ? acc + 1 : acc), 0);
  assert.equal(byTitle.ups.at(-1), expectedUps);
  for (let i = 2; i < C.length; i++) assert.ok(Math.abs(byTitle.zero[i]) < 1e-9);
  assert.ok(byTitle.zero2.every((v) => Math.abs(v) < 1e-9));
  assert.equal(byTitle.dir[5], C[5].close > C[5].open ? 1 : -1);
  assert.equal(byTitle.bar.at(-1), C.length - 1);
});

test('pine inputs: defaults, overrides by title, sources', () => {
  const src = script("len = input.int(10, 'Length', minval=2)\nsrc = input.source(close, 'Source')\nplot(ta.sma(src, len))");
  const a = Pine.run(src, C);
  assert.deepEqual(a.inputs.map((x) => [x.key, x.type, x.value]), [['Length', 'int', 10], ['Source', 'source', 'close']]);
  const b = Pine.run(src, C, { inputs: { Length: 30, Source: 'hl2' } });
  const ref = I.compute('sma', C, { length: 30, source: 'hl2' }).ma;
  assert.ok(Math.abs(b.plots[0].values.at(-1) - ref.at(-1).value) < 1e-9);
});

test('pine strategy: orders fill at the next open, reversals, stop exits, statistics', () => {
  const out = Pine.run(
    `//@version=5
strategy('x', overlay=true, initial_capital=1000, default_qty_type=strategy.percent_of_equity, default_qty_value=100)
if bar_index == 10
    strategy.entry('L', strategy.long)
if bar_index == 20
    strategy.entry('S', strategy.short)
if bar_index == 30
    strategy.close('S')
if bar_index == 40
    strategy.entry('L2', strategy.long)
strategy.exit('x', 'L2', stop=strategy.position_avg_price * 0.5)
plot(strategy.position_size)`,
    C
  );
  const s = out.strategy;
  const [t1, t2] = s.trades;
  assert.equal(t1.entryTime, C[11].time);
  assert.equal(t1.entryPrice, C[11].open);
  assert.equal(t1.exitTime, C[21].time);
  assert.equal(t1.reason, 'reverse');
  assert.equal(t2.dir, 'short');
  assert.equal(t2.exitTime, C[31].time);
  assert.equal(t2.reason, 'signal');
  const expected1 = (C[21].open / C[11].open - 1) * 1000;
  assert.ok(Math.abs(t1.profit - expected1) < 1e-6);
  assert.equal(s.totalTrades >= 2, true);
  assert.equal(out.plots[0].values[12] > 0, true);
  assert.equal(out.plots[0].values[25] < 0, true);
  // The last entry is either still open or stopped out at half its price.
  if (s.trades.length === 3) assert.equal(s.trades[2].reason, 'stop');
  else assert.equal(s.openTrade.id, 'L2');
  assert.ok(s.maxDrawdownPct >= 0 && s.equity.length === C.length);
});

test('pine errors carry the line number', () => {
  assert.throws(() => Pine.run(script('x = ta.nothing(close)'), C), /line 3: unknown function ta.nothing/);
  assert.throws(() => Pine.parse("indicator('t')\nx = (1 + \n"), /line/);
  assert.throws(() => Pine.run('//@version=5\nplot(close)', C), /indicator\(\.\.\.\) or strategy/);
  assert.throws(() => Pine.run(script('y = z + 1'), C), /line 3: unknown name "z"/);
  assert.throws(() => Pine.run(script("strategy.entry('L', strategy.long)"), C), /needs strategy/);
});

test('pine to Freqtrade: signals, inputs, helpers, refusals', () => {
  const src = `//@version=5
strategy('EMA cross + RSI', overlay=true)
fastLen = input.int(9, 'Fast', minval=2, maxval=50)
slowLen = input.int(21, 'Slow')
useRsi = input.bool(true, 'RSI filter')
fast = ta.ema(close, fastLen)
slow = ta.ema(close, slowLen)
r = ta.rsi(close, 14)
[m, s, h] = ta.macd(close, 12, 26, 9)
longOk = ta.crossover(fast, slow) and (not useRsi or r < 70)
if longOk
    strategy.entry('Long', strategy.long)
if ta.crossunder(fast, slow)
    strategy.close('Long')
plot(fast, 'Fast', color=color.orange)
plot(slow, 'Slow')`;
  const out = Pine.toFreqtrade(src, { className: 'EmaRsiPine', timeframe: '1h' });
  const py = out.source;
  assert.match(py, /^class EmaRsiPine\(IStrategy\):$/m);
  assert.match(py, /timeframe = "1h"/);
  assert.match(py, /p_fastLen = IntParameter\(2, 50, default=9, space="buy"\)/);
  assert.match(py, /p_useRsi = BooleanParameter\(default=True, space="buy"\)/);
  assert.match(py, /dataframe\["fast"\] = _ema\(dataframe\["close"\], int\(self\.p_fastLen\.value\)\)/);
  assert.match(py, /t1 = _macd\(/);
  assert.match(py, /def _rsi\(/);
  assert.match(py, /def _ema_core\(/);
  assert.doesNotMatch(py, /def _supertrend\(/);
  assert.match(py, /dataframe\["pine_enter_long"\] = _bool\(dataframe\["longOk"\], dataframe\)/);
  assert.match(py, /dataframe\["pine_exit_long"\] = _bool\(_crossunder\(dataframe\["fast"\], dataframe\["slow"\]\), dataframe\)/);
  assert.match(py, /can_short = False/);
  assert.match(py, /"fast": \{"color": "#ff9800"\}/);
  assert.match(py, /return entries_allowed\(pair\)/);

  const both = Pine.toFreqtrade("//@version=5\nstrategy('x')\nif close > open\n    strategy.entry('L', strategy.long)\nelse\n    strategy.entry('S', strategy.short)", { className: 'BothWays' }).source;
  assert.match(both, /can_short = True/);
  assert.match(both, /pine_exit_long"\] = _bool\(~\(dataframe\["close"\] > dataframe\["open"\]\)/);

  assert.throws(() => Pine.toFreqtrade("//@version=5\nstrategy('x')\nvar c = 0\nstrategy.entry('L', strategy.long)"), /line 3: var keeps state/);
  assert.throws(() => Pine.toFreqtrade("//@version=5\nstrategy('x')\nx = 1\nx := 2"), /line 4: "x :=" reassigns/);
  assert.throws(() => Pine.toFreqtrade("//@version=5\nindicator('x')\nplot(close)"), /only strategy/);
  const exitWarn = Pine.toFreqtrade("//@version=5\nstrategy('x')\nstrategy.entry('L', strategy.long, when=close > open)\nstrategy.exit('x', 'L', stop=close * 0.9)");
  assert.ok(exitWarn.warnings.some((w) => /strategy.exit/.test(w)));
});
