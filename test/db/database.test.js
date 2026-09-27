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
