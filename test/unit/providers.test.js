const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const { validateBaseUrl, adapterFor, KINDS, _internal } = require('../../lib/providers');

const { cleanCandles, aggregate, geckoInverted, templateUrl, dig, getJson } = _internal;

test('validateBaseUrl: https public hosts only', () => {
  assert.equal(validateBaseUrl('binance', 'https://api.binance.com'), null);
  assert.equal(validateBaseUrl('freqtrade', 'http://127.0.0.1:8080'), null, 'the local Freqtrade kind is exempt');
  const rejected = [
    'http://api.binance.com',
    'https://localhost',
    'https://127.0.0.1',
    'https://10.1.2.3',
    'https://192.168.1.1',
    'https://172.16.0.1',
    'https://169.254.169.254',
    'https://100.88.42.15',
    'https://host.tail1234.ts.net',
    'https://[::1]',
    'not a url',
  ];
  for (const url of rejected) assert.ok(validateBaseUrl('rest_template', url), `${url} must be rejected`);
});

test('cleanCandles drops invalid rows, sorts and de-duplicates by time', () => {
  const rows = [
    { time: 3, open: 1, high: 2, low: 0.5, close: 1.5 },
    { time: 1, open: 1, high: 2, low: 0.5, close: 1.5 },
    { time: 3, open: 9, high: 9, low: 9, close: 9 },
    { time: 2, open: NaN, high: 2, low: 0.5, close: 1.5 },
  ];
  assert.deepEqual(cleanCandles(rows).map((c) => c.time), [1, 3]);
});

test('aggregate combines N candles into one', () => {
  const c = (time, o, h, l, cl, v) => ({ time, open: o, high: h, low: l, close: cl, volume: v });
  const out = aggregate([c(0, 1, 5, 1, 2, 10), c(60, 2, 6, 0.5, 3, 5), c(120, 3, 4, 2, 4, 1)], 2);
  assert.deepEqual(out, [c(0, 1, 6, 0.5, 3, 15), c(120, 3, 4, 2, 4, 1)]);
});

test('geckoInverted detects pools listed the other way round', () => {
  assert.equal(geckoInverted({ symbol: 'WETH/USDT' }, 'USDT / WETH 0.05%'), true);
  assert.equal(geckoInverted({ symbol: 'ETH/USDT' }, 'WETH / USDT'), false);
});

test('templateUrl fills placeholders and resolves paths against base_url', () => {
  const p = { base_url: 'https://api.example.com', config: { symbol_format: '{base}_{quote}' } };
  const url = templateUrl(p, '/candles?pair={symbol}&i={interval}&n={limit}', { symbol: 'BTC/USDT' }, { interval: '1h', limit: 5 });
  assert.equal(url, 'https://api.example.com/candles?pair=BTC_USDT&i=1h&n=5');
  assert.equal(dig({ a: { b: [1, 2] } }, 'a.b.1'), 2);
});

test('every kind has an adapter with candles, ticker, orderbook and test', () => {
  for (const kind of Object.keys(KINDS)) {
    const a = adapterFor({ kind });
    for (const m of ['candles', 'ticker', 'orderbook', 'test']) assert.equal(typeof a[m], 'function', `${kind}.${m}`);
  }
  assert.throws(() => adapterFor({ kind: 'nope' }), /Unknown provider kind/);
});

test('getJson marks 5xx, 429 and unreachable hosts as transient, 4xx not', async (t) => {
  const server = http.createServer((req, res) => {
    const status = Number(req.url.slice(1)) || 200;
    res.writeHead(status, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ msg: `status ${status}` }));
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  t.after(() => server.close());
  const base = `http://127.0.0.1:${server.address().port}`;
  assert.deepEqual(await getJson(`${base}/200`), { msg: 'status 200' });
  await assert.rejects(getJson(`${base}/503`), (e) => e.transient === true && e.upstreamStatus === 503);
  await assert.rejects(getJson(`${base}/429`), (e) => e.transient === true);
  await assert.rejects(getJson(`${base}/404`), (e) => e.transient === false && /HTTP 404 \(status 404\)/.test(e.message));
  await assert.rejects(getJson('http://127.0.0.1:1/'), (e) => e.transient === true && e.code === 'provider_unreachable');
});

test('rankMatches: exact base first, USDT before other quotes, prefix before substring', () => {
  const { rankMatches } = _internal;
  const rows = [
    { base: 'WBTC', quote: 'USDT' },
    { base: 'BTC', quote: 'EUR' },
    { base: 'BTC', quote: 'USDT' },
    { base: 'BTCDOM', quote: 'USDT' },
    { base: 'ETH', quote: 'BTC' },
  ];
  assert.deepEqual(rankMatches(rows, 'btc').map((r) => `${r.base}/${r.quote}`), ['BTC/USDT', 'BTC/EUR', 'BTCDOM/USDT', 'WBTC/USDT']);
  assert.deepEqual(rankMatches(rows, 'btc/usdt').map((r) => `${r.base}/${r.quote}`), ['BTC/USDT']);
  assert.deepEqual(rankMatches(rows, ''), []);
});
