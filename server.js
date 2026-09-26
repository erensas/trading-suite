const express = require('express');
const { Pool } = require('pg');
const { exec } = require('child_process');
const fs = require('fs');
const path = require('path');
const os = require('os');
const { KINDS, TIMEFRAMES, ProviderError, adapterFor, validateBaseUrl } = require('./lib/providers');

const app = express();
const PORT = process.env.PORT || 18795;
const HOST = process.env.HOST || '127.0.0.1';

app.use(express.json({ limit: '64kb' }));
app.use(express.static(path.join(__dirname, 'public')));

// PostgreSQL pool for the dedicated trade database (Unix socket, peer auth).
const postgresPool = new Pool({
  database: process.env.PG_MAIN_DB || 'trade_db',
  user: process.env.DB_USER || process.env.PGUSER || 'openclaw',
  host: process.env.DB_HOST || process.env.PGHOST || '/var/run/postgresql',
  password: process.env.DB_PASSWORD || process.env.PGPASSWORD || '',
  port: parseInt(process.env.DB_PORT || process.env.PGPORT || '5432', 10),
});

postgresPool.on('error', (err) => {
  console.error('PostgreSQL pool error:', err.message);
});

const SUPERVISOR_LOG_PATH = '/home/openclaw/.openclaw/worktrees/web3-dex-bot/web3-dex-bot/supervisor/supervisor.log';
const SYSTEM_DASHBOARD_HEALTH = process.env.SYSTEM_DASHBOARD_HEALTH || 'http://127.0.0.1:18791/health';
const providerCtx = { freqtradeApi: (...args) => freqtradeApi(...args) };

const sendError = (res, err, fallbackStatus = 500) =>
  res.status(err.status || fallbackStatus).json({ success: false, error: err.message, unsupported: !!err.unsupported });

app.get(['/health', '/api/health'], (req, res) => {
  res.json({ status: 'ok', service: 'trading-suite', timestamp: new Date().toISOString() });
});

app.get(['/metrics', '/api/metrics'], async (req, res) => {
  try {
    const mem = process.memoryUsage();
    let dbStatus = 'ok';
    let totalLogs = 0;
    try {
      const dbRes = await postgresPool.query('SELECT count(*) FROM trade_logs');
      totalLogs = parseInt(dbRes.rows[0].count, 10);
    } catch (e) {
      dbStatus = 'error: ' + e.message;
    }

    const metricsData = {
      status: 'ok',
      service: 'trading-suite',
      timestamp: new Date().toISOString(),
      uptime_seconds: Math.floor(process.uptime()),
      memory: { rss_bytes: mem.rss, heapTotal_bytes: mem.heapTotal, heapUsed_bytes: mem.heapUsed, external_bytes: mem.external },
      database: {
        status: dbStatus,
        total_trade_logs: totalLogs,
        pool_total_count: postgresPool.totalCount,
        pool_idle_count: postgresPool.idleCount,
        pool_waiting_count: postgresPool.waitingCount,
      },
      settings,
      ticker_refresh: tickerRefreshState,
      multi_asset_cache_status: multiAssetCache.status || 'unknown',
    };

    if (req.headers.accept && req.headers.accept.includes('text/plain')) {
      let out = '# HELP trading_suite_uptime_seconds Process uptime in seconds\n';
      out += '# TYPE trading_suite_uptime_seconds counter\n';
      out += `trading_suite_uptime_seconds ${metricsData.uptime_seconds}\n`;
      out += '# HELP trading_suite_memory_rss_bytes Memory RSS in bytes\n';
      out += `trading_suite_memory_rss_bytes ${mem.rss}\n`;
      out += '# HELP trading_suite_trade_logs_total Total trade logs count\n';
      out += `trading_suite_trade_logs_total ${totalLogs}\n`;
      res.setHeader('Content-Type', 'text/plain; version=0.0.4');
      return res.send(out);
    }
    res.json(metricsData);
  } catch (err) {
    res.status(500).json({ status: 'error', error: err.message });
  }
});

// ---------------------------------------------------------------------------
// Settings: persisted in trade_db.suite_settings (db/migrations/003_market_providers.sql).
// ---------------------------------------------------------------------------
const SETTING_RULES = {
  profitGuardThresholdUsd: { type: 'number', min: 0, max: 10000, default: 1.0 },
  maxSlippagePct: { type: 'number', min: 0, max: 50, default: 1.0 },
  maxDrawdownLimitUsd: { type: 'number', min: 0, max: 1000000, default: 50.0 },
  defaultSymbol: { type: 'string', default: 'BTC/USDT' },
  defaultTimeframe: { type: 'enum', values: TIMEFRAMES, default: '15m' },
  candleLimit: { type: 'number', min: 50, max: 1000, integer: true, default: 300 },
  tickerRefreshSeconds: { type: 'number', min: 15, max: 3600, integer: true, default: 60 },
  showTradeMarkers: { type: 'boolean', default: true },
  showVolume: { type: 'boolean', default: true },
};
const settings = Object.fromEntries(Object.entries(SETTING_RULES).map(([k, r]) => [k, r.default]));
let settingsPersisted = false;

function coerceSetting(key, raw) {
  const rule = SETTING_RULES[key];
  if (!rule) throw new Error(`Unknown setting "${key}"`);
  if (rule.type === 'number') {
    const v = Number(raw);
    if (!Number.isFinite(v) || v < rule.min || v > rule.max) throw new Error(`${key} must be between ${rule.min} and ${rule.max}`);
    return rule.integer ? Math.round(v) : v;
  }
  if (rule.type === 'boolean') return raw === true || raw === 'true';
  if (rule.type === 'enum') {
    if (!rule.values.includes(raw)) throw new Error(`${key} must be one of ${rule.values.join(', ')}`);
    return raw;
  }
  const s = String(raw || '').trim();
  if (!s || s.length > 50) throw new Error(`${key} must be 1-50 characters`);
  return s;
}

async function loadSettings() {
  try {
    const r = await postgresPool.query("SELECT value FROM suite_settings WHERE key = 'suite'");
    settingsPersisted = true;
    if (r.rows[0]) {
      for (const [k, v] of Object.entries(r.rows[0].value || {})) {
        try {
          if (k in SETTING_RULES) settings[k] = coerceSetting(k, v);
        } catch (e) {}
      }
    }
  } catch (e) {
    if (e.code !== UNDEFINED_TABLE) console.error('Loading settings failed:', e.message);
  }
}

app.get('/api/trading/settings', (req, res) => {
  res.json({ success: true, settings, persisted: settingsPersisted, rules: SETTING_RULES });
});

app.post('/api/trading/settings', requireControlRequest, async (req, res) => {
  try {
    const next = { ...settings };
    for (const [k, v] of Object.entries(req.body || {})) {
      if (k in SETTING_RULES) next[k] = coerceSetting(k, v);
    }
    await postgresPool.query(
      `INSERT INTO suite_settings (key, value, updated_by, updated_at) VALUES ('suite', $1, $2, NOW())
       ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_by = EXCLUDED.updated_by, updated_at = NOW()`,
      [next, controlActor(req)]
    );
    Object.assign(settings, next);
    settingsPersisted = true;
    // The web3 scanner reads its profit guard from economist_signals.
    await postgresPool
      .query('UPDATE economist_signals SET min_profit_threshold = $1, updated_at = CURRENT_TIMESTAMP', [settings.profitGuardThresholdUsd])
      .catch((e) => console.error('economist_signals update failed:', e.message));
    scheduleTickerRefresh();
    res.json({ success: true, settings, message: 'Settings saved.' });
  } catch (err) {
    res.status(400).json({ success: false, error: err.message });
  }
});

// ---------------------------------------------------------------------------
// Market data providers (trade_db.market_providers) and adapters (lib/providers.js).
// ---------------------------------------------------------------------------
const PROVIDER_COLUMNS = 'id, name, kind, base_url, enabled, config, credential_env, last_test_ok, last_test_at, last_test_msg';

async function listProviders() {
  const r = await postgresPool.query(`
    SELECT ${PROVIDER_COLUMNS.split(', ').map((c) => 'p.' + c).join(', ')},
           (SELECT count(*) FROM instrument_registry i WHERE i.provider_id = p.id)::int AS instrument_count
    FROM market_providers p ORDER BY p.id`);
  return r.rows;
}

async function getProvider(id) {
  const r = await postgresPool.query(`SELECT ${PROVIDER_COLUMNS} FROM market_providers WHERE id = $1`, [id]);
  return r.rows[0] || null;
}

function validateProvider(body, existing = {}) {
  const p = {
    name: body.name !== undefined ? String(body.name).trim() : existing.name,
    kind: body.kind !== undefined ? String(body.kind) : existing.kind,
    base_url: body.base_url !== undefined ? String(body.base_url).trim().replace(/\/+$/, '') : existing.base_url,
    enabled: body.enabled !== undefined ? body.enabled === true || body.enabled === 'true' : existing.enabled !== false,
    config: body.config !== undefined ? body.config : existing.config || {},
    credential_env: body.credential_env !== undefined ? String(body.credential_env || '').trim() || null : existing.credential_env || null,
  };
  if (!p.name || p.name.length > 60) throw new Error('name must be 1-60 characters');
  if (!KINDS[p.kind]) throw new Error(`kind must be one of ${Object.keys(KINDS).join(', ')}`);
  if (typeof p.config === 'string') {
    try {
      p.config = p.config.trim() ? JSON.parse(p.config) : {};
    } catch (e) {
      throw new Error('config is not valid JSON');
    }
  }
  if (!p.config || typeof p.config !== 'object' || Array.isArray(p.config)) throw new Error('config must be a JSON object');
  if (p.kind === 'freqtrade') p.base_url = FREQTRADE_API_URL;
  const urlError = validateBaseUrl(p.kind, p.base_url);
  if (urlError) throw new Error(urlError);
  // Template URLs may only point at the provider's own base_url.
  for (const key of ['candles_url', 'ticker_url']) {
    const t = p.config[key];
    if (t && !String(t).startsWith('/') && !String(t).startsWith(p.base_url + '/')) {
      throw new Error(`config.${key} must start with "/" or with base_url`);
    }
  }
  if (p.credential_env && !/^[A-Z][A-Z0-9_]{1,63}$/.test(p.credential_env)) {
    throw new Error('credential_env must be an UPPER_SNAKE_CASE variable name (the value goes in ~/.openclaw/credentials/market-providers.env)');
  }
  return p;
}

app.get('/api/providers/kinds', (req, res) => {
  const kinds = Object.fromEntries(
    Object.entries(KINDS).map(([k, v]) => [k, { label: v.label, defaults: v.defaults, symbolHint: v.symbolHint, config: v.config, credentials: !!v.credentials }])
  );
  res.json({ success: true, kinds, timeframes: TIMEFRAMES });
});

app.get('/api/providers', async (req, res) => {
  try {
    res.json({ success: true, providers: await listProviders() });
  } catch (err) {
    if (err.code === UNDEFINED_TABLE) return res.json({ success: true, providers: [], notInstalled: true });
    sendError(res, err);
  }
});

app.post('/api/providers', requireControlRequest, async (req, res) => {
  try {
    const p = validateProvider(req.body || {});
    const r = await postgresPool.query(
      `INSERT INTO market_providers (name, kind, base_url, enabled, config, credential_env)
       VALUES ($1, $2, $3, $4, $5, $6) RETURNING ${PROVIDER_COLUMNS}`,
      [p.name, p.kind, p.base_url, p.enabled, p.config, p.credential_env]
    );
    res.json({ success: true, provider: r.rows[0] });
  } catch (err) {
    res.status(err.code === '23505' ? 409 : 400).json({ success: false, error: err.code === '23505' ? 'A provider with this name exists' : err.message });
  }
});

app.put('/api/providers/:id', requireControlRequest, async (req, res) => {
  try {
    const existing = await getProvider(req.params.id);
    if (!existing) return res.status(404).json({ success: false, error: 'Provider not found' });
    const p = validateProvider(req.body || {}, existing);
    const r = await postgresPool.query(
      `UPDATE market_providers SET name = $2, kind = $3, base_url = $4, enabled = $5, config = $6, credential_env = $7, updated_at = NOW()
       WHERE id = $1 RETURNING ${PROVIDER_COLUMNS}`,
      [existing.id, p.name, p.kind, p.base_url, p.enabled, p.config, p.credential_env]
    );
    candleCache.clear();
    res.json({ success: true, provider: r.rows[0] });
  } catch (err) {
    res.status(err.code === '23505' ? 409 : 400).json({ success: false, error: err.code === '23505' ? 'A provider with this name exists' : err.message });
  }
});

app.delete('/api/providers/:id', requireControlRequest, async (req, res) => {
  try {
    const r = await postgresPool.query('DELETE FROM market_providers WHERE id = $1 RETURNING name', [req.params.id]);
    if (!r.rows.length) return res.status(404).json({ success: false, error: 'Provider not found' });
    candleCache.clear();
    res.json({ success: true, message: `${r.rows[0].name} removed; its instruments have no provider now.` });
  } catch (err) {
    sendError(res, err);
  }
});

async function testProvider(provider) {
  const started = Date.now();
  let ok = false;
  let msg;
  try {
    msg = await adapterFor(provider).test(provider, providerCtx);
    ok = true;
  } catch (e) {
    msg = e.message;
  }
  msg = `${String(msg).slice(0, 300)} (${Date.now() - started} ms)`;
  await postgresPool
    .query('UPDATE market_providers SET last_test_ok = $2, last_test_at = NOW(), last_test_msg = $3 WHERE id = $1', [provider.id, ok, msg])
    .catch(() => {});
  return { ok, message: msg };
}

app.post('/api/providers/:id/test', requireControlRequest, async (req, res) => {
  try {
    const provider = await getProvider(req.params.id);
    if (!provider) return res.status(404).json({ success: false, error: 'Provider not found' });
    res.json({ success: true, ...(await testProvider(provider)) });
  } catch (err) {
    sendError(res, err);
  }
});

// ---------------------------------------------------------------------------
// Instruments (trade_db.instrument_registry) with their provider routing.
// ---------------------------------------------------------------------------
const INSTRUMENT_CATEGORIES = ['CEX', 'CEX_FUTURES', 'DEX', 'TRADFI'];

async function listInstruments({ activeOnly = false } = {}) {
  const r = await postgresPool.query(`
    SELECT ir.symbol, ir.name, ir.category, ir.base_asset, ir.quote_asset, ir.contract_address, ir.exchange,
           ir.is_active, ir.last_price, ir.change_24h_pct, ir.volume_24h_usd, ir.updated_at,
           ir.provider_id, ir.provider_symbol, ir.network,
           mp.name AS provider_name, mp.kind AS provider_kind, mp.enabled AS provider_enabled,
           es.profit_score, es.score_grade
    FROM instrument_registry ir
    LEFT JOIN market_providers mp ON mp.id = ir.provider_id
    LEFT JOIN economist_signals es ON es.symbol = ir.symbol
    ${activeOnly ? 'WHERE ir.is_active IS NOT FALSE' : ''}
    ORDER BY ir.category ASC, ir.volume_24h_usd DESC NULLS LAST, ir.symbol ASC`);
  return r.rows;
}

async function getInstrument(symbol) {
  const r = await postgresPool.query(
    `SELECT ir.*, mp.id AS p_id, mp.name AS p_name, mp.kind AS p_kind, mp.base_url AS p_base_url, mp.enabled AS p_enabled,
            mp.config AS p_config, mp.credential_env AS p_credential_env
     FROM instrument_registry ir LEFT JOIN market_providers mp ON mp.id = ir.provider_id
     WHERE ir.symbol = $1`,
    [symbol]
  );
  const row = r.rows[0];
  if (!row) return null;
  const provider = row.p_id
    ? { id: row.p_id, name: row.p_name, kind: row.p_kind, base_url: row.p_base_url, enabled: row.p_enabled, config: row.p_config || {}, credential_env: row.p_credential_env }
    : null;
  return { inst: row, provider };
}

async function resolveInstrument(symbol) {
  const found = await getInstrument(symbol);
  if (!found) throw new ProviderError(`Unknown instrument ${symbol}`, { status: 404 });
  if (!found.provider) throw new ProviderError(`${symbol} has no data provider; pick one in Settings → Instruments`, { status: 409 });
  if (!found.provider.enabled) throw new ProviderError(`Provider ${found.provider.name} is disabled`, { status: 409 });
  return found;
}

app.get('/api/trading/pairs', async (req, res) => {
  try {
    res.json({ success: true, pairs: await listInstruments({ activeOnly: req.query.all !== '1' }) });
  } catch (err) {
    sendError(res, err);
  }
});

function validateInstrument(body, existing = {}) {
  const pick = (k) => (body[k] !== undefined ? body[k] : existing[k]);
  const i = {
    symbol: String(pick('symbol') || '').trim().toUpperCase(),
    name: pick('name') ? String(pick('name')).trim().slice(0, 100) : null,
    category: String(pick('category') || '').toUpperCase(),
    base_asset: pick('base_asset') ? String(pick('base_asset')).trim().toUpperCase().slice(0, 20) : null,
    quote_asset: pick('quote_asset') ? String(pick('quote_asset')).trim().toUpperCase().slice(0, 20) : null,
    exchange: pick('exchange') ? String(pick('exchange')).trim().slice(0, 50) : null,
    contract_address: pick('contract_address') ? String(pick('contract_address')).trim() : null,
    network: pick('network') ? String(pick('network')).trim().toLowerCase() : null,
    provider_id: pick('provider_id') ? parseInt(pick('provider_id'), 10) : null,
    provider_symbol: pick('provider_symbol') ? String(pick('provider_symbol')).trim() : null,
    is_active: pick('is_active') === undefined ? true : pick('is_active') === true || pick('is_active') === 'true',
  };
  if (!/^[A-Z0-9._₮^-]{1,24}(\/[A-Z0-9._₮-]{1,24})?$/iu.test(i.symbol)) throw new Error('symbol must look like BASE/QUOTE (or a ticker such as SPY)');
  if (!INSTRUMENT_CATEGORIES.includes(i.category)) throw new Error(`category must be one of ${INSTRUMENT_CATEGORIES.join(', ')}`);
  if (!i.base_asset || !i.quote_asset) {
    const [b, q] = i.symbol.split('/');
    i.base_asset = i.base_asset || b;
    i.quote_asset = i.quote_asset || q || 'USD';
  }
  return i;
}

app.post('/api/trading/pairs', requireControlRequest, async (req, res) => {
  try {
    const i = validateInstrument(req.body || {});
    const r = await postgresPool.query(
      `INSERT INTO instrument_registry (symbol, name, category, base_asset, quote_asset, exchange, contract_address, network, provider_id, provider_symbol, is_active, route_type, updated_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, NOW()) RETURNING symbol`,
      [i.symbol, i.name, i.category, i.base_asset, i.quote_asset, i.exchange, i.contract_address, i.network, i.provider_id, i.provider_symbol, i.is_active, i.category === 'DEX' ? 'DEX' : 'CEX']
    );
    scheduleTickerRefresh(2000);
    res.json({ success: true, symbol: r.rows[0].symbol });
  } catch (err) {
    res.status(err.code === '23505' ? 409 : 400).json({ success: false, error: err.code === '23505' ? 'This symbol is already registered' : err.message });
  }
});

app.put('/api/trading/pairs/:symbol', requireControlRequest, async (req, res) => {
  try {
    const found = await getInstrument(req.params.symbol);
    if (!found) return res.status(404).json({ success: false, error: 'Instrument not found' });
    const i = validateInstrument({ ...req.body, symbol: found.inst.symbol }, found.inst);
    await postgresPool.query(
      `UPDATE instrument_registry SET name = $2, category = $3, base_asset = $4, quote_asset = $5, exchange = $6, contract_address = $7,
              network = $8, provider_id = $9, provider_symbol = $10, is_active = $11, updated_at = NOW()
       WHERE symbol = $1`,
      [i.symbol, i.name, i.category, i.base_asset, i.quote_asset, i.exchange, i.contract_address, i.network, i.provider_id, i.provider_symbol, i.is_active]
    );
    for (const key of candleCache.keys()) if (key.startsWith(`${i.symbol}|`)) candleCache.delete(key);
    scheduleTickerRefresh(2000);
    res.json({ success: true, symbol: i.symbol });
  } catch (err) {
    res.status(400).json({ success: false, error: err.message });
  }
});

// ---------------------------------------------------------------------------
// Candles, ticker and order book through each instrument's provider.
// ---------------------------------------------------------------------------
const candleCache = new Map();
const CANDLE_TTL_MS = { geckoterminal: 60000, yahoo: 60000, default: 10000 };

app.get('/api/trading/candles', async (req, res) => {
  try {
    const symbol = String(req.query.symbol || settings.defaultSymbol);
    const tf = TIMEFRAMES.includes(req.query.tf) ? req.query.tf : settings.defaultTimeframe;
    const limit = Math.max(20, Math.min(parseInt(req.query.limit || settings.candleLimit, 10) || settings.candleLimit, 1000));
    const { inst, provider } = await resolveInstrument(symbol);

    const key = `${symbol}|${provider.id}|${tf}|${limit}`;
    const hit = candleCache.get(key);
    const ttl = CANDLE_TTL_MS[provider.kind] || CANDLE_TTL_MS.default;
    if (hit && Date.now() - hit.at < ttl) return res.json(hit.body);

    const adapter = adapterFor(provider);
    const candles = await adapter.candles(provider, inst, tf, limit, providerCtx);
    let source = provider.name;
    if (adapter.describe) source = await adapter.describe(provider, inst).catch(() => source);
    const body = { success: true, symbol, timeframe: tf, provider: { id: provider.id, name: provider.name, kind: provider.kind }, source, candles };
    candleCache.set(key, { at: Date.now(), body });
    if (candleCache.size > 300) candleCache.delete(candleCache.keys().next().value);
    res.json(body);
  } catch (err) {
    sendError(res, err, 502);
  }
});

app.get('/api/trading/orderbook', async (req, res) => {
  try {
    const symbol = String(req.query.symbol || settings.defaultSymbol);
    const { inst, provider } = await resolveInstrument(symbol);
    const book = await adapterFor(provider).orderbook(provider, inst, providerCtx);
    if (!book.bids.length && !book.asks.length) throw new ProviderError(`${provider.name} returned an empty order book`);
    res.json({ success: true, symbol, provider: provider.name, bids: book.bids, asks: book.asks });
  } catch (err) {
    sendError(res, err, 502);
  }
});

// Kept for existing callers (software_tester): Binance spot depth by exchange symbol.
app.get('/api/trading/binance/orderbook', async (req, res) => {
  try {
    const symbol = String(req.query.symbol || 'ETHUSDT').replace('/', '').toUpperCase();
    const provider = { kind: 'binance', base_url: 'https://api.binance.com', config: {} };
    const book = await adapterFor(provider).orderbook(provider, { symbol, provider_symbol: symbol });
    res.json({
      success: true,
      symbol,
      bids: book.bids.slice(0, 10).map(([price, qty]) => ({ price, qty })),
      asks: book.asks.slice(0, 10).map(([price, qty]) => ({ price, qty })),
    });
  } catch (err) {
    sendError(res, err, 502);
  }
});

// Background ticker refresh: keeps last_price / change / volume in the registry current.
const tickerRefreshState = { running: false, lastRunAt: null, updated: 0, failed: 0, errors: {} };
let tickerTimer = null;
const GECKO_MIN_INTERVAL_MS = 5 * 60 * 1000;
let lastGeckoRefresh = 0;

async function refreshTickers() {
  if (tickerRefreshState.running) return;
  tickerRefreshState.running = true;
  let updated = 0;
  let failed = 0;
  const errors = {};
  try {
    const r = await postgresPool.query(`
      SELECT ir.*, mp.id AS p_id, mp.name AS p_name, mp.kind AS p_kind, mp.base_url AS p_base_url, mp.config AS p_config, mp.credential_env AS p_credential_env
      FROM instrument_registry ir JOIN market_providers mp ON mp.id = ir.provider_id
      WHERE ir.is_active IS NOT FALSE AND mp.enabled`);
    const doGecko = Date.now() - lastGeckoRefresh >= GECKO_MIN_INTERVAL_MS;
    if (doGecko) lastGeckoRefresh = Date.now();
    const jobs = r.rows.filter((row) => row.p_kind !== 'freqtrade' && (row.p_kind !== 'geckoterminal' || doGecko));
    const queue = [...jobs];
    const worker = async () => {
      while (queue.length) {
        const row = queue.shift();
        const provider = { id: row.p_id, name: row.p_name, kind: row.p_kind, base_url: row.p_base_url, config: row.p_config || {}, credential_env: row.p_credential_env };
        try {
          const t = await adapterFor(provider).ticker(provider, row, providerCtx);
          if (t.price === null || !Number.isFinite(t.price)) throw new Error('no price');
          const clampPct = (v) => (Number.isFinite(v) ? Math.max(-999999, Math.min(999999, v)) : null);
          const clampVol = (v) => (Number.isFinite(v) ? Math.min(v, 9.9e15) : null);
          await postgresPool.query(
            'UPDATE instrument_registry SET last_price = $2, change_24h_pct = $3, volume_24h_usd = $4, updated_at = NOW() WHERE symbol = $1',
            [row.symbol, t.price, clampPct(t.changePct), clampVol(t.volumeUsd)]
          );
          updated++;
        } catch (e) {
          if (!e.unsupported) {
            failed++;
            errors[row.symbol] = e.message.slice(0, 200);
          }
        }
      }
    };
    await Promise.all([worker(), worker(), worker()]);
  } catch (e) {
    if (e.code !== UNDEFINED_TABLE) errors._ = e.message;
  } finally {
    Object.assign(tickerRefreshState, { running: false, lastRunAt: new Date().toISOString(), updated, failed, errors });
  }
}

function scheduleTickerRefresh(delayMs) {
  clearTimeout(tickerTimer);
  tickerTimer = setTimeout(async function tick() {
    await refreshTickers();
    tickerTimer = setTimeout(tick, settings.tickerRefreshSeconds * 1000);
  }, delayMs === undefined ? settings.tickerRefreshSeconds * 1000 : delayMs);
}

// ---------------------------------------------------------------------------
// Trade markers, economist signal, news, manual orders.
// ---------------------------------------------------------------------------
app.get('/api/trading/chart-markers', async (req, res) => {
  try {
    const symbol = String(req.query.symbol || settings.defaultSymbol);
    const markers = [];
    const found = await getInstrument(symbol).catch(() => null);
    const contract = found && found.inst.contract_address ? found.inst.contract_address.toLowerCase() : null;

    // Web3 executions are matched by token address; they carry no pair symbol.
    if (contract) {
      const dexRes = await postgresPool.query(
        `SELECT id, created_at, action, amount_in, amount_out, status FROM trade_logs
         WHERE lower(token_address) = $1 AND status IS DISTINCT FROM 'INVALID_SYNTHETIC'
         ORDER BY id DESC LIMIT 200`,
        [contract]
      );
      dexRes.rows.forEach((r) => {
        const pnl = (parseFloat(r.amount_out || 0) - parseFloat(r.amount_in || 0)).toFixed(4);
        markers.push({
          id: `dex_${r.id}`, time: Math.floor(new Date(r.created_at).getTime() / 1000), position: 'aboveBar',
          color: '#a855f7', shape: 'circle', text: `DEX ${r.action || ''} PnL ${pnl}`.trim(), kind: 'dex',
        });
      });
    }

    try {
      const ft = await postgresPool.query(
        `SELECT id, pair, open_rate, close_rate, open_date, close_date, realized_profit, close_profit_abs, is_open
         FROM trades WHERE pair = $1 ORDER BY id DESC LIMIT 200`,
        [symbol]
      );
      ft.rows.forEach((t) => {
        markers.push({
          id: `ft_open_${t.id}`, time: Math.floor(new Date(t.open_date).getTime() / 1000), position: 'belowBar',
          color: '#3b82f6', shape: 'arrowUp', text: `FT buy ${Number(t.open_rate)}`, kind: 'freqtrade',
        });
        if (!t.is_open && t.close_date) {
          const pnl = parseFloat(t.close_profit_abs ?? t.realized_profit ?? 0);
          markers.push({
            id: `ft_close_${t.id}`, time: Math.floor(new Date(t.close_date).getTime() / 1000), position: 'aboveBar',
            color: pnl >= 0 ? '#10b981' : '#f43f5e', shape: 'arrowDown', text: `FT sell ${Number(t.close_rate)} (${pnl >= 0 ? '+' : ''}${pnl.toFixed(2)})`, kind: 'freqtrade',
          });
        }
      });
    } catch (e) {
      if (e.code !== UNDEFINED_TABLE) throw e;
    }

    const manualRes = await postgresPool.query(
      'SELECT id, side, amount, price, created_at FROM manual_orders WHERE symbol = $1 ORDER BY id DESC LIMIT 100',
      [symbol]
    );
    manualRes.rows.forEach((m) => {
      const isBuy = m.side === 'BUY';
      markers.push({
        id: `manual_${m.id}`, time: Math.floor(new Date(m.created_at).getTime() / 1000), position: isBuy ? 'belowBar' : 'aboveBar',
        color: '#f59e0b', shape: isBuy ? 'arrowUp' : 'arrowDown', text: `Test ${m.side} ${Number(m.amount)}`, kind: 'manual',
      });
    });

    markers.sort((a, b) => a.time - b.time);
    res.json({ success: true, symbol, markers });
  } catch (err) {
    sendError(res, err);
  }
});

app.get('/api/trading/economist', async (req, res) => {
  try {
    const symbol = String(req.query.symbol || settings.defaultSymbol);
    const dbRes = await postgresPool.query('SELECT * FROM economist_signals WHERE symbol = $1 LIMIT 1', [symbol]);
    res.json({ success: true, signal: dbRes.rows[0] || null });
  } catch (err) {
    sendError(res, err);
  }
});

app.get('/api/trading/news', async (req, res) => {
  try {
    const symbol = String(req.query.symbol || settings.defaultSymbol);
    const result = await postgresPool.query(
      'SELECT * FROM market_news_cache WHERE symbol = $1 OR symbol IS NULL ORDER BY published_at DESC LIMIT 10',
      [symbol]
    );
    res.json({ success: true, news: result.rows });
  } catch (err) {
    sendError(res, err);
  }
});

app.post('/api/trading/orders', async (req, res) => {
  try {
    const { symbol, side, amount, price, order_type } = req.body || {};
    if (!symbol || !side || !amount) {
      return res.status(400).json({ success: false, error: 'symbol, side, amount required' });
    }
    if (!['BUY', 'SELL'].includes(String(side).toUpperCase()) || !(Number(amount) > 0)) {
      return res.status(400).json({ success: false, error: 'side must be BUY or SELL and amount must be positive' });
    }
    const insertRes = await postgresPool.query(
      `INSERT INTO manual_orders (symbol, side, order_type, amount, price, status, pnl_usd)
       VALUES ($1, $2, $3, $4, $5, 'SIMULATED', 0.00) RETURNING *`,
      [symbol, String(side).toUpperCase(), order_type || 'MARKET', amount, price || null]
    );
    res.json({ success: true, order: insertRes.rows[0], message: `Simulated ${side} order recorded for ${symbol}` });
  } catch (err) {
    sendError(res, err);
  }
});

// ---------------------------------------------------------------------------
// Multi-asset runner (CEX funding carry, IBKR paper account).
// ---------------------------------------------------------------------------
let multiAssetCache = { success: false, status: 'loading' };

function refreshMultiAssetData() {
  const runnerPath = '/home/openclaw/.openclaw/workspace/supervisor/multi_asset_runner.py';
  if (!fs.existsSync(runnerPath)) {
    multiAssetCache = { success: false, status: 'runner not found' };
    return;
  }
  exec(`python3 ${runnerPath}`, { timeout: 15000 }, (error, stdout) => {
    if (error) {
      multiAssetCache = { ...multiAssetCache, success: !!multiAssetCache.cex_funding_arbitrage, status: `runner failed: ${error.message.slice(0, 120)}` };
      return;
    }
    try {
      multiAssetCache = { success: true, ...JSON.parse(stdout) };
    } catch (e) {
      multiAssetCache = { ...multiAssetCache, status: 'runner returned invalid JSON' };
    }
  });
}
refreshMultiAssetData();
setInterval(refreshMultiAssetData, 30000);

app.get('/api/trading/multi-asset', (req, res) => {
  res.json(multiAssetCache);
});

app.get('/api/trading/ibkr/option-chain', (req, res) => {
  const strat = multiAssetCache.ibkr_tradfi && multiAssetCache.ibkr_tradfi.delta_neutral_strategy;
  if (!strat) return res.status(503).json({ success: false, error: 'No IBKR data from the multi-asset runner' });
  res.json({
    success: true,
    symbol: req.query.symbol || strat.underlying || 'SPY',
    underlying_price: strat.spot_price,
    strike: strat.strike,
    annualized_yield_pct: strat.annualized_theta_yield_pct,
    portfolio_greeks: strat.portfolio_greeks,
    legs: strat.legs,
  });
});

// ---------------------------------------------------------------------------
// Overview, trade tables, exports, log stream.
// ---------------------------------------------------------------------------
app.get('/api/trading/overview', async (req, res) => {
  try {
    const tradeLogsRes = await postgresPool.query(
      "SELECT count(*), COALESCE(sum(amount_out - amount_in), 0) AS net_pnl FROM trade_logs WHERE status IS DISTINCT FROM 'INVALID_SYNTHETIC'"
    );
    const dexStats = tradeLogsRes.rows[0] || { count: 0, net_pnl: 0 };

    let openTradesCount = 0;
    let closedTradesCount = 0;
    let freqPnl = 0;
    let closedWins = 0;
    try {
      const pg = await postgresPool.query(`
        SELECT count(*) FILTER (WHERE is_open) AS open_cnt,
               count(*) FILTER (WHERE NOT is_open) AS closed_cnt,
               COALESCE(sum(close_profit_abs) FILTER (WHERE NOT is_open), 0) AS pnl,
               count(*) FILTER (WHERE NOT is_open AND close_profit_abs > 0) AS wins
        FROM trades`);
      openTradesCount = parseInt(pg.rows[0].open_cnt || 0, 10);
      closedTradesCount = parseInt(pg.rows[0].closed_cnt || 0, 10);
      freqPnl = parseFloat(pg.rows[0].pnl || 0);
      closedWins = parseInt(pg.rows[0].wins || 0, 10);
    } catch (e) {
      if (e.code !== UNDEFINED_TABLE) throw e;
    }

    let capital = null;
    try {
      const bal = await freqtradeApi('GET', '/balance');
      capital = { value: Number(bal.total), currency: bal.stake || 'USDT', source: 'freqtrade', dryRun: true };
      const cfg = await freqtradeApi('GET', '/show_config');
      capital.dryRun = !!cfg.dry_run;
    } catch (e) {}

    const totalPnlUsd = (parseFloat(dexStats.net_pnl || 0) + freqPnl).toFixed(2);
    const control = await getControlState().catch(() => ({ installed: false }));
    const score = await postgresPool.query('SELECT round(avg(profit_score), 1) AS avg FROM economist_signals').catch(() => ({ rows: [{}] }));

    res.json({
      success: true,
      summary: {
        totalRealizedPnlUsd: totalPnlUsd,
        capital,
        winRatePercent: closedTradesCount > 0 ? ((closedWins / closedTradesCount) * 100).toFixed(1) : null,
        profitScore: score.rows[0].avg !== undefined && score.rows[0].avg !== null ? Number(score.rows[0].avg) : null,
        openTradesCount,
        totalExecutedTrades: parseInt(dexStats.count, 10) + closedTradesCount,
        systemStatus: !control.installed ? 'CONTROL PLANE NOT INSTALLED' : control.halted ? 'HALTED' : 'ACTIVE',
        profitGuardThresholdUsd: settings.profitGuardThresholdUsd,
      },
    });
  } catch (err) {
    sendError(res, err);
  }
});

app.get('/api/trading/dex-arbitrage', async (req, res) => {
  try {
    const dbRes = await postgresPool.query(`
      SELECT id, created_at, action, token_address, amount_in, amount_out, gas_used, status,
             (CAST(amount_out AS NUMERIC) - CAST(amount_in AS NUMERIC)) AS pnl_usd
      FROM trade_logs WHERE status IS DISTINCT FROM 'INVALID_SYNTHETIC'
      ORDER BY created_at DESC LIMIT 50`);
    res.json({ success: true, count: dbRes.rows.length, trades: dbRes.rows });
  } catch (err) {
    sendError(res, err);
  }
});

app.get('/api/trading/freqtrade', async (req, res) => {
  try {
    const dbRes = await postgresPool.query(`
      SELECT id, pair, open_rate, close_rate, stake_amount, open_date, close_date,
             realized_profit, close_profit_abs, is_open, strategy, enter_tag, exit_reason
      FROM trades ORDER BY open_date DESC LIMIT 50`);
    res.json({ success: true, count: dbRes.rows.length, trades: dbRes.rows });
  } catch (err) {
    sendError(res, err);
  }
});

app.get('/api/trading/export/trades', async (req, res) => {
  try {
    const format = req.query.format || 'json';
    const limit = Math.max(1, Math.min(parseInt(req.query.limit || '500', 10) || 500, 10000));
    const dbRes = await postgresPool.query('SELECT * FROM trade_logs ORDER BY created_at DESC LIMIT $1', [limit]);
    const rows = dbRes.rows;
    if (format === 'csv') {
      res.setHeader('Content-Type', 'text/csv');
      res.setHeader('Content-Disposition', `attachment; filename="trade_logs_${Date.now()}.csv"`);
      if (!rows.length) return res.send('id,tx_hash,token_address,action,amount_in,amount_out,gas_used,status,created_at\n');
      const cell = (v) => (v === null ? '' : v instanceof Date ? v.toISOString() : typeof v === 'string' ? `"${v.replace(/"/g, '""')}"` : v);
      return res.send([Object.keys(rows[0]).join(','), ...rows.map((r) => Object.values(r).map(cell).join(','))].join('\n'));
    }
    res.setHeader('Content-Disposition', `attachment; filename="trade_logs_${Date.now()}.json"`);
    return res.json({ success: true, count: rows.length, data: rows });
  } catch (err) {
    sendError(res, err);
  }
});

// Server-sent events: new lines of the web3 supervisor log.
app.get('/api/trading/logs/stream', (req, res) => {
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  const send = (data) => res.write(`data: ${JSON.stringify(data)}\n\n`);
  send({ type: 'connected', message: `Streaming ${SUPERVISOR_LOG_PATH}` });

  let position = null;
  const tick = () => {
    try {
      const { size } = fs.statSync(SUPERVISOR_LOG_PATH);
      if (position === null || size < position) position = Math.max(0, size - 4000);
      if (size === position) return;
      const length = Math.min(size - position, 64 * 1024);
      const fd = fs.openSync(SUPERVISOR_LOG_PATH, 'r');
      const buffer = Buffer.alloc(length);
      fs.readSync(fd, buffer, 0, length, position);
      fs.closeSync(fd);
      const text = buffer.toString('utf8');
      const lastNewline = text.lastIndexOf('\n');
      if (lastNewline < 0) return;
      position += Buffer.byteLength(text.slice(0, lastNewline + 1));
      text.slice(0, lastNewline).split('\n').filter(Boolean).forEach((log) => send({ type: 'log', log }));
    } catch (e) {}
  };
  tick();
  const interval = setInterval(tick, 2000);
  req.on('close', () => clearInterval(interval));
});

// ---------------------------------------------------------------------------
// Integrations: one status view over everything the suite talks to.
// ---------------------------------------------------------------------------
async function timed(fn) {
  const started = Date.now();
  try {
    const detail = await fn();
    return { ok: true, detail, ms: Date.now() - started };
  } catch (e) {
    return { ok: false, detail: e.message, ms: Date.now() - started };
  }
}

app.get('/api/integrations', async (req, res) => {
  const [db, ft, dash, heartbeat] = await Promise.all([
    timed(async () => {
      const r = await postgresPool.query('SELECT current_database() AS db, pg_size_pretty(pg_database_size(current_database())) AS size');
      return `${r.rows[0].db}, ${r.rows[0].size}`;
    }),
    timed(async () => {
      const cfg = await freqtradeApi('GET', '/show_config');
      return `${cfg.strategy}, ${cfg.dry_run ? 'dry-run' : 'LIVE'}, state ${cfg.state}`;
    }),
    timed(async () => {
      const r = await fetch(SYSTEM_DASHBOARD_HEALTH, { signal: AbortSignal.timeout(3000) });
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      return 'healthy';
    }),
    timed(async () => {
      const rows = await getHeartbeatEngines();
      const w = rows.find((r) => r.engine === 'web3-dex-bot');
      if (!w || w.state === 'OFFLINE' || w.state === 'NOT_REPORTING') throw new Error(`web3-dex-bot ${w ? w.state : 'not reporting'}`);
      return `web3-dex-bot ${w.mode}, ${w.state}`;
    }),
  ]);
  let providers = [];
  try {
    providers = (await listProviders()).map((p) => ({
      id: p.id, name: p.name, kind: p.kind, enabled: p.enabled, instruments: p.instrument_count,
      ok: p.last_test_ok, tested_at: p.last_test_at, detail: p.last_test_msg,
    }));
  } catch (e) {}
  res.json({
    success: true,
    services: [
      { name: 'PostgreSQL trade_db', ...db },
      { name: 'Freqtrade API', ...ft },
      { name: 'Web3 DEX engine heartbeat', ...heartbeat },
      { name: 'System dashboard', ...dash },
    ],
    providers,
    tickerRefresh: tickerRefreshState,
  });
});

app.get('/api/integrations/freqtrade', async (req, res) => {
  try {
    const [cfg, status, profit, whitelist] = await Promise.all([
      freqtradeApi('GET', '/show_config'),
      freqtradeApi('GET', '/status').catch(() => []),
      freqtradeApi('GET', '/profit').catch(() => null),
      freqtradeApi('GET', '/whitelist').catch(() => ({ whitelist: [] })),
    ]);
    res.json({
      success: true,
      config: {
        strategy: cfg.strategy, state: cfg.state, dry_run: cfg.dry_run, timeframe: cfg.timeframe, exchange: cfg.exchange,
        stake_currency: cfg.stake_currency, stake_amount: cfg.stake_amount, max_open_trades: cfg.max_open_trades,
        stoploss: cfg.stoploss, minimal_roi: cfg.minimal_roi, trailing_stop: cfg.trailing_stop, trading_mode: cfg.trading_mode,
        bot_name: cfg.bot_name, version: cfg.version,
      },
      whitelist: whitelist.whitelist || [],
      openTrades: (status || []).map((t) => ({
        id: t.trade_id, pair: t.pair, open_rate: t.open_rate, current_rate: t.current_rate, stake_amount: t.stake_amount,
        profit_abs: t.profit_abs, profit_pct: t.profit_pct, open_date: t.open_date,
      })),
      profit,
    });
  } catch (err) {
    res.status(502).json({ success: false, error: err.message });
  }
});

// Service control is left to the system dashboard; this route only reports status now.
app.post('/api/trading/services/:id/:action', requireControlRequest, (req, res) => {
  const allowed = ['trading-suite.service', 'web3-dex-bot.service', 'freqtrade.service', 'system-dashboard.service'];
  if (!allowed.includes(req.params.id)) return res.status(403).json({ success: false, error: 'Unauthorized service control.' });
  if (req.params.action !== 'status') return res.status(400).json({ success: false, error: 'Only "status" is supported here; use the System view to start or stop services.' });
  exec(`systemctl is-active ${req.params.id}`, { timeout: 5000 }, (error, stdout) => {
    res.json({ success: true, service: req.params.id, state: String(stdout || '').trim() || 'unknown' });
  });
});

// ---------------------------------------------------------------------------
// Trading control plane: kill switch and real engine modes (2026-09-26).
// State lives in trade_db (db/migrations/001_trading_control.sql). Each engine reads the
// switch on its own; this service writes it, pauses Freqtrade, and reports engine modes.
// ---------------------------------------------------------------------------
const FREQTRADE_API_URL = process.env.FREQTRADE_API_URL || 'http://127.0.0.1:8080';
const ENGINE_STALE_SECONDS = 180;
const UNDEFINED_TABLE = '42P01';

function readFreqtradeCredentials() {
  let user = process.env.FREQTRADE_USER;
  let pass = process.env.FREQTRADE_PASS;
  if (!user || !pass) {
    try {
      const file = path.join(os.homedir(), '.openclaw', 'credentials', 'freqtrade.env');
      for (const line of fs.readFileSync(file, 'utf8').split('\n')) {
        const match = line.match(/^(FREQTRADE_USER|FREQTRADE_PASS)=(.*)$/);
        if (!match) continue;
        const value = match[2].trim().replace(/^['"]|['"]$/g, '');
        if (match[1] === 'FREQTRADE_USER' && !user) user = value;
        if (match[1] === 'FREQTRADE_PASS' && !pass) pass = value;
      }
    } catch (e) {}
  }
  return { user, pass };
}

let freqtradeToken = null;
let freqtradeTokenExpiry = 0;

async function freqtradeApi(method, apiPath) {
  if (!freqtradeToken || Date.now() > freqtradeTokenExpiry) {
    const { user, pass } = readFreqtradeCredentials();
    if (!user || !pass) throw new Error('Freqtrade API credentials not configured');
    const login = await fetch(`${FREQTRADE_API_URL}/api/v1/token/login`, {
      method: 'POST',
      headers: { Authorization: 'Basic ' + Buffer.from(`${user}:${pass}`).toString('base64') },
      signal: AbortSignal.timeout(5000),
    });
    if (!login.ok) throw new Error(`Freqtrade login failed: HTTP ${login.status}`);
    freqtradeToken = (await login.json()).access_token;
    freqtradeTokenExpiry = Date.now() + 10 * 60 * 1000;
  }
  const res = await fetch(`${FREQTRADE_API_URL}/api/v1${apiPath}`, {
    method,
    headers: { Authorization: `Bearer ${freqtradeToken}` },
    signal: AbortSignal.timeout(5000),
  });
  if (res.status === 401) freqtradeToken = null;
  if (!res.ok) throw new Error(`Freqtrade ${method} ${apiPath}: HTTP ${res.status}`);
  return res.json();
}

async function getControlState() {
  try {
    const r = await postgresPool.query(
      'SELECT halted, reason, changed_by, changed_at FROM trading_control WHERE id = 1'
    );
    if (!r.rows.length) return { installed: false };
    return { installed: true, ...r.rows[0] };
  } catch (e) {
    if (e.code === UNDEFINED_TABLE) return { installed: false };
    throw e;
  }
}

async function getFreqtradeEngine() {
  try {
    const cfg = await freqtradeApi('GET', '/show_config');
    return {
      engine: 'freqtrade',
      mode: cfg.dry_run ? 'DRY_RUN' : 'LIVE',
      state: String(cfg.state || 'unknown').toUpperCase(),
      detail: { strategy: cfg.strategy, runmode: cfg.runmode },
    };
  } catch (e) {
    return { engine: 'freqtrade', mode: 'UNKNOWN', state: 'OFFLINE', detail: { error: e.message } };
  }
}

async function getHeartbeatEngines() {
  let rows = [];
  try {
    const r = await postgresPool.query(`
      SELECT engine, mode, state, detail, last_seen,
             EXTRACT(EPOCH FROM (NOW() - last_seen)) AS age_seconds
      FROM engine_status ORDER BY engine;
    `);
    rows = r.rows.map((row) => ({
      engine: row.engine,
      mode: row.mode,
      state: Number(row.age_seconds) > ENGINE_STALE_SECONDS ? 'OFFLINE' : row.state,
      last_seen: row.last_seen,
      detail: row.detail,
    }));
  } catch (e) {
    if (e.code !== UNDEFINED_TABLE) throw e;
  }
  if (!rows.some((row) => row.engine === 'web3-dex-bot')) {
    rows.push({ engine: 'web3-dex-bot', mode: 'UNKNOWN', state: 'NOT_REPORTING', detail: null });
  }
  return rows;
}

// A cross-site page can send neither the custom header nor a matching Origin (CSRF guard).
function requireControlRequest(req, res, next) {
  if (req.get('X-Trading-Control') !== '1') {
    return res.status(403).json({ success: false, error: 'Missing X-Trading-Control header' });
  }
  const origin = req.get('Origin');
  if (origin) {
    let originHost = null;
    try {
      originHost = new URL(origin).host;
    } catch (e) {}
    if (originHost !== req.get('Host')) {
      return res.status(403).json({ success: false, error: 'Cross-origin control request rejected' });
    }
  }
  next();
}

function controlActor(req) {
  return `trading-suite UI (${req.get('X-Forwarded-For') || req.ip})`;
}

async function writeControlState(halted, reason, changedBy) {
  const client = await postgresPool.connect();
  try {
    await client.query('BEGIN');
    await client.query(
      'UPDATE trading_control SET halted = $1, reason = $2, changed_by = $3, changed_at = NOW() WHERE id = 1',
      [halted, reason, changedBy]
    );
    await client.query(
      'INSERT INTO trading_control_audit (halted, reason, changed_by) VALUES ($1, $2, $3)',
      [halted, reason, changedBy]
    );
    await client.query('COMMIT');
  } catch (e) {
    await client.query('ROLLBACK').catch(() => {});
    throw e;
  } finally {
    client.release();
  }
}

app.get('/api/control/status', async (req, res) => {
  try {
    const [control, freqtrade, heartbeat] = await Promise.all([
      getControlState(),
      getFreqtradeEngine(),
      getHeartbeatEngines(),
    ]);
    res.json({ success: true, control, engines: [freqtrade, ...heartbeat] });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

app.post('/api/control/halt', requireControlRequest, async (req, res) => {
  try {
    const control = await getControlState();
    if (!control.installed) {
      return res.status(409).json({
        success: false,
        error: 'Control plane not installed: apply db/migrations/001_trading_control.sql',
      });
    }
    const reason = String((req.body && req.body.reason) || 'Manual kill switch').slice(0, 200);
    await writeControlState(true, reason, controlActor(req));

    const results = { database: 'halted' };
    try {
      await freqtradeApi('POST', '/pause');
      results.freqtrade = 'paused (open trades managed, no new entries)';
    } catch (e) {
      results.freqtrade = `pause failed: ${e.message}; entries stay blocked by confirm_trade_entry`;
    }
    results['web3-dex-bot'] = 'reads trading_control; scanner stops transmitting';
    res.json({ success: true, results });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

app.post('/api/control/resume', requireControlRequest, async (req, res) => {
  try {
    if (!req.body || req.body.confirm !== 'RESUME') {
      return res.status(400).json({ success: false, error: 'Type RESUME to confirm' });
    }
    const control = await getControlState();
    if (!control.installed) {
      return res.status(409).json({ success: false, error: 'Control plane not installed' });
    }
    await writeControlState(false, 'Resumed from trading-suite UI', controlActor(req));

    const results = { database: 'resumed' };
    try {
      await freqtradeApi('POST', '/start');
      results.freqtrade = 'running';
    } catch (e) {
      results.freqtrade = `start failed: ${e.message}`;
    }
    res.json({ success: true, results });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// Keep Freqtrade paused while halted, e.g. after it restarts in its initial "running" state.
setInterval(async () => {
  try {
    const control = await getControlState();
    if (!control.installed || !control.halted) return;
    const cfg = await freqtradeApi('GET', '/show_config');
    if (String(cfg.state).toLowerCase() === 'running') {
      await freqtradeApi('POST', '/pause');
      console.log('[control] Trading halted: re-paused Freqtrade after it reported state "running".');
    }
  } catch (e) {}
}, 30000);

loadSettings().finally(() => {
  scheduleTickerRefresh(3000);
  app.listen(PORT, HOST, () => {
    console.log(`Unified Trading Suite running on http://${HOST}:${PORT}`);
  });
});
