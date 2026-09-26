// HTTP behaviour with a fake database and Freqtrade: headers, error shape, validation,
// the control guard, readiness.
const test = require('node:test');
const assert = require('node:assert/strict');
const { startApp, fakeDb, fakeFreqtrade, pgError } = require('../helpers');

test('health, security headers and request ids', async (t) => {
  const app = await startApp();
  t.after(app.close);
  const r = await app.request('GET', '/health');
  assert.equal(r.status, 200);
  assert.equal(r.json.status, 'ok');
  assert.match(r.headers.get('content-security-policy'), /script-src 'self';/);
  assert.equal(r.headers.get('x-frame-options'), 'SAMEORIGIN');
  assert.equal(r.headers.get('x-powered-by'), null);
  assert.match(r.headers.get('x-request-id'), /^[0-9a-f-]{36}$/);
  const own = await app.request('GET', '/health', { headers: { 'X-Request-Id': 'abc-123' } });
  assert.equal(own.headers.get('x-request-id'), 'abc-123');
  const bad = await app.request('GET', '/health', { headers: { 'X-Request-Id': 'has spaces; and <tags>' } });
  assert.match(bad.headers.get('x-request-id'), /^[0-9a-f-]{36}$/, 'an unsafe incoming id is replaced');
});

test('ready: 200 when the database answers, 503 when it does not or while shutting down', async (t) => {
  let dbUp = true;
  const db = fakeDb([[/^SELECT 1$/, () => (dbUp ? [{ '?column?': 1 }] : Promise.reject(new Error('connection refused')))]]);
  const app = await startApp({ db, freqtrade: fakeFreqtrade({ 'GET /ping': { status: 'pong' } }) });
  t.after(app.close);
  let r = await app.request('GET', '/ready');
  assert.equal(r.status, 200);
  assert.deepEqual(r.json.checks, { database: 'ok', freqtrade: 'ok' });
  dbUp = false;
  r = await app.request('GET', '/ready');
  assert.equal(r.status, 503);
  assert.equal(r.json.checks.database, 'connection refused');
  dbUp = true;
  app.ctx.shuttingDown = true;
  r = await app.request('GET', '/ready');
  assert.equal(r.status, 503);
});

test('unknown API routes and bad JSON get the standard error shape', async (t) => {
  const app = await startApp();
  t.after(app.close);
  const r = await app.request('GET', '/api/nope');
  assert.equal(r.status, 404);
  assert.equal(r.json.success, false);
  assert.equal(r.json.code, 'not_found');
  assert.equal(r.json.requestId, r.headers.get('x-request-id'));
  const bad = await app.request('POST', '/api/trading/orders', { body: '{"symbol":' });
  assert.equal(bad.status, 400);
  assert.equal(bad.json.code, 'invalid_json');
});

test('control guard: header required, cross-origin rejected', async (t) => {
  const app = await startApp();
  t.after(app.close);
  const noHeader = await app.request('POST', '/api/control/halt', { body: {} });
  assert.equal(noHeader.status, 403);
  assert.match(noHeader.json.error, /X-Trading-Control/);
  const crossOrigin = await app.request('POST', '/api/control/halt', { body: {}, control: true, headers: { Origin: 'https://evil.example' } });
  assert.equal(crossOrigin.status, 403);
  assert.match(crossOrigin.json.error, /Cross-origin/);
  const svc = await app.request('POST', '/api/trading/services/rootkit.service/restart', { control: true });
  assert.equal(svc.status, 403);
});

test('settings: validation errors are 400 with the field name; valid changes are stored and audited', async (t) => {
  const stored = [];
  const audits = [];
  const db = fakeDb([
    [/INSERT INTO suite_settings/, (params) => stored.push(params)],
    [/UPDATE economist_signals/, () => []],
    [/INSERT INTO suite_audit_log/, (params) => audits.push(params)],
  ]);
  const app = await startApp({ db });
  t.after(app.close);
  const bad = await app.request('POST', '/api/trading/settings', { control: true, body: { candleLimit: 5 } });
  assert.equal(bad.status, 400);
  assert.match(bad.json.error, /^candleLimit: must be between 50 and 1000/);
  assert.equal(stored.length, 0);

  const ok = await app.request('POST', '/api/trading/settings', { control: true, body: { candleLimit: '500', showVolume: false } });
  assert.equal(ok.status, 200);
  assert.equal(ok.json.settings.candleLimit, 500);
  assert.equal(ok.json.settings.showVolume, false);
  assert.equal(stored.length, 1);
  assert.equal(stored[0][1], 'trading-suite UI: tester@example (test-node, 100.64.0.1)');
  assert.equal(audits.length, 1);
  assert.equal(audits[0][1], 'update');
});

test('providers: private base URLs and bad ids are rejected before touching the database', async (t) => {
  const db = fakeDb();
  const app = await startApp({ db });
  t.after(app.close);
  const r = await app.request('POST', '/api/providers', { control: true, body: { name: 'Internal', kind: 'rest_template', base_url: 'https://10.0.0.5' } });
  assert.equal(r.status, 400);
  assert.match(r.json.error, /public host/);
  const badId = await app.request('DELETE', '/api/providers/abc', { control: true });
  assert.equal(badId.status, 400);
  assert.match(badId.json.error, /^id:/);
  assert.equal(db.calls.length, 0);
});

test('providers: a duplicate name is a 409', async (t) => {
  const db = fakeDb([[/INSERT INTO market_providers/, () => Promise.reject(pgError('23505'))]]);
  const app = await startApp({ db });
  t.after(app.close);
  const r = await app.request('POST', '/api/providers', { control: true, body: { name: 'Binance Spot', kind: 'binance', base_url: 'https://api.binance.com' } });
  assert.equal(r.status, 409);
  assert.equal(r.json.code, 'conflict');
});

test('orders: validated, stored as SIMULATED', async (t) => {
  const db = fakeDb([[/INSERT INTO manual_orders/, (p) => [{ id: 7, symbol: p[0], side: p[1], order_type: p[2], amount: String(p[3]), status: 'SIMULATED' }]]]);
  const app = await startApp({ db });
  t.after(app.close);
  const empty = await app.request('POST', '/api/trading/orders', { body: {} });
  assert.equal(empty.status, 400);
  const bad = await app.request('POST', '/api/trading/orders', { body: { symbol: 'ETH/USDT', side: 'HOLD', amount: 1 } });
  assert.equal(bad.status, 400);
  assert.match(bad.json.error, /side must be BUY or SELL/);
  const ok = await app.request('POST', '/api/trading/orders', { body: { symbol: 'ETH/USDT', side: 'buy', amount: 100 } });
  assert.equal(ok.status, 200);
  assert.equal(ok.json.order.side, 'BUY');
});

test('candles: unknown instrument is 404, a failing provider falls back to the cached candles', async (t) => {
  let fail = false;
  const inst = {
    symbol: 'BTC/USDT', base_asset: 'BTC', quote_asset: 'USDT', provider_symbol: 'BTC/USDT',
    p_id: 9, p_name: 'Freqtrade Bot', p_kind: 'freqtrade', p_base_url: 'http://127.0.0.1:8080', p_enabled: true, p_config: {},
  };
  const db = fakeDb([[/FROM instrument_registry ir LEFT JOIN market_providers/, (p) => (p[0] === 'BTC/USDT' ? [inst] : [])]]);
  const freqtrade = fakeFreqtrade({
    'GET /pair_candles?pair=BTC%2FUSDT&timeframe=1h&limit=50': () => {
      if (fail) throw Object.assign(new Error('Freqtrade down'), { transient: true });
      return { columns: ['date', 'open', 'high', 'low', 'close', 'volume'], data: [['2026-09-26T10:00:00Z', 1, 2, 0.5, 1.5, 10]] };
    },
  });
  const app = await startApp({ db, freqtrade });
  t.after(app.close);
  const unknown = await app.request('GET', '/api/trading/candles?symbol=NOPE/USDT&tf=1h&limit=50');
  assert.equal(unknown.status, 404);
  const badTf = await app.request('GET', '/api/trading/candles?symbol=BTC/USDT&tf=2h');
  assert.equal(badTf.status, 400);

  const first = await app.request('GET', '/api/trading/candles?symbol=BTC/USDT&tf=1h&limit=50');
  assert.equal(first.status, 200);
  assert.equal(first.json.candles.length, 1);
  // Expire the cache entry (10 s for this kind), then make the provider fail.
  fail = true;
  const realNow = Date.now;
  Date.now = () => realNow() + 60000;
  t.after(() => (Date.now = realNow));
  const second = await app.request('GET', '/api/trading/candles?symbol=BTC/USDT&tf=1h&limit=50');
  assert.equal(second.status, 200);
  assert.equal(second.json.stale, true);
  assert.match(second.json.staleReason, /Freqtrade down/);
});
