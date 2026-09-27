// Backtests (trade_db.backtests): queued from the UI, run one at a time as sandboxed
// transient units (systemd-run --user, memory and time limits, no new privileges):
//   1. freqtrade download-data for the pairs and timeframe (only what is missing),
//   2. freqtrade backtesting with the strategy from the library or the main bot's folder,
//   3. tools/bt_result.py reads the result archive; the summary goes into the table.
const fs = require('fs');
const path = require('path');
const { z } = require('zod');
const { badRequest, notFound } = require('../http/errors');
const { TIMEFRAMES } = require('../../lib/providers');

const ROOT = path.join(__dirname, '..', '..');
const TF_MINUTES = { '1m': 1, '5m': 5, '15m': 15, '1h': 60, '4h': 240, '1d': 1440 };
const EXCHANGES = ['binance', 'bybit', 'okx', 'kraken', 'kucoin', 'gate', 'bitget', 'htx'];

const PAIR = /^[A-Z0-9]{1,20}\/[A-Z0-9]{1,12}(:[A-Z0-9]{1,12})?$/;
const paramsSchema = z.object({
  strategy: z.string().regex(/^[A-Za-z_][A-Za-z0-9_]{2,60}$/, 'strategy must be a class name'),
  pairs: z.array(z.string().trim().toUpperCase().regex(PAIR, 'pairs look like BTC/USDT (or BTC/USDT:USDT for futures)')).min(1, 'at least one pair').max(20, 'at most 20 pairs'),
  timeframe: z.enum(TIMEFRAMES).nullish(),
  days: z.coerce.number().int().min(3).max(730).default(90),
  exchange: z.enum(EXCHANGES).default('binance'),
  trading_mode: z.enum(['spot', 'futures']).default('spot'),
  stake_amount: z.coerce.number().positive().max(1e7).default(100),
  max_open_trades: z.coerce.number().int().min(1).max(50).default(3),
  wallet: z.coerce.number().positive().max(1e9).default(1000),
  fee: z.coerce.number().min(0).max(0.01).nullish(),
});

const dayStamp = (d) => d.toISOString().slice(0, 10).replace(/-/g, '');
// The last lines of a run's output, without progress bars and terminal colours.
const tail = (text, n = 40) =>
  String(text || '')
    .replace(/\x1b\[[0-9;]*m/g, '')
    .split('\n')
    .filter((l) => l.trim() && !/━|Downloading|Timeframe\s/.test(l))
    .slice(-n)
    .join('\n');

function createBacktests({ db, sysd, strategies, config, log }) {
  const baseDir = path.join(config.bots.dir, 'backtests');
  const userdir = path.join(config.bots.dir, 'userdir');
  let running = false;
  let currentId = null;

  function parse(input) {
    const r = paramsSchema.safeParse(input);
    if (!r.success) {
      const i = r.error.issues[0];
      throw badRequest(`${i.path.join('.') || 'params'}: ${i.message}`);
    }
    return r.data;
  }

  async function create(body, actor) {
    const params = parse(body);
    const loc = await strategies.locate(params.strategy);
    if (!loc) throw notFound(`Strategy ${params.strategy} is neither in the library nor in the main bot's folder`);
    if (loc.inLibrary && loc.checkStatus === 'failed') throw badRequest(`${params.strategy} failed its last check; fix it first`);
    if (params.trading_mode === 'futures') params.pairs = params.pairs.map((p) => (p.includes(':') ? p : `${p}:${p.split('/')[1]}`));
    const r = await db.query('INSERT INTO backtests (strategy, strategy_sha, params, created_by) VALUES ($1, $2, $3, $4) RETURNING id, status, created_at', [
      params.strategy,
      loc.sha,
      JSON.stringify(params),
      actor,
    ]);
    if (config.bots.worker) setImmediate(() => drain().catch((e) => log.warn({ error: e.message }, 'backtest queue failed')));
    return { ...r.rows[0], params };
  }

  async function list({ strategy, limit = 50 } = {}) {
    const r = await db.query(
      `SELECT id, strategy, strategy_sha, params, status, summary, error, created_by, created_at, started_at, finished_at
       FROM backtests ${strategy ? 'WHERE strategy = $2' : ''} ORDER BY id DESC LIMIT $1`,
      strategy ? [limit, strategy] : [limit]
    );
    return r.rows;
  }

  async function get(id) {
    const r = await db.query('SELECT * FROM backtests WHERE id = $1', [id]);
    if (!r.rows[0]) throw notFound('Backtest not found');
    return r.rows[0];
  }

  async function cancel(id) {
    const b = await get(id);
    if (b.status === 'queued') await db.query("UPDATE backtests SET status = 'cancelled', finished_at = NOW() WHERE id = $1", [id]);
    else if (b.status === 'running') {
      await db.query("UPDATE backtests SET status = 'cancelled', error = 'cancelled', finished_at = NOW() WHERE id = $1 AND status = 'running'", [id]);
      await Promise.all(STEPS.map((s) => sysd.stop(`ts-${s}-${id}.service`).catch(() => {})));
    }
    else throw badRequest(`Backtest ${id} is ${b.status}`);
  }

  const STEPS = ['userdir', 'download', 'backtest', 'btresult'];

  // Runs marked running whose units are gone were cut off by a restart of the suite (a run
  // whose unit still works after a restart is marked once the unit has finished).
  async function recover() {
    const r = await db.query("SELECT id FROM backtests WHERE status = 'running'");
    for (const { id } of r.rows) {
      if (id === currentId) continue;
      const states = await Promise.all(STEPS.map((s) => sysd.unitState(`ts-${s}-${id}.service`).catch(() => ({ active: false }))));
      if (states.some((u) => u.active)) continue;
      await db.query("UPDATE backtests SET status = 'failed', error = 'interrupted by a trading-suite restart', finished_at = NOW() WHERE id = $1 AND status = 'running'", [id]);
    }
  }

  function writeConfig(dir, p, tf) {
    const cfg = {
      max_open_trades: p.max_open_trades,
      stake_currency: p.pairs[0].split('/')[1].split(':')[0],
      stake_amount: p.stake_amount,
      tradable_balance_ratio: 0.99,
      dry_run: true,
      dry_run_wallet: p.wallet,
      timeframe: tf,
      trading_mode: p.trading_mode,
      margin_mode: p.trading_mode === 'futures' ? 'isolated' : '',
      exchange: { name: p.exchange, pair_whitelist: p.pairs, pair_blacklist: [] },
      pairlists: [{ method: 'StaticPairList' }],
      entry_pricing: { price_side: 'same', use_order_book: false, price_last_balance: 0.0 },
      exit_pricing: { price_side: 'same', use_order_book: false },
      dataformat_ohlcv: 'feather',
    };
    if (p.fee !== null && p.fee !== undefined) cfg.fee = p.fee;
    fs.writeFileSync(path.join(dir, 'config.json'), JSON.stringify(cfg, null, 2));
  }

  async function runOne(b) {
    const p = b.params;
    const dir = path.join(baseDir, String(b.id));
    fs.mkdirSync(dir, { recursive: true });
    fs.mkdirSync(userdir, { recursive: true });
    const loc = await strategies.locate(p.strategy);
    if (!loc) throw new Error(`strategy ${p.strategy} no longer exists`);
    const tf = p.timeframe || loc.timeframe || '15m';
    writeConfig(dir, p, tf);
    const datadir = path.join(config.bots.dir, 'data', p.exchange);
    const start = new Date(Date.now() - p.days * 86400000);
    // Extra history so indicators with long look-backs are warmed up at the start.
    const warmupDays = Math.ceil((500 * TF_MINUTES[tf]) / 1440) + 1;
    const dlStart = new Date(start.getTime() - warmupDays * 86400000);
    const ft = config.bots.freqtradeBin;
    const logs = [];

    if (!fs.existsSync(path.join(userdir, 'backtest_results'))) {
      await sysd.run({ unit: `ts-userdir-${b.id}`, cwd: config.bots.dir, argv: [ft, 'create-userdir', '--userdir', userdir], memoryMax: '400M', runtimeMaxSec: 120 });
    }
    const dl = await sysd.run({
      unit: `ts-download-${b.id}`,
      cwd: config.bots.dir,
      argv: [ft, 'download-data', '--userdir', userdir, '--exchange', p.exchange, '--pairs', ...p.pairs, '--timeframes', tf, '--timerange', `${dayStamp(dlStart)}-`, '--datadir', datadir, '--trading-mode', p.trading_mode, '--data-format-ohlcv', 'feather'],
      memoryMax: config.bots.backtestMemoryMax,
      runtimeMaxSec: 900,
    });
    logs.push(tail(dl.stdout + dl.stderr, 15));
    if (dl.code !== 0) throw Object.assign(new Error(`data download failed (exit ${dl.code})`), { logs });

    const bt = await sysd.run({
      unit: `ts-backtest-${b.id}`,
      cwd: dir,
      argv: [ft, 'backtesting', '--userdir', userdir, '--config', path.join(dir, 'config.json'), '--strategy', p.strategy, '--strategy-path', loc.dir,
        '--datadir', datadir, '--timerange', `${dayStamp(start)}-`, '--export', 'trades', '--export-directory', dir, '--cache', 'none', '--data-format-ohlcv', 'feather'],
      memoryMax: config.bots.backtestMemoryMax,
      runtimeMaxSec: 1800,
    });
    logs.push(tail(bt.stdout + bt.stderr, 25));
    if (bt.code !== 0) throw Object.assign(new Error(`backtesting failed (exit ${bt.code})`), { logs });

    const res = await sysd.run({ unit: `ts-btresult-${b.id}`, cwd: dir, argv: [config.bots.python, path.join(ROOT, 'tools', 'bt_result.py'), dir, '1000'], memoryMax: '400M', runtimeMaxSec: 120 });
    const line = res.stdout.split('\n').find((l) => l.startsWith('BT_RESULT '));
    if (!line) throw Object.assign(new Error('no result was written'), { logs: [...logs, tail(res.stdout + res.stderr, 10)] });
    const out = JSON.parse(line.slice('BT_RESULT '.length));
    if (out.error) throw Object.assign(new Error(out.error), { logs });
    out.summary.timeframe = tf;
    out.summary.trade_count_stored = out.trades.length;
    out.summary.exit_reasons = out.exit_reasons;
    return { out, logs };
  }

  async function drain() {
    if (running) return;
    running = true;
    try {
      for (;;) {
        // Claimed in one statement, so two suite processes never run the same backtest.
        const r = await db.query(
          `UPDATE backtests SET status = 'running', started_at = NOW()
           WHERE id = (SELECT id FROM backtests WHERE status = 'queued' ORDER BY id LIMIT 1 FOR UPDATE SKIP LOCKED) RETURNING *`
        );
        const b = r.rows[0];
        if (!b) break;
        currentId = b.id;
        try {
          const { out, logs } = await runOne(b);
          await db.query(
            `UPDATE backtests SET status = 'done', summary = $2, per_pair = $3, trades = $4, daily = $5, log_tail = $6, finished_at = NOW() WHERE id = $1 AND status = 'running'`,
            [b.id, JSON.stringify(out.summary), JSON.stringify(out.per_pair), JSON.stringify(out.trades), JSON.stringify(out.daily), logs.join('\n---\n').slice(-8000)]
          );
          log.info({ backtest: b.id, strategy: b.strategy, trades: out.summary.total_trades, profit: out.summary.profit_total }, 'backtest done');
        } catch (e) {
          const now = (await db.query('SELECT status FROM backtests WHERE id = $1', [b.id])).rows[0];
          await db.query("UPDATE backtests SET status = 'failed', error = $2, log_tail = $3, finished_at = NOW() WHERE id = $1 AND status = 'running'", [
            b.id,
            e.message.slice(0, 500),
            (e.logs || []).join('\n---\n').slice(-8000),
          ]);
          if (!now || now.status === 'running') log.warn({ backtest: b.id, error: e.message }, 'backtest failed');
        }
        currentId = null;
      }
    } finally {
      running = false;
    }
  }

  return { create, list, get, cancel, drain, recover, running: () => currentId, EXCHANGES };
}

module.exports = { createBacktests, paramsSchema };
