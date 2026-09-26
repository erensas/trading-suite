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
