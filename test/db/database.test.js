// Tests against a real PostgreSQL database: migrations and the API end to end.
// Runs only when TEST_DATABASE_URL is set (CI sets it); the database name must contain
// "test", because every test starts by dropping and recreating the public schema.
//   TEST_DATABASE_URL=postgres://suite:suite@localhost/trade_db_test npm test
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { Pool } = require('pg');
const migrate = require('../../db/migrate');
const { createPool } = require('../../src/db');
const { createLogger } = require('../../src/logger');
const { createSettings } = require('../../src/services/settings');
const { startApp, fakeFreqtrade } = require('../helpers');

const URL_ = process.env.TEST_DATABASE_URL;
const skip = !URL_ ? 'TEST_DATABASE_URL is not set' : !/test/i.test(new URL(URL_).pathname) ? 'TEST_DATABASE_URL must name a database containing "test"' : false;
const FIXTURE = fs.readFileSync(path.join(__dirname, '..', 'fixtures', 'external-tables.sql'), 'utf8');
const quiet = () => {};

async function resetSchema({ fixture = true } = {}) {
  const pool = new Pool({ connectionString: URL_, max: 1 });
  try {
    await pool.query('DROP SCHEMA public CASCADE; CREATE SCHEMA public;');
    if (fixture) await pool.query(FIXTURE);
  } finally {
    await pool.end();
  }
}

const withClient = (fn) => migrate.withMigrationClient({ connectionString: URL_ }, fn);

test('migrations: apply from scratch, then nothing is pending', { skip }, async () => {
  await resetSchema();
  const migrations = migrate.readMigrations();
  assert.ok(migrations.length >= 4);
  const ran = await withClient((c) => migrate.up(c, migrations, quiet));
  assert.deepEqual(ran, migrations.map((m) => m.file));
  const again = await withClient((c) => migrate.up(c, migrations, quiet));
  assert.deepEqual(again, []);
  const st = await withClient((c) => migrate.status(c, migrations));
  assert.ok(st.every((m) => m.state === 'applied'));
  // A file edited after it was applied is reported, not re-run.
  const edited = migrations.map((m, i) => (i === 0 ? { ...m, checksum: 'different' } : m));
  const st2 = await withClient((c) => migrate.status(c, edited));
  assert.equal(st2[0].state, 'applied (file changed since)');
});

test('migrations: baseline records hand-applied files without running them', { skip }, async () => {
  await resetSchema();
  const migrations = migrate.readMigrations();
  const pool = new Pool({ connectionString: URL_, max: 1 });
  for (const m of migrations) await pool.query(m.sql); // the way they were applied with psql
  await pool.end();
  await assert.rejects(withClient((c) => migrate.up(c, migrations, quiet)), /migrated by hand/);
  await withClient((c) => migrate.baseline(c, migrations, migrations[migrations.length - 1].version, quiet));
  const st = await withClient((c) => migrate.status(c, migrations));
  assert.ok(st.every((m) => m.state === 'applied' && m.baseline));
  assert.deepEqual(await withClient((c) => migrate.up(c, migrations, quiet)), []);
});

test('migrations: a failing file is rolled back completely', { skip }, async () => {
  await resetSchema();
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mig-'));
  fs.writeFileSync(path.join(dir, '001_ok.sql'), 'CREATE TABLE mig_ok (id int);');
  fs.writeFileSync(path.join(dir, '002_bad.sql'), 'BEGIN;\nCREATE TABLE mig_bad (id int);\nSELECT 1/0;\nCOMMIT;\n');
  const migrations = migrate.readMigrations(dir);
  await assert.rejects(withClient((c) => migrate.up(c, migrations, quiet)), /002_bad\.sql: division by zero/);
  const pool = new Pool({ connectionString: URL_, max: 1 });
  const tables = (await pool.query("SELECT tablename FROM pg_tables WHERE schemaname = 'public' AND tablename LIKE 'mig_%'")).rows.map((r) => r.tablename);
  const versions = (await pool.query('SELECT version FROM schema_migrations')).rows.map((r) => r.version);
  await pool.end();
  assert.deepEqual(tables, ['mig_ok']);
  assert.deepEqual(versions, ['001']);
  fs.rmSync(dir, { recursive: true });
});

test('API against the database: providers, instruments, settings, orders, audit', { skip }, async (t) => {
  await resetSchema();
  await withClient((c) => migrate.up(c, migrate.readMigrations(), quiet));
  const log = createLogger('silent');
  const db = createPool({ connectionString: URL_, max: 4, statementTimeoutMs: 3000 }, log);
  const app = await startApp({ db, freqtrade: fakeFreqtrade({ 'GET /ping': { status: 'pong' } }) });
  t.after(async () => {
    await app.close();
    await db.end();
  });

  // Pool limits reach the server.
  assert.equal((await db.query('SHOW statement_timeout')).rows[0].statement_timeout, '3s');
  assert.equal((await app.request('GET', '/ready')).status, 200);

  // Seeded providers from migration 003.
  const list = await app.request('GET', '/api/providers');
  assert.ok(list.json.providers.some((p) => p.kind === 'geckoterminal'));
  assert.equal(list.json.providers[0].circuit.state, 'closed');

  // Create, then a partial update keeps the fields that were not sent.
  const created = await app.request('POST', '/api/providers', {
    control: true,
    body: { name: 'Gate', kind: 'rest_template', base_url: 'https://api.gateio.ws/api/v4', enabled: false, config: { candles_url: '/spot/candlesticks?currency_pair={symbol}' } },
  });
  assert.equal(created.status, 200, JSON.stringify(created.json));
  const id = created.json.provider.id;
  const updated = await app.request('PUT', `/api/providers/${id}`, { control: true, body: { name: 'Gate.io' } });
  assert.equal(updated.status, 200, JSON.stringify(updated.json));
  assert.equal(updated.json.provider.name, 'Gate.io');
  assert.equal(updated.json.provider.enabled, false, 'enabled was not sent, so it stays false');
  const dup = await app.request('POST', '/api/providers', { control: true, body: { name: 'Gate.io', kind: 'binance', base_url: 'https://api.binance.com' } });
  assert.equal(dup.status, 409);

  // Instruments.
  const inst = await app.request('POST', '/api/trading/pairs', { control: true, body: { symbol: 'gt/usdt', category: 'CEX', provider_id: String(id), name: '' } });
  assert.equal(inst.status, 200, JSON.stringify(inst.json));
  assert.equal(inst.json.symbol, 'GT/USDT');
  const badProvider = await app.request('POST', '/api/trading/pairs', { control: true, body: { symbol: 'XX/USDT', category: 'CEX', provider_id: 99999 } });
  assert.equal(badProvider.status, 400);
  const edit = await app.request('PUT', `/api/trading/pairs/${encodeURIComponent('GT/USDT')}`, { control: true, body: { exchange: 'gate' } });
  assert.equal(edit.status, 200, JSON.stringify(edit.json));
  const pairs = await app.request('GET', '/api/trading/pairs?all=1');
  const gt = pairs.json.pairs.find((p) => p.symbol === 'GT/USDT');
  assert.equal(gt.exchange, 'gate');
  assert.equal(gt.provider_name, 'Gate.io');
  assert.equal(gt.quote_asset, 'USDT');
  const missing = await app.request('PUT', '/api/trading/pairs/NOPE', { control: true, body: {} });
  assert.equal(missing.status, 404);

  // A disabled provider cannot serve candles.
  const candles = await app.request('GET', `/api/trading/candles?symbol=${encodeURIComponent('GT/USDT')}`);
  assert.equal(candles.status, 409);
  assert.match(candles.json.error, /disabled/);

  // Settings persist and load back.
  const saved = await app.request('POST', '/api/trading/settings', { control: true, body: { tickerRefreshSeconds: '120', defaultSymbol: 'GT/USDT' } });
  assert.equal(saved.status, 200);
  const reloaded = createSettings({ db, log });
  await reloaded.load();
  assert.equal(reloaded.values.tickerRefreshSeconds, 120);
  assert.equal(reloaded.persisted, true);

  // Test order, markers, overview, export.
  const order = await app.request('POST', '/api/trading/orders', { body: { symbol: 'GT/USDT', side: 'sell', amount: 5 } });
  assert.equal(order.status, 200);
  const markers = await app.request('GET', `/api/trading/chart-markers?symbol=${encodeURIComponent('GT/USDT')}`);
  assert.equal(markers.json.markers.length, 1);
  assert.equal(markers.json.markers[0].kind, 'manual');
  const overview = await app.request('GET', '/api/trading/overview');
  assert.equal(overview.status, 200);
  assert.equal(overview.json.summary.systemStatus, 'ACTIVE');
  const csv = await app.request('GET', '/api/trading/export/trades?format=csv');
  assert.equal(csv.status, 200);
  assert.match(csv.text, /^id,tx_hash/);

  // Delete leaves the instrument without a provider.
  const del = await app.request('DELETE', `/api/providers/${id}`, { control: true });
  assert.equal(del.status, 200);
  const after = (await app.request('GET', '/api/trading/pairs?all=1')).json.pairs.find((p) => p.symbol === 'GT/USDT');
  assert.equal(after.provider_id, null);

  // Every change is in the audit log with the caller.
  const audit = (await db.query('SELECT action, entity, actor FROM suite_audit_log ORDER BY id')).rows;
  assert.deepEqual(
    audit.map((a) => `${a.action} ${a.entity}`),
    ['create provider', 'update provider', 'create instrument', 'update instrument', 'update settings', 'delete provider']
  );
  assert.ok(audit.every((a) => a.actor.includes('tester@example')));

  // Kill switch round trip.
  const halt = await app.request('POST', '/api/control/halt', { control: true, body: { reason: 'test' } });
  assert.equal(halt.status, 200);
  assert.equal((await app.request('GET', '/api/control/status')).json.control.halted, true);
  const noConfirm = await app.request('POST', '/api/control/resume', { control: true, body: {} });
  assert.equal(noConfirm.status, 400);
  assert.match(noConfirm.json.error, /Type RESUME/);
  const resume = await app.request('POST', '/api/control/resume', { control: true, body: { confirm: 'RESUME' } });
  assert.equal(resume.status, 200);
  const ctlAudit = (await db.query('SELECT halted FROM trading_control_audit ORDER BY id')).rows.map((r) => r.halted);
  assert.deepEqual(ctlAudit, [true, false]);
});

// A guard that answers adapter calls from a table instead of the network:
// answers[providerName][guard.method] = value | Error; anything else calls the adapter.
function tableGuard(answers) {
  return {
    calls: [],
    async run(provider, fn) {
      this.calls.push(provider.name);
      const a = (answers[provider.name] || {})[this.method];
      if (a instanceof Error) throw a;
      if (a !== undefined) return typeof a === 'function' ? a() : a;
      return fn();
    },
    status: () => ({ state: 'closed', failures: 0, retryInS: 0, lastError: null, ratePerMin: null }),
    forget() {},
  };
}

test('phase A: several sources per instrument, fallback, order, import, watchlists', { skip }, async (t) => {
  await resetSchema();
  await withClient((c) => migrate.up(c, migrate.readMigrations(), quiet));
  const log = createLogger('silent');
  const db = createPool({ connectionString: URL_, max: 4, statementTimeoutMs: 3000 }, log);
  const candle = (close) => [{ time: 1790000000, open: close, high: close, low: close, close, volume: 1 }];
  const { ProviderError } = require('../../lib/providers');
  const answers = {
    'Binance Spot': { candles: new ProviderError('api.binance.com: HTTP 503', { transient: true }) },
    OKX: { candles: candle(101) },
  };
  // The guard does not see which adapter method is called, so the test names it.
  const guard = tableGuard(answers);
  const app = await startApp({ db, guard, freqtrade: fakeFreqtrade({ 'GET /ping': { status: 'pong' } }) });
  t.after(async () => {
    await app.close();
    await db.end();
  });
  const providers = (await app.request('GET', '/api/providers')).json.providers;
  const id = (name) => providers.find((p) => p.name === name).id;

  // Migration 005 made the old provider the primary source and seeded the lists.
  const lists = (await app.request('GET', '/api/watchlists')).json.watchlists;
  assert.deepEqual(lists.map((w) => w.name), ['Main', 'Crypto spot', 'Crypto futures', 'DEX pools', 'Stocks & ETFs']);
  assert.equal(lists[0].is_default, true);

  // Import a new instrument with two sources straight onto a list.
  const imp = await app.request('POST', '/api/instruments/import', {
    control: true,
    body: {
      symbol: 'ARB/USDT', category: 'CEX', base_asset: 'ARB', quote_asset: 'USDT', watchlist_id: lists[0].id,
      listings: [{ provider_id: id('Binance Spot'), provider_symbol: 'ARBUSDT' }, { provider_id: id('OKX'), provider_symbol: 'ARB-USDT' }],
    },
  });
  assert.equal(imp.status, 200, JSON.stringify(imp.json));
  assert.equal(imp.json.created, true);
  assert.equal(imp.json.listings.length, 2);
  const again = await app.request('POST', '/api/instruments/import', { control: true, body: { symbol: 'arb/usdt', category: 'CEX', listings: [{ provider_id: id('OKX'), provider_symbol: 'ARB-USDT' }] } });
  assert.equal(again.json.created, false);
  assert.equal(again.json.listings.length, 0, 'an existing source is not added twice');

  const detail = (await app.request('GET', '/api/instruments/ARB%2FUSDT')).json;
  assert.deepEqual(detail.listings.map((l) => l.provider.name), ['Binance Spot', 'OKX']);
  assert.equal(detail.instrument.provider_id, id('Binance Spot'), 'the primary source is mirrored into the registry');
  assert.deepEqual(detail.watchlists, [lists[0].id]);

  // Binance fails, so the chart falls back to OKX and says so.
  guard.method = 'candles';
  const c = await app.request('GET', '/api/trading/candles?symbol=ARB%2FUSDT&tf=1h&limit=50');
  assert.equal(c.status, 200, JSON.stringify(c.json));
  assert.equal(c.json.provider.name, 'OKX');
  assert.equal(c.json.fallbackFrom[0].provider, 'Binance Spot');
  // A chosen listing is used alone.
  const only = await app.request('GET', `/api/trading/candles?symbol=ARB%2FUSDT&tf=1h&limit=50&listing=${detail.listings[0].id}`);
  assert.equal(only.status, 502);

  // Reorder: OKX first, mirrored into the registry.
  const order = await app.request('PUT', '/api/instruments/ARB%2FUSDT/listings/order', { control: true, body: { ids: [detail.listings[1].id, detail.listings[0].id] } });
  assert.equal(order.status, 200, JSON.stringify(order.json));
  assert.equal(order.json.listings[0].provider.name, 'OKX');
  const reg = (await db.query("SELECT provider_id FROM instrument_registry WHERE symbol = 'ARB/USDT'")).rows[0];
  assert.equal(reg.provider_id, id('OKX'));
  const badOrder = await app.request('PUT', '/api/instruments/ARB%2FUSDT/listings/order', { control: true, body: { ids: [detail.listings[1].id] } });
  assert.equal(badOrder.status, 400);

  // Disable one source, delete the other: the instrument has no provider left.
  const dis = await app.request('PUT', `/api/listings/${detail.listings[1].id}`, { control: true, body: { enabled: false } });
  assert.equal(dis.json.listing.enabled, false);
  assert.equal(dis.json.listing.provider_symbol, 'ARB-USDT', 'fields not sent are kept');
  await app.request('DELETE', `/api/listings/${detail.listings[0].id}`, { control: true });
  const none = await app.request('GET', '/api/trading/candles?symbol=ARB%2FUSDT&tf=1h');
  assert.equal(none.status, 409);
  assert.match(none.json.error, /disabled/);

  // Watchlists: create, add, reorder, default, delete.
  const w = await app.request('POST', '/api/watchlists', { control: true, body: { name: 'Swing', columns: ['price', 'score'], sort: { by: 'change', dir: 'desc' } } });
  assert.equal(w.status, 200, JSON.stringify(w.json));
  const wid = w.json.watchlist.id;
  assert.equal((await app.request('POST', '/api/watchlists', { control: true, body: { name: 'Swing' } })).status, 409);
  assert.equal((await app.request('POST', `/api/watchlists/${wid}/items`, { control: true, body: { symbol: 'NOPE/USDT' } })).status, 404);
  for (const s of ['ARB/USDT', 'SOL/USDT', 'BTC/USDT']) {
    await db.query("INSERT INTO instrument_registry (symbol, category) VALUES ($1, 'CEX') ON CONFLICT DO NOTHING", [s]);
    const r = await app.request('POST', `/api/watchlists/${wid}/items`, { control: true, body: { symbol: s } });
    assert.equal(r.json.added, true);
  }
  const ro = await app.request('PUT', `/api/watchlists/${wid}/items`, { control: true, body: { symbols: ['BTC/USDT', 'ARB/USDT'] } });
  assert.deepEqual(ro.json.order, ['BTC/USDT', 'ARB/USDT', 'SOL/USDT']);
  const items = (await app.request('GET', `/api/watchlists/${wid}/items`)).json.items;
  assert.deepEqual(items.map((i) => i.symbol), ['BTC/USDT', 'ARB/USDT', 'SOL/USDT']);
  await app.request('DELETE', `/api/watchlists/${wid}/items/${encodeURIComponent('SOL/USDT')}`, { control: true });
  const def = await app.request('PUT', `/api/watchlists/${wid}`, { control: true, body: { is_default: true } });
  assert.equal(def.json.watchlist.is_default, true);
  assert.deepEqual(def.json.watchlist.columns, ['price', 'score'], 'fields not sent are kept');
  const defaults = (await db.query('SELECT count(*)::int AS n FROM watchlists WHERE is_default')).rows[0].n;
  assert.equal(defaults, 1);
  await app.request('DELETE', `/api/watchlists/${wid}`, { control: true });
  const after = (await app.request('GET', '/api/watchlists')).json.watchlists;
  assert.equal(after.filter((x) => x.is_default).length, 1, 'deleting the default list makes another one default');

  // Registry rows written by other scripts get a listing on the next ticker run.
  await db.query("INSERT INTO instrument_registry (symbol, category, provider_id) VALUES ('ZZZ/USDT', 'CEX', $1)", [id('Bybit')]);
  const { createInstruments } = require('../../src/services/instruments');
  assert.equal(await createInstruments({ db }).backfillListings(), 1);
});

test('phase B: chart layouts and price / indicator alerts', { skip }, async (t) => {
  await resetSchema();
  await withClient((c) => migrate.up(c, migrate.readMigrations(), quiet));
  const log = createLogger('silent');
  const db = createPool({ connectionString: URL_, max: 4, statementTimeoutMs: 3000 }, log);
  // 60 hourly candles rising 1 per bar: RSI 100 on the last closed bar.
  const rising = Array.from({ length: 60 }, (_, i) => ({ time: 1790000000 + i * 3600, open: 100 + i, high: 101 + i, low: 99 + i, close: 100 + i, volume: 5 }));
  const guard = tableGuard({ 'Binance Spot': { candles: rising } });
  guard.method = 'candles';
  const app = await startApp({ db, guard, freqtrade: fakeFreqtrade({}) });
  t.after(async () => {
    await app.close();
    await db.end();
  });
  await db.query("INSERT INTO instrument_registry (symbol, category, last_price, change_24h_pct) VALUES ('BTC/USDT', 'CEX', 100, 1.5)");
  const binance = (await db.query("SELECT id FROM market_providers WHERE name = 'Binance Spot'")).rows[0].id;
  await db.query('INSERT INTO instrument_listings (symbol, provider_id, priority) VALUES ($1, $2, 0)', ['BTC/USDT', binance]);

  // Layouts: the default applies until a symbol has its own.
  const layout = { indicators: [{ uid: 'a1', id: 'rsi', params: { length: 14 }, colors: { rsi: '#ff0000' }, visible: true }], showVolume: false };
  assert.equal((await app.request('PUT', '/api/chart-layout', { control: true, body: { scope: 'default', layout } })).status, 200);
  let got = (await app.request('GET', '/api/chart-layout?symbol=BTC%2FUSDT')).json;
  assert.equal(got.scope, 'default');
  assert.equal(got.layout.indicators[0].id, 'rsi');
  await app.request('PUT', '/api/chart-layout', { control: true, body: { scope: 'BTC/USDT', layout: { indicators: [], showVolume: true } } });
  got = (await app.request('GET', '/api/chart-layout?symbol=BTC%2FUSDT')).json;
  assert.equal(got.scope, 'BTC/USDT');
  assert.equal(got.hasOwn, true);
  const bad = await app.request('PUT', '/api/chart-layout', { control: true, body: { layout: { indicators: [{ uid: 'x', id: 'nope' }] } } });
  assert.equal(bad.status, 400);

  // One-shot price alert: fires once, then is disabled.
  const a1 = await app.request('POST', '/api/alerts', { control: true, body: { symbol: 'BTC/USDT', kind: 'price_above', value: 110, note: 'breakout' } });
  assert.equal(a1.status, 200, JSON.stringify(a1.json));
  assert.match(a1.json.alert.text, /BTC\/USDT price above 110/);
  // Repeating 24h-change alert.
  const a2 = await app.request('POST', '/api/alerts', { control: true, body: { symbol: 'BTC/USDT', kind: 'change_below', value: -5, repeat: true } });
  assert.equal(a2.status, 200);
  const needsInd = await app.request('POST', '/api/alerts', { control: true, body: { symbol: 'BTC/USDT', kind: 'indicator_above', value: 70 } });
  assert.equal(needsInd.status, 400);
  const a3 = await app.request('POST', '/api/alerts', { control: true, body: { symbol: 'BTC/USDT', kind: 'indicator_above', value: 70, timeframe: '1h', indicator: { id: 'rsi', params: { length: 14 } } } });
  assert.equal(a3.status, 200, JSON.stringify(a3.json));

  const alerts = app.ctx.alerts;
  assert.equal(await alerts.evaluatePrices(), 0);
  await db.query("UPDATE instrument_registry SET last_price = 111, change_24h_pct = -6 WHERE symbol = 'BTC/USDT'");
  assert.equal(await alerts.evaluatePrices(), 2);
  assert.equal(await alerts.evaluatePrices(), 0, 'nothing fires twice while the condition holds');
  await db.query("UPDATE instrument_registry SET change_24h_pct = 0 WHERE symbol = 'BTC/USDT'");
  await alerts.evaluatePrices(); // re-arms the repeating alert
  await db.query("UPDATE instrument_registry SET change_24h_pct = -7 WHERE symbol = 'BTC/USDT'");
  assert.equal(await alerts.evaluatePrices(), 1, 'the repeating alert fires again after re-arming');
  const oneShot = (await db.query('SELECT enabled, triggered_at FROM alerts WHERE id = $1', [a1.json.alert.id])).rows[0];
  assert.equal(oneShot.enabled, false);
  assert.ok(oneShot.triggered_at);

  // Indicator alert on the last closed candle.
  assert.equal(await alerts.evaluateIndicators(), 1);
  const ev = (await app.request('GET', '/api/alert-events')).json;
  assert.equal(ev.events.length, 4);
  assert.equal(ev.unseen, 4);
  assert.match(ev.events[0].message, /RSI 14 \(1h\) above 70/);
  await app.request('POST', '/api/alert-events/seen', { control: true, body: { all: true } });
  assert.equal((await app.request('GET', '/api/alert-events')).json.unseen, 0);

  // Editing re-arms and re-enables.
  const upd = await app.request('PUT', `/api/alerts/${a1.json.alert.id}`, { control: true, body: { enabled: true, value: 120 } });
  assert.equal(upd.json.alert.armed, true);
  assert.equal(Number(upd.json.alert.value), 120);
  assert.equal((await app.request('DELETE', `/api/alerts/${a2.json.alert.id}`, { control: true })).status, 200);
  assert.equal((await app.request('GET', '/api/alerts?symbol=BTC%2FUSDT')).json.alerts.length, 2);
});

// A user systemd manager that runs nothing: transient runs answer from the test, units are
// a set of names.
function fakeSysd({ check, btResult, pinned }) {
  const active = new Set();
  const runs = [];
  const ok = (stdout = '') => ({ code: 0, stdout, stderr: '' });
  return {
    runs,
    active,
    pinned,
    async run({ unit, argv }) {
      runs.push({ unit, argv });
      const script = argv.find((a) => a.endsWith('.py')) || '';
      if (script.endsWith('strategy_check.py')) return ok(`STRATEGY_CHECK ${JSON.stringify(check(argv[3]))}\n`);
      if (script.endsWith('bt_result.py')) return ok(`BT_RESULT ${JSON.stringify(btResult)}\n`);
      if (argv.includes('create-userdir')) fs.mkdirSync(argv[argv.indexOf('--userdir') + 1], { recursive: true });
      return ok('done');
    },
    unitState: async (u) => ({ active: active.has(u), state: active.has(u) ? 'active' : 'inactive' }),
    journal: async (u, { system }) => [`${system ? 'system' : 'user'} journal of ${u}`],
    start: async (u) => active.add(u),
    restart: async (u) => active.add(u),
    stop: async (u) => active.delete(u),
    enable: async () => {},
    disable: async () => {},
    exec: async () => ok(pinned.value ? '{ path=/x/freqtrade ; argv[]=/x/freqtrade trade --strategy LLMAgentStrategy }' : '{ argv[]=/x/freqtrade trade }'),
  };
}

// A Freqtrade REST API with a trading state; reload_config reads the strategy from the
// config file, as Freqtrade does.
function fakeBot(configPath) {
  const s = { state: 'running', strategy: JSON.parse(fs.readFileSync(configPath(), 'utf8')).strategy, dry_run: true, closed: 0 };
  const calls = [];
  const api = async (method, apiPath) => {
    calls.push(`${method} ${apiPath}`);
    switch (`${method} ${apiPath}`) {
      case 'GET /show_config':
        return { state: s.state, strategy: s.strategy, dry_run: s.dry_run, timeframe: '15m', exchange: 'binance', stake_currency: 'USDT' };
      case 'GET /status':
        return [];
      case 'GET /profit':
        return { closed_trade_count: s.closed, trade_count: s.closed, profit_closed_coin: 0, profit_all_coin: 0 };
      case 'GET /count':
        return { current: 0, max: 3 };
      case 'POST /pause':
        s.state = 'paused';
        return { status: 'paused' };
      case 'POST /start':
        s.state = 'running';
        return { status: 'running' };
      case 'POST /stop':
        s.state = 'stopped';
        return { status: 'stopped' };
      case 'POST /reload_config':
        s.strategy = JSON.parse(fs.readFileSync(configPath(), 'utf8')).strategy;
        return { status: 'reloading' };
      default:
        throw new Error(`fake bot has no ${method} ${apiPath}`);
    }
  };
  return { s, calls, api };
}

test('phases C to E: strategy library, backtests, bots, kill switch, going live', { skip }, async (t) => {
  await resetSchema();
  await withClient((c) => migrate.up(c, migrate.readMigrations(), quiet));
  const log = createLogger('silent');
  const db = createPool({ connectionString: URL_, max: 4, statementTimeoutMs: 3000 }, log);
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ts-bots-'));
  const dirs = { bots: path.join(tmp, 'bots'), creds: path.join(tmp, 'credentials'), main: path.join(tmp, 'main-strategies') };
  fs.mkdirSync(dirs.main, { recursive: true });
  fs.writeFileSync(path.join(dirs.main, 'LLMAgentStrategy.py'), '"""The main bot\'s strategy."""\nclass LLMAgentStrategy(IStrategy):\n    pass\n');
  const mainConfig = path.join(tmp, 'main-config.json');
  fs.writeFileSync(mainConfig, JSON.stringify({ strategy: 'LLMAgentStrategy', dry_run: true, stake_amount: 10 }));
  await db.query('UPDATE bots SET config_path = $1 WHERE name = $2', [mainConfig, 'main']);

  const pinned = { value: true };
  const sysd = fakeSysd({
    pinned,
    check: (name) => ({ ok: true, message: 'loads and runs', errors: [], warnings: [], class: name, timeframe: '15m', can_short: false }),
    btResult: { summary: { total_trades: 12, profit_total: 0.05, winrate: 0.6 }, per_pair: [{ key: 'BTC/USDT', trades: 12 }], exit_reasons: [], trades: [{ pair: 'BTC/USDT' }], trade_count: 12, daily: [] },
  });
  const main = fakeBot(() => mainConfig);
  const managed = new Map();
  // Managed bots' clients: the port in the URL names the instance.
  const factory = ({ url }) => {
    const port = Number(new URL(url).port);
    const configPath = () => {
      for (const n of fs.readdirSync(path.join(dirs.bots, 'instances'))) {
        const f = path.join(dirs.bots, 'instances', n, 'config.json');
        if (fs.existsSync(f) && JSON.parse(fs.readFileSync(f, 'utf8')).api_server.listen_port === port) return f;
      }
      throw new Error(`no instance on port ${port}`);
    };
    if (!managed.has(port)) managed.set(port, fakeBot(configPath));
    return managed.get(port);
  };
  const app = await startApp({
    db,
    sysd,
    freqtrade: main,
    freqtradeFactory: factory,
    env: { BOTS_DIR: dirs.bots, BOT_CREDENTIALS_DIR: dirs.creds, MAIN_STRATEGIES_DIR: dirs.main, BOT_MIN_FREE_MB: '0' },
  });
  t.after(async () => {
    await app.close();
    await db.end();
    fs.rmSync(tmp, { recursive: true, force: true });
  });
  const call = (method, url, body) => app.request(method, url, { control: method !== 'GET', body });

  // Seeded bots, and the strategies that can be copied into the library.
  let bots = (await call('GET', '/api/bots')).json.bots;
  assert.deepEqual(bots.map((b) => b.name), ['main', 'web3-dex-bot']);
  assert.equal(bots[0].api.state, 'running');
  assert.equal(bots[0].credentials_file, undefined);
  let lib = (await call('GET', '/api/strategies')).json;
  assert.deepEqual(lib.library, []);
  assert.ok(lib.templates.some((x) => x.name === 'EmaCrossStrategy'));
  assert.deepEqual(lib.mainFiles.map((x) => x.name), ['LLMAgentStrategy']);

  // Import a template; bots may use it only after its check.
  const imp = await call('POST', '/api/strategies/import', { kind: 'template', name: 'EmaCrossStrategy' });
  assert.equal(imp.status, 200);
  assert.ok(fs.existsSync(path.join(dirs.bots, 'strategies', 'EmaCrossStrategy.py')));
  assert.ok(fs.existsSync(path.join(dirs.bots, 'strategies', 'ts_guard.py')));
  assert.equal((await call('POST', '/api/strategies/import', { kind: 'template', name: 'EmaCrossStrategy' })).status, 409);
  const early = await call('POST', '/api/bots', { name: 'alpha', strategy: 'EmaCrossStrategy', pairs: ['BTC/USDT'], start: false });
  assert.equal(early.status, 400);
  assert.match(early.json.error, /has not passed its check/);

  // A new version resets the check; the source must define the class it is saved under.
  const src = (await call('GET', '/api/strategies/EmaCrossStrategy')).json.strategy.source;
  const bad = await call('PUT', '/api/strategies/EmaCrossStrategy', { source: 'class Other(IStrategy):\n    pass\n' });
  assert.equal(bad.status, 400);
  assert.match(bad.json.error, /must define "class EmaCrossStrategy\(IStrategy\):"/);
  assert.equal((await call('POST', '/api/strategies/EmaCrossStrategy/check')).json.result.ok, true);
  const v2 = await call('PUT', '/api/strategies/EmaCrossStrategy', { source: src + '\n# tuned\n' });
  assert.equal(v2.json.changed, true);
  assert.equal((await call('GET', '/api/strategies/EmaCrossStrategy')).json.strategy.check_status, 'unchecked');
  assert.equal((await call('GET', '/api/strategies/EmaCrossStrategy/versions')).json.versions.length, 2);
  assert.equal((await call('PUT', '/api/strategies/EmaCrossStrategy', { source: src + '\n# tuned\n' })).json.changed, false);
  await call('POST', '/api/strategies/EmaCrossStrategy/check');
  const checked = (await call('GET', '/api/strategies/EmaCrossStrategy')).json.strategy;
  assert.equal(checked.check_status, 'ok');
  assert.equal(checked.timeframe, '15m');

  // Backtest: queued, run by the worker, result stored.
  const bt = await call('POST', '/api/backtests', { strategy: 'EmaCrossStrategy', pairs: ['btc/usdt'], days: 30 });
  assert.equal(bt.status, 200);
  assert.equal(bt.json.backtest.status, 'queued');
  assert.equal((await call('POST', '/api/backtests', { strategy: 'EmaCrossStrategy', pairs: ['nonsense'] })).status, 400);
  await app.ctx.backtests.drain();
  const done = (await call('GET', `/api/backtests/${bt.json.backtest.id}`)).json.backtest;
  assert.equal(done.status, 'done', done.error);
  assert.equal(done.summary.total_trades, 12);
  assert.equal(done.strategy_sha, checked.sha);
  const btArgv = sysd.runs.find((r) => r.unit === `ts-backtest-${done.id}`).argv;
  assert.ok(btArgv.includes('--strategy-path') && btArgv.includes(path.join(dirs.bots, 'strategies')));
  assert.equal(JSON.parse(fs.readFileSync(path.join(dirs.bots, 'backtests', String(done.id), 'config.json'), 'utf8')).exchange.pair_whitelist[0], 'BTC/USDT');

  // Managed bot: config, API credentials (0600), user unit.
  const created = await call('POST', '/api/bots', { name: 'Alpha', strategy: 'EmaCrossStrategy', pairs: ['BTC/USDT', 'ETH/USDT'], start: false });
  assert.equal(created.status, 200, created.text);
  assert.equal(created.json.bot.name, 'alpha');
  assert.equal(created.json.bot.api_port, 8090);
  const alphaCfgPath = path.join(dirs.bots, 'instances', 'alpha', 'config.json');
  const alphaCfg = JSON.parse(fs.readFileSync(alphaCfgPath, 'utf8'));
  assert.equal(alphaCfg.dry_run, true);
  assert.equal(alphaCfg.strategy_path, path.join(dirs.bots, 'strategies'));
  assert.match(alphaCfg.db_url, /trades\.dryrun\.sqlite$/);
  const credFile = path.join(dirs.creds, 'alpha.env');
  assert.equal(fs.statSync(credFile).mode & 0o777, 0o600);
  assert.match(fs.readFileSync(credFile, 'utf8'), /^FREQTRADE__API_SERVER__PASSWORD=\S{20,}$/m);
  assert.ok(!created.text.includes('PASSWORD'));
  assert.equal((await call('POST', '/api/bots', { name: 'main', strategy: 'EmaCrossStrategy', pairs: ['BTC/USDT'] })).status, 409);
  assert.equal((await call('POST', '/api/bots/alpha/action', { action: 'start_process' })).status, 200);
  assert.ok(sysd.active.has('freqtrade-bot@alpha.service'));
  bots = (await call('GET', '/api/bots')).json.bots;
  assert.equal(bots.find((b) => b.name === 'alpha').api.state, 'running');

  // Main bot strategy switch: refused while the unit pins --strategy, then config + reload.
  const refused = await call('POST', '/api/bots/main/strategy', { strategy: 'EmaCrossStrategy' });
  assert.equal(refused.status, 400);
  assert.match(refused.json.error, /runs with --strategy/);
  pinned.value = false;
  const switched = await call('POST', '/api/bots/main/strategy', { strategy: 'EmaCrossStrategy' });
  assert.equal(switched.status, 200, switched.text);
  assert.equal(switched.json.from, 'LLMAgentStrategy');
  assert.equal(main.s.strategy, 'EmaCrossStrategy');
  assert.equal(JSON.parse(fs.readFileSync(mainConfig, 'utf8')).strategy_path, path.join(dirs.bots, 'strategies'));
  assert.equal(fs.readdirSync(path.join(dirs.bots, 'config-backups')).length, 1);
  assert.equal((await call('DELETE', '/api/strategies/EmaCrossStrategy')).status, 409);

  // Kill switch: running bots are paused; resume starts only those.
  await call('POST', '/api/bots/main/action', { action: 'pause' });
  const halt = await call('POST', '/api/control/halt', { reason: 'test' });
  assert.equal(halt.json.results.freqtrade, 'already paused');
  assert.equal(halt.json.results['bot alpha'], 'paused');
  const alphaBot = managed.get(8090);
  assert.equal(alphaBot.s.state, 'paused');
  const blocked = await call('POST', '/api/bots/alpha/action', { action: 'start' });
  assert.equal(blocked.status, 409);
  assert.equal(blocked.json.code, 'halted');
  alphaBot.s.state = 'running'; // restarted behind the suite's back
  await app.ctx.bots.repauseRunning();
  assert.equal(alphaBot.s.state, 'paused');
  const resume = await call('POST', '/api/control/resume', { confirm: 'RESUME' });
  assert.equal(resume.json.results['bot alpha'], 'running');
  assert.match(resume.json.results.freqtrade, /left as it was/);
  assert.equal(main.s.state, 'paused');
  assert.equal(alphaBot.s.state, 'running');

  // Going live: every check, write-only exchange keys, typed confirmation.
  let checks = (await call('GET', '/api/bots/alpha/live-checks')).json;
  assert.equal(checks.ready, false);
  const failing = checks.checks.filter((c) => !c.ok).map((c) => c.id);
  assert.deepEqual(failing, ['dry_run_days', 'dry_run_trades', 'exchange_keys', 'capital_limit']);
  assert.equal((await call('GET', '/api/bots/main/live-checks')).json.checks[0].ok, false);
  const keys = await call('PUT', '/api/bots/alpha/exchange-keys', { key: 'AKIAKEY123456789WXYZ', secret: 'topsecretvalue123456' });
  assert.equal(keys.json.keys.hint, '…WXYZ');
  assert.ok(!keys.text.includes('topsecretvalue'));
  assert.ok(!(await call('GET', '/api/bots/alpha/exchange-keys')).text.includes('topsecretvalue'));
  assert.equal(fs.statSync(credFile).mode & 0o777, 0o600);
  assert.equal((await call('PUT', '/api/bots/alpha/capital-limit', { amount: 100 })).status, 200);
  checks = (await call('GET', '/api/bots/alpha/live-checks')).json;
  assert.equal(checks.checks.find((c) => c.id === 'capital_limit').ok, false); // 50 x 3 > 100
  await call('PUT', '/api/bots/alpha/capital-limit', { amount: 200 });
  alphaBot.s.closed = 6;
  await db.query("UPDATE bots SET dry_run_since = NOW() - INTERVAL '8 days' WHERE name = 'alpha'");
  checks = (await call('GET', '/api/bots/alpha/live-checks')).json;
  assert.equal(checks.ready, true, JSON.stringify(checks.checks));
  assert.equal((await call('POST', '/api/bots/alpha/live', { confirm: 'live alpha' })).status, 400);
  const live = await call('POST', '/api/bots/alpha/live', { confirm: 'LIVE alpha' });
  assert.equal(live.status, 200, live.text);
  const liveCfg = JSON.parse(fs.readFileSync(alphaCfgPath, 'utf8'));
  assert.equal(liveCfg.dry_run, false);
  assert.equal(liveCfg.available_capital, 200);
  assert.match(liveCfg.db_url, /trades\.live\.sqlite$/);
  assert.equal((await call('POST', '/api/bots/alpha/strategy', { strategy: 'EmaCrossStrategy' })).status, 400);
  assert.equal((await call('DELETE', '/api/bots/alpha', { confirm: 'alpha' })).status, 400);
  assert.equal((await call('POST', '/api/bots/alpha/dry-run')).status, 200);
  assert.equal(JSON.parse(fs.readFileSync(alphaCfgPath, 'utf8')).dry_run, true);

  // Journal, then delete: instance and credentials go to trash folders.
  assert.deepEqual((await call('GET', '/api/bots/alpha/journal')).json.lines, ['user journal of freqtrade-bot@alpha.service']);
  assert.deepEqual((await call('GET', '/api/bots/main/journal')).json.lines, ['system journal of freqtrade.service']);
  assert.equal((await call('DELETE', '/api/bots/alpha', { confirm: 'nope' })).status, 400);
  const del = await call('DELETE', '/api/bots/alpha', { confirm: 'alpha' });
  assert.equal(del.status, 200, del.text);
  assert.ok(fs.existsSync(path.join(del.json.trashed, 'config.json')));
  assert.ok(!fs.existsSync(credFile));
  assert.equal(fs.readdirSync(path.join(dirs.creds, 'trash')).length, 1);
  assert.ok(!sysd.active.has('freqtrade-bot@alpha.service'));
  const events = (await db.query("SELECT action FROM bot_events WHERE bot = 'alpha' ORDER BY id")).rows.map((r) => r.action);
  assert.deepEqual(events, ['create', 'start_process', 'kill_switch_pause', 'kill_switch_pause', 'resume_start', 'exchange_keys', 'capital_limit', 'capital_limit', 'go_live', 'go_dry_run', 'delete']);
  const audit = (await db.query("SELECT action, entity FROM suite_audit_log WHERE entity LIKE 'bot%' OR entity = 'strategy' ORDER BY id")).rows.map((a) => `${a.action} ${a.entity}`);
  assert.ok(audit.includes('import strategy') && audit.includes('go live bot') && audit.includes('delete bot'));
});
