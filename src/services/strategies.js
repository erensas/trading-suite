// Strategy library (trade_db.strategies, db/migrations/007).
//
// The database holds every strategy written or imported through the suite, with its
// versions; the files in <bots dir>/strategies are written from it (plus ts_guard.py, the
// kill switch helper) and are the strategy_path of every managed bot and backtest. The main
// bot's own strategy files and the templates shipped in strategy-templates/ are listed too
// and can be copied into the library. A strategy is checked (static rules, load, sample run)
// in a sandboxed transient unit before bots may use it.
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { badRequest, notFound, conflict } = require('../http/errors');

const ROOT = path.join(__dirname, '..', '..');
const TEMPLATES_DIR = path.join(ROOT, 'strategy-templates');
const TOOLS_DIR = path.join(ROOT, 'tools');
const NAME = /^[A-Za-z_][A-Za-z0-9_]{2,60}$/;
const MAX_SOURCE = 200 * 1024;

const sha = (text) => crypto.createHash('sha256').update(text).digest('hex').slice(0, 16);

// Class names that subclass IStrategy in a source file.
const strategyClasses = (source) => [...source.matchAll(/^class\s+([A-Za-z_]\w*)\s*\(\s*IStrategy\s*\)/gm)].map((m) => m[1]);
const docstring = (source) => {
  const m = source.match(/^\s*(?:"""|''')([\s\S]*?)(?:"""|''')/);
  return m ? m[1].trim().split('\n')[0].slice(0, 200) : null;
};

function createStrategies({ db, sysd, config, log }) {
  const libDir = path.join(config.bots.dir, 'strategies');

  function ensureLibDir() {
    fs.mkdirSync(libDir, { recursive: true });
    fs.copyFileSync(path.join(TOOLS_DIR, 'ts_guard.py'), path.join(libDir, 'ts_guard.py'));
  }

  function writeFile(name, source) {
    ensureLibDir();
    const tmp = path.join(libDir, `.${name}.py.tmp`);
    fs.writeFileSync(tmp, source, { mode: 0o640 });
    fs.renameSync(tmp, path.join(libDir, `${name}.py`));
  }

  // Library files written from the database (after a restore, or on first start).
  async function syncFiles() {
    try {
      ensureLibDir();
      const r = await db.query('SELECT name, source FROM strategies');
      for (const row of r.rows) {
        const file = path.join(libDir, `${row.name}.py`);
        if (!fs.existsSync(file) || fs.readFileSync(file, 'utf8') !== row.source) writeFile(row.name, row.source);
      }
    } catch (e) {
      log.warn({ error: e.message }, 'strategy library sync failed');
    }
  }

  function readDirStrategies(dir, origin) {
    try {
      return fs
        .readdirSync(dir)
        .filter((f) => f.endsWith('.py'))
        .flatMap((f) => {
          const source = fs.readFileSync(path.join(dir, f), 'utf8');
          return strategyClasses(source).map((name) => ({ name, origin, file: f, description: docstring(source) }));
        });
    } catch (e) {
      return [];
    }
  }

  async function list() {
    const r = await db.query(
      `SELECT s.name, s.sha, s.origin, s.description, s.timeframe, s.can_short, s.check_status, s.check_message, s.checked_at, s.created_by, s.updated_at,
              (SELECT row_to_json(b) FROM (SELECT id, status, finished_at, summary->>'total_trades' AS trades, summary->>'profit_total' AS profit_total,
                      summary->>'max_drawdown_account' AS max_drawdown, summary->>'winrate' AS winrate
                     FROM backtests WHERE strategy = s.name ORDER BY id DESC LIMIT 1) b) AS last_backtest,
              (SELECT array_agg(name) FROM bots WHERE strategy = s.name) AS used_by
       FROM strategies s ORDER BY s.name`
    );
    const inLib = new Set(r.rows.map((x) => x.name));
    const templates = readDirStrategies(TEMPLATES_DIR, 'template').filter((t) => !inLib.has(t.name));
    const mainFiles = readDirStrategies(config.bots.mainStrategiesDir, 'main bot file').filter((t) => !inLib.has(t.name));
    return { library: r.rows, templates, mainFiles };
  }

  async function get(name) {
    const r = await db.query('SELECT * FROM strategies WHERE name = $1', [name]);
    if (!r.rows[0]) throw notFound(`Strategy ${name} is not in the library`);
    return r.rows[0];
  }

  async function versions(name) {
    const r = await db.query('SELECT id, sha, created_by, created_at, length(source) AS size FROM strategy_versions WHERE name = $1 ORDER BY id DESC LIMIT 50', [name]);
    return r.rows;
  }

  async function version(name, id) {
    const r = await db.query('SELECT * FROM strategy_versions WHERE name = $1 AND id = $2', [name, id]);
    if (!r.rows[0]) throw notFound('Version not found');
    return r.rows[0];
  }

  function validateSource(name, source) {
    if (!NAME.test(name)) throw badRequest('The strategy name must be a Python class name (letters, digits, _; 3 to 61 characters)');
    if (typeof source !== 'string' || !source.trim()) throw badRequest('The source is empty');
    if (Buffer.byteLength(source) > MAX_SOURCE) throw badRequest('The source is larger than 200 KB');
    const classes = strategyClasses(source);
    if (!classes.includes(name)) throw badRequest(`The source must define "class ${name}(IStrategy):" (found: ${classes.join(', ') || 'no IStrategy class'})`);
  }

  // Saves a new strategy or a new version; the check has to run again afterwards.
  async function save(name, source, { actor, origin = 'editor', description } = {}) {
    validateSource(name, source);
    const digest = sha(source);
    const existing = await db.query('SELECT sha, origin FROM strategies WHERE name = $1', [name]);
    if (existing.rows[0] && existing.rows[0].sha === digest) return { name, sha: digest, changed: false };
    await db.query(
      `INSERT INTO strategies (name, source, sha, origin, description, created_by, check_status, check_message, updated_at)
       VALUES ($1, $2, $3, $4, $5, $6, 'unchecked', NULL, NOW())
       ON CONFLICT (name) DO UPDATE SET source = EXCLUDED.source, sha = EXCLUDED.sha, description = COALESCE(EXCLUDED.description, strategies.description),
         check_status = 'unchecked', check_message = NULL, check_detail = NULL, updated_at = NOW()`,
      [name, source, digest, existing.rows[0] ? existing.rows[0].origin : origin, description || docstring(source), actor]
    );
    await db.query('INSERT INTO strategy_versions (name, sha, source, created_by) VALUES ($1, $2, $3, $4)', [name, digest, source, actor]);
    writeFile(name, source);
    return { name, sha: digest, changed: true, created: !existing.rows[0] };
  }

  // Copies a template or one of the main bot's files into the library.
  async function importFrom(kind, name, actor) {
    const dir = kind === 'template' ? TEMPLATES_DIR : config.bots.mainStrategiesDir;
    const hit = readDirStrategies(dir, kind).find((s) => s.name === name);
    if (!hit) throw notFound(`${name} is not a ${kind === 'template' ? 'template' : 'main bot strategy file'}`);
    const exists = await db.query('SELECT 1 FROM strategies WHERE name = $1', [name]);
    if (exists.rows[0]) throw conflict(`${name} is already in the library`);
    const source = fs.readFileSync(path.join(dir, hit.file), 'utf8');
    if (strategyClasses(source).length !== 1) throw badRequest(`${hit.file} defines several strategies; copy it by hand`);
    return save(name, source, { actor, origin: kind === 'template' ? 'template' : 'main bot file', description: hit.description });
  }

  async function remove(name) {
    const s = await get(name);
    const used = await db.query('SELECT name FROM bots WHERE strategy = $1', [name]);
    if (used.rows.length) throw conflict(`${name} is used by ${used.rows.map((b) => b.name).join(', ')}; switch those bots first`);
    await db.query('DELETE FROM strategies WHERE name = $1', [name]);
    // Keep the file in a trash folder rather than deleting it.
    const trash = path.join(config.bots.dir, 'trash');
    fs.mkdirSync(trash, { recursive: true });
    const file = path.join(libDir, `${name}.py`);
    if (fs.existsSync(file)) fs.renameSync(file, path.join(trash, `${name}-${Date.now()}.py`));
    return s;
  }

  // Static rules, load through Freqtrade, and a run on sample candles, in a sandboxed unit.
  async function check(name) {
    const s = await get(name);
    writeFile(name, s.source);
    const out = await sysd.run({
      unit: `ts-check-${name.toLowerCase().replace(/_/g, '-')}-${Date.now().toString(36)}`,
      cwd: config.bots.dir,
      argv: [config.bots.python, path.join(TOOLS_DIR, 'strategy_check.py'), libDir, name],
      memoryMax: '600M',
      runtimeMaxSec: 180,
    });
    const line = out.stdout.split('\n').find((l) => l.startsWith('STRATEGY_CHECK '));
    let result;
    try {
      result = JSON.parse(line.slice('STRATEGY_CHECK '.length));
    } catch (e) {
      result = { ok: false, message: `the check did not finish: ${(out.stderr || out.stdout).trim().split('\n').slice(-3).join(' ').slice(0, 300) || `exit ${out.code}`}`, errors: [], warnings: [] };
    }
    await db.query(
      `UPDATE strategies SET check_status = $2, check_message = $3, check_detail = $4, checked_at = NOW(),
              timeframe = COALESCE($5, timeframe), can_short = COALESCE($6, can_short)
       WHERE name = $1 AND sha = $7`,
      [name, result.ok ? 'ok' : 'failed', String(result.message || '').slice(0, 500), JSON.stringify(result), result.timeframe || null, result.can_short ?? null, s.sha]
    );
    return result;
  }

  // Where a strategy can be loaded from: the library, or the main bot's folder.
  async function locate(name) {
    const r = await db.query('SELECT sha, check_status, timeframe FROM strategies WHERE name = $1', [name]);
    if (r.rows[0]) return { dir: libDir, sha: r.rows[0].sha, checkStatus: r.rows[0].check_status, timeframe: r.rows[0].timeframe, inLibrary: true };
    const main = readDirStrategies(config.bots.mainStrategiesDir, 'main').find((s) => s.name === name);
    if (main) return { dir: config.bots.mainStrategiesDir, sha: null, checkStatus: 'unchecked', timeframe: null, inLibrary: false };
    return null;
  }

  function templateSource(name) {
    const hit = readDirStrategies(TEMPLATES_DIR, 'template').find((s) => s.name === name);
    return hit ? fs.readFileSync(path.join(TEMPLATES_DIR, hit.file), 'utf8') : null;
  }

  return { libDir, list, get, versions, version, save, importFrom, remove, check, locate, syncFiles, templateSource, strategyClasses };
}

module.exports = { createStrategies, strategyClasses, sha };
