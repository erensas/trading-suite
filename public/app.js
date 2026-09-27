// Trading view: markets (chart + side panel), screener, engine tables, logs.
// Watchlists, search and instrument sources live in watchlists.js; settings, providers,
// instruments and integrations in settings.js.

const TIMEFRAMES = ['1m', '5m', '15m', '1h', '4h', '1d'];
const TF_SECONDS = { '1m': 60, '5m': 300, '15m': 900, '1h': 3600, '4h': 14400, '1d': 86400 };
const CATEGORY_LABELS = { CEX: 'CEX spot', CEX_FUTURES: 'CEX futures', DEX: 'DEX', TRADFI: 'TradFi' };
const CATEGORY_PILL = { CEX: 'pill-green', CEX_FUTURES: 'pill-warn', DEX: 'pill-purple', TRADFI: 'pill-blue' };

const TS = {
  settings: {},
  pairs: [],
  activeSymbol: null,
  activeTf: '15m',
  candles: [],
  markers: [],
  showMarkers: true,
  activeTab: 'chart',
  candleRequest: 0,
  // Chosen data source per symbol (listing id); none = automatic, in priority order.
  sourceChoice: {},
  listings: [],
};
window.TS = TS;

const storage = {
  get(key, fallback) {
    try {
      const v = localStorage.getItem(`ts.${key}`);
      return v === null ? fallback : JSON.parse(v);
    } catch (e) {
      return fallback;
    }
  },
  set(key, value) {
    try {
      localStorage.setItem(`ts.${key}`, JSON.stringify(value));
    } catch (e) {}
  },
};

// ---- helpers --------------------------------------------------------------------
const $ = (id) => document.getElementById(id);
const esc = (v) => escapeHtml(v);

async function api(url, options = {}) {
  const res = await fetch(url, options);
  let body;
  try {
    body = await res.json();
  } catch (e) {
    throw new Error(`HTTP ${res.status}`);
  }
  if (!res.ok || body.success === false) {
    const err = new Error(body.error || `HTTP ${res.status}`);
    err.unsupported = !!body.unsupported;
    throw err;
  }
  return body;
}
const apiSend = (method, url, body) =>
  api(url, { method, headers: CONTROL_HEADERS, body: body === undefined ? undefined : JSON.stringify(body) });
TS.api = api;
TS.apiSend = apiSend;

// Number formatting: cached Intl formatters, 4 significant digits below 1, and the
// subscript-zero notation for micro prices (0.00000439 -> 0.0₅439).
const NUMBER_FORMATS = new Map();
function nf(options) {
  const key = JSON.stringify(options);
  if (!NUMBER_FORMATS.has(key)) NUMBER_FORMATS.set(key, new Intl.NumberFormat('en-US', options));
  return NUMBER_FORMATS.get(key);
}
const SUBSCRIPT = '₀₁₂₃₄₅₆₇₈₉';
const toNumber = (v) => (v === null || v === undefined || v === '' ? NaN : Number(v));

function fmtPrice(v) {
  const n = toNumber(v);
  if (!Number.isFinite(n)) return '-';
  const a = Math.abs(n);
  if (a === 0) return '0';
  if (a >= 1000) return nf({ maximumFractionDigits: 2 }).format(n);
  if (a >= 1) return nf({ maximumFractionDigits: 4 }).format(n);
  if (a >= 0.001) return nf({ maximumSignificantDigits: 4 }).format(n);
  const [mantissa, exp] = a.toExponential(3).split('e');
  const zeros = -Number(exp) - 1;
  const digits = mantissa.replace('.', '').replace(/0+$/, '');
  const sub = String(zeros).split('').map((d) => SUBSCRIPT[d]).join('');
  return `${n < 0 ? '-' : ''}0.0${sub}${digits}`;
}
// Direction is shown by an arrow as well as by colour.
function fmtPct(v) {
  const n = toNumber(v);
  if (!Number.isFinite(n)) return '-';
  const arrow = n > 0 ? '▲ ' : n < 0 ? '▼ ' : '';
  return `${arrow}${nf({ minimumFractionDigits: 2, maximumFractionDigits: 2 }).format(Math.abs(n))}%`;
}
function fmtCompact(v) {
  const n = toNumber(v);
  if (!Number.isFinite(n)) return '-';
  return nf({ notation: 'compact', maximumFractionDigits: 2 }).format(n);
}
function fmtUsd(v, digits = 2) {
  const n = toNumber(v);
  if (!Number.isFinite(n)) return '-';
  return nf({ style: 'currency', currency: 'USD', minimumFractionDigits: digits, maximumFractionDigits: digits }).format(n);
}
function fmtTime(v) {
  if (!v) return '-';
  const d = new Date(v);
  return Number.isNaN(d.getTime()) ? '-' : d.toLocaleString('en-GB', { dateStyle: 'short', timeStyle: 'short' });
}
function ago(v) {
  if (!v) return '-';
  const s = Math.max(0, (Date.now() - new Date(v).getTime()) / 1000);
  if (s < 90) return `${Math.round(s)}s ago`;
  if (s < 5400) return `${Math.round(s / 60)}m ago`;
  if (s < 129600) return `${Math.round(s / 3600)}h ago`;
  return `${Math.round(s / 86400)}d ago`;
}
const changeClass = (v) => (Number(v) > 0 ? 'pos' : Number(v) < 0 ? 'neg' : 'muted');
const pairBySymbol = (s) => TS.pairs.find((p) => p.symbol === s);
TS.fmt = { fmtPrice, fmtPct, fmtCompact, fmtUsd, fmtTime, ago };
TS.util = { storage, changeClass, pairBySymbol, CATEGORY_LABELS, CATEGORY_PILL };

// ---- data freshness -----------------------------------------------------------------
// Each loader reports success (markFresh) or failure (markError); every [data-age] label
// shows how old its data is and turns amber once it is older than expected.
const FRESH = {};
const STALE_AFTER_S = { candles: 60, orderbook: 20, pairs: 120, overview: 60, freqtrade: 40, dex: 40, news: 900, economist: 900 };
const RETRY = {};

function shortAge(seconds) {
  if (seconds < 60) return `${Math.max(0, Math.round(seconds))}s`;
  if (seconds < 3600) return `${Math.round(seconds / 60)}m`;
  if (seconds < 86400) return `${Math.round(seconds / 3600)}h`;
  return `${Math.round(seconds / 86400)}d`;
}
function markFresh(key, at = Date.now()) {
  FRESH[key] = { at, error: null };
  renderAges(key);
}
function markError(key, message) {
  FRESH[key] = { at: FRESH[key] ? FRESH[key].at : null, error: message || 'update failed' };
  renderAges(key);
}
function renderAges(only) {
  document.querySelectorAll(only ? `[data-age="${only}"]` : '[data-age]').forEach((el) => {
    const key = el.dataset.age;
    const f = FRESH[key];
    if (!f) {
      el.textContent = '';
      return;
    }
    const age = f.at ? (Date.now() - f.at) / 1000 : null;
    const stale = !!f.error || age === null || age > (STALE_AFTER_S[key] || 120);
    el.classList.toggle('stale', stale);
    el.textContent = f.error ? `⚠ ${age === null ? 'no data' : `${shortAge(age)} old`}` : `${shortAge(age)} ago`;
    el.title = f.error ? `Last update failed: ${f.error}` : `Updated ${new Date(f.at).toLocaleTimeString('en-GB')}`;
  });
}
const retryButton = (key) => `<button type="button" class="icon-btn" data-retry="${key}"><i class="fa-solid fa-rotate-right" aria-hidden="true"></i> Retry</button>`;

function showToast(title, message, type = 'info') {
  const container = $('toast-container');
  if (!container) return;
  const toast = document.createElement('div');
  toast.className = `toast-card toast-${type}`;
  toast.innerHTML = `<div class="t">${esc(title)}</div><div class="m">${message}</div>`;
  container.appendChild(toast);
  setTimeout(() => {
    toast.style.transition = 'opacity 0.3s';
    toast.style.opacity = '0';
    setTimeout(() => toast.remove(), 300);
  }, 4500);
}
window.showToast = showToast;

// ---- chart (Lightweight Charts 5: panes for oscillators, markers as a plugin) -----------
const LC = LightweightCharts;
let chart = null;
let candleSeries = null;
let volumeSeries = null;
let markersApi = null;

function initChart() {
  const el = $('chart-wrapper');
  chart = LC.createChart(el, {
    width: el.clientWidth,
    height: el.clientHeight,
    layout: {
      background: { type: 'solid', color: '#020617' }, textColor: '#94a3b8', fontSize: 11, fontFamily: "'JetBrains Mono Variable', ui-monospace, monospace",
      panes: { separatorColor: '#1e293b', separatorHoverColor: 'rgba(56, 189, 248, 0.25)', enableResize: true },
    },
    grid: { vertLines: { color: '#111c33' }, horzLines: { color: '#111c33' } },
    crosshair: { mode: LC.CrosshairMode.Normal },
    localization: { priceFormatter: fmtPrice },
    rightPriceScale: { borderColor: '#1e293b' },
    timeScale: { borderColor: '#1e293b', timeVisible: true, secondsVisible: false },
  });
  candleSeries = chart.addSeries(LC.CandlestickSeries, {
    upColor: '#10b981', downColor: '#f43f5e', borderUpColor: '#10b981', borderDownColor: '#f43f5e', wickUpColor: '#10b981', wickDownColor: '#f43f5e',
  });
  volumeSeries = chart.addSeries(LC.HistogramSeries, { priceScaleId: 'vol', priceFormat: { type: 'volume' }, lastValueVisible: false, priceLineVisible: false });
  chart.priceScale('vol').applyOptions({ scaleMargins: { top: 0.82, bottom: 0 } });
  markersApi = LC.createSeriesMarkers(candleSeries, []);
  new ResizeObserver(() => chart.applyOptions({ width: el.clientWidth, height: el.clientHeight })).observe(el);
  chart.subscribeCrosshairMove((param) => {
    const bar = param && param.time ? param.seriesData.get(candleSeries) : null;
    renderLegend(bar, param);
  });
  TS.chart = chart;
  TS.candleSeries = candleSeries;
  TS.volumeSeries = volumeSeries;
}

// OHLCV legend: the bar under the crosshair, or the last bar; indicator values below it.
function renderLegend(bar, param) {
  const box = $('chart-legend');
  if (!box) return;
  const c = bar || TS.candles[TS.candles.length - 1];
  if (!c) {
    box.innerHTML = '';
    return;
  }
  const full = TS.candles.find((x) => x.time === c.time) || c;
  const chg = full.open ? ((full.close - full.open) / full.open) * 100 : null;
  const cls = changeClass(chg);
  box.innerHTML = `<span class="lg-sym">${esc(TS.activeSymbol || '')} · ${esc(TS.activeTf)}</span>
    <span>O <b class="${cls}">${fmtPrice(full.open)}</b></span><span>H <b class="${cls}">${fmtPrice(full.high)}</b></span>
    <span>L <b class="${cls}">${fmtPrice(full.low)}</b></span><span>C <b class="${cls}">${fmtPrice(full.close)}</b></span>
    ${chg === null ? '' : `<span class="${cls}">${fmtPct(chg)}</span>`}
    ${full.volume ? `<span>V <b>${fmtCompact(full.volume)}</b></span>` : ''}
    ${TS.studies ? TS.studies.legend(param) : ''}`;
}

// Entry, stop-loss and liquidation lines of open Freqtrade trades on the active pair.
let tradeLines = [];
async function loadTradeLines() {
  const symbol = TS.activeSymbol;
  let trades = [];
  if (symbol && TS.showMarkers) {
    try {
      const d = await api('api/integrations/freqtrade');
      trades = (d.openTrades || []).filter((t) => String(t.pair || '').split(':')[0] === symbol);
    } catch (e) {
      trades = [];
    }
  }
  if (symbol !== TS.activeSymbol || !candleSeries) return;
  tradeLines.forEach((l) => candleSeries.removePriceLine(l));
  tradeLines = [];
  const dashed = LC.LineStyle.Dashed;
  for (const t of trades) {
    const side = t.is_short ? 'short' : 'long';
    const add = (price, color, title) => {
      if (Number(price) > 0) tradeLines.push(candleSeries.createPriceLine({ price: Number(price), color, lineWidth: 1, lineStyle: dashed, axisLabelVisible: true, title }));
    };
    add(t.open_rate, '#38bdf8', `#${t.id} ${side} entry`);
    add(t.stop_loss_abs, '#fb7185', `#${t.id} stop`);
    add(t.liquidation_price, '#f59e0b', `#${t.id} liq.`);
  }
}

function priceFormatFor(candles) {
  const last = candles.length ? Math.abs(candles[candles.length - 1].close) : 1;
  let precision = 2;
  if (last < 1) precision = Math.min(10, Math.max(4, Math.ceil(-Math.log10(last)) + 3));
  else if (last < 10) precision = 4;
  return { type: 'price', precision, minMove: Number((1 / 10 ** precision).toFixed(precision)) };
}

function chartMessage(text) {
  const box = $('chart-message');
  box.classList.toggle('hidden', !text);
  box.innerHTML = text || '';
}

function volumeData(candles) {
  return candles.map((c) => ({ time: c.time, value: c.volume || 0, color: c.close >= c.open ? 'rgba(16,185,129,0.35)' : 'rgba(244,63,94,0.35)' }));
}

async function loadCandles({ incremental = false } = {}) {
  const symbol = TS.activeSymbol;
  const tf = TS.activeTf;
  if (!symbol) return;
  const request = ++TS.candleRequest;
  if (!incremental) chartMessage('<i class="fa-solid fa-spinner fa-spin" aria-hidden="true"></i>&nbsp; Loading candles…');
  try {
    const listing = TS.sourceChoice[symbol];
    const data = await api(`api/trading/candles?symbol=${encodeURIComponent(symbol)}&tf=${tf}&limit=${TS.settings.candleLimit || 300}${listing ? `&listing=${listing}` : ''}`);
    if (request !== TS.candleRequest) return;
    const candles = data.candles || [];
    const fellBack = (data.fallbackFrom || []).map((f) => `${f.provider}: ${f.error}`);
    $('chart-source').textContent = `${fellBack.length ? '⚠ ' : ''}${data.provider.name} · ${data.source !== data.provider.name ? data.source : tf}`;
    $('chart-source').title = fellBack.length ? `Fell back to ${data.provider.name} because\n${fellBack.join('\n')}` : data.source;
    $('chart-source').classList.toggle('warn', fellBack.length > 0);
    if (data.stale) {
      FRESH.candles = { at: Date.parse(data.fetchedAt) || null, error: data.staleReason || 'provider failed; showing the last good candles' };
      renderAges('candles');
    } else {
      markFresh('candles');
    }
    if (!candles.length) {
      TS.candles = [];
      candleSeries.setData([]);
      volumeSeries.setData([]);
      chartMessage(`${esc(data.provider.name)} returned no ${tf} candles for ${esc(symbol)}.`);
      return;
    }
    const prevLast = TS.candles.length ? TS.candles[TS.candles.length - 1].time : null;
    const sameSeries = incremental && prevLast !== null && TS.candles.length && candles[0].time <= prevLast;
    TS.candles = candles;
    if (sameSeries) {
      candles.filter((c) => c.time >= prevLast).forEach((c) => {
        candleSeries.update(c);
        volumeSeries.update(volumeData([c])[0]);
      });
    } else {
      candleSeries.applyOptions({ priceFormat: priceFormatFor(candles) });
      candleSeries.setData(candles);
      volumeSeries.setData(showVolume() ? volumeData(candles) : []);
      chart.timeScale().fitContent();
      chart.timeScale().scrollToRealTime();
    }
    chartMessage(null);
    if (TS.studies) TS.studies.update();
    applyMarkers();
    updateLivePrice(candles);
    renderLegend(null);
  } catch (e) {
    if (request !== TS.candleRequest) return;
    TS.candles = [];
    candleSeries.setData([]);
    volumeSeries.setData([]);
    chartMessage(`<div><i class="fa-solid fa-triangle-exclamation" aria-hidden="true"></i> No chart for <b>${esc(symbol)}</b> (${tf})<br><span class="muted">${esc(e.message)}</span><br><span class="hint">Pick another timeframe or another source (plug button), or add a source.</span><br>${retryButton('candles')}</div>`);
    $('chart-source').textContent = '-';
    markError('candles', e.message);
    renderLegend(null);
  }
}

function updateLivePrice(candles) {
  const last = candles[candles.length - 1];
  const pair = pairBySymbol(TS.activeSymbol);
  $('active-price').textContent = fmtPrice(last.close);
  const chg = pair && pair.change_24h_pct !== null && pair.change_24h_pct !== undefined ? Number(pair.change_24h_pct) : null;
  const el = $('active-change');
  el.textContent = chg === null ? '' : fmtPct(chg);
  el.className = `change ${chg === null ? '' : changeClass(chg)}`;
  const entry = $('calc-entry');
  if (entry && (!Number(entry.value) || entry.dataset.symbol !== TS.activeSymbol)) {
    entry.value = Number(last.close.toPrecision(6));
    entry.dataset.symbol = TS.activeSymbol;
    calculatePnL();
  }
}

// Volume: the chart layout decides (studies.js); the global setting is the fallback.
function showVolume() {
  if (TS.layout && typeof TS.layout.showVolume === 'boolean') return TS.layout.showVolume;
  return TS.settings.showVolume !== false;
}
TS.refreshVolume = () => volumeSeries && volumeSeries.setData(showVolume() ? volumeData(TS.candles) : []);

async function loadMarkers() {
  if (!TS.activeSymbol) return;
  try {
    const data = await api(`api/trading/chart-markers?symbol=${encodeURIComponent(TS.activeSymbol)}`);
    TS.markers = data.markers || [];
  } catch (e) {
    TS.markers = [];
  }
  applyMarkers();
  loadTradeLines();
}

// Markers must sit on an existing bar: snap each to the bar that contains it and drop
// the ones outside the loaded range.
function applyMarkers() {
  if (!markersApi) return;
  if (!TS.showMarkers || !TS.candles.length) return markersApi.setMarkers([]);
  const times = TS.candles.map((c) => c.time);
  const first = times[0];
  const lastEnd = times[times.length - 1] + TF_SECONDS[TS.activeTf];
  const snapped = [];
  for (const m of TS.markers) {
    if (m.time < first || m.time >= lastEnd) continue;
    let lo = 0;
    let hi = times.length - 1;
    while (lo < hi) {
      const mid = (lo + hi + 1) >> 1;
      if (times[mid] <= m.time) lo = mid;
      else hi = mid - 1;
    }
    snapped.push({ time: times[lo], position: m.position, color: m.color, shape: m.shape, text: m.text });
  }
  snapped.sort((a, b) => a.time - b.time);
  markersApi.setMarkers(snapped);
}

// ---- pairs ---------------------------------------------------------------------------
async function loadPairs() {
  try {
    const data = await api('api/trading/pairs?all=1');
    TS.pairs = data.pairs || [];
    markFresh('pairs');
  } catch (e) {
    markError('pairs', e.message);
    if (!TS.pairs.length) showToast('Instruments', esc(e.message), 'error');
  }
  renderScreener();
  if (TS.activeSymbol) updateHeader();
  document.dispatchEvent(new CustomEvent('ts:pairs'));
}
TS.reloadPairs = loadPairs;

function matchesFilter(p, q, cat) {
  if (cat && cat !== 'ALL' && p.category !== cat) return false;
  if (!q) return true;
  return [p.symbol, p.name, p.exchange, p.provider_name, p.category].some((v) => String(v || '').toLowerCase().includes(q));
}

function updateHeader() {
  const p = pairBySymbol(TS.activeSymbol);
  $('active-symbol-title').textContent = TS.activeSymbol || '-';
  const pill = $('active-category-pill');
  pill.textContent = p ? CATEGORY_LABELS[p.category] || p.category : '-';
  pill.className = `pill ${p ? CATEGORY_PILL[p.category] || 'pill-gray' : 'pill-gray'}`;
}

function selectPair(symbol, { switchTab = false } = {}) {
  if (!symbol) return;
  const changed = symbol !== TS.activeSymbol;
  TS.activeSymbol = symbol;
  storage.set('symbol', symbol);
  updateHeader();
  document.dispatchEvent(new CustomEvent('ts:symbol', { detail: symbol }));
  if (switchTab) showTab('chart');
  if (changed) syncUrl(true);
  if (!changed && TS.candles.length) return;
  TS.candles = [];
  TS.markers = [];
  delete FRESH.candles;
  delete FRESH.orderbook;
  renderAges();
  $('active-price').textContent = '-';
  $('active-change').textContent = '';
  $('ob-mid-price').textContent = '-';
  loadSources();
  loadCandles();
  loadMarkers();
  loadOrderbook();
  loadEconomist();
  loadNews();
}
TS.selectPair = selectPair;

// Data source choice for the chart: "Auto" (priority order) or one listing.
async function loadSources() {
  const symbol = TS.activeSymbol;
  const select = $('source-select');
  try {
    const d = await api(`api/instruments/${encodeURIComponent(symbol)}`);
    if (symbol !== TS.activeSymbol) return;
    TS.listings = d.listings;
    const chosen = TS.sourceChoice[symbol];
    if (chosen && !d.listings.some((l) => l.id === chosen)) delete TS.sourceChoice[symbol];
    select.innerHTML = [`<option value="">Auto (${d.listings.length} source${d.listings.length === 1 ? '' : 's'})</option>`]
      .concat(d.listings.map((l) => `<option value="${l.id}" ${l.enabled && l.provider.enabled ? '' : 'disabled'}>${esc(l.provider.name)}${l.provider_symbol ? ` · ${esc(l.provider_symbol)}` : ''}${l.enabled ? '' : ' (off)'}</option>`))
      .join('');
    select.value = TS.sourceChoice[symbol] ? String(TS.sourceChoice[symbol]) : '';
  } catch (e) {
    select.innerHTML = '<option value="">Auto</option>';
  }
}
TS.loadSources = loadSources;

function chooseSource(listingId) {
  const symbol = TS.activeSymbol;
  if (listingId) TS.sourceChoice[symbol] = Number(listingId);
  else delete TS.sourceChoice[symbol];
  storage.set('sources', TS.sourceChoice);
  TS.candles = [];
  loadCandles();
}

function setTimeframe(tf) {
  if (!TIMEFRAMES.includes(tf)) return;
  TS.activeTf = tf;
  storage.set('tf', tf);
  markTimeframe();
  syncUrl(false);
  TS.candles = [];
  loadCandles();
}
function markTimeframe() {
  document.querySelectorAll('#tf-group .tf-btn').forEach((b) => {
    b.classList.toggle('active', b.dataset.tf === TS.activeTf);
    b.setAttribute('aria-pressed', String(b.dataset.tf === TS.activeTf));
  });
}

// ---- URL state ------------------------------------------------------------------------
// #markets/<pair>/<tf>, #screener, #freqtrade, #dex, #settings/<pane>, #logs. The shell
// owns #system and #frequi. Tab and pair changes add a history entry (Back works), a
// timeframe change replaces it.
const ROUTE_OF_TAB = { chart: 'markets', screener: 'screener', freqtrade: 'freqtrade', dex: 'dex', settings: 'settings', logs: 'logs' };
const TAB_OF_ROUTE = Object.fromEntries(Object.entries(ROUTE_OF_TAB).map(([t, r]) => [r, t]));
let routing = false;

function currentRoute() {
  const route = ROUTE_OF_TAB[TS.activeTab] || 'markets';
  if (route === 'markets' && TS.activeSymbol) return `markets/${encodeURIComponent(TS.activeSymbol)}/${TS.activeTf}`;
  if (route === 'settings') return `settings/${TS.settingsPane || 'general'}`;
  return route;
}
function syncUrl(push) {
  if (routing || document.getElementById('view-trading').classList.contains('hidden')) return;
  const hash = `#${currentRoute()}`;
  if (location.hash === hash) return;
  history[push ? 'pushState' : 'replaceState'](null, '', hash);
}
TS.syncUrl = syncUrl;

function parseRoute(hash) {
  const [head, a, b] = String(hash || '').replace(/^#/, '').split('/');
  const tab = TAB_OF_ROUTE[head];
  if (!tab) return null;
  const route = { tab };
  if (tab === 'chart') {
    try {
      route.symbol = a ? decodeURIComponent(a) : null;
    } catch (e) {
      route.symbol = null;
    }
    route.tf = TIMEFRAMES.includes(b) ? b : null;
  }
  if (tab === 'settings' && a) route.pane = a;
  return route;
}
function applyRoute(route) {
  if (!route) return;
  routing = true;
  try {
    if (route.pane && TS.setSettingsPane) TS.setSettingsPane(route.pane);
    if (route.tf && route.tf !== TS.activeTf) {
      TS.activeTf = route.tf;
      markTimeframe();
      TS.candles = [];
    }
    if (route.symbol && pairBySymbol(route.symbol)) selectPair(route.symbol);
    else if (route.tf && TS.activeSymbol) loadCandles();
    showTab(route.tab);
  } finally {
    routing = false;
  }
}
TS.applyRoute = (hash) => applyRoute(parseRoute(hash));

// ---- side panel ----------------------------------------------------------------
async function loadOrderbook() {
  const symbol = TS.activeSymbol;
  if (!symbol) return;
  const asks = $('ob-asks-container');
  const bids = $('ob-bids-container');
  try {
    const data = await api(`api/trading/orderbook?symbol=${encodeURIComponent(symbol)}`);
    if (symbol !== TS.activeSymbol) return;
    $('ob-provider').textContent = data.provider ? `· ${data.provider}` : '';
    const rows = (list, side) => {
      const top = list.slice(0, 8);
      const maxQty = Math.max(...top.map((x) => Number(x[1])), 0) || 1;
      return top
        .map(([price, qty]) => `
          <div class="ob-row"><div class="ob-bar ${side}" style="width:${Math.min(100, (Number(qty) / maxQty) * 100)}%"></div>
            <span class="${side === 'bid' ? 'pos' : 'neg'}">${fmtPrice(price)}</span><span>${fmtCompact(qty)}</span><span class="muted">${fmtCompact(Number(price) * Number(qty))}</span></div>`)
        .join('');
    };
    asks.innerHTML = rows(data.asks, 'ask');
    bids.innerHTML = rows(data.bids, 'bid');
    const ask = Number(data.asks[0] && data.asks[0][0]);
    const bid = Number(data.bids[0] && data.bids[0][0]);
    $('ob-mid-price').textContent = ask && bid ? `${fmtPrice((ask + bid) / 2)}  ·  spread ${(((ask - bid) / ((ask + bid) / 2)) * 100).toFixed(3)}%` : '-';
    markFresh('orderbook');
  } catch (e) {
    if (symbol !== TS.activeSymbol) return;
    asks.innerHTML = '';
    bids.innerHTML = '';
    $('ob-provider').textContent = '';
    if (e.unsupported) {
      delete FRESH.orderbook;
      renderAges('orderbook');
      $('ob-mid-price').innerHTML = '<span class="muted small">No order book from this provider</span>';
    } else {
      markError('orderbook', e.message);
      $('ob-mid-price').innerHTML = `<span class="muted small">${esc(e.message)}</span> ${retryButton('orderbook')}`;
    }
  }
}

async function loadEconomist() {
  const box = $('econ-box');
  try {
    const data = await api(`api/trading/economist?symbol=${encodeURIComponent(TS.activeSymbol)}`);
    const s = data.signal;
    if (!s) {
      box.className = 'econ-box muted';
      box.textContent = 'No economist signal for this pair.';
      return;
    }
    box.className = 'econ-box';
    box.innerHTML = `
      <div class="econ-row"><span class="muted">Profit score</span><strong class="pos">${s.profit_score ?? '-'} / 100 ${s.score_grade ? `<span class="muted">(${esc(s.score_grade)})</span>` : ''}</strong></div>
      <div class="econ-row"><span class="muted">Confidence</span><strong>${s.confidence_pct ?? '-'}%</strong></div>
      <div class="econ-row"><span class="muted">Risk</span><span class="pill pill-purple">${esc(s.risk_level || '-')}</span></div>
      <div class="econ-text">${esc(s.recommendation || '')}</div>
      <div class="hint">Updated ${ago(s.updated_at)}</div>`;
  } catch (e) {
    box.className = 'econ-box muted';
    box.innerHTML = `${esc(e.message)} ${retryButton('economist')}`;
  }
}

async function loadNews() {
  const box = $('news-container');
  try {
    const data = await api(`api/trading/news?symbol=${encodeURIComponent(TS.activeSymbol)}`);
    box.innerHTML = data.news.length
      ? data.news
          .map((n) => `
            <div class="news-item">
              <a href="${esc(/^https?:/.test(n.url || '') ? n.url : '#')}" target="_blank" rel="noopener" class="news-title">${esc(n.title)}</a>
              ${n.summary ? `<div class="small muted">${esc(n.summary)}</div>` : ''}
              <div class="news-meta"><span>${esc(n.source || '')}</span><span>${fmtTime(n.published_at)}</span></div>
            </div>`)
          .join('')
      : '<div class="muted small">No news for this pair.</div>';
    markFresh('news');
  } catch (e) {
    markError('news', e.message);
    box.innerHTML = `<div class="muted small">${esc(e.message)} ${retryButton('news')}</div>`;
  }
}

function calculatePnL() {
  const v = (id) => parseFloat($(id).value) || 0;
  const entry = v('calc-entry');
  const margin = v('calc-margin');
  const lev = Math.max(1, v('calc-leverage'));
  const size = margin * lev;
  const tp = size * (v('calc-tp') / 100);
  const sl = size * (v('calc-sl') / 100);
  $('calc-res-tp').textContent = `+${fmtUsd(tp)} (+${margin ? ((tp / margin) * 100).toFixed(1) : 0}%)`;
  $('calc-res-sl').textContent = `-${fmtUsd(sl)} (-${margin ? ((sl / margin) * 100).toFixed(1) : 0}%)`;
  $('calc-res-rr').textContent = sl > 0 ? `1 : ${(tp / sl).toFixed(2)}` : '-';
  $('calc-res-liq').textContent = lev > 1 && entry ? fmtPrice(entry * (1 - (1 / lev) * 0.9)) : 'n/a (no leverage)';
}

async function submitTestOrder() {
  const side = $('order-side').value;
  const amount = parseFloat($('order-amount').value);
  try {
    await api('api/trading/orders', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ symbol: TS.activeSymbol, side, amount }),
    });
    showToast('Test order recorded', `${esc(TS.activeSymbol)} ${side} ${amount} USDT (simulated)`, 'success');
    loadMarkers();
  } catch (e) {
    showToast('Order failed', esc(e.message), 'error');
  }
}

// ---- overview KPIs ---------------------------------------------------------------
async function loadOverview() {
  try {
    const { summary: s } = await api('api/trading/overview');
    const pnl = Number(s.totalRealizedPnlUsd);
    $('kpi-pnl').innerHTML = `<span class="${changeClass(pnl)}">${fmtUsd(pnl)}</span>`;
    if (s.capital && Number.isFinite(s.capital.value)) {
      $('kpi-capital-label').textContent = `Capital${s.capital.dryRun ? ' (dry-run)' : ''}`;
      $('kpi-capital').textContent = `${s.capital.value.toLocaleString('en-US', { maximumFractionDigits: 2 })} ${s.capital.currency}`;
    } else {
      $('kpi-capital').textContent = '-';
    }
    $('kpi-winrate').textContent = s.winRatePercent === null ? '-' : `${s.winRatePercent}%`;
    $('kpi-open').textContent = s.openTradesCount;
    $('kpi-score').textContent = s.profitScore === null ? '-' : `${s.profitScore} / 100`;
    markFresh('overview');
  } catch (e) {
    markError('overview', e.message);
    ['kpi-pnl', 'kpi-capital', 'kpi-winrate', 'kpi-open', 'kpi-score'].forEach((id) => {
      if ($(id).querySelector('.skeleton')) $(id).textContent = '-';
    });
  }
}

// ---- screener ----------------------------------------------------------------------
let screenerCat = 'ALL';
function renderScreener() {
  const pool = $('screener-inactive').checked ? TS.pairs : TS.pairs.filter((p) => p.is_active !== false);
  const counts = pool.reduce((acc, p) => ((acc[p.category] = (acc[p.category] || 0) + 1), acc), {});
  $('screener-cats').innerHTML = ['ALL', ...Object.keys(CATEGORY_LABELS)]
    .map((c) => `<button type="button" class="tf-btn${c === screenerCat ? ' active' : ''}" aria-pressed="${c === screenerCat}" data-cat="${c}">${c === 'ALL' ? 'All' : CATEGORY_LABELS[c]} (${c === 'ALL' ? pool.length : counts[c] || 0})</button>`)
    .join('');
  const q = $('screener-search').value.trim().toLowerCase();
  const rows = pool.filter((p) => matchesFilter(p, q, screenerCat));
  $('screener-count').textContent = `(${rows.length})`;
  $('screener-tbody').innerHTML = rows.length
    ? rows
        .map((p) => `
          <tr class="clickable" data-symbol="${esc(p.symbol)}" title="Open chart">
            <td><strong>${esc(p.symbol)}</strong></td>
            <td><span class="pill ${CATEGORY_PILL[p.category] || 'pill-gray'}">${esc(CATEGORY_LABELS[p.category] || p.category)}</span></td>
            <td>${esc(p.exchange || '-')}</td>
            <td>${p.provider_name ? `${esc(p.provider_name)}${p.listing_count > 1 ? ` <span class="muted">+${p.listing_count - 1}</span>` : ''}` : '<span class="neg">none</span>'}${p.is_active === false ? ' <span class="pill pill-gray">inactive</span>' : ''}</td>
            <td class="r mono">${fmtPrice(p.last_price)}</td>
            <td class="r ${p.change_24h_pct === null ? 'muted' : changeClass(p.change_24h_pct)}">${fmtPct(p.change_24h_pct)}</td>
            <td class="r">${p.volume_24h_usd === null ? '-' : '$' + fmtCompact(p.volume_24h_usd)}</td>
            <td>${p.profit_score !== null && p.profit_score !== undefined ? `${p.profit_score}${p.score_grade ? ` (${esc(p.score_grade)})` : ''}` : '<span class="muted">-</span>'}</td>
            <td class="muted">${ago(p.updated_at)}</td>
            <td class="r nowrap"><button type="button" class="icon-btn" data-add-to-list="${esc(p.symbol)}" title="Add to the current watchlist" aria-label="Add ${esc(p.symbol)} to the watchlist"><i class="fa-solid fa-plus" aria-hidden="true"></i></button> <button type="button" class="icon-btn" data-sources="${esc(p.symbol)}" title="Data sources" aria-label="Data sources of ${esc(p.symbol)}"><i class="fa-solid fa-plug" aria-hidden="true"></i></button></td>
          </tr>`)
        .join('')
    : '<tr><td colspan="10" class="empty">No instruments match.</td></tr>';
}

// ---- engine tables ---------------------------------------------------------------
async function loadFreqtradeTab() {
  const kv = (k, v) => `<div class="kv"><div class="k">${esc(k)}</div><div class="v">${v}</div></div>`;
  try {
    const d = await api('api/integrations/freqtrade');
    const c = d.config;
    $('ft-state').innerHTML = `<span class="pill ${c.dry_run ? 'pill-warn' : 'pill-red'}">${c.dry_run ? 'DRY-RUN' : 'LIVE'}</span> <span class="pill pill-gray">${esc(c.state)}</span>`;
    $('ft-config').className = 'kv-grid';
    $('ft-config').innerHTML = [
      kv('Strategy', esc(c.strategy)), kv('Exchange', esc(c.exchange)), kv('Timeframe', esc(c.timeframe)),
      kv('Stake', `${esc(c.stake_amount)} ${esc(c.stake_currency)}`), kv('Max open trades', esc(c.max_open_trades)),
      kv('Stoploss', c.stoploss !== undefined ? `${(c.stoploss * 100).toFixed(1)}%` : '-'), kv('Trailing stop', c.trailing_stop ? 'on' : 'off'),
      kv('Trading mode', esc(c.trading_mode || 'spot')), kv('Version', esc(c.version || '-')),
    ].join('');
    const p = d.profit || {};
    $('ft-profit').className = 'kv-grid';
    $('ft-profit').innerHTML = [
      kv('Closed profit', `<span class="${changeClass(p.profit_closed_coin)}">${fmtPrice(p.profit_closed_coin)} ${esc(c.stake_currency)}</span>`),
      kv('All profit', `<span class="${changeClass(p.profit_all_coin)}">${fmtPrice(p.profit_all_coin)} ${esc(c.stake_currency)}</span>`),
      kv('Trades', `${p.trade_count ?? '-'} (${p.closed_trade_count ?? '-'} closed)`),
      kv('Win / loss', `${p.winning_trades ?? '-'} / ${p.losing_trades ?? '-'}`),
      kv('Best pair', esc(p.best_pair || '-')), kv('Max drawdown', p.max_drawdown !== undefined ? `${(p.max_drawdown * 100).toFixed(2)}%` : '-'),
    ].join('');
    $('ft-whitelist').innerHTML = d.whitelist.length
      ? d.whitelist.map((w) => `<button class="pill ${pairBySymbol(w) ? 'pill-blue' : 'pill-gray'}" data-symbol="${esc(w)}" title="${pairBySymbol(w) ? 'Open chart' : 'Not in the instrument registry'}">${esc(w)}</button>`).join('')
      : '<span class="muted small">Empty</span>';
    $('ft-open-tbody').innerHTML = d.openTrades.length
      ? d.openTrades
          .map((t) => `
            <tr class="clickable" data-symbol="${esc(t.pair)}">
              <td class="mono">#${t.id}</td><td><strong>${esc(t.pair)}</strong></td>
              <td class="r mono">${fmtPrice(t.open_rate)}</td><td class="r mono">${fmtPrice(t.current_rate)}</td>
              <td class="r">${fmtPrice(t.stake_amount)}</td>
              <td class="r ${changeClass(t.profit_abs)}">${fmtPrice(t.profit_abs)} (${fmtPct(t.profit_pct)})</td>
              <td>${esc(t.open_date || '-')}</td>
            </tr>`)
          .join('')
      : '<tr><td colspan="7" class="empty">No open trades.</td></tr>';
    markFresh('freqtrade');
  } catch (e) {
    markError('freqtrade', e.message);
    $('ft-state').innerHTML = '<span class="pill pill-red">API unreachable</span>';
    $('ft-config').className = 'kv-grid muted';
    $('ft-config').innerHTML = `Freqtrade API: ${esc(e.message)} ${retryButton('freqtrade')}`;
    $('ft-profit').textContent = '';
    $('ft-whitelist').innerHTML = '';
    $('ft-open-tbody').innerHTML = `<tr><td colspan="7" class="empty">Freqtrade API unreachable. ${retryButton('freqtrade')}</td></tr>`;
  }
  try {
    const d = await api('api/trading/freqtrade');
    $('freqtrade-tbody').innerHTML = d.trades.length
      ? d.trades
          .map((t) => {
            const pnl = Number(t.close_profit_abs ?? t.realized_profit ?? 0);
            return `
              <tr class="clickable" data-symbol="${esc(t.pair)}">
                <td class="mono">#${t.id}</td><td><strong>${esc(t.pair)}</strong></td>
                <td class="r mono">${fmtPrice(t.open_rate)}</td><td class="r mono">${t.close_rate ? fmtPrice(t.close_rate) : '-'}</td>
                <td class="r">${fmtPrice(t.stake_amount)}</td><td>${fmtTime(t.open_date)}</td><td>${t.close_date ? fmtTime(t.close_date) : '-'}</td>
                <td class="r ${t.is_open ? 'muted' : changeClass(pnl)}">${t.is_open ? '-' : fmtPrice(pnl)}</td>
                <td>${esc(t.exit_reason || '-')}</td>
                <td><span class="pill ${t.is_open ? 'pill-blue' : 'pill-gray'}">${t.is_open ? 'OPEN' : 'CLOSED'}</span></td>
              </tr>`;
          })
          .join('')
      : '<tr><td colspan="10" class="empty">No trades.</td></tr>';
  } catch (e) {
    $('freqtrade-tbody').innerHTML = `<tr><td colspan="10" class="empty">${esc(e.message)} ${retryButton('freqtrade')}</td></tr>`;
  }
}

async function loadDexTrades() {
  try {
    const d = await api('api/trading/dex-arbitrage');
    $('dex-tbody').innerHTML = d.trades.length
      ? d.trades
          .map((t) => {
            const pnl = Number(t.pnl_usd || 0);
            const token = t.token_address ? `${t.token_address.slice(0, 6)}…${t.token_address.slice(-4)}` : '-';
            return `
              <tr>
                <td class="mono">#${t.id}</td><td>${fmtTime(t.created_at)}</td>
                <td><span class="pill pill-purple">${esc(t.action || '-')}</span></td>
                <td class="mono" title="${esc(t.token_address || '')}">${esc(token)}</td>
                <td class="r">${fmtPrice(t.amount_in)}</td><td class="r">${fmtPrice(t.amount_out)}</td>
                <td class="r">${t.gas_used ?? '-'}</td>
                <td class="r ${changeClass(pnl)}">${fmtUsd(pnl, 4)}</td>
                <td><span class="pill ${/FAIL|REVERT/i.test(t.status || '') ? 'pill-red' : 'pill-green'}">${esc(t.status || '-')}</span></td>
              </tr>`;
          })
          .join('')
      : '<tr><td colspan="9" class="empty">No executions.</td></tr>';
    markFresh('dex');
  } catch (e) {
    markError('dex', e.message);
    $('dex-tbody').innerHTML = `<tr><td colspan="9" class="empty">${esc(e.message)} ${retryButton('dex')}</td></tr>`;
  }
}

function initLogStream() {
  const box = $('log-console');
  const source = new EventSource('api/trading/logs/stream');
  source.onmessage = (e) => {
    try {
      const msg = JSON.parse(e.data);
      // Every (re)connect resends the tail of the file, so start from a clean view.
      if (msg.type === 'connected') box.innerHTML = '';
      const line = document.createElement('div');
      line.textContent = msg.type === 'log' ? msg.log : `# ${msg.message}`;
      box.appendChild(line);
      while (box.childElementCount > 2000) box.firstElementChild.remove();
      if (box.scrollHeight - box.scrollTop - box.clientHeight < 80) box.scrollTop = box.scrollHeight;
    } catch (err) {}
  };
}

// ---- tabs --------------------------------------------------------------------------
function showTab(tab) {
  if (!document.getElementById(`tab-${tab}`)) tab = 'chart';
  const changed = tab !== TS.activeTab;
  TS.activeTab = tab;
  document.querySelectorAll('.tab-content').forEach((el) => el.classList.toggle('hidden', el.id !== `tab-${tab}`));
  document.querySelectorAll('.tab-btn').forEach((b) => {
    const on = b.dataset.tab === tab;
    b.classList.toggle('active', on);
    b.setAttribute('aria-selected', String(on));
    b.tabIndex = on ? 0 : -1;
  });
  storage.set('tab', tab);
  syncUrl(changed);
  if (tab === 'screener') loadPairs();
  if (tab === 'freqtrade') loadFreqtradeTab();
  if (tab === 'dex') loadDexTrades();
  document.dispatchEvent(new CustomEvent('ts:tab', { detail: tab }));
}
TS.showTab = showTab;
TS.reloadCandles = () => loadCandles();
TS.renderLegend = () => renderLegend(null);
TS.openSettings = (pane) => {
  if (TS.setSettingsPane) TS.setSettingsPane(pane);
  showTab('settings');
};

// ---- wiring --------------------------------------------------------------------------
function setWatchlistVisible(visible) {
  $('markets-layout').classList.toggle('no-watchlist', !visible);
  $('btn-watchlist').classList.toggle('active', visible);
  $('btn-watchlist').setAttribute('aria-pressed', String(visible));
  storage.set('watchlist', visible);
}

function bindEvents() {
  document.querySelectorAll('.tab-btn').forEach((b) => b.addEventListener('click', () => showTab(b.dataset.tab)));
  // Tabs follow the WAI-ARIA pattern: arrow keys, Home and End move between tabs.
  $('nav-tabs').addEventListener('keydown', (e) => {
    const tabs = [...document.querySelectorAll('#nav-tabs [role="tab"]')];
    const i = tabs.indexOf(document.activeElement);
    if (i < 0) return;
    const next = { ArrowRight: i + 1, ArrowLeft: i - 1, Home: 0, End: tabs.length - 1 }[e.key];
    if (next === undefined) return;
    e.preventDefault();
    const target = tabs[(next + tabs.length) % tabs.length];
    target.focus();
    showTab(target.dataset.tab);
  });
  $('tf-group').innerHTML = TIMEFRAMES.map((tf) => `<button type="button" class="tf-btn" data-tf="${tf}" aria-pressed="false">${tf}</button>`).join('');
  $('tf-group').addEventListener('click', (e) => {
    const b = e.target.closest('[data-tf]');
    if (b) setTimeframe(b.dataset.tf);
  });
  $('btn-markers').addEventListener('click', () => {
    TS.showMarkers = !TS.showMarkers;
    $('btn-markers').classList.toggle('active', TS.showMarkers);
    $('btn-markers').setAttribute('aria-pressed', String(TS.showMarkers));
    applyMarkers();
    loadTradeLines();
  });

  // Retry buttons in error states.
  Object.assign(RETRY, {
    candles: () => loadCandles(), orderbook: loadOrderbook, economist: loadEconomist, news: loadNews,
    pairs: loadPairs, freqtrade: loadFreqtradeTab, dex: loadDexTrades, overview: loadOverview,
  });
  document.addEventListener('click', (e) => {
    const b = e.target.closest('[data-retry]');
    if (b && RETRY[b.dataset.retry]) RETRY[b.dataset.retry]();
  });

  window.addEventListener('popstate', () => {
    const view = location.hash.replace('#', '');
    if (typeof switchView === 'function' && ['system', 'frequi'].includes(view)) return switchView(view, { history: false });
    if (typeof switchView === 'function' && $('view-trading').classList.contains('hidden')) switchView('trading', { history: false });
    applyRoute(parseRoute(location.hash));
  });
  $('btn-watchlist').addEventListener('click', () => setWatchlistVisible($('markets-layout').classList.contains('no-watchlist')));

  $('source-select').addEventListener('change', (e) => chooseSource(e.target.value));
  $('screener-inactive').addEventListener('change', renderScreener);

  // Any element with data-symbol opens that pair on the chart.
  document.addEventListener('click', (e) => {
    const target = e.target.closest('[data-symbol]');
    if (!target || target.closest('#tab-settings') || target.closest('.modal-backdrop') || e.target.closest('button[data-add-to-list], button[data-sources], button[data-remove-item]')) return;
    const symbol = target.dataset.symbol;
    if (!pairBySymbol(symbol)) {
      showToast('Not registered', `${esc(symbol)} is not in the instrument registry; find and add it with search (Ctrl+K).`, 'error');
      return;
    }
    selectPair(symbol, { switchTab: !target.closest('#tab-chart') });
  });

  $('screener-search').addEventListener('input', renderScreener);
  $('screener-cats').addEventListener('click', (e) => {
    const b = e.target.closest('[data-cat]');
    if (!b) return;
    screenerCat = b.dataset.cat;
    renderScreener();
  });
  ['calc-entry', 'calc-margin', 'calc-leverage', 'calc-sl', 'calc-tp'].forEach((id) => $(id).addEventListener('input', calculatePnL));
  $('btn-submit-order').addEventListener('click', submitTestOrder);
  $('btn-clear-logs').addEventListener('click', () => ($('log-console').innerHTML = ''));

}

async function init() {
  bindEvents();
  initChart();
  try {
    TS.settings = (await api('api/trading/settings')).settings;
  } catch (e) {
    TS.settings = {};
  }
  TS.showMarkers = TS.settings.showTradeMarkers !== false;
  $('btn-markers').classList.toggle('active', TS.showMarkers);
  $('btn-markers').setAttribute('aria-pressed', String(TS.showMarkers));
  TS.sourceChoice = storage.get('sources', {}) || {};
  setWatchlistVisible(storage.get('watchlist', true));

  await loadPairs();
  // A link (#markets/<pair>/<tf>, #settings/providers, ...) wins over the stored view.
  const route = parseRoute(location.hash);
  const saved = storage.get('symbol', null);
  const symbol = [route && route.symbol, saved, TS.settings.defaultSymbol].find((s) => s && pairBySymbol(s)) || (TS.pairs[0] && TS.pairs[0].symbol);
  const tf = [route && route.tf, storage.get('tf', null), TS.settings.defaultTimeframe].find((t) => TIMEFRAMES.includes(t)) || '15m';
  TS.activeTf = tf;
  markTimeframe();
  if (route && route.pane && TS.setSettingsPane) TS.setSettingsPane(route.pane);
  routing = true;
  if (symbol) selectPair(symbol);
  else chartMessage('No instruments yet. Press Ctrl+K to find and add one.');
  routing = false;

  const tab = route ? route.tab : storage.get('tab', 'chart');
  routing = true;
  showTab(tab);
  routing = false;
  syncUrl(false);
  setInterval(() => renderAges(), 1000);
  loadOverview();
  calculatePnL();
  initLogStream();

  const visible = (tab) => TS.activeTab === tab && !document.hidden && !document.getElementById('view-trading').classList.contains('hidden');
  setInterval(() => visible('chart') && loadCandles({ incremental: true }), 15000);
  setInterval(() => visible('chart') && loadOrderbook(), 5000);
  setInterval(() => visible('chart') && loadMarkers(), 30000);
  setInterval(() => !document.hidden && loadPairs(), 30000);
  setInterval(() => !document.hidden && loadOverview(), 20000);
  setInterval(() => visible('freqtrade') && loadFreqtradeTab(), 10000);
  setInterval(() => visible('dex') && loadDexTrades(), 10000);
}

document.addEventListener('DOMContentLoaded', init);
