// Market data provider adapters.
//
// A provider row in trade_db.market_providers picks an adapter by `kind`. Every adapter
// returns the same shapes, so the UI does not care where the data comes from:
//   candles   [{ time (unix s), open, high, low, close, volume }] oldest first
//   ticker    { price, changePct, volumeUsd }
//   orderbook { bids: [[price, qty]], asks: [[price, qty]] }
// An adapter that cannot serve something throws ProviderError with `unsupported: true`.

const fs = require('fs');
const os = require('os');
const path = require('path');

const TIMEFRAMES = ['1m', '5m', '15m', '1h', '4h', '1d'];
const TIMEFRAME_SECONDS = { '1m': 60, '5m': 300, '15m': 900, '1h': 3600, '4h': 14400, '1d': 86400 };
const CREDENTIALS_FILE = path.join(os.homedir(), '.openclaw', 'credentials', 'market-providers.env');
const USER_AGENT = 'Mozilla/5.0 (X11; Linux x86_64) trading-suite/2.0';

class ProviderError extends Error {
  constructor(message, { unsupported = false, status = 502 } = {}) {
    super(message);
    this.unsupported = unsupported;
    this.status = unsupported ? 501 : status;
  }
}

const unsupported = (what) => {
  throw new ProviderError(`${what} is not available from this provider`, { unsupported: true });
};

async function getJson(url, { headers = {}, timeoutMs = 8000 } = {}) {
  const res = await fetch(url, {
    headers: { 'User-Agent': USER_AGENT, Accept: 'application/json', ...headers },
    signal: AbortSignal.timeout(timeoutMs),
  });
  const text = await res.text();
  let body;
  try {
    body = JSON.parse(text);
  } catch (e) {
    throw new ProviderError(`${new URL(url).host}: HTTP ${res.status}, not JSON`);
  }
  if (!res.ok) {
    const detail = body && (body.msg || body.message || (body.errors && JSON.stringify(body.errors)));
    throw new ProviderError(`${new URL(url).host}: HTTP ${res.status}${detail ? ` (${String(detail).slice(0, 160)})` : ''}`);
  }
  return body;
}

// Secrets never live in the database: a provider names a variable, the value comes from
// ~/.openclaw/credentials/market-providers.env (or the process environment).
function readCredential(name) {
  if (!name) return null;
  if (process.env[name]) return process.env[name];
  try {
    for (const line of fs.readFileSync(CREDENTIALS_FILE, 'utf8').split('\n')) {
      const m = line.match(/^([A-Za-z_][A-Za-z0-9_]*)=(.*)$/);
      if (m && m[1] === name) return m[2].trim().replace(/^['"]|['"]$/g, '');
    }
  } catch (e) {}
  return null;
}

const num = (v) => (v === null || v === undefined || v === '' ? null : Number(v));
const byTime = (a, b) => a.time - b.time;
const cleanCandles = (rows) =>
  rows
    .filter((c) => [c.time, c.open, c.high, c.low, c.close].every((v) => Number.isFinite(v)))
    .sort(byTime)
    .filter((c, i, arr) => i === 0 || c.time !== arr[i - 1].time);

function aggregate(candles, factor) {
  if (factor <= 1) return candles;
  const out = [];
  for (let i = 0; i < candles.length; i += factor) {
    const chunk = candles.slice(i, i + factor);
    out.push({
      time: chunk[0].time,
      open: chunk[0].open,
      high: Math.max(...chunk.map((c) => c.high)),
      low: Math.min(...chunk.map((c) => c.low)),
      close: chunk[chunk.length - 1].close,
      volume: chunk.reduce((s, c) => s + (c.volume || 0), 0),
    });
  }
  return out;
}

// Instrument symbol at the provider: explicit provider_symbol wins, else base+quote.
function pairParts(inst) {
  const [symBase, symQuote] = String(inst.symbol || '').split('/');
  return {
    base: String(inst.base_asset || symBase || '').toUpperCase(),
    quote: String(inst.quote_asset || symQuote || '').toUpperCase(),
  };
}
const joined = (inst, sep = '') => {
  if (inst.provider_symbol) return inst.provider_symbol;
  const { base, quote } = pairParts(inst);
  return `${base}${sep}${quote}`;
};

// ---- Binance spot / USD-M futures (and Binance-compatible APIs via base_url) ----------
function binanceFamily(prefix) {
  return {
    async candles(p, inst, tf, limit) {
      const rows = await getJson(`${p.base_url}${prefix}/klines?symbol=${encodeURIComponent(joined(inst))}&interval=${tf}&limit=${limit}`);
      return cleanCandles(rows.map((r) => ({ time: Math.floor(r[0] / 1000), open: +r[1], high: +r[2], low: +r[3], close: +r[4], volume: +r[5] })));
    },
    async ticker(p, inst) {
      const t = await getJson(`${p.base_url}${prefix}/ticker/24hr?symbol=${encodeURIComponent(joined(inst))}`);
      return { price: num(t.lastPrice), changePct: num(t.priceChangePercent), volumeUsd: num(t.quoteVolume) };
    },
    async orderbook(p, inst) {
      const d = await getJson(`${p.base_url}${prefix}/depth?symbol=${encodeURIComponent(joined(inst))}&limit=20`);
      return { bids: d.bids.map((b) => [+b[0], +b[1]]), asks: d.asks.map((a) => [+a[0], +a[1]]) };
    },
    async test(p) {
      await getJson(`${p.base_url}${prefix}/ping`);
      return 'ping ok';
    },
  };
}

// ---- OKX ---------------------------------------------------------------------------
const OKX_BAR = { '1m': '1m', '5m': '5m', '15m': '15m', '1h': '1H', '4h': '4H', '1d': '1Dutc' };
const okxInstId = (p, inst) => {
  if (inst.provider_symbol) return inst.provider_symbol;
  const swap = String((p.config && p.config.instType) || 'SPOT').toUpperCase() === 'SWAP';
  return `${joined(inst, '-')}${swap ? '-SWAP' : ''}`;
};
const okx = {
  async candles(p, inst, tf, limit) {
    const d = await getJson(`${p.base_url}/api/v5/market/candles?instId=${encodeURIComponent(okxInstId(p, inst))}&bar=${OKX_BAR[tf]}&limit=${Math.min(limit, 300)}`);
    if (d.code && d.code !== '0') throw new ProviderError(`OKX: ${d.msg || d.code}`);
    return cleanCandles(d.data.map((r) => ({ time: Math.floor(r[0] / 1000), open: +r[1], high: +r[2], low: +r[3], close: +r[4], volume: +r[5] })));
  },
  async ticker(p, inst) {
    const d = await getJson(`${p.base_url}/api/v5/market/ticker?instId=${encodeURIComponent(okxInstId(p, inst))}`);
    const t = d.data && d.data[0];
    if (!t) throw new ProviderError(`OKX: ${d.msg || 'unknown instrument'}`);
    const last = num(t.last);
    const open = num(t.sodUtc0) || num(t.open24h);
    return { price: last, changePct: open ? ((last - open) / open) * 100 : null, volumeUsd: num(t.volCcy24h) * (t.instType === 'SWAP' ? last : 1) };
  },
  async orderbook(p, inst) {
    const d = await getJson(`${p.base_url}/api/v5/market/books?instId=${encodeURIComponent(okxInstId(p, inst))}&sz=20`);
    const b = d.data && d.data[0];
    if (!b) throw new ProviderError(`OKX: ${d.msg || 'no book'}`);
    return { bids: b.bids.map((x) => [+x[0], +x[1]]), asks: b.asks.map((x) => [+x[0], +x[1]]) };
  },
  async test(p) {
    await getJson(`${p.base_url}/api/v5/public/time`);
    return 'server time ok';
  },
};

// ---- Bybit (spot or linear via config.category) ------------------------------------
const BYBIT_INTERVAL = { '1m': '1', '5m': '5', '15m': '15', '1h': '60', '4h': '240', '1d': 'D' };
const bybitCategory = (p) => (p.config && p.config.category) || 'spot';
const bybit = {
  async candles(p, inst, tf, limit) {
    const d = await getJson(`${p.base_url}/v5/market/kline?category=${bybitCategory(p)}&symbol=${encodeURIComponent(joined(inst))}&interval=${BYBIT_INTERVAL[tf]}&limit=${Math.min(limit, 1000)}`);
    if (d.retCode !== 0) throw new ProviderError(`Bybit: ${d.retMsg}`);
    return cleanCandles(d.result.list.map((r) => ({ time: Math.floor(r[0] / 1000), open: +r[1], high: +r[2], low: +r[3], close: +r[4], volume: +r[5] })));
  },
  async ticker(p, inst) {
    const d = await getJson(`${p.base_url}/v5/market/tickers?category=${bybitCategory(p)}&symbol=${encodeURIComponent(joined(inst))}`);
    const t = d.result && d.result.list && d.result.list[0];
    if (!t) throw new ProviderError(`Bybit: ${d.retMsg || 'unknown instrument'}`);
    return { price: num(t.lastPrice), changePct: num(t.price24hPcnt) * 100, volumeUsd: num(t.turnover24h) };
  },
  async orderbook(p, inst) {
    const d = await getJson(`${p.base_url}/v5/market/orderbook?category=${bybitCategory(p)}&symbol=${encodeURIComponent(joined(inst))}&limit=20`);
    if (d.retCode !== 0) throw new ProviderError(`Bybit: ${d.retMsg}`);
    return { bids: d.result.b.map((x) => [+x[0], +x[1]]), asks: d.result.a.map((x) => [+x[0], +x[1]]) };
  },
  async test(p) {
    await getJson(`${p.base_url}/v5/market/time`);
    return 'server time ok';
  },
};

// ---- GeckoTerminal (DEX pools) -------------------------------------------------------
// provider_symbol "network:pool_address" pins a pool; otherwise the pool is found by
// searching for the contract address (or the pair name) and cached for 6 hours.
const GECKO_HEADERS = { Accept: 'application/json;version=20230302' };
// The public API allows only a few calls a minute per IP (429 at ~28/min in practice):
// space calls ~6.5 s apart, and after a 429 fail fast for a minute instead of queueing.
const GECKO_SPACING_MS = 6500;
const GECKO_MAX_WAIT_MS = 30000;
let geckoNextSlot = 0;
let geckoCooldownUntil = 0;
async function geckoGet(url) {
  const now = Date.now();
  if (now < geckoCooldownUntil) {
    throw new ProviderError(`GeckoTerminal rate limit; retry in ${Math.ceil((geckoCooldownUntil - now) / 1000)} s`, { status: 429 });
  }
  const wait = Math.max(0, geckoNextSlot - now);
  if (wait > GECKO_MAX_WAIT_MS) throw new ProviderError('GeckoTerminal request queue is full; try again shortly', { status: 429 });
  geckoNextSlot = now + wait + GECKO_SPACING_MS;
  if (wait) await new Promise((r) => setTimeout(r, wait));
  try {
    return await getJson(url, { headers: GECKO_HEADERS, timeoutMs: 10000 });
  } catch (e) {
    if (/HTTP 429/.test(e.message)) geckoCooldownUntil = Date.now() + 60000;
    throw e;
  }
}
const GECKO_TF = { '1m': ['minute', 1], '5m': ['minute', 5], '15m': ['minute', 15], '1h': ['hour', 1], '4h': ['hour', 4], '1d': ['day', 1] };
const geckoPoolCache = new Map();
const sameAsset = (a, b) => {
  const norm = (s) => String(s || '').toUpperCase().replace(/^W(ETH|BTC|SOL|BNB)$/, '$1').replace(/[^A-Z0-9]/g, '');
  return norm(a) === norm(b);
};

async function geckoPool(p, inst) {
  if (inst.provider_symbol && inst.provider_symbol.includes(':')) {
    const [network, address] = inst.provider_symbol.split(':');
    return { network, address, name: inst.symbol };
  }
  const key = `${p.id}|${inst.symbol}|${inst.contract_address || ''}|${inst.network || ''}`;
  const hit = geckoPoolCache.get(key);
  if (hit && hit.expires > Date.now()) return hit.pool;

  const { base, quote } = pairParts(inst);
  const query = inst.contract_address || `${base} ${quote}`;
  const network = inst.network ? `&network=${encodeURIComponent(inst.network)}` : '';
  const d = await geckoGet(`${p.base_url}/search/pools?query=${encodeURIComponent(query)}${network}`);
  const pools = (d.data || []).map((x) => {
    const [b, q] = String(x.attributes.name || '').split('/').map((s) => s.trim().split(' ')[0]);
    return {
      network: String(x.id).split('_')[0],
      address: x.attributes.address,
      name: x.attributes.name,
      reserve: Number(x.attributes.reserve_in_usd || 0),
      exact: sameAsset(b, base) && sameAsset(q, quote),
      baseMatch: sameAsset(b, base),
    };
  });
  if (!pools.length) throw new ProviderError(`GeckoTerminal: no pool found for ${inst.symbol}`);
  pools.sort((a, b) => b.exact - a.exact || b.baseMatch - a.baseMatch || b.reserve - a.reserve);
  const pool = pools[0];
  geckoPoolCache.set(key, { pool, expires: Date.now() + 6 * 3600 * 1000 });
  return pool;
}

const geckoterminal = {
  async candles(p, inst, tf, limit) {
    const pool = await geckoPool(p, inst);
    const [unit, agg] = GECKO_TF[tf];
    const d = await geckoGet(
      `${p.base_url}/networks/${pool.network}/pools/${pool.address}/ohlcv/${unit}?aggregate=${agg}&limit=${Math.min(limit, 1000)}&currency=usd`
    );
    const rows = (d.data && d.data.attributes && d.data.attributes.ohlcv_list) || [];
    return cleanCandles(rows.map((r) => ({ time: r[0], open: +r[1], high: +r[2], low: +r[3], close: +r[4], volume: +r[5] })));
  },
  async ticker(p, inst) {
    const pool = await geckoPool(p, inst);
    const d = await geckoGet(`${p.base_url}/networks/${pool.network}/pools/${pool.address}`);
    const a = d.data.attributes;
    return { price: num(a.base_token_price_usd), changePct: num(a.price_change_percentage && a.price_change_percentage.h24), volumeUsd: num(a.volume_usd && a.volume_usd.h24) };
  },
  orderbook() {
    return unsupported('An order book');
  },
  async describe(p, inst) {
    const pool = await geckoPool(p, inst);
    return `${pool.name} on ${pool.network} (${pool.address})`;
  },
  async test(p) {
    await geckoGet(`${p.base_url}/networks?page=1`);
    return 'networks ok';
  },
};

// ---- Yahoo Finance (stocks, ETFs, indices) ------------------------------------------
const YAHOO = { '1m': ['1m', '5d', 1], '5m': ['5m', '1mo', 1], '15m': ['15m', '1mo', 1], '1h': ['60m', '6mo', 1], '4h': ['60m', '2y', 4], '1d': ['1d', '5y', 1] };
const yahooSymbol = (inst) => inst.provider_symbol || String(inst.symbol).split('/')[0];
async function yahooChart(p, inst, interval, range) {
  const d = await getJson(`${p.base_url}/v8/finance/chart/${encodeURIComponent(yahooSymbol(inst))}?interval=${interval}&range=${range}&includePrePost=false`);
  const r = d.chart && d.chart.result && d.chart.result[0];
  if (!r) throw new ProviderError(`Yahoo: ${(d.chart && d.chart.error && d.chart.error.description) || 'no data'}`);
  return r;
}
const yahoo = {
  async candles(p, inst, tf, limit) {
    const [interval, range, factor] = YAHOO[tf];
    const r = await yahooChart(p, inst, interval, range);
    const q = (r.indicators.quote || [])[0] || {};
    const rows = (r.timestamp || []).map((t, i) => ({ time: t, open: num(q.open[i]), high: num(q.high[i]), low: num(q.low[i]), close: num(q.close[i]), volume: num(q.volume[i]) || 0 }));
    return aggregate(cleanCandles(rows), factor).slice(-limit);
  },
  async ticker(p, inst) {
    const r = await yahooChart(p, inst, '1d', '5d');
    const m = r.meta;
    const prev = num(m.chartPreviousClose) || num(m.previousClose);
    const price = num(m.regularMarketPrice);
    return { price, changePct: prev ? ((price - prev) / prev) * 100 : null, volumeUsd: num(m.regularMarketVolume) * price || null };
  },
  orderbook() {
    return unsupported('An order book');
  },
  async test(p) {
    await yahooChart(p, { symbol: 'SPY' }, '1d', '5d');
    return 'SPY chart ok';
  },
};

// ---- Freqtrade bot API (the bot's own whitelist and candles) -------------------------
// Uses the authenticated client in server.js (ctx.freqtradeApi); base_url is informational.
const freqtrade = {
  async candles(p, inst, tf, limit, ctx) {
    const d = await ctx.freqtradeApi('GET', `/pair_candles?pair=${encodeURIComponent(inst.provider_symbol || inst.symbol)}&timeframe=${tf}&limit=${limit}`);
    const cols = d.columns || [];
    const at = (name) => cols.indexOf(name);
    const iDate = at('__date_ts') >= 0 ? at('__date_ts') : at('date');
    const rows = (d.data || []).map((r) => ({
      time: typeof r[iDate] === 'number' ? Math.floor(r[iDate] / (r[iDate] > 1e12 ? 1000 : 1)) : Math.floor(Date.parse(r[iDate]) / 1000),
      open: +r[at('open')], high: +r[at('high')], low: +r[at('low')], close: +r[at('close')], volume: +r[at('volume')],
    }));
    if (!rows.length) throw new ProviderError(`Freqtrade has no ${tf} candles for ${inst.symbol} (only whitelisted pairs at the strategy timeframe)`);
    return cleanCandles(rows);
  },
  ticker() {
    return unsupported('A ticker');
  },
  orderbook() {
    return unsupported('An order book');
  },
  async test(p, ctx) {
    const cfg = await ctx.freqtradeApi('GET', '/show_config');
    return `${cfg.strategy} ${cfg.dry_run ? 'dry-run' : 'LIVE'}, ${cfg.state}, timeframe ${cfg.timeframe}`;
  },
};

// ---- Generic REST template: add a provider without writing code ----------------------
// config: {
//   candles_url: "https://host/path?symbol={symbol}&interval={interval}&limit={limit}",
//   rows_path: "data.items"            dot path to the candle array ("" = response root)
//   fields: { time: 0, open: 1, high: 2, low: 3, close: 4, volume: 5 }   index or key
//   time_unit: "ms" | "s",
//   intervals: { "1m": "1m", ... }     provider interval names (defaults to ours)
//   symbol_format: "{base}{quote}"     used when the instrument has no provider_symbol
//   ticker_url, ticker_path, ticker_fields: { price, change_pct, volume_usd }   optional
//   headers: { "X-API-KEY": "{credential}" }   {credential} = value of credential_env
// }
const dig = (obj, dotted) => (dotted ? String(dotted).split('.').reduce((o, k) => (o == null ? o : o[k]), obj) : obj);
function templateUrl(p, template, inst, extra = {}) {
  const { base, quote } = pairParts(inst);
  const symbol = inst.provider_symbol || String((p.config && p.config.symbol_format) || '{base}{quote}').replace('{base}', base).replace('{quote}', quote);
  let url = String(template).replace(/\{(\w+)\}/g, (m, k) => {
    const v = { symbol, base, quote, contract: inst.contract_address || '', network: inst.network || '', ...extra }[k];
    return v === undefined ? m : encodeURIComponent(v);
  });
  if (url.startsWith('/')) url = `${p.base_url}${url}`;
  return url;
}
function templateHeaders(p) {
  const out = {};
  const cred = readCredential(p.credential_env);
  for (const [k, v] of Object.entries((p.config && p.config.headers) || {})) out[k] = String(v).replace('{credential}', cred || '');
  return out;
}
const restTemplate = {
  async candles(p, inst, tf, limit) {
    const c = p.config || {};
    if (!c.candles_url) throw new ProviderError('rest_template provider has no candles_url in its config');
    const interval = (c.intervals && c.intervals[tf]) || tf;
    const body = await getJson(templateUrl(p, c.candles_url, inst, { interval, limit }), { headers: templateHeaders(p) });
    const rows = dig(body, c.rows_path);
    if (!Array.isArray(rows)) throw new ProviderError(`rows_path "${c.rows_path || ''}" is not an array in the response`);
    const f = { time: 0, open: 1, high: 2, low: 3, close: 4, volume: 5, ...(c.fields || {}) };
    const div = c.time_unit === 's' ? 1 : 1000;
    return cleanCandles(rows.map((r) => {
      const t = r[f.time];
      return {
        time: typeof t === 'string' && !/^\d+$/.test(t) ? Math.floor(Date.parse(t) / 1000) : Math.floor(Number(t) / div),
        open: num(r[f.open]), high: num(r[f.high]), low: num(r[f.low]), close: num(r[f.close]), volume: num(r[f.volume]) || 0,
      };
    })).slice(-limit);
  },
  async ticker(p, inst) {
    const c = p.config || {};
    if (!c.ticker_url) return unsupported('A ticker');
    const body = dig(await getJson(templateUrl(p, c.ticker_url, inst), { headers: templateHeaders(p) }), c.ticker_path);
    const f = { price: 'price', change_pct: 'change_pct', volume_usd: 'volume_usd', ...(c.ticker_fields || {}) };
    return { price: num(dig(body, f.price)), changePct: num(dig(body, f.change_pct)), volumeUsd: num(dig(body, f.volume_usd)) };
  },
  orderbook() {
    return unsupported('An order book');
  },
  async test(p) {
    const c = p.config || {};
    const sample = { symbol: c.test_symbol || 'BTC/USDT', provider_symbol: c.test_provider_symbol || null };
    const candles = await restTemplate.candles(p, sample, '1h', 5);
    if (!candles.length) throw new ProviderError('the template returned no candles');
    return `${candles.length} candles for ${sample.symbol}, last close ${candles[candles.length - 1].close}`;
  },
};

// Kinds, with the fields the Settings UI shows for each.
const KINDS = {
  binance: { label: 'Binance spot (or a Binance-compatible API)', adapter: binanceFamily('/api/v3'), defaults: { base_url: 'https://api.binance.com' }, symbolHint: 'BTCUSDT', config: [] },
  binance_futures: { label: 'Binance USD-M futures', adapter: binanceFamily('/fapi/v1'), defaults: { base_url: 'https://fapi.binance.com' }, symbolHint: 'BTCUSDT', config: [] },
  okx: { label: 'OKX', adapter: okx, defaults: { base_url: 'https://www.okx.com', config: { instType: 'SPOT' } }, symbolHint: 'BTC-USDT or BTC-USDT-SWAP', config: [{ key: 'instType', label: 'Instrument type', options: ['SPOT', 'SWAP'] }] },
  bybit: { label: 'Bybit', adapter: bybit, defaults: { base_url: 'https://api.bybit.com', config: { category: 'spot' } }, symbolHint: 'BTCUSDT', config: [{ key: 'category', label: 'Category', options: ['spot', 'linear', 'inverse'] }] },
  geckoterminal: { label: 'GeckoTerminal (DEX pools)', adapter: geckoterminal, defaults: { base_url: 'https://api.geckoterminal.com/api/v2' }, symbolHint: 'network:pool_address, e.g. eth:0xa43f…', config: [] },
  yahoo: { label: 'Yahoo Finance (stocks, ETFs)', adapter: yahoo, defaults: { base_url: 'https://query1.finance.yahoo.com' }, symbolHint: 'SPY, AAPL, ^GSPC', config: [] },
  freqtrade: { label: 'Freqtrade bot API', adapter: freqtrade, defaults: { base_url: 'http://127.0.0.1:8080' }, symbolHint: 'BTC/USDT (whitelisted pairs)', config: [] },
  rest_template: {
    label: 'Generic REST (URL template)',
    adapter: restTemplate,
    defaults: { base_url: 'https://', config: { candles_url: '/klines?symbol={symbol}&interval={interval}&limit={limit}', rows_path: '', fields: { time: 0, open: 1, high: 2, low: 3, close: 4, volume: 5 }, time_unit: 'ms' } },
    symbolHint: 'as the provider expects it',
    config: [{ key: '*', label: 'Config (JSON)', json: true }],
    credentials: true,
  },
};

function adapterFor(provider) {
  const kind = KINDS[provider.kind];
  if (!kind) throw new ProviderError(`Unknown provider kind "${provider.kind}"`, { status: 400 });
  return kind.adapter;
}

// Outbound URL guard for user-configured providers: https only, no loopback or private
// ranges (the freqtrade kind is the one local integration and is not configurable).
function validateBaseUrl(kind, baseUrl) {
  if (kind === 'freqtrade') return null;
  let u;
  try {
    u = new URL(baseUrl);
  } catch (e) {
    return 'base_url is not a valid URL';
  }
  if (u.protocol !== 'https:') return 'base_url must use https';
  const h = u.hostname.toLowerCase();
  if (h === 'localhost' || h.endsWith('.localhost') || h.endsWith('.internal') || h.endsWith('.ts.net') ||
      /^(127\.|10\.|192\.168\.|169\.254\.|0\.|100\.(6[4-9]|[7-9]\d|1[01]\d|12[0-7])\.)/.test(h) ||
      /^172\.(1[6-9]|2\d|3[01])\./.test(h) || h.startsWith('[') ) {
    return 'base_url must be a public host';
  }
  return null;
}

module.exports = { KINDS, TIMEFRAMES, TIMEFRAME_SECONDS, ProviderError, adapterFor, validateBaseUrl, CREDENTIALS_FILE };
