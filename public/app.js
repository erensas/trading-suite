// Trading view: markets (watchlist + chart + side panel), screener, engine tables, logs.
// Settings, providers, instruments and integrations live in settings.js.

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
  indicators: { sma20: false, sma50: false, ema200: false },
  showMarkers: true,
  activeTab: 'chart',
  candleRequest: 0,
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

function fmtPrice(v) {
  const n = Number(v);
  if (v === null || v === undefined || v === '' || !Number.isFinite(n)) return '-';
  const a = Math.abs(n);
  if (a >= 1000) return n.toLocaleString('en-US', { maximumFractionDigits: 2 });
  if (a >= 1) return n.toLocaleString('en-US', { maximumFractionDigits: 4 });
  if (a === 0) return '0';
  return n.toPrecision(4);
}
function fmtPct(v) {
  const n = Number(v);
  if (v === null || v === undefined || !Number.isFinite(n)) return '-';
  return `${n >= 0 ? '+' : ''}${n.toFixed(2)}%`;
}
function fmtCompact(v) {
  const n = Number(v);
  if (v === null || v === undefined || !Number.isFinite(n)) return '-';
  return n.toLocaleString('en-US', { notation: 'compact', maximumFractionDigits: 2 });
}
function fmtUsd(v, digits = 2) {
  const n = Number(v);
  if (v === null || v === undefined || !Number.isFinite(n)) return '-';
  return `${n < 0 ? '-' : ''}$${Math.abs(n).toLocaleString('en-US', { minimumFractionDigits: digits, maximumFractionDigits: digits })}`;
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
const changeClass = (v) => (Number(v) >= 0 ? 'pos' : 'neg');
const pairBySymbol = (s) => TS.pairs.find((p) => p.symbol === s);
TS.fmt = { fmtPrice, fmtPct, fmtCompact, fmtUsd, fmtTime, ago };

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

// ---- chart ---------------------------------------------------------------------
let chart = null;
let candleSeries = null;
let volumeSeries = null;
const indicatorSeries = {};
const INDICATOR_STYLE = { sma20: ['#38bdf8', 20, 'sma'], sma50: ['#f59e0b', 50, 'sma'], ema200: ['#a855f7', 200, 'ema'] };

function initChart() {
  const el = $('chart-wrapper');
  chart = LightweightCharts.createChart(el, {
    width: el.clientWidth,
    height: el.clientHeight,
    layout: { background: { type: 'solid', color: '#020617' }, textColor: '#94a3b8', fontSize: 11, fontFamily: 'JetBrains Mono' },
    grid: { vertLines: { color: '#111c33' }, horzLines: { color: '#111c33' } },
    crosshair: { mode: LightweightCharts.CrosshairMode.Normal },
    rightPriceScale: { borderColor: '#1e293b' },
    timeScale: { borderColor: '#1e293b', timeVisible: true, secondsVisible: false },
  });
  candleSeries = chart.addCandlestickSeries({
    upColor: '#10b981', downColor: '#f43f5e', borderUpColor: '#10b981', borderDownColor: '#f43f5e', wickUpColor: '#10b981', wickDownColor: '#f43f5e',
  });
  volumeSeries = chart.addHistogramSeries({ priceScaleId: 'vol', priceFormat: { type: 'volume' }, lastValueVisible: false, priceLineVisible: false });
  chart.priceScale('vol').applyOptions({ scaleMargins: { top: 0.82, bottom: 0 } });
  new ResizeObserver(() => chart.applyOptions({ width: el.clientWidth, height: el.clientHeight })).observe(el);
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
  if (!incremental) chartMessage('<i class="fa-solid fa-spinner fa-spin"></i>&nbsp; Loading candles…');
  try {
    const data = await api(`api/trading/candles?symbol=${encodeURIComponent(symbol)}&tf=${tf}&limit=${TS.settings.candleLimit || 300}`);
    if (request !== TS.candleRequest) return;
    const candles = data.candles || [];
    $('chart-source').textContent = `${data.stale ? '⚠ stale · ' : ''}${data.provider.name} · ${data.source !== data.provider.name ? data.source : tf}`;
    $('chart-source').title = data.stale ? `Showing data from ${data.fetchedAt}: ${data.staleReason}` : data.source;
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
      volumeSeries.setData(TS.settings.showVolume === false ? [] : volumeData(candles));
      chart.timeScale().fitContent();
      chart.timeScale().scrollToRealTime();
    }
    chartMessage(null);
    renderIndicators();
    applyMarkers();
    updateLivePrice(candles);
  } catch (e) {
    if (request !== TS.candleRequest) return;
    TS.candles = [];
    candleSeries.setData([]);
    volumeSeries.setData([]);
    chartMessage(`<div><i class="fa-solid fa-triangle-exclamation"></i> No chart for <b>${esc(symbol)}</b> (${tf})<br><span class="muted">${esc(e.message)}</span><br><span class="hint">Pick another timeframe, or change the instrument's provider in Settings → Instruments.</span></div>`);
    $('chart-source').textContent = '-';
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

function sma(c, n) {
  const out = [];
  let sum = 0;
  for (let i = 0; i < c.length; i++) {
    sum += c[i].close;
    if (i >= n) sum -= c[i - n].close;
    if (i >= n - 1) out.push({ time: c[i].time, value: sum / n });
  }
  return out;
}
function ema(c, n) {
  const out = [];
  const k = 2 / (n + 1);
  let e = null;
  c.forEach((x, i) => {
    e = e === null ? x.close : x.close * k + e * (1 - k);
    if (i >= n - 1) out.push({ time: x.time, value: e });
  });
  return out;
}
function renderIndicators() {
  for (const [key, [color, n, type]] of Object.entries(INDICATOR_STYLE)) {
    if (TS.indicators[key]) {
      if (!indicatorSeries[key]) indicatorSeries[key] = chart.addLineSeries({ color, lineWidth: 2, priceLineVisible: false, lastValueVisible: false, crosshairMarkerVisible: false });
      indicatorSeries[key].setData(type === 'sma' ? sma(TS.candles, n) : ema(TS.candles, n));
    } else if (indicatorSeries[key]) {
      chart.removeSeries(indicatorSeries[key]);
      delete indicatorSeries[key];
    }
  }
}

async function loadMarkers() {
  if (!TS.activeSymbol) return;
  try {
    const data = await api(`api/trading/chart-markers?symbol=${encodeURIComponent(TS.activeSymbol)}`);
    TS.markers = data.markers || [];
  } catch (e) {
    TS.markers = [];
  }
  applyMarkers();
}

// Markers must sit on an existing bar: snap each to the bar that contains it and drop
// the ones outside the loaded range.
function applyMarkers() {
  if (!candleSeries) return;
  if (!TS.showMarkers || !TS.candles.length) return candleSeries.setMarkers([]);
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
  candleSeries.setMarkers(snapped);
}

// ---- pairs: watchlist and picker ------------------------------------------------
async function loadPairs() {
  try {
    const data = await api('api/trading/pairs');
    TS.pairs = data.pairs || [];
  } catch (e) {
    showToast('Instruments', esc(e.message), 'error');
  }
  renderWatchlist();
  renderPickerList();
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

function renderWatchlist() {
  const body = $('watchlist-body');
  const q = $('watchlist-search').value.trim().toLowerCase();
  const cat = $('watchlist-category').value;
  const rows = TS.pairs.filter((p) => matchesFilter(p, q, cat));
  if (!rows.length) {
    body.innerHTML = '<div class="muted small" style="padding:12px">No instruments match.</div>';
    return;
  }
  body.innerHTML = rows
    .map((p) => `
      <div class="wl-row${p.symbol === TS.activeSymbol ? ' active' : ''}" data-symbol="${esc(p.symbol)}" title="${esc(p.provider_name || 'no provider')}">
        <div><div class="wl-sym">${esc(p.symbol)}</div><div class="wl-sub">${esc(CATEGORY_LABELS[p.category] || p.category)} · ${esc(p.exchange || p.provider_name || '-')}</div></div>
        <div class="wl-price">${fmtPrice(p.last_price)}</div>
        <div class="wl-chg ${p.change_24h_pct === null ? 'muted' : changeClass(p.change_24h_pct)}">${fmtPct(p.change_24h_pct)}</div>
      </div>`)
    .join('');
}

let pickerFocus = -1;
function renderPickerList() {
  const list = $('pair-picker-list');
  const q = $('pair-picker-search').value.trim().toLowerCase();
  const rows = TS.pairs.filter((p) => matchesFilter(p, q));
  const groups = {};
  rows.forEach((p) => (groups[p.category] = groups[p.category] || []).push(p));
  pickerFocus = -1;
  list.innerHTML = rows.length
    ? Object.entries(groups)
        .map(([cat, ps]) => `<div class="pair-group">${esc(CATEGORY_LABELS[cat] || cat)}</div>` +
          ps.map((p) => `
            <div class="pair-option${p.symbol === TS.activeSymbol ? ' active' : ''}" role="option" data-symbol="${esc(p.symbol)}">
              <span><span class="sym">${esc(p.symbol)}</span> <span class="prov">${esc(p.provider_name || 'no provider')}</span></span>
              <span class="mono">${fmtPrice(p.last_price)}</span>
              <span class="mono ${p.change_24h_pct === null ? 'muted' : changeClass(p.change_24h_pct)}">${fmtPct(p.change_24h_pct)}</span>
            </div>`).join(''))
        .join('')
    : '<div class="muted small" style="padding:10px">No instruments match.</div>';
}

function openPicker(open) {
  const menu = $('pair-picker-menu');
  const show = open === undefined ? menu.classList.contains('hidden') : open;
  menu.classList.toggle('hidden', !show);
  $('pair-picker-btn').setAttribute('aria-expanded', String(show));
  if (show) {
    $('pair-picker-search').value = '';
    renderPickerList();
    setTimeout(() => $('pair-picker-search').focus(), 0);
  }
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
  renderWatchlist();
  openPicker(false);
  if (switchTab) showTab('chart');
  if (!changed && TS.candles.length) return;
  TS.candles = [];
  TS.markers = [];
  $('active-price').textContent = '-';
  $('active-change').textContent = '';
  $('ob-mid-price').textContent = '-';
  loadCandles();
  loadMarkers();
  loadOrderbook();
  loadEconomist();
  loadNews();
}
TS.selectPair = selectPair;

function setTimeframe(tf) {
  if (!TIMEFRAMES.includes(tf)) return;
  TS.activeTf = tf;
  storage.set('tf', tf);
  document.querySelectorAll('#tf-group .tf-btn').forEach((b) => b.classList.toggle('active', b.dataset.tf === tf));
  TS.candles = [];
  loadCandles();
}

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
  } catch (e) {
    if (symbol !== TS.activeSymbol) return;
    asks.innerHTML = '';
    bids.innerHTML = '';
    $('ob-provider').textContent = '';
    $('ob-mid-price').innerHTML = `<span class="muted small">${e.unsupported ? 'No order book from this provider' : esc(e.message)}</span>`;
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
    box.textContent = e.message;
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
  } catch (e) {
    box.innerHTML = `<div class="muted small">${esc(e.message)}</div>`;
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
  } catch (e) {}
}

// ---- screener ----------------------------------------------------------------------
let screenerCat = 'ALL';
function renderScreener() {
  const counts = TS.pairs.reduce((acc, p) => ((acc[p.category] = (acc[p.category] || 0) + 1), acc), {});
  $('screener-cats').innerHTML = ['ALL', ...Object.keys(CATEGORY_LABELS)]
    .map((c) => `<button class="tf-btn${c === screenerCat ? ' active' : ''}" data-cat="${c}">${c === 'ALL' ? 'All' : CATEGORY_LABELS[c]} (${c === 'ALL' ? TS.pairs.length : counts[c] || 0})</button>`)
    .join('');
  const q = $('screener-search').value.trim().toLowerCase();
  const rows = TS.pairs.filter((p) => matchesFilter(p, q, screenerCat));
  $('screener-count').textContent = `(${rows.length})`;
  $('screener-tbody').innerHTML = rows.length
    ? rows
        .map((p) => `
          <tr class="clickable" data-symbol="${esc(p.symbol)}" title="Open chart">
            <td><strong>${esc(p.symbol)}</strong></td>
            <td><span class="pill ${CATEGORY_PILL[p.category] || 'pill-gray'}">${esc(CATEGORY_LABELS[p.category] || p.category)}</span></td>
            <td>${esc(p.exchange || '-')}</td>
            <td>${p.provider_name ? esc(p.provider_name) : '<span class="neg">none</span>'}</td>
            <td class="r mono">${fmtPrice(p.last_price)}</td>
            <td class="r ${p.change_24h_pct === null ? 'muted' : changeClass(p.change_24h_pct)}">${fmtPct(p.change_24h_pct)}</td>
            <td class="r">${p.volume_24h_usd === null ? '-' : '$' + fmtCompact(p.volume_24h_usd)}</td>
            <td>${p.profit_score !== null && p.profit_score !== undefined ? `${p.profit_score}${p.score_grade ? ` (${esc(p.score_grade)})` : ''}` : '<span class="muted">-</span>'}</td>
            <td class="muted">${ago(p.updated_at)}</td>
          </tr>`)
        .join('')
    : '<tr><td colspan="9" class="empty">No instruments match.</td></tr>';
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
  } catch (e) {
    $('ft-state').innerHTML = '<span class="pill pill-red">API unreachable</span>';
    $('ft-config').className = 'kv-grid muted';
    $('ft-config').textContent = `Freqtrade API: ${e.message}`;
    $('ft-profit').textContent = '';
    $('ft-whitelist').innerHTML = '';
    $('ft-open-tbody').innerHTML = '<tr><td colspan="7" class="empty">Freqtrade API unreachable.</td></tr>';
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
    $('freqtrade-tbody').innerHTML = `<tr><td colspan="10" class="empty">${esc(e.message)}</td></tr>`;
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
                <td class="r ${changeClass(pnl)}">${pnl >= 0 ? '+' : ''}${pnl.toFixed(4)}</td>
                <td><span class="pill ${/FAIL|REVERT/i.test(t.status || '') ? 'pill-red' : 'pill-green'}">${esc(t.status || '-')}</span></td>
              </tr>`;
          })
          .join('')
      : '<tr><td colspan="9" class="empty">No executions.</td></tr>';
  } catch (e) {
    $('dex-tbody').innerHTML = `<tr><td colspan="9" class="empty">${esc(e.message)}</td></tr>`;
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
  TS.activeTab = tab;
  document.querySelectorAll('.tab-content').forEach((el) => el.classList.toggle('hidden', el.id !== `tab-${tab}`));
  document.querySelectorAll('.tab-btn').forEach((b) => b.classList.toggle('active', b.dataset.tab === tab));
  storage.set('tab', tab);
  if (tab === 'screener') loadPairs();
  if (tab === 'freqtrade') loadFreqtradeTab();
  if (tab === 'dex') loadDexTrades();
  document.dispatchEvent(new CustomEvent('ts:tab', { detail: tab }));
}
TS.showTab = showTab;

// ---- wiring --------------------------------------------------------------------------
function setWatchlistVisible(visible) {
  $('markets-layout').classList.toggle('no-watchlist', !visible);
  $('btn-watchlist').classList.toggle('active', visible);
  storage.set('watchlist', visible);
}

function bindEvents() {
  document.querySelectorAll('.tab-btn').forEach((b) => b.addEventListener('click', () => showTab(b.dataset.tab)));
  $('tf-group').innerHTML = TIMEFRAMES.map((tf) => `<button class="tf-btn" data-tf="${tf}">${tf}</button>`).join('');
  $('tf-group').addEventListener('click', (e) => {
    const b = e.target.closest('[data-tf]');
    if (b) setTimeframe(b.dataset.tf);
  });
  document.querySelectorAll('[data-indicator]').forEach((b) =>
    b.addEventListener('click', () => {
      const key = b.dataset.indicator;
      TS.indicators[key] = !TS.indicators[key];
      b.classList.toggle('active', TS.indicators[key]);
      storage.set('indicators', TS.indicators);
      renderIndicators();
    })
  );
  $('btn-markers').addEventListener('click', () => {
    TS.showMarkers = !TS.showMarkers;
    $('btn-markers').classList.toggle('active', TS.showMarkers);
    applyMarkers();
  });
  $('btn-watchlist').addEventListener('click', () => setWatchlistVisible($('markets-layout').classList.contains('no-watchlist')));

  $('watchlist-search').addEventListener('input', renderWatchlist);
  $('watchlist-category').addEventListener('change', () => {
    storage.set('wlcat', $('watchlist-category').value);
    renderWatchlist();
  });

  // Any element with data-symbol opens that pair on the chart.
  document.addEventListener('click', (e) => {
    const target = e.target.closest('[data-symbol]');
    if (!target || target.closest('#tab-settings')) return;
    const symbol = target.dataset.symbol;
    if (!pairBySymbol(symbol)) {
      showToast('Not registered', `${esc(symbol)} is not in the instrument registry; add it in Settings → Instruments.`, 'error');
      return;
    }
    selectPair(symbol, { switchTab: !target.closest('#tab-chart') });
  });

  $('pair-picker-btn').addEventListener('click', () => openPicker());
  $('pair-picker-search').addEventListener('input', renderPickerList);
  $('pair-picker-search').addEventListener('keydown', (e) => {
    const options = [...document.querySelectorAll('#pair-picker-list .pair-option')];
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault();
      pickerFocus = Math.max(0, Math.min(options.length - 1, pickerFocus + (e.key === 'ArrowDown' ? 1 : -1)));
      options.forEach((o, i) => o.classList.toggle('focused', i === pickerFocus));
      if (options[pickerFocus]) options[pickerFocus].scrollIntoView({ block: 'nearest' });
    } else if (e.key === 'Enter') {
      const pick = options[pickerFocus] || options[0];
      if (pick) selectPair(pick.dataset.symbol);
    } else if (e.key === 'Escape') {
      openPicker(false);
    }
  });
  document.addEventListener('click', (e) => {
    if (!e.target.closest('#pair-picker')) openPicker(false);
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

  // Keyboard: "/" opens the pair picker.
  document.addEventListener('keydown', (e) => {
    if (e.key === '/' && !['INPUT', 'TEXTAREA', 'SELECT'].includes(document.activeElement.tagName) && TS.activeTab === 'chart') {
      e.preventDefault();
      openPicker(true);
    }
  });
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
  Object.assign(TS.indicators, storage.get('indicators', {}));
  document.querySelectorAll('[data-indicator]').forEach((b) => b.classList.toggle('active', !!TS.indicators[b.dataset.indicator]));
  $('watchlist-category').value = storage.get('wlcat', 'ALL');
  setWatchlistVisible(storage.get('watchlist', true));

  await loadPairs();
  const saved = storage.get('symbol', null);
  const symbol = [saved, TS.settings.defaultSymbol].find((s) => s && pairBySymbol(s)) || (TS.pairs[0] && TS.pairs[0].symbol);
  TS.activeTf = storage.get('tf', TS.settings.defaultTimeframe || '15m');
  document.querySelectorAll('#tf-group .tf-btn').forEach((b) => b.classList.toggle('active', b.dataset.tf === TS.activeTf));
  if (symbol) selectPair(symbol);
  else chartMessage('No instruments yet. Add one in Settings → Instruments.');

  const tab = storage.get('tab', 'chart');
  showTab(document.getElementById(`tab-${tab}`) ? tab : 'chart');
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
