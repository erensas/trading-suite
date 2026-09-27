// Trading bots (trade_db.bots, db/migrations/007): the main Freqtrade bot (system unit),
// the Web3 DEX bot (read-only) and managed Freqtrade bots that the suite creates and runs as
// user units freqtrade-bot@<name> (systemd/freqtrade-bot@.service), each with its own
// config, SQLite trade database, API port and generated API credentials.
//
// Everything a bot does goes through its REST API (start, stop, pause, reload_config) or,
// for managed bots, through systemctl --user. Going live is only possible for a managed bot
// that passes every check in liveChecks() and is confirmed by typing "LIVE <name>".
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { z } = require('zod');
const { createFreqtradeClient } = require('./freqtrade');
const { availableMemoryMb } = require('./sysd');
const { badRequest, notFound, conflict, ApiError } = require('../http/errors');
const { UNDEFINED_TABLE } = require('../db');
const { TIMEFRAMES } = require('../../lib/providers');

const NAME = /^[a-z0-9][a-z0-9-]{1,29}$/;
const PAIR = /^[A-Z0-9]{1,20}\/[A-Z0-9]{1,12}(:[A-Z0-9]{1,12})?$/;

const createSchema = z.object({
  name: z.string().trim().toLowerCase().regex(NAME, 'name: 2-30 characters, lowercase letters, digits and dashes'),
  strategy: z.string().regex(/^[A-Za-z_][A-Za-z0-9_]{2,60}$/),
  exchange: z.string().trim().toLowerCase().regex(/^[a-z0-9]{2,30}$/, 'exchange: a ccxt id such as binance').default('binance'),
  trading_mode: z.enum(['spot', 'futures']).default('spot'),
  pairs: z.array(z.string().trim().toUpperCase().regex(PAIR, 'pairs look like BTC/USDT')).min(1).max(30),
  timeframe: z.enum(TIMEFRAMES).nullish(),
  stake_amount: z.coerce.number().positive().max(1e7).default(50),
  max_open_trades: z.coerce.number().int().min(1).max(20).default(3),
  dry_run_wallet: z.coerce.number().positive().max(1e9).default(1000),
  description: z.string().max(200).nullish(),
  start: z.boolean().default(true),
});
const editSchema = createSchema.pick({ pairs: true, timeframe: true, stake_amount: true, max_open_trades: true, dry_run_wallet: true, description: true }).partial();

function readEnvFile(file) {
  const out = {};
  try {
    for (const line of fs.readFileSync(file, 'utf8').split('\n')) {
      const m = line.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)=(.*)$/);
      if (m) out[m[1]] = m[2].trim().replace(/^['"]|['"]$/g, '');
    }
  } catch (e) {}
  return out;
}

function writeEnvFile(file, values, header) {
  const lines = [header ? `# ${header}` : null, ...Object.entries(values).map(([k, v]) => `${k}=${v}`)].filter(Boolean);
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  fs.writeFileSync(file, lines.join('\n') + '\n', { mode: 0o600 });
  fs.chmodSync(file, 0o600);
}

const randomSecret = (bytes = 24) => crypto.randomBytes(bytes).toString('base64url');

function createBots({ db, sysd, strategies, control, freqtrade, venues, config, log, freqtradeFactory = createFreqtradeClient }) {
  const B = config.bots;
  const clients = new Map();

  // ---- API clients ------------------------------------------------------------------------
  function clientFor(bot) {
    if (bot.engine !== 'freqtrade' || !bot.api_url) return null;
    const hit = clients.get(bot.name);
    if (hit && hit.url === bot.api_url) return hit.client;
    // The main bot is the suite's own Freqtrade client (config.freqtrade).
    if (bot.name === 'main') return freqtrade;
    let client;
    {
      const env = readEnvFile(bot.credentials_file);
      client = freqtradeFactory({ url: bot.api_url, user: env.FREQTRADE__API_SERVER__USERNAME, pass: env.FREQTRADE__API_SERVER__PASSWORD, credentialsFile: '/nonexistent' });
    }
    clients.set(bot.name, { url: bot.api_url, client });
    return client;
  }

  const within = (p, ms) => Promise.race([p, new Promise((_, rej) => setTimeout(() => rej(new Error('timeout')), ms))]);

  // Before migration 007 there is only the main bot.
  const MAIN_ONLY = [{ name: 'main', engine: 'freqtrade', managed: false, unit: 'freqtrade.service', api_url: config.freqtrade.url, strategy: null, dry_run: true, legacy: true }];
  async function rows() {
    try {
      return (await db.query('SELECT * FROM bots ORDER BY managed, name')).rows;
    } catch (e) {
      if (e.code === UNDEFINED_TABLE) return MAIN_ONLY;
      throw e;
    }
  }

  async function getRow(name) {
    const r = await db.query('SELECT * FROM bots WHERE name = $1', [name]);
    if (!r.rows[0]) throw notFound(`No bot named ${name}`);
    return r.rows[0];
  }

  // The settings the UI shows, from the config file (never the whole file: the main bot's
  // may hold secrets).
  function configSummary(bot) {
    try {
      const c = JSON.parse(fs.readFileSync(bot.config_path, 'utf8'));
      return {
        pairs: (c.exchange && c.exchange.pair_whitelist) || [],
        pairlists: (c.pairlists || []).map((p) => p.method),
        stake_amount: c.stake_amount,
        stake_currency: c.stake_currency,
        max_open_trades: c.max_open_trades,
        dry_run_wallet: c.dry_run_wallet,
        timeframe: c.timeframe || null,
      };
    } catch (e) {
      return null;
    }
  }

  // Live view of one bot: API state, open trades, profit; unit state for managed bots.
  async function status(bot) {
    const out = { ...bot, credentials_file: undefined, api: null, unit_state: null, open_trades: [], profit: null, error: null };
    if (bot.config_path) out.config = configSummary(bot);
    if (bot.managed) out.unit_state = await sysd.unitState(bot.unit).catch((e) => ({ state: 'unknown', error: e.message }));
    if (bot.engine === 'web3') {
      const r = await db.query('SELECT mode, state, detail, last_seen, EXTRACT(EPOCH FROM (NOW() - last_seen)) AS age FROM engine_status WHERE engine = $1', ['web3-dex-bot']).catch(() => ({ rows: [] }));
      const e = r.rows[0];
      out.api = e ? { state: Number(e.age) > 180 ? 'offline' : String(e.state).toLowerCase(), dry_run: e.mode !== 'LIVE', last_seen: e.last_seen, detail: e.detail } : { state: 'not reporting' };
      out.dry_run = e ? e.mode !== 'LIVE' : true;
      return out;
    }
    const client = clientFor(bot);
    if (!client || (bot.managed && out.unit_state && !out.unit_state.active)) {
      out.api = { state: bot.managed ? 'process stopped' : 'unreachable' };
      return out;
    }
    try {
      const [cfg, trades, profit, count] = await within(
        Promise.all([client.api('GET', '/show_config'), client.api('GET', '/status').catch(() => []), client.api('GET', '/profit').catch(() => null), client.api('GET', '/count').catch(() => null)]),
        6000
      );
      out.api = {
        state: cfg.state, strategy: cfg.strategy, dry_run: cfg.dry_run, timeframe: cfg.timeframe, exchange: cfg.exchange, trading_mode: cfg.trading_mode || 'spot',
        stake_currency: cfg.stake_currency, stake_amount: cfg.stake_amount, max_open_trades: cfg.max_open_trades, stoploss: cfg.stoploss,
        whitelist_count: undefined, bot_name: cfg.bot_name, version: cfg.version, available_capital: cfg.available_capital,
      };
      out.open_trades = (trades || []).map((t) => ({ id: t.trade_id, pair: t.pair, profit_pct: t.profit_pct, profit_abs: t.profit_abs, open_date: t.open_date, is_short: !!t.is_short }));
      out.profit = profit && {
        closed: profit.profit_closed_coin, all: profit.profit_all_coin, closed_pct: profit.profit_closed_percent, trades: profit.trade_count, closed_trades: profit.closed_trade_count,
        winrate: profit.winrate, max_drawdown: profit.max_drawdown, first_trade: profit.first_trade_date,
      };
      out.count = count;
      if (cfg.strategy && cfg.strategy !== bot.strategy) {
        // The bot runs something else than we recorded (changed in FreqUI or by hand).
        await db.query('UPDATE bots SET strategy = $2, updated_at = NOW() WHERE name = $1', [bot.name, cfg.strategy]);
        out.strategy = cfg.strategy;
      }
      if (typeof cfg.dry_run === 'boolean' && cfg.dry_run !== bot.dry_run) out.mode_mismatch = true;
    } catch (e) {
      out.api = { state: 'unreachable' };
      out.error = e.message;
    }
    return out;
  }

  async function list() {
    return Promise.all((await rows()).map((b) => status(b)));
  }

  async function get(name) {
    const bot = await getRow(name);
    const [s, ev] = await Promise.all([status(bot), db.query('SELECT * FROM bot_events WHERE bot = $1 ORDER BY id DESC LIMIT 30', [name])]);
    return { ...s, events: ev.rows };
  }

  const event = (bot, actor, action, detail) => db.query('INSERT INTO bot_events (bot, actor, action, detail) VALUES ($1, $2, $3, $4)', [bot, actor, action, detail ? JSON.stringify(detail) : null]);

  // ---- config files ------------------------------------------------------------------------
  function readConfig(bot) {
    return JSON.parse(fs.readFileSync(bot.config_path, 'utf8'));
  }

  // Keeps a copy of the previous config, then writes the new one in place (the main bot's
  // folder is not writable for the suite, only the file itself).
  function writeConfig(bot, cfg) {
    const backups = path.join(B.dir, 'config-backups');
    fs.mkdirSync(backups, { recursive: true });
    const copy = path.join(backups, `${bot.name}-${new Date().toISOString().replace(/[:.]/g, '-')}.json`);
    fs.copyFileSync(bot.config_path, copy);
    fs.chmodSync(copy, 0o600);
    fs.writeFileSync(bot.config_path, JSON.stringify(cfg, null, 2) + '\n');
  }

  // The main unit may pin the strategy with --strategy, which beats the config file (and
  // survives reload_config). The running process counts: after the drop-in that removes
  // it is installed, the bot has to be restarted once.
  async function mainPinsStrategy(bot) {
    const r = await sysd.exec('systemctl', ['show', '-p', 'ExecStart', '-p', 'MainPID', bot.unit]);
    const pid = (r.stdout.match(/^MainPID=(\d+)$/m) || [])[1];
    let cmdline = '';
    try {
      if (pid && pid !== '0') cmdline = fs.readFileSync(`/proc/${pid}/cmdline`, 'utf8').split('\0').join(' ');
    } catch (e) {}
    return /--strategy\b/.test(cmdline || r.stdout);
  }

  async function waitFor(client, predicate, timeoutMs = 60000) {
    const until = Date.now() + timeoutMs;
    let last = null;
    while (Date.now() < until) {
      try {
        last = await client.api('GET', '/show_config');
        if (predicate(last)) return last;
      } catch (e) {}
      await new Promise((r) => setTimeout(r, 2000));
    }
    return last;
  }

  // ---- actions -----------------------------------------------------------------------------
  async function assertNotHalted(what) {
    const ctl = await control.state().catch(() => ({ installed: false }));
    if (ctl.installed && ctl.halted) throw new ApiError(409, `Trading is halted (kill switch): ${what} is blocked until trading is resumed`, { code: 'halted' });
  }

  // start / stop / pause: the bot's trading loop (API). start_process / stop_process /
  // restart_process: the whole Freqtrade process of a managed bot (user unit).
  async function act(name, action, actor) {
    const bot = await getRow(name);
    if (bot.engine !== 'freqtrade') throw badRequest(`${name} is controlled by its own service; use the System view`);
    if (['start', 'start_process', 'restart_process'].includes(action)) await assertNotHalted(`starting ${name}`);
    if (action.endsWith('_process')) {
      if (!bot.managed) throw badRequest('The main bot process is a system service; restart it from the System view');
      const verb = action.split('_')[0];
      if (verb === 'start') await sysd.enable(bot.unit).catch(() => {});
      if (verb === 'stop') await sysd.disable(bot.unit).catch(() => {});
      await sysd[verb](bot.unit);
    } else {
      const client = clientFor(bot);
      const pathFor = { start: '/start', stop: '/stop', pause: '/pause', reload: '/reload_config' }[action];
      if (!pathFor) throw badRequest(`Unknown action ${action}`);
      await client.api('POST', pathFor);
    }
    await event(name, actor, action);
    return { ok: true };
  }

  // Kill switch. Every Freqtrade bot whose trading loop runs is paused through its API; the
  // pause is recorded as a 'kill_switch_pause' event, so resume starts exactly those bots
  // again (a bot someone had paused or stopped before stays that way). A managed bot that
  // cannot be paused is stopped (its process), so it cannot open trades either.
  const freqtradeRows = async () => (await rows()).filter((b) => b.engine === 'freqtrade');
  const processUp = async (bot) => !bot.managed || (await sysd.unitState(bot.unit)).active;
  const record = (bot, actor, action, detail) => (bot.legacy ? Promise.resolve() : event(bot.name, actor, action, detail).catch(() => {}));

  async function pauseOne(bot, reason) {
    if (!(await processUp(bot))) return 'not running';
    const client = clientFor(bot);
    try {
      const cfg = await within(client.api('GET', '/show_config'), 6000);
      const state = String(cfg.state || '').toLowerCase();
      if (state !== 'running') return `already ${state || 'not running'}`;
      await client.api('POST', '/pause');
      await record(bot, 'kill switch', 'kill_switch_pause', { reason });
      return bot.managed ? 'paused' : 'paused (open trades managed, no new entries)';
    } catch (e) {
      if (bot.managed) {
        await sysd.stop(bot.unit).catch(() => {});
        await record(bot, 'kill switch', 'kill_switch_stop', { reason, error: e.message });
        return `pause failed (${e.message}); process stopped`;
      }
      return `pause failed: ${e.message}; entries stay blocked by confirm_trade_entry`;
    }
  }

  async function pauseAll(reason) {
    const out = {};
    for (const bot of await freqtradeRows()) out[bot.name] = await pauseOne(bot, reason);
    log.warn({ reason, results: out }, 'bots paused by the kill switch');
    return out;
  }

  async function lastEvent(bot) {
    if (bot.legacy) return 'kill_switch_pause';
    const r = await db.query("SELECT action FROM bot_events WHERE bot = $1 AND action NOT IN ('edit', 'exchange_keys', 'exchange_keys_removed', 'capital_limit') ORDER BY id DESC LIMIT 1", [bot.name]);
    return r.rows[0] && r.rows[0].action;
  }

  async function startAll(actor = 'kill switch') {
    const out = {};
    for (const bot of await freqtradeRows()) {
      try {
        const last = await lastEvent(bot);
        if (last === 'kill_switch_stop') {
          await sysd.start(bot.unit);
          await record(bot, actor, 'resume_start_process');
          out[bot.name] = 'process started';
        } else if (last === 'kill_switch_pause') {
          if (!(await processUp(bot))) {
            out[bot.name] = 'not running';
            continue;
          }
          await clientFor(bot).api('POST', '/start');
          await record(bot, actor, 'resume_start');
          out[bot.name] = 'running';
        } else {
          out[bot.name] = 'left as it was (not paused by the kill switch)';
        }
      } catch (e) {
        out[bot.name] = `start failed: ${e.message}`;
      }
    }
    return out;
  }

  // Bots that report "running" while trading is halted (restarted, or started elsewhere).
  async function repauseRunning() {
    for (const bot of await freqtradeRows()) {
      try {
        if (!(await processUp(bot))) continue;
        const client = clientFor(bot);
        const cfg = await within(client.api('GET', '/show_config'), 6000);
        if (String(cfg.state).toLowerCase() === 'running') {
          await client.api('POST', '/pause');
          await record(bot, 'halt guard', 'kill_switch_pause', { reason: 'reported running while halted' });
          log.warn({ bot: bot.name }, 'trading halted: re-paused a running bot');
        }
      } catch (e) {
        log.debug({ bot: bot.name, error: e.message }, 'halt guard check failed');
      }
    }
  }

  // Switches a bot to another strategy: config file, then reload_config, then verify.
  async function setStrategy(name, strategy, actor) {
    const bot = await getRow(name);
    if (bot.engine !== 'freqtrade') throw badRequest(`${name} does not run Freqtrade strategies`);
    const loc = await strategies.locate(strategy);
    if (!loc) throw notFound(`Strategy ${strategy} is not in the library`);
    if (bot.managed && !loc.inLibrary) throw badRequest(`Managed bots use library strategies; copy ${strategy} into the library first`);
    if (loc.inLibrary && loc.checkStatus !== 'ok') throw badRequest(`${strategy} has not passed its check (${loc.checkStatus}); run the check first`);
    if (!bot.dry_run) throw badRequest(`${name} trades live; switch it back to dry-run before changing its strategy`);
    if (bot.name === 'main' && (await mainPinsStrategy(bot))) {
      throw badRequest('freqtrade.service runs with --strategy on its command line: install the drop-in systemd/freqtrade-strategy-from-config.conf and restart the bot once (see the trading-suite README)');
    }
    const cfg = readConfig(bot);
    const before = cfg.strategy;
    const pathBefore = cfg.strategy_path;
    cfg.strategy = strategy;
    // Library strategies load from the library; the main bot's own files from its default folder.
    if (loc.inLibrary) cfg.strategy_path = strategies.libDir;
    else delete cfg.strategy_path;
    writeConfig(bot, cfg);
    const client = clientFor(bot);
    let open = [];
    try {
      open = await client.api('GET', '/status');
    } catch (e) {}
    let now = null;
    if (!bot.managed || (await sysd.unitState(bot.unit)).active) {
      await client.api('POST', '/reload_config');
      now = await waitFor(client, (c) => c.strategy === strategy, 60000);
    }
    if (now && now.strategy !== strategy) {
      // Put the old config back so file and process agree.
      cfg.strategy = before;
      if (pathBefore) cfg.strategy_path = pathBefore;
      else delete cfg.strategy_path;
      writeConfig(bot, cfg);
      await client.api('POST', '/reload_config').catch(() => {});
      throw new ApiError(502, `${name} did not load ${strategy} (it reports ${now.strategy}); the previous config is back`, { code: 'reload_failed' });
    }
    await db.query('UPDATE bots SET strategy = $2, dry_run_since = NOW(), updated_at = NOW() WHERE name = $1', [name, strategy]);
    await event(name, actor, 'strategy', { from: before, to: strategy, open_trades: open.length });
    return { from: before, to: strategy, openTrades: open.length, running: !!now };
  }

  // ---- managed bots (phase D) ------------------------------------------------------------------
  const instanceDir = (name) => path.join(B.dir, 'instances', name);
  const credentialsFile = (name) => path.join(B.credentialsDir, `${name}.env`);

  async function freePort() {
    const used = new Set((await db.query('SELECT api_port FROM bots WHERE api_port IS NOT NULL')).rows.map((r) => r.api_port));
    for (let p = B.portBase; p < B.portBase + 50; p++) if (!used.has(p)) return p;
    throw conflict('No free API port for another bot');
  }

  function botConfig(name, p, port, strategy, tf) {
    const stake = p.pairs[0].split('/')[1].split(':')[0];
    const dir = instanceDir(name);
    const cfg = {
      bot_name: `ts-${name}`,
      max_open_trades: p.max_open_trades,
      stake_currency: stake,
      stake_amount: p.stake_amount,
      tradable_balance_ratio: 0.99,
      fiat_display_currency: 'USD',
      dry_run: true,
      dry_run_wallet: p.dry_run_wallet,
      cancel_open_orders_on_exit: false,
      trading_mode: p.trading_mode,
      margin_mode: p.trading_mode === 'futures' ? 'isolated' : '',
      strategy,
      strategy_path: strategies.libDir,
      db_url: `sqlite:///${path.join(dir, 'trades.dryrun.sqlite')}`,
      user_data_dir: path.join(dir, 'user_data'),
      datadir: path.join(B.dir, 'data', p.exchange),
      exchange: { name: p.exchange, key: '', secret: '', pair_whitelist: p.pairs, pair_blacklist: [] },
      pairlists: [{ method: 'StaticPairList' }],
      entry_pricing: { price_side: 'same', use_order_book: true, order_book_top: 1, price_last_balance: 0.0 },
      exit_pricing: { price_side: 'same', use_order_book: true, order_book_top: 1 },
      order_types: { entry: 'limit', exit: 'limit', emergency_exit: 'market', force_entry: 'market', force_exit: 'market', stoploss: 'market', stoploss_on_exchange: false },
      api_server: { enabled: true, listen_ip_address: '127.0.0.1', listen_port: port, verbosity: 'error', enable_openapi: false, CORS_origins: [] },
      internals: { process_throttle_secs: 5 },
      initial_state: 'running',
      force_entry_enable: false,
    };
    if (tf) cfg.timeframe = tf;
    return cfg;
  }

  async function create(body, actor) {
    const parsed = createSchema.safeParse(body);
    if (!parsed.success) {
      const i = parsed.error.issues[0];
      throw badRequest(`${i.path.join('.') || 'bot'}: ${i.message}`);
    }
    const p = parsed.data;
    if (['main', 'web3-dex-bot'].includes(p.name)) throw conflict(`${p.name} is reserved`);
    if (venues && !(await venues.isTradable(p.exchange))) throw badRequest(`exchange: Freqtrade does not trade on ${p.exchange}`);
    if ((await db.query('SELECT 1 FROM bots WHERE name = $1', [p.name])).rows[0]) throw conflict(`A bot named ${p.name} exists`);
    const managed = (await db.query('SELECT count(*)::int AS n FROM bots WHERE managed')).rows[0].n;
    if (managed >= B.maxManaged) throw conflict(`At most ${B.maxManaged} managed bots run on this host (memory); delete one first`);
    const loc = await strategies.locate(p.strategy);
    if (!loc || !loc.inLibrary) throw badRequest(`${p.strategy} is not in the library`);
    if (loc.checkStatus !== 'ok') throw badRequest(`${p.strategy} has not passed its check`);
    if (p.start) {
      const free = availableMemoryMb();
      if (free !== null && free < B.minFreeMemoryMb) throw conflict(`Only ${free} MB of memory is free; a bot needs about ${B.minFreeMemoryMb} MB. Create it without starting, or stop another bot`);
    }
    if (p.trading_mode === 'futures') p.pairs = p.pairs.map((x) => (x.includes(':') ? x : `${x}:${x.split('/')[1]}`));
    const port = await freePort();
    const dir = instanceDir(p.name);
    fs.mkdirSync(dir, { recursive: true });
    const setup = await sysd.run({ unit: `ts-userdir-${p.name}-${Date.now().toString(36)}`, cwd: B.dir, argv: [B.freqtradeBin, 'create-userdir', '--userdir', path.join(dir, 'user_data')], memoryMax: '400M', runtimeMaxSec: 120 });
    if (setup.code !== 0) throw new Error(`create-userdir failed: ${(setup.stderr || setup.stdout).trim().slice(-300)}`);
    const cfg = botConfig(p.name, p, port, p.strategy, p.timeframe);
    fs.writeFileSync(path.join(dir, 'config.json'), JSON.stringify(cfg, null, 2) + '\n', { mode: 0o640 });
    writeEnvFile(credentialsFile(p.name), {
      FREQTRADE__API_SERVER__USERNAME: `ts-${p.name}`,
      FREQTRADE__API_SERVER__PASSWORD: randomSecret(),
      FREQTRADE__API_SERVER__JWT_SECRET_KEY: randomSecret(32),
      FREQTRADE__API_SERVER__WS_TOKEN: randomSecret(),
    }, `API credentials of the managed bot ${p.name}, generated by trading-suite ${new Date().toISOString()}`);
    await db.query(
      `INSERT INTO bots (name, engine, managed, unit, api_url, api_port, config_path, credentials_file, description, exchange, trading_mode, strategy, dry_run, dry_run_since, created_by)
       VALUES ($1, 'freqtrade', TRUE, $2, $3, $4, $5, $6, $7, $8, $9, $10, TRUE, NOW(), $11)`,
      [p.name, `freqtrade-bot@${p.name}.service`, `http://127.0.0.1:${port}`, port, path.join(dir, 'config.json'), credentialsFile(p.name), p.description || null, p.exchange, p.trading_mode, p.strategy, actor]
    );
    await event(p.name, actor, 'create', { strategy: p.strategy, exchange: p.exchange, pairs: p.pairs, port });
    if (p.start) {
      const unit = `freqtrade-bot@${p.name}.service`;
      await sysd.enable(unit).catch(() => {});
      await sysd.start(unit);
      await event(p.name, actor, 'start_process');
    }
    return getRow(p.name);
  }

  async function edit(name, body, actor) {
    const bot = await getRow(name);
    if (!bot.managed) throw badRequest('Only managed bots are edited here; the main bot has its own config in the freqtrade repo');
    const parsed = editSchema.safeParse(body);
    if (!parsed.success) throw badRequest(parsed.error.issues[0].message);
    const p = parsed.data;
    const cfg = readConfig(bot);
    if (p.pairs) cfg.exchange.pair_whitelist = bot.trading_mode === 'futures' ? p.pairs.map((x) => (x.includes(':') ? x : `${x}:${x.split('/')[1]}`)) : p.pairs;
    if (p.timeframe !== undefined) {
      if (p.timeframe) cfg.timeframe = p.timeframe;
      else delete cfg.timeframe;
    }
    for (const k of ['stake_amount', 'max_open_trades', 'dry_run_wallet']) if (p[k] !== undefined) cfg[k] = p[k];
    writeConfig(bot, cfg);
    if (p.description !== undefined) await db.query('UPDATE bots SET description = $2, updated_at = NOW() WHERE name = $1', [name, p.description]);
    const running = (await sysd.unitState(bot.unit)).active;
    if (running) await clientFor(bot).api('POST', '/reload_config').catch(() => {});
    await event(name, actor, 'edit', p);
    return { reloaded: running };
  }

  async function remove(name, actor) {
    const bot = await getRow(name);
    if (!bot.managed) throw badRequest(`${name} is not a managed bot`);
    if (!bot.dry_run) throw badRequest(`${name} trades live; switch it to dry-run and close its positions first`);
    await sysd.stop(bot.unit).catch(() => {});
    await sysd.disable(bot.unit).catch(() => {});
    if (sysd.resetFailed) await sysd.resetFailed(bot.unit).catch(() => {});
    // Keep the instance (config, trade database, logs) in the trash folder.
    const trash = path.join(B.dir, 'trash');
    fs.mkdirSync(trash, { recursive: true });
    const stamp = new Date().toISOString().replace(/[:.]/g, '-');
    if (fs.existsSync(instanceDir(name))) fs.renameSync(instanceDir(name), path.join(trash, `${name}-${stamp}`));
    // The credentials go to a trash folder next to them (mode 0700), not into the bots tree.
    if (bot.credentials_file && fs.existsSync(bot.credentials_file)) {
      const credTrash = path.join(B.credentialsDir, 'trash');
      fs.mkdirSync(credTrash, { recursive: true, mode: 0o700 });
      fs.renameSync(bot.credentials_file, path.join(credTrash, `${name}-${stamp}.env`));
    }
    await db.query('DELETE FROM bots WHERE name = $1', [name]);
    clients.delete(name);
    await event(name, actor, 'delete', { kept_in: path.join(trash, `${name}-${stamp}`) });
    return { trashed: path.join(trash, `${name}-${stamp}`) };
  }

  async function journal(name, lines = 200) {
    const bot = await getRow(name);
    if (bot.engine !== 'freqtrade' && bot.engine !== 'web3') return [];
    return sysd.journal(bot.unit, { lines, system: !bot.managed });
  }

  // ---- going live (phase E) ------------------------------------------------------------------
  function exchangeKeys(bot) {
    const env = readEnvFile(bot.credentials_file);
    const key = env.FREQTRADE__EXCHANGE__KEY || '';
    return { configured: !!(key && env.FREQTRADE__EXCHANGE__SECRET), hint: key ? `…${key.slice(-4)}` : null };
  }

  // Stores exchange API keys in the bot's credentials file (0600). They are never returned.
  async function setExchangeKeys(name, { key, secret, password }, actor) {
    const bot = await getRow(name);
    if (!bot.managed) throw badRequest('Exchange keys are set for managed bots only');
    if (!/^[\x21-\x7e]{8,256}$/.test(key || '') || !/^[\x21-\x7e]{8,256}$/.test(secret || '')) throw badRequest('key and secret must be 8-256 printable characters without spaces');
    if (password && !/^[\x21-\x7e]{1,128}$/.test(password)) throw badRequest('password must be printable characters without spaces');
    const env = readEnvFile(bot.credentials_file);
    env.FREQTRADE__EXCHANGE__KEY = key;
    env.FREQTRADE__EXCHANGE__SECRET = secret;
    if (password) env.FREQTRADE__EXCHANGE__PASSWORD = password;
    else delete env.FREQTRADE__EXCHANGE__PASSWORD;
    writeEnvFile(bot.credentials_file, env, `Credentials of the managed bot ${name}; exchange keys set by ${actor} ${new Date().toISOString()}`);
    await event(name, actor, 'exchange_keys', { hint: `…${key.slice(-4)}` });
    return exchangeKeys(bot);
  }

  // A trading venue's keys (Settings -> Trading venues) for this bot.
  async function keysFromVenue(name, venueId, actor) {
    const bot = await getRow(name);
    const { venue, key, secret, password } = await venues.freqtradeKeys(venueId);
    if (venue.exchange !== bot.exchange) throw badRequest(`${venue.name} is ${venue.exchange}; ${name} trades on ${bot.exchange}`);
    if (venue.trading_mode !== bot.trading_mode) throw badRequest(`${venue.name} is set up for ${venue.trading_mode}; ${name} trades ${bot.trading_mode}`);
    const out = await setExchangeKeys(name, { key, secret, password }, actor);
    await event(name, actor, 'exchange_keys_from_venue', { venue: venue.name });
    return out;
  }

  async function removeExchangeKeys(name, actor) {
    const bot = await getRow(name);
    if (!bot.dry_run) throw badRequest(`${name} trades live; switch it to dry-run first`);
    const env = readEnvFile(bot.credentials_file);
    for (const k of ['FREQTRADE__EXCHANGE__KEY', 'FREQTRADE__EXCHANGE__SECRET', 'FREQTRADE__EXCHANGE__PASSWORD']) delete env[k];
    writeEnvFile(bot.credentials_file, env, `Credentials of the managed bot ${name}`);
    await event(name, actor, 'exchange_keys_removed');
  }

  async function setCapitalLimit(name, amount, actor) {
    const bot = await getRow(name);
    if (!bot.managed) throw badRequest('Capital limits apply to managed bots');
    const n = Number(amount);
    if (!(n > 0 && n <= 1e7)) throw badRequest('The capital limit must be a positive amount');
    await db.query('UPDATE bots SET capital_limit = $2, updated_at = NOW() WHERE name = $1', [name, n]);
    await event(name, actor, 'capital_limit', { amount: n });
  }

  // Every condition for going live, each with ok and a reason.
  async function liveChecks(name) {
    const bot = await getRow(name);
    const checks = [];
    const add = (id, ok, text) => checks.push({ id, ok: !!ok, text });
    add('managed', bot.managed, bot.managed ? 'Managed bot (own config, own trade database)' : 'Only managed bots can go live; the main bot stays in dry-run');
    if (!bot.managed) return { bot: name, ready: false, checks };
    const s = bot.strategy ? await db.query('SELECT sha, check_status FROM strategies WHERE name = $1', [bot.strategy]) : { rows: [] };
    const strat = s.rows[0];
    add('strategy_checked', strat && strat.check_status === 'ok', strat ? `Strategy ${bot.strategy}: check ${strat.check_status}` : `Strategy ${bot.strategy} is not in the library`);
    const bt = strat
      ? (await db.query("SELECT id, summary FROM backtests WHERE strategy = $1 AND strategy_sha = $2 AND status = 'done' ORDER BY id DESC LIMIT 1", [bot.strategy, strat.sha])).rows[0]
      : null;
    const btTrades = bt ? Number(bt.summary.total_trades) : 0;
    const btProfit = bt ? Number(bt.summary.profit_total) : null;
    add('backtest', bt && btTrades >= B.liveMinBacktestTrades && btProfit >= 0,
      bt ? `Backtest #${bt.id} of this version: ${btTrades} trades, ${(btProfit * 100).toFixed(2)}% (needs ≥ ${B.liveMinBacktestTrades} trades and no loss)` : 'No finished backtest of this strategy version');
    const days = bot.dry_run_since ? (Date.now() - new Date(bot.dry_run_since).getTime()) / 86400000 : 0;
    add('dry_run_days', days >= B.liveMinDryRunDays, `Dry-run with this strategy for ${days.toFixed(1)} days (needs ${B.liveMinDryRunDays})`);
    let closed = 0;
    try {
      const pr = await clientFor(bot).api('GET', '/profit');
      closed = Number(pr.closed_trade_count) || 0;
    } catch (e) {}
    add('dry_run_trades', closed >= B.liveMinDryRunTrades, `${closed} closed dry-run trades (needs ${B.liveMinDryRunTrades})`);
    const keys = exchangeKeys(bot);
    add('exchange_keys', keys.configured, keys.configured ? `Exchange API keys set (${keys.hint}); use trade-only keys without withdrawal rights` : 'No exchange API keys for this bot');
    let cfg = {};
    try {
      cfg = readConfig(bot);
    } catch (e) {}
    const exposure = Number(cfg.stake_amount) * Number(cfg.max_open_trades);
    add('capital_limit', bot.capital_limit && exposure <= Number(bot.capital_limit),
      bot.capital_limit ? `Capital limit ${Number(bot.capital_limit)} ${cfg.stake_currency || ''}; stake × max open trades = ${exposure}` : 'No capital limit set');
    const ctl = await control.state().catch(() => ({ installed: false }));
    add('not_halted', ctl.installed && !ctl.halted, ctl.installed ? (ctl.halted ? 'Trading is halted (kill switch)' : 'Kill switch: trading active') : 'Kill switch table missing');
    return { bot: name, ready: checks.every((c) => c.ok), checks };
  }

  async function goLive(name, confirmText, actor) {
    const bot = await getRow(name);
    if (!bot.dry_run) throw badRequest(`${name} already trades live`);
    if (confirmText !== `LIVE ${name}`) throw badRequest(`Type "LIVE ${name}" to confirm`);
    const { ready, checks } = await liveChecks(name);
    if (!ready) throw new ApiError(409, `Not every check passes: ${checks.filter((c) => !c.ok).map((c) => c.text).join('; ')}`, { code: 'live_checks_failed', details: checks });
    const cfg = readConfig(bot);
    cfg.dry_run = false;
    cfg.available_capital = Number(bot.capital_limit);
    cfg.db_url = `sqlite:///${path.join(instanceDir(name), 'trades.live.sqlite')}`;
    delete cfg.dry_run_wallet;
    writeConfig(bot, cfg);
    await sysd.restart(bot.unit);
    await db.query('UPDATE bots SET dry_run = FALSE, live_since = NOW(), live_approved_by = $2, updated_at = NOW() WHERE name = $1', [name, actor]);
    await event(name, actor, 'go_live', { capital_limit: Number(bot.capital_limit), strategy: bot.strategy, checks });
    log.warn({ bot: name, actor, capital: Number(bot.capital_limit) }, 'bot switched to LIVE trading');
    return { live: true };
  }

  async function goDryRun(name, actor) {
    const bot = await getRow(name);
    if (!bot.managed) throw badRequest(`${name} is not a managed bot`);
    const cfg = readConfig(bot);
    cfg.dry_run = true;
    cfg.dry_run_wallet = cfg.dry_run_wallet || 1000;
    delete cfg.available_capital;
    cfg.db_url = `sqlite:///${path.join(instanceDir(name), 'trades.dryrun.sqlite')}`;
    writeConfig(bot, cfg);
    if ((await sysd.unitState(bot.unit)).active) await sysd.restart(bot.unit);
    await db.query('UPDATE bots SET dry_run = TRUE, dry_run_since = NOW(), live_since = NULL, updated_at = NOW() WHERE name = $1', [name]);
    await event(name, actor, 'go_dry_run');
    return { live: false };
  }

  return {
    list, get, act, setStrategy, create, edit, remove, journal, pauseAll, startAll, repauseRunning,
    liveChecks, goLive, goDryRun, setExchangeKeys, keysFromVenue, removeExchangeKeys, exchangeKeys: async (n) => exchangeKeys(await getRow(n)), setCapitalLimit,
    clientFor, createSchema,
  };
}

module.exports = { createBots, readEnvFile, writeEnvFile };
