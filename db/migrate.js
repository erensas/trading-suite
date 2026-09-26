#!/usr/bin/env node
// Migration runner for db/migrations/NNN_name.sql, tracked in schema_migrations.
//
//   node db/migrate.js status              list migrations and whether they are applied
//   node db/migrate.js check               exit 0 when nothing is pending, 3 when something is
//   node db/migrate.js up                  apply pending migrations in order
//   node db/migrate.js baseline <NNN>      record 001..NNN as applied without running them
//                                          (for a database migrated by hand with psql)
//
// Each migration runs in one transaction together with its schema_migrations row. Files may
// carry their own BEGIN; / COMMIT; lines (they did when applied by hand); the runner drops
// those lines. A changed file that is already applied is reported, never re-run.
// Connection: the same settings as the service (src/config.js), or DATABASE_URL.
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { Pool } = require('pg');
const { loadConfig } = require('../src/config');

const DIR = path.join(__dirname, 'migrations');
const LOCK_KEY = 72100418; // pg_advisory_lock key: one runner at a time
const FILE = /^(\d{3})_[a-z0-9_]+\.sql$/;

function readMigrations(dir = DIR) {
  return fs
    .readdirSync(dir)
    .filter((f) => FILE.test(f))
    .sort()
    .map((file) => {
      const sql = fs.readFileSync(path.join(dir, file), 'utf8');
      return { version: file.slice(0, 3), file, sql, checksum: crypto.createHash('sha256').update(sql).digest('hex') };
    });
}

// Drops top-level transaction control; the runner wraps each file in its own transaction.
const withoutTransactionControl = (sql) => sql.replace(/^\s*(BEGIN|COMMIT)\s*;\s*$/gim, '');

async function ensureTable(client) {
  await client.query(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      version     TEXT PRIMARY KEY,
      file        TEXT NOT NULL,
      checksum    TEXT NOT NULL,
      applied_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      applied_by  TEXT NOT NULL DEFAULT current_user,
      baseline    BOOLEAN NOT NULL DEFAULT FALSE
    )`);
}

async function applied(client) {
  const r = await client.query('SELECT version, file, checksum, applied_at, baseline FROM schema_migrations ORDER BY version');
  return new Map(r.rows.map((row) => [row.version, row]));
}

// A database that has the suite's tables but no schema_migrations rows was migrated by hand
// with psql; running the files again could redo data changes, so `up` refuses until
// `baseline` has recorded what is there.
async function needsBaseline(client) {
  const r = await client.query("SELECT (SELECT count(*) FROM schema_migrations)::int AS n, to_regclass('public.trading_control') IS NOT NULL AS has_tables");
  return r.rows[0].n === 0 && r.rows[0].has_tables;
}

async function status(client, migrations) {
  const done = await applied(client);
  return migrations.map((m) => {
    const row = done.get(m.version);
    if (!row) return { ...m, state: 'pending' };
    return { ...m, state: row.checksum === m.checksum ? 'applied' : 'applied (file changed since)', appliedAt: row.applied_at, baseline: row.baseline };
  });
}

async function up(client, migrations, log = console.log) {
  if (await needsBaseline(client)) {
    throw new Error('this database was migrated by hand (tables exist, schema_migrations is empty); run "baseline <NNN>" for the files already applied first');
  }
  const done = await applied(client);
  const ran = [];
  for (const m of migrations) {
    if (done.has(m.version)) continue;
    await client.query('BEGIN');
    try {
      await client.query(withoutTransactionControl(m.sql));
      await client.query('INSERT INTO schema_migrations (version, file, checksum) VALUES ($1, $2, $3)', [m.version, m.file, m.checksum]);
      await client.query('COMMIT');
    } catch (e) {
      await client.query('ROLLBACK').catch(() => {});
      e.message = `${m.file}: ${e.message}`;
      throw e;
    }
    log(`applied ${m.file}`);
    ran.push(m.file);
  }
  return ran;
}

async function baseline(client, migrations, through, log = console.log) {
  if (!/^\d{3}$/.test(String(through))) throw new Error('baseline needs a version such as 004');
  const done = await applied(client);
  for (const m of migrations.filter((x) => x.version <= through)) {
    if (done.has(m.version)) continue;
    await client.query('INSERT INTO schema_migrations (version, file, checksum, baseline) VALUES ($1, $2, $3, TRUE)', [m.version, m.file, m.checksum]);
    log(`recorded ${m.file} as applied (baseline)`);
  }
}

// Runs fn(client) holding the advisory lock, with schema_migrations in place.
async function withMigrationClient(poolConfig, fn) {
  const pool = new Pool({ ...poolConfig, max: 1, application_name: 'trading-suite migrate' });
  const client = await pool.connect();
  try {
    await client.query('SELECT pg_advisory_lock($1)', [LOCK_KEY]);
    await ensureTable(client);
    return await fn(client);
  } finally {
    await client.query('SELECT pg_advisory_unlock($1)', [LOCK_KEY]).catch(() => {});
    client.release();
    await pool.end();
  }
}

function poolConfigFromEnv(env = process.env) {
  const db = loadConfig(env).db;
  return db.connectionString
    ? { connectionString: db.connectionString }
    : { database: db.database, user: db.user, host: db.host, password: db.password, port: db.port };
}

async function main(argv) {
  const [command = 'status', arg] = argv;
  const migrations = readMigrations();
  return withMigrationClient(poolConfigFromEnv(), async (client) => {
    if (command === 'status' || command === 'check') {
      if (await needsBaseline(client)) {
        console.error('schema_migrations is empty but the tables exist: run "node db/migrate.js baseline <NNN>" first');
        return 1;
      }
      const rows = await status(client, migrations);
      if (command === 'status') {
        for (const r of rows) console.log(`${r.file.padEnd(40)} ${r.state}${r.baseline ? ' (baseline)' : ''}${r.appliedAt ? ` ${r.appliedAt.toISOString()}` : ''}`);
      }
      const pending = rows.filter((r) => r.state === 'pending');
      if (command === 'check') console.log(pending.length ? `pending: ${pending.map((r) => r.file).join(', ')}` : 'no pending migrations');
      return command === 'check' && pending.length ? 3 : 0;
    }
    if (command === 'up') {
      const ran = await up(client, migrations);
      if (!ran.length) console.log('no pending migrations');
      return 0;
    }
    if (command === 'baseline') {
      await baseline(client, migrations, arg);
      return 0;
    }
    throw new Error(`unknown command "${command}" (status, check, up, baseline <NNN>)`);
  });
}

if (require.main === module) {
  main(process.argv.slice(2)).then(
    (code) => process.exit(code),
    (e) => {
      console.error(`migrate: ${e.message}`);
      process.exit(1);
    }
  );
}

module.exports = { readMigrations, withoutTransactionControl, ensureTable, needsBaseline, status, up, baseline, withMigrationClient };
