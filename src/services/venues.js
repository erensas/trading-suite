// Trading venues (trade_db.trading_venues, migration 010): crypto exchange accounts used
// through Freqtrade / ccxt, and Alpaca's paper-trading API for stocks. The suite stores the
// venue, writes its API keys to ~/.openclaw/credentials/venues/<id>.env (0600, never
// returned), and tests the connection: exchanges in a sandboxed unit (tools/venue_tool.py,
// public markets and ticker, then the balance when keys are set), Alpaca over its REST API.
// Managed bots can take a venue's keys when they go live. Nothing here places orders.
const fs = require('fs');
const path = require('path');
const { badRequest, notFound, onDuplicate } = require('../http/errors');
const { readEnvFile, writeEnvFile } = require('./bots');

const ROOT = path.join(__dirname, '..', '..');
const ALPACA = { paper: 'https://paper-api.alpaca.markets' };
// Used until Freqtrade's own list has been read once.
const FALLBACK_EXCHANGES = ['binance', 'binanceusdm', 'bybit', 'okx', 'kraken', 'krakenfutures', 'kucoin', 'gate', 'bitget', 'htx', 'bingx', 'hyperliquid'].map((id) => ({ id, name: id, supported: true, dex: id === 'hyperliquid', modes: ['spot'] }));
const KEY = /^[\x21-\x7e]{8,256}$/;

function createVenues({ db, sysd, config, log, httpFetch = (...a) => fetch(...a) }) {
  const dir = config.bots.venueCredentialsDir;
  let exchangeCache = null;

  // Freqtrade's exchange list, read once a day in a sandboxed unit.
  async function exchanges() {
    if (exchangeCache && Date.now() - exchangeCache.at < 86400000) return exchangeCache.list;
    try {
      const out = await sysd.run({ unit: `ts-venues-${Date.now().toString(36)}`, cwd: config.bots.dir, argv: [config.bots.python, path.join(ROOT, 'tools', 'venue_tool.py'), 'exchanges'], memoryMax: '500M', runtimeMaxSec: 120 });
      const line = out.stdout.split('\n').find((l) => l.startsWith('VENUE '));
      const list = JSON.parse(line.slice(6)).exchanges;
      if (!Array.isArray(list) || !list.length) throw new Error('empty list');
      exchangeCache = { at: Date.now(), list };
      return list;
    } catch (e) {
      log.warn({ error: e.message }, 'exchange list not read; using the built-in one');
      return FALLBACK_EXCHANGES;
    }
  }
  // Exchanges Freqtrade can trade on (a bot, a backtest).
  async function isTradable(id) {
    const list = await exchanges();
    const hit = list.find((x) => x.id === id);
    return !!hit && (hit.supported || list === FALLBACK_EXCHANGES);
  }

  const file = (id) => path.join(dir, `${id}.env`);
  function keyStatus(id) {
    const env = readEnvFile(file(id));
    const key = env.VENUE_KEY || '';
    return { configured: !!(key && env.VENUE_SECRET), hint: key ? `…${key.slice(-4)}` : null, passphrase: !!env.VENUE_PASSWORD };
  }

  async function get(id) {
    const r = await db.query('SELECT * FROM trading_venues WHERE id = $1', [id]);
    if (!r.rows[0]) throw notFound('Venue not found');
    return r.rows[0];
  }

  async function list() {
    const r = await db.query('SELECT * FROM trading_venues ORDER BY kind, name');
    return r.rows.map((v) => ({ ...v, keys: keyStatus(v.id) }));
  }

  async function validate(body, before) {
    const v = { ...(before || {}), ...body };
    if (typeof v.name !== 'string' || !v.name.trim() || v.name.trim().length > 60) throw badRequest('name: 1 to 60 characters');
    if (!['cex', 'broker'].includes(v.kind)) throw badRequest('kind: cex or broker');
    if (!['spot', 'futures'].includes(v.trading_mode || 'spot')) throw badRequest('trading_mode: spot or futures');
    if (v.kind === 'broker') {
      if (v.exchange !== 'alpaca') throw badRequest('exchange: the only broker is alpaca');
      if ((v.mode || 'paper') !== 'paper') throw badRequest('mode: Alpaca is connected in paper mode only');
      v.mode = 'paper';
      v.trading_mode = 'spot';
    } else {
      if (!/^[a-z0-9]{2,30}$/.test(String(v.exchange || ''))) throw badRequest('exchange: a ccxt id such as binance or okx');
      const known = (await exchanges()).find((x) => x.id === v.exchange);
      if (!known) throw badRequest(`exchange: ${v.exchange} is not in Freqtrade's exchange list`);
      if (v.trading_mode === 'futures' && known.modes && !known.modes.includes('futures')) throw badRequest(`${known.name} has no futures in Freqtrade`);
      if (!['read_only', 'live'].includes(v.mode || 'read_only')) throw badRequest('mode: read_only or live (what the keys are for)');
      v.mode = v.mode || 'read_only';
    }
    if (v.notes !== undefined && v.notes !== null && String(v.notes).length > 300) throw badRequest('notes: at most 300 characters');
    return { name: v.name.trim(), kind: v.kind, exchange: v.exchange, trading_mode: v.trading_mode || 'spot', mode: v.mode, notes: v.notes || null, enabled: v.enabled !== false };
  }

  async function create(body, actor) {
    const v = await validate(body);
    const r = await db
      .query('INSERT INTO trading_venues (name, kind, exchange, trading_mode, mode, notes, enabled, created_by) VALUES ($1, $2, $3, $4, $5, $6, $7, $8) RETURNING *', [v.name, v.kind, v.exchange, v.trading_mode, v.mode, v.notes, v.enabled, actor])
      .catch(onDuplicate(`A venue named ${v.name} exists`));
    return { ...r.rows[0], keys: keyStatus(r.rows[0].id) };
  }

  async function update(id, body) {
    const before = await get(id);
    const v = await validate(body, before);
    const r = await db
      .query('UPDATE trading_venues SET name = $2, kind = $3, exchange = $4, trading_mode = $5, mode = $6, notes = $7, enabled = $8, updated_at = NOW() WHERE id = $1 RETURNING *', [id, v.name, v.kind, v.exchange, v.trading_mode, v.mode, v.notes, v.enabled])
      .catch(onDuplicate(`A venue named ${v.name} exists`));
    return { before, after: { ...r.rows[0], keys: keyStatus(id) } };
  }

  // The keys move to a trash folder next to them, like a deleted bot's.
  function trashKeys(id) {
    if (!fs.existsSync(file(id))) return;
    const trash = path.join(dir, 'trash');
    fs.mkdirSync(trash, { recursive: true, mode: 0o700 });
    fs.renameSync(file(id), path.join(trash, `${id}-${new Date().toISOString().replace(/[:.]/g, '-')}.env`));
  }

  async function remove(id) {
    const v = await get(id);
    await db.query('DELETE FROM trading_venues WHERE id = $1', [id]);
    trashKeys(id);
    return v;
  }

  async function setKeys(id, { key, secret, password }, actor) {
    const v = await get(id);
    if (!KEY.test(key || '') || !KEY.test(secret || '')) throw badRequest('key and secret must be 8-256 printable characters without spaces');
    if (password && !/^[\x21-\x7e]{1,128}$/.test(password)) throw badRequest('password must be printable characters without spaces');
    const env = { VENUE_KEY: key, VENUE_SECRET: secret };
    if (password) env.VENUE_PASSWORD = password;
    writeEnvFile(file(id), env, `API keys of trading venue ${v.name} (${v.exchange}), set by ${actor} ${new Date().toISOString()}`);
    await db.query('UPDATE trading_venues SET last_test_at = NULL, last_test_ok = NULL, last_test_message = NULL, last_test_detail = NULL, updated_at = NOW() WHERE id = $1', [id]);
    return keyStatus(id);
  }

  async function removeKeys(id) {
    await get(id);
    trashKeys(id);
  }

  // GET on the Alpaca paper API with the venue's keys; null when no keys are set.
  function alpacaCaller(v) {
    const env = readEnvFile(file(v.id));
    if (!env.VENUE_KEY || !env.VENUE_SECRET) return null;
    const headers = { 'APCA-API-KEY-ID': env.VENUE_KEY, 'APCA-API-SECRET-KEY': env.VENUE_SECRET, Accept: 'application/json' };
    return async (p) => {
      const res = await httpFetch(`${ALPACA.paper}${p}`, { headers, signal: AbortSignal.timeout(10000) });
      const body = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(`${p}: HTTP ${res.status}${body.message ? ` ${String(body.message).slice(0, 120)}` : ''}`);
      return body;
    };
  }

  // The paper account's equity, cash and positions (Portfolio tab). Read only.
  async function alpacaPortfolio(id) {
    const v = await get(id);
    if (v.kind !== 'broker' || v.exchange !== 'alpaca') throw badRequest(`${v.name} is not an Alpaca account`);
    const call = alpacaCaller(v);
    if (!call) throw badRequest(`${v.name} has no API keys`);
    const [acct, positions] = await Promise.all([call('/v2/account'), call('/v2/positions')]);
    return {
      currency: acct.currency || 'USD',
      equity: Number(acct.equity),
      cash: Number(acct.cash),
      positions: (positions || []).map((p) => ({
        symbol: p.symbol, quantity: Number(p.qty), price: Number(p.current_price), value: Number(p.market_value),
        cost_basis: Number(p.cost_basis), pnl: Number(p.unrealized_pl), asset_class: p.asset_class,
      })),
    };
  }

  async function testAlpaca(v) {
    const call = alpacaCaller(v);
    if (!call) return { ok: false, message: 'set the API key and secret of the paper account first' };
    try {
      const [acct, positions] = await Promise.all([call('/v2/account'), call('/v2/positions')]);
      const account = { status: acct.status, currency: acct.currency, equity: Number(acct.equity), buying_power: Number(acct.buying_power), trading_blocked: !!acct.trading_blocked, positions: positions.length };
      return { ok: acct.status === 'ACTIVE' && !acct.trading_blocked, message: `paper account ${acct.status}, equity ${account.equity} ${acct.currency}, ${positions.length} positions`, account };
    } catch (e) {
      return { ok: false, message: e.message };
    }
  }

  async function test(id) {
    const v = await get(id);
    let result;
    if (v.kind === 'broker') result = await testAlpaca(v);
    else {
      const out = await sysd.run({
        unit: `ts-venue-${id}-${Date.now().toString(36)}`,
        cwd: config.bots.dir,
        argv: [config.bots.python, path.join(ROOT, 'tools', 'venue_tool.py'), 'test', v.exchange, fs.existsSync(file(id)) ? file(id) : '-', v.trading_mode],
        memoryMax: '500M',
        runtimeMaxSec: 90,
      });
      const line = out.stdout.split('\n').find((l) => l.startsWith('VENUE '));
      try {
        result = JSON.parse(line.slice(6));
      } catch (e) {
        result = { ok: false, message: `the test did not finish (exit ${out.code})` };
      }
    }
    await db.query('UPDATE trading_venues SET last_test_at = NOW(), last_test_ok = $2, last_test_message = $3, last_test_detail = $4 WHERE id = $1', [id, !!result.ok, String(result.message || '').slice(0, 500), JSON.stringify(result)]);
    return result;
  }

  // For a managed bot going live: the venue's keys in Freqtrade's variable names.
  async function freqtradeKeys(id) {
    const v = await get(id);
    if (v.kind !== 'cex') throw badRequest(`${v.name} is not a crypto exchange`);
    const env = readEnvFile(file(id));
    if (!env.VENUE_KEY || !env.VENUE_SECRET) throw badRequest(`${v.name} has no API keys`);
    return { venue: v, key: env.VENUE_KEY, secret: env.VENUE_SECRET, password: env.VENUE_PASSWORD || null };
  }

  // The Web3 engine as a DEX venue (read-only): its heartbeat and the pools tracked per network.
  async function dex() {
    const [hb, pools] = await Promise.all([
      db.query("SELECT mode, state, detail, last_seen, EXTRACT(EPOCH FROM (NOW() - last_seen)) AS age FROM engine_status WHERE engine = 'web3-dex-bot'").catch(() => ({ rows: [] })),
      // The network is on the registry row, on the pool's source, or the prefix of a
      // GeckoTerminal provider symbol ("eth:0x…").
      db.query(`SELECT COALESCE(r.network,
                         (SELECT COALESCE(l.network, NULLIF(split_part(l.provider_symbol, ':', 1), l.provider_symbol))
                          FROM instrument_listings l WHERE l.symbol = r.symbol ORDER BY l.priority LIMIT 1), 'unknown') AS network,
                       count(*)::int AS pools, count(*) FILTER (WHERE r.is_active IS NOT FALSE)::int AS active
                FROM instrument_registry r WHERE r.category = 'DEX' GROUP BY 1 ORDER BY 2 DESC`),
    ]);
    const e = hb.rows[0];
    return { engine: e ? { mode: e.mode, state: Number(e.age) > 180 ? 'OFFLINE' : e.state, last_seen: e.last_seen, detail: e.detail } : null, networks: pools.rows };
  }

  return { exchanges, isTradable, list, get, create, update, remove, setKeys, removeKeys, test, freqtradeKeys, dex, keyStatus, alpacaPortfolio };
}

module.exports = { createVenues };
