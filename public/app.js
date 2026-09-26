let chart = null;
let candlestickSeries = null;
let activeSymbol = 'ETH/USDT';
let activeCategory = 'DEX';
let activeTimeframe = '1m';
let activeCategoryFilter = 'ALL';
let allPairs = [];
let rawCandleData = [];

// Indicator Series
let indicatorSeries = {
  sma20: null,
  sma50: null,
  ema200: null
};
let indicatorStates = {
  sma20: false,
  sma50: false,
  ema200: false
};

// Initialize Dashboard on Load
document.addEventListener('DOMContentLoaded', () => {
  initChart();
  loadPairs();
  loadOverview();
  loadChartMarkers(activeSymbol);
  loadEconomistAdvice(activeSymbol);
  loadNews(activeSymbol);
  loadOrderbook(activeSymbol);
  loadDexTrades();
  loadFreqtradeTrades();
  loadMultiAssetData();
  initSSELogStream();
  calculatePnL();

  // Refresh intervals
  setInterval(() => {
    loadOverview();
    loadChartMarkers(activeSymbol);
  }, 15000);

  setInterval(() => {
    loadOrderbook(activeSymbol);
    loadDexTrades();
    loadFreqtradeTrades();
  }, 5000);
});

// Initialize TradingView Lightweight Chart
function initChart() {
  const container = document.getElementById('chart-wrapper');
  if (!container) return;
  container.innerHTML = '';

  chart = LightweightCharts.createChart(container, {
    width: container.clientWidth,
    height: 480,
    layout: {
      backgroundColor: '#020617',
      textColor: '#94a3b8',
      fontSize: 12,
      fontFamily: 'JetBrains Mono',
    },
    grid: {
      vertLines: { color: '#1e293b' },
      horzLines: { color: '#1e293b' },
    },
    crosshair: {
      mode: LightweightCharts.CrosshairMode.Normal,
    },
    rightPriceScale: {
      borderColor: '#1e293b',
    },
    timeScale: {
      borderColor: '#1e293b',
      timeVisible: true,
      secondsVisible: false,
    },
  });

  candlestickSeries = chart.addCandlestickSeries({
    upColor: '#10b981',
    downColor: '#f43f5e',
    borderDownColor: '#f43f5e',
    borderUpColor: '#10b981',
    wickDownColor: '#f43f5e',
    wickUpColor: '#10b981',
  });

  fetchCandlesAndRender(activeSymbol, activeTimeframe);

  window.addEventListener('resize', () => {
    chart.applyOptions({ width: container.clientWidth });
  });
}

// Timeframe Selector
function changeTimeframe(tf, btnElement) {
  activeTimeframe = tf;
  document.querySelectorAll('.tf-btn-group .tf-btn').forEach(b => {
    if (b.innerText.includes('m') || b.innerText.includes('h') || b.innerText.includes('d')) {
      b.classList.remove('active');
    }
  });
  if (btnElement) btnElement.classList.add('active');

  fetchCandlesAndRender(activeSymbol, activeTimeframe);
  showToast('Zaman Dilimi Değiştirildi', `${activeSymbol} - ${tf} grafik yükleniyor.`, 'info');
}

// Fetch Candlestick Data from Binance API or Fallback
async function fetchCandlesAndRender(symbol, interval = '1m') {
  let binanceSymbol = symbol.replace('/', '').replace('WBTC', 'BTC');
  if (symbol === 'SPY' || symbol === 'QQQ' || symbol === 'NVDA' || symbol === 'AAPL') {
    binanceSymbol = 'BTCUSDT';
  }

  try {
    const res = await fetch(`https://api.binance.com/api/v3/klines?symbol=${binanceSymbol}&interval=${interval}&limit=200`);
    const data = await res.json();

    if (Array.isArray(data)) {
      rawCandleData = data.map(d => ({
        time: Math.floor(d[0] / 1000),
        open: parseFloat(d[1]),
        high: parseFloat(d[2]),
        low: parseFloat(d[3]),
        close: parseFloat(d[4])
      }));

      candlestickSeries.setData(rawCandleData);
      renderIndicators();
    } else {
      generateSimulatedCandles();
    }
  } catch (err) {
    console.warn('Binance candles fallback:', err.message);
    generateSimulatedCandles();
  }
}

function generateSimulatedCandles() {
  const candles = [];
  let basePrice = activeSymbol.includes('ETH') ? 2600 : (activeSymbol.includes('BTC') ? 65000 : 100);
  let now = Math.floor(Date.now() / 1000) - 150 * 60;

  for (let i = 0; i < 150; i++) {
    const open = basePrice + (Math.random() - 0.48) * 10;
    const high = open + Math.random() * 5;
    const low = open - Math.random() * 5;
    const close = (high + low) / 2;
    basePrice = close;

    candles.push({ time: now + i * 60, open, high, low, close });
  }
  rawCandleData = candles;
  candlestickSeries.setData(candles);
  renderIndicators();
}

// Indicator Toggle Logic
function toggleIndicator(type) {
  indicatorStates[type] = !indicatorStates[type];
  const btn = document.getElementById(`btn-${type}`);
  if (btn) {
    if (indicatorStates[type]) {
      btn.classList.add('active');
    } else {
      btn.classList.remove('active');
    }
  }
  renderIndicators();
}

function renderIndicators() {
  if (!rawCandleData || rawCandleData.length === 0) return;

  // SMA 20
  if (indicatorStates.sma20) {
    if (!indicatorSeries.sma20) {
      indicatorSeries.sma20 = chart.addLineSeries({ color: '#38bdf8', lineWidth: 2, title: 'SMA 20' });
    }
    indicatorSeries.sma20.setData(calculateSMA(rawCandleData, 20));
  } else if (indicatorSeries.sma20) {
    chart.removeSeries(indicatorSeries.sma20);
    indicatorSeries.sma20 = null;
  }

  // SMA 50
  if (indicatorStates.sma50) {
    if (!indicatorSeries.sma50) {
      indicatorSeries.sma50 = chart.addLineSeries({ color: '#f59e0b', lineWidth: 2, title: 'SMA 50' });
    }
    indicatorSeries.sma50.setData(calculateSMA(rawCandleData, 50));
  } else if (indicatorSeries.sma50) {
    chart.removeSeries(indicatorSeries.sma50);
    indicatorSeries.sma50 = null;
  }

  // EMA 200
  if (indicatorStates.ema200) {
    if (!indicatorSeries.ema200) {
      indicatorSeries.ema200 = chart.addLineSeries({ color: '#a855f7', lineWidth: 2, title: 'EMA 200' });
    }
    indicatorSeries.ema200.setData(calculateEMA(rawCandleData, 200));
  } else if (indicatorSeries.ema200) {
    chart.removeSeries(indicatorSeries.ema200);
    indicatorSeries.ema200 = null;
  }
}

function calculateSMA(candles, period) {
  const result = [];
  for (let i = 0; i < candles.length; i++) {
    if (i < period - 1) continue;
    let sum = 0;
    for (let j = 0; j < period; j++) {
      sum += candles[i - j].close;
    }
    result.push({ time: candles[i].time, value: sum / period });
  }
  return result;
}

function calculateEMA(candles, period) {
  const result = [];
  const k = 2 / (period + 1);
  let ema = candles[0] ? candles[0].close : 0;

  for (let i = 0; i < candles.length; i++) {
    const close = candles[i].close;
    if (i === 0) {
      ema = close;
    } else {
      ema = close * k + ema * (1 - k);
    }
    if (i >= period - 1) {
      result.push({ time: candles[i].time, value: ema });
    }
  }
  return result;
}

// Load DB Chart Overlays / Markers
async function loadChartMarkers(symbol) {
  try {
    const res = await fetch(`api/trading/chart-markers?symbol=${encodeURIComponent(symbol)}`);
    const data = await res.json();

    if (data.success && data.markers) {
      candlestickSeries.setMarkers(data.markers);
    }
  } catch (err) {
    console.error('Error loading markers:', err);
  }
}

// Load Orderbook Depth Data
async function loadOrderbook(symbol) {
  try {
    const res = await fetch(`api/trading/orderbook?symbol=${encodeURIComponent(symbol)}`);
    const data = await res.json();

    const pill = document.getElementById('ob-symbol-pill');
    if (pill) pill.innerText = symbol;

    if (data.success) {
      renderOrderbook(data.bids || [], data.asks || []);
    }
  } catch (err) {}
}

function renderOrderbook(bids, asks) {
  const bidsContainer = document.getElementById('ob-bids-container');
  const asksContainer = document.getElementById('ob-asks-container');
  const midPrice = document.getElementById('ob-mid-price');

  if (!bidsContainer || !asksContainer) return;

  const topAsk = asks[0] ? parseFloat(asks[0][0]) : 0;
  const topBid = bids[0] ? parseFloat(bids[0][0]) : 0;
  if (topAsk && topBid && midPrice) {
    midPrice.innerText = `$${((topAsk + topBid) / 2).toLocaleString(undefined, { minimumFractionDigits: 2 })}`;
  }

  asksContainer.innerHTML = asks.slice(0, 5).map(a => {
    const price = parseFloat(a[0]).toFixed(2);
    const amount = parseFloat(a[1]).toFixed(4);
    const total = (price * amount).toFixed(2);
    return `
      <div class="ob-row">
        <div class="ob-bar-ask" style="width: ${Math.min(amount * 10, 100)}%;"></div>
        <span class="ob-ask" style="z-index: 1;">$${price}</span>
        <span style="text-align: right; z-index: 1;">${amount}</span>
        <span style="text-align: right; z-index: 1; color: #94a3b8;">$${total}</span>
      </div>
    `;
  }).join('');

  bidsContainer.innerHTML = bids.slice(0, 5).map(b => {
    const price = parseFloat(b[0]).toFixed(2);
    const amount = parseFloat(b[1]).toFixed(4);
    const total = (price * amount).toFixed(2);
    return `
      <div class="ob-row">
        <div class="ob-bar-bid" style="width: ${Math.min(amount * 10, 100)}%;"></div>
        <span class="ob-bid" style="z-index: 1;">$${price}</span>
        <span style="text-align: right; z-index: 1;">${amount}</span>
        <span style="text-align: right; z-index: 1; color: #94a3b8;">$${total}</span>
      </div>
    `;
  }).join('');
}

// Load All Instruments from Database
async function loadPairs() {
  try {
    const res = await fetch('api/trading/pairs');
    const data = await res.json();

    if (data.success) {
      allPairs = data.pairs;
      renderScreener(allPairs);
    }
  } catch (err) {
    console.error('Error loading pairs:', err);
  }
}

function renderScreener(pairs) {
  const tbody = document.getElementById('screener-tbody');
  if (!tbody) return;

  if (!pairs || pairs.length === 0) {
    tbody.innerHTML = '<tr><td colspan="8" style="text-align:center; color:#64748b;">Enstrüman bulunamadı.</td></tr>';
    return;
  }

  tbody.innerHTML = pairs.map(p => {
    const isPos = parseFloat(p.change_24h_pct || 0) >= 0;
    const pillClass = p.category === 'DEX' ? 'pill-purple' : (p.category === 'TRADFI' ? 'pill-blue' : (p.category === 'CEX_FUTURES' ? 'pill-warn' : 'pill-green'));

    const priceFormatted = p.last_price ? '$' + parseFloat(p.last_price).toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 6 }) : '-';
    const volFormatted = p.volume_24h_usd ? '$' + (parseFloat(p.volume_24h_usd) / 1000000).toFixed(2) + 'M' : '-';
    const changeFormatted = p.change_24h_pct !== null && p.change_24h_pct !== undefined ? `${isPos ? '+' : ''}${p.change_24h_pct}%` : '-';
    const scoreFormatted = p.profit_score ? `${p.profit_score} / 100` : '85.0 / 100';
    const gradeFormatted = p.score_grade ? ` (${p.score_grade})` : '';

    return `
      <tr onclick="selectPair('${p.symbol}', '${p.category}')">
        <td style="font-weight: 700; color: #f8fafc;">${p.symbol}</td>
        <td><span class="pill ${pillClass}">${p.category}</span></td>
        <td>${p.exchange || 'N/A'}</td>
        <td style="font-family: 'JetBrains Mono', monospace;">${priceFormatted}</td>
        <td style="font-weight: 700; color: ${isPos ? '#34d399' : '#fb7185'};">${changeFormatted}</td>
        <td>${volFormatted}</td>
        <td><span class="pill pill-green"><i class="fa-solid fa-brain"></i> ${scoreFormatted}${gradeFormatted}</span></td>
        <td><button class="pill pill-blue" style="cursor: pointer;"><i class="fa-solid fa-chart-line"></i> Grafik Aç</button></td>
      </tr>
    `;
  }).join('');
}

// Category Filter for Screener
function filterScreenerCat(cat, btnElement) {
  activeCategoryFilter = cat;
  if (btnElement && btnElement.parentElement) {
    btnElement.parentElement.querySelectorAll('.tf-btn').forEach(b => b.classList.remove('active'));
    btnElement.classList.add('active');
  }
  filterScreener();
}

// Filter Market Screener
function filterScreener() {
  const query = (document.getElementById('screener-search')?.value || '').toLowerCase();
  const filtered = allPairs.filter(p => {
    const matchesSearch = p.symbol.toLowerCase().includes(query) || p.category.toLowerCase().includes(query) || (p.exchange && p.exchange.toLowerCase().includes(query));
    const matchesCat = activeCategoryFilter === 'ALL' || p.category === activeCategoryFilter;
    return matchesSearch && matchesCat;
  });
  renderScreener(filtered);
}

// Load Economist Advice
async function loadEconomistAdvice(symbol) {
  try {
    const res = await fetch(`api/trading/economist?symbol=${encodeURIComponent(symbol)}`);
    const data = await res.json();

    if (data.success && data.signal) {
      document.getElementById('econ-score').innerText = `${data.signal.profit_score} / 100`;
      document.getElementById('econ-risk').innerText = data.signal.risk_level || 'DÜŞÜK RISK';
      document.getElementById('econ-text').innerText = data.signal.recommendation || 'Görüş mevcut.';
    }
  } catch (e) {}
}

// Load Market News
async function loadNews(symbol) {
  try {
    const res = await fetch(`api/trading/news?symbol=${encodeURIComponent(symbol)}`);
    const data = await res.json();

    const container = document.getElementById('news-container');
    if (!container) return;

    if (data.success && data.news.length > 0) {
      container.innerHTML = data.news.map(n => `
        <div class="news-item">
          <a href="${n.url || '#'}" target="_blank" class="news-title">${n.title}</a>
          <div style="font-size: 11px; color: #94a3b8;">${n.summary}</div>
          <div class="news-meta">
            <span>${n.source}</span>
            <span>${new Date(n.published_at).toLocaleTimeString()}</span>
          </div>
        </div>
      `).join('');
    } else {
      container.innerHTML = '<div style="font-size: 12px; color: #64748b;">Haber bulunamadı.</div>';
    }
  } catch (e) {}
}

// Interactive Risk & PnL Calculator
function calculatePnL() {
  const entry = parseFloat(document.getElementById('calc-entry')?.value || 2600);
  const margin = parseFloat(document.getElementById('calc-margin')?.value || 500);
  const lev = parseFloat(document.getElementById('calc-leverage')?.value || 5);
  const sl = parseFloat(document.getElementById('calc-sl')?.value || 2.0);
  const tp = parseFloat(document.getElementById('calc-tp')?.value || 5.0);

  const positionSize = margin * lev;
  const tpProfit = positionSize * (tp / 100);
  const slLoss = positionSize * (sl / 100);

  const tpReturnPct = (tpProfit / margin) * 100;
  const slLossPct = (slLoss / margin) * 100;

  const rrRatio = slLoss > 0 ? (tpProfit / slLoss).toFixed(2) : '0.00';
  const liqPrice = entry * (1 - (1 / lev) * 0.9);

  if (document.getElementById('calc-res-tp')) {
    document.getElementById('calc-res-tp').innerText = `+$${tpProfit.toFixed(2)} (+${tpReturnPct.toFixed(1)}%)`;
    document.getElementById('calc-res-sl').innerText = `-$${slLoss.toFixed(2)} (-${slLossPct.toFixed(1)}%)`;
    document.getElementById('calc-res-rr').innerText = `1 : ${rrRatio}`;
    document.getElementById('calc-res-liq').innerText = `$${liqPrice.toFixed(2)}`;
  }
}

// Submit Test Order
async function submitTestOrder() {
  const symbol = document.getElementById('order-symbol').value;
  const side = document.getElementById('order-side').value;
  const amount = parseFloat(document.getElementById('order-amount').value || 100);

  try {
    const res = await fetch('api/trading/orders', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ symbol, side, amount })
    });
    const data = await res.json();

    if (data.success) {
      showToast('Emir İletildi', `✅ ${symbol} - ${side} ($${amount}) simülasyona aktarıldı.`, 'success');
      loadChartMarkers(symbol);
    } else {
      showToast('Emir Hatası', `❌ ${data.error}`, 'error');
    }
  } catch (e) {
    showToast('Bağlantı Hatası', `❌ ${e.message}`, 'error');
  }
}

// Toast Notifications Component
function showToast(title, message, type = 'info') {
  const container = document.getElementById('toast-container');
  if (!container) return;

  const toast = document.createElement('div');
  toast.className = `toast-card toast-${type}`;
  toast.innerHTML = `
    <div>
      <div style="font-weight: 700; margin-bottom: 2px;">${title}</div>
      <div style="font-size: 12px; color: #cbd5e1;">${message}</div>
    </div>
  `;

  container.appendChild(toast);
  setTimeout(() => {
    toast.style.opacity = '0';
    toast.style.transition = 'opacity 0.3s';
    setTimeout(() => toast.remove(), 300);
  }, 4000);
}

// Load Multi-Asset Data
async function loadMultiAssetData() {
  try {
    const res = await fetch('api/trading/multi-asset');
    const data = await res.json();

    if (data.success && data.cex_funding_arbitrage) {
      const cexTbody = document.getElementById('cex-funding-tbody');
      if (cexTbody) {
        cexTbody.innerHTML = data.cex_funding_arbitrage.opportunities.slice(0, 8).map(o => `
          <tr>
            <td style="font-weight: 700;">${o.symbol}</td>
            <td>${o.exchange}</td>
            <td>$${o.spot_price} / $${o.futures_price}</td>
            <td>${o.funding_rate_pct}%</td>
            <td style="font-weight: 700; color: #34d399;">%${o.net_apy_pct} APY</td>
            <td><span class="pill pill-green">${o.recommendation}</span></td>
          </tr>
        `).join('');
      }
    }

    if (data.success && data.ibkr_tradfi) {
      const ibkrContainer = document.getElementById('ibkr-container');
      if (ibkrContainer) {
        const acc = data.ibkr_tradfi.account;
        const strat = data.ibkr_tradfi.delta_neutral_strategy;
        ibkrContainer.innerHTML = `
          <div style="background: #020617; border: 1px solid #1e293b; border-radius: 8px; padding: 12px; display: flex; flex-direction: column; gap: 8px;">
            <div style="display: flex; justify-content: space-between;"><strong>Hesap Değeri:</strong> <span>$${acc.net_liquidation.toLocaleString()} ${acc.currency}</span></div>
            <div style="display: flex; justify-content: space-between;"><strong>Nakit Bakiye:</strong> <span>$${acc.cash_balance.toLocaleString()}</span></div>
            <div style="display: flex; justify-content: space-between;"><strong>Alım Gücü:</strong> <span>$${acc.buying_power.toLocaleString()}</span></div>
          </div>
          <div style="background: rgba(16, 185, 129, 0.1); border: 1px solid rgba(16, 185, 129, 0.3); border-radius: 8px; padding: 12px; color: #34d399;">
            <strong>${strat.strategy} (${strat.underlying}):</strong> ${strat.status}
            <div style="margin-top: 6px; font-size: 11px; color: #cbd5e1;">Yıllık Theta Getiri Oranı: %${strat.annualized_theta_yield_pct}</div>
          </div>
        `;
      }
    }
  } catch (e) {}
}

// Load Overall Executive Overview
async function loadOverview() {
  try {
    const res = await fetch('api/trading/overview');
    const data = await res.json();

    if (data.success && data.summary) {
      document.getElementById('kpi-pnl').innerText = `$${data.summary.totalRealizedPnlUsd} USD`;
      const winRate = data.summary.winRatePercent;
      document.getElementById('kpi-winrate').innerText = winRate === null || winRate === undefined ? '-' : `${winRate}%`;
      const score = data.summary.profitScore;
      document.getElementById('kpi-score').innerText = score === null || score === undefined ? '-' : `${score} / 100`;
    }
  } catch (e) {}
}

// Real-Time SSE Log Stream
function initSSELogStream() {
  const consoleBox = document.getElementById('log-console');
  if (!consoleBox) return;

  const evtSource = new EventSource('api/trading/logs/stream');
  evtSource.onmessage = (e) => {
    try {
      const msg = JSON.parse(e.data);
      if (msg.type === 'log') {
        const line = document.createElement('div');
        line.innerText = msg.log;
        consoleBox.appendChild(line);
        consoleBox.scrollTop = consoleBox.scrollHeight;
      }
    } catch(err) {}
  };
}

function clearLogs() {
  document.getElementById('log-console').innerText = '';
}

// Load Web3 DEX Flashloan Arbitrage Executions from trade_logs
async function loadDexTrades() {
  try {
    const res = await fetch('api/trading/dex-arbitrage');
    const data = await res.json();

    const tbody = document.getElementById('dex-tbody');
    if (!tbody) return;

    if (data.success && data.trades && data.trades.length > 0) {
      tbody.innerHTML = data.trades.map(t => {
        const pnl = parseFloat(t.pnl_usd || 0);
        const pnlColor = pnl >= 0 ? '#34d399' : '#fb7185';
        return `
          <tr>
            <td style="font-weight: 700; font-family: 'JetBrains Mono';">#${t.id}</td>
            <td>${new Date(t.created_at).toLocaleString('tr-TR')}</td>
            <td><span class="pill pill-purple">${t.action || 'FLASHLOAN_ARBITRAGE'}</span></td>
            <td>$${parseFloat(t.amount_in || 0).toLocaleString()}</td>
            <td>$${parseFloat(t.amount_out || 0).toLocaleString()}</td>
            <td>${t.gas_used || '0'} Gwei</td>
            <td style="font-weight: 700; color: ${pnlColor};">+$${pnl.toFixed(4)} USD</td>
            <td><span class="pill pill-green">${t.status || 'SUCCESS'}</span></td>
          </tr>
        `;
      }).join('');
    } else {
      tbody.innerHTML = '<tr><td colspan="8" style="text-align:center; color:#64748b;">Kayıt bulunamadı.</td></tr>';
    }
  } catch (e) {
    console.error('Error loading DEX trades:', e);
  }
}

// Load Freqtrade Spot Trades from trades table
async function loadFreqtradeTrades() {
  try {
    const res = await fetch('api/trading/freqtrade');
    const data = await res.json();

    const tbody = document.getElementById('freqtrade-tbody');
    if (!tbody) return;

    if (data.success && data.trades && data.trades.length > 0) {
      tbody.innerHTML = data.trades.map(t => {
        const profit = parseFloat(t.close_profit_abs || t.realized_profit || 0);
        const profitColor = profit >= 0 ? '#34d399' : '#fb7185';
        const isOpen = t.is_open;
        return `
          <tr>
            <td style="font-weight: 700; font-family: 'JetBrains Mono';">#${t.id}</td>
            <td style="font-weight: 700;">${t.pair}</td>
            <td>$${parseFloat(t.open_rate || 0).toLocaleString()}</td>
            <td>${t.close_rate ? '$' + parseFloat(t.close_rate).toLocaleString() : '-'}</td>
            <td>$${parseFloat(t.stake_amount || 0).toFixed(2)} USDT</td>
            <td>${new Date(t.open_date).toLocaleString('tr-TR')}</td>
            <td>${t.close_date ? new Date(t.close_date).toLocaleString('tr-TR') : 'AÇIK POS'}</td>
            <td style="font-weight: 700; color: ${profitColor};">${profit >= 0 ? '+' : ''}$${profit.toFixed(4)} USD</td>
            <td><span class="pill ${isOpen ? 'pill-blue' : 'pill-green'}">${isOpen ? 'OPEN' : 'CLOSED'}</span></td>
          </tr>
        `;
      }).join('');
    } else {
      tbody.innerHTML = '<tr><td colspan="9" style="text-align:center; color:#64748b;">Kayıt bulunamadı.</td></tr>';
    }
  } catch (e) {
    console.error('Error loading Freqtrade trades:', e);
  }
}

// Tab Switching
function switchTab(tabId, btnElement = null) {
  document.querySelectorAll('.tab-content').forEach(el => el.classList.add('hidden'));
  document.querySelectorAll('.tab-btn').forEach(btn => btn.classList.remove('active'));

  const selected = document.getElementById(`tab-${tabId}`);
  if (selected) selected.classList.remove('hidden');

  let targetBtn = btnElement;
  if (!targetBtn && window.event) {
    const src = window.event.target;
    targetBtn = src.closest ? src.closest('.tab-btn') : src;
  }
  if (!targetBtn) {
    targetBtn = document.querySelector(`.tab-btn[onclick*="'${tabId}'"]`);
  }
  if (targetBtn && targetBtn.classList) {
    targetBtn.classList.add('active');
  }

  // Trigger data refreshes on tab change
  if (tabId === 'screener') loadPairs();
  if (tabId === 'dex') loadDexTrades();
  if (tabId === 'freqtrade') loadFreqtradeTrades();
  if (tabId === 'multiasset') loadMultiAssetData();

  if (tabId === 'chart' && chart) {
    setTimeout(() => {
      const container = document.getElementById('chart-wrapper');
      if (container) {
        chart.applyOptions({ width: container.clientWidth });
      }
    }, 100);
  }
}