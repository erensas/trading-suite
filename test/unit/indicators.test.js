const test = require('node:test');
const assert = require('node:assert/strict');
const I = require('../../public/indicators');

const { sma, ema, rma, stdev, rsi, crossover, crossunder, highest, lowest } = I.core;
const close = (xs) => xs.map((c, i) => ({ time: 1_700_000_000 + i * 3600, open: c, high: c + 1, low: c - 1, close: c, volume: 10 }));
const near = (a, b, eps = 1e-9) => assert.ok(Math.abs(a - b) < eps, `${a} != ${b}`);

test('sma, ema (SMA seed), rma, highest, lowest', () => {
  assert.deepEqual(sma([1, 2, 3, 4, 5], 3), [null, null, 2, 3, 4]);
  assert.deepEqual(ema([1, 2, 3, 4, 5], 3), [null, null, 2, 3, 4]); // alpha 0.5: 2, 0.5*4+0.5*2, ...
  const r = rma([2, 4, 6, 8], 2); // seed 3, then 1/2*6 + 1/2*3 = 4.5, then 6.25
  assert.deepEqual(r, [null, 3, 4.5, 6.25]);
  assert.deepEqual(highest([1, 5, 2, 4], 2), [null, 5, 5, 4]);
  assert.deepEqual(lowest([1, 5, 2, 4], 2), [null, 1, 2, 2]);
});

test('population standard deviation', () => {
  near(stdev([2, 4, 4, 4, 5, 5, 7, 9], 8)[7], 2);
});

test('rsi: 100 on a rising series, 0 on a falling one, 50 on alternating equal moves', () => {
  assert.equal(rsi([1, 2, 3, 4, 5, 6, 7, 8], 3).at(-1), 100);
  assert.equal(rsi([8, 7, 6, 5, 4, 3, 2, 1], 3).at(-1), 0);
  const alt = Array.from({ length: 40 }, (_, i) => (i % 2 ? 11 : 10));
  // The last move is up, so Wilder smoothing leaves it a little above 50.
  near(rsi(alt, 14).at(-1), 50, 5);
});

test('crossover and crossunder', () => {
  assert.deepEqual(crossover([1, 3, 3], [2, 2, 2]), [false, true, false]);
  assert.deepEqual(crossunder([3, 1, 1], [2, 2, 2]), [false, true, false]);
});

test('bollinger bands are the basis plus / minus mult x stdev', () => {
  const c = close(Array.from({ length: 30 }, (_, i) => 100 + Math.sin(i) * 5));
  const out = I.compute('bb', c, { length: 20, mult: 2 });
  const last = out.basis.length - 1;
  const dev = stdev(c.map((x) => x.close), 20).at(-1);
  near(out.upper[last].value - out.basis[last].value, 2 * dev, 1e-9);
  near(out.basis[last].value - out.lower[last].value, 2 * dev, 1e-9);
});

test('macd is ema(fast) - ema(slow); histogram is macd - signal', () => {
  const c = close(Array.from({ length: 80 }, (_, i) => 50 + i * 0.3 + Math.cos(i / 3)));
  const out = I.compute('macd', c, {});
  const s = c.map((x) => x.close);
  const expected = ema(s, 12).at(-1) - ema(s, 26).at(-1);
  near(out.macd.at(-1).value, expected, 1e-9);
  near(out.hist.at(-1).value, out.macd.at(-1).value - out.signal.at(-1).value, 1e-9);
});

test('supertrend is green (below price) in a steady uptrend and red after a crash', () => {
  const up = close(Array.from({ length: 60 }, (_, i) => 100 + i));
  const st = I.compute('supertrend', up, { length: 10, mult: 3 }).line;
  assert.equal(st.at(-1).color, '#34d399');
  assert.ok(st.at(-1).value < up.at(-1).close);
  const crash = close([...Array.from({ length: 40 }, (_, i) => 100 + i), ...Array.from({ length: 20 }, (_, i) => 130 - i * 4)]);
  const st2 = I.compute('supertrend', crash, { length: 10, mult: 3 }).line;
  assert.equal(st2.at(-1).color, '#fb7185');
  assert.ok(st2.at(-1).value > crash.at(-1).close);
});

test('every indicator computes on real-looking data and drops warm-up bars', () => {
  let p = 100;
  const c = Array.from({ length: 200 }, (_, i) => {
    const o = p;
    p *= 1 + Math.sin(i / 7) * 0.01;
    return { time: 1_700_000_000 + i * 900, open: o, high: Math.max(o, p) * 1.003, low: Math.min(o, p) * 0.997, close: p, volume: 100 + (i % 17) };
  });
  for (const [id, def] of Object.entries(I.DEFS)) {
    const out = I.compute(id, c, {});
    for (const o of def.outputs) {
      assert.ok(out[o.key].length > 100, `${id}.${o.key} has values`);
      assert.ok(out[o.key].every((pt) => Number.isFinite(pt.value)), `${id}.${o.key} is finite`);
    }
  }
});

test('params are clamped and labels are short', () => {
  assert.deepEqual(I.normalizeParams('rsi', { length: 99999, source: 'nope' }), { length: 500, source: 'close' });
  assert.equal(I.label('bb', {}), 'BB 20 2');
  assert.equal(I.label('rsi', { length: 7 }), 'RSI 7');
  assert.throws(() => I.normalizeParams('nope'), /Unknown indicator/);
});
