let chart = null;
let candlestickSeries = null;
let activeSymbol = 'ETH/USDT';
let activeCategory = 'DEX';
let allPairs = [];

// Initialize Dashboard on Load
document.addEventListener('DOMContentLoaded', () => {
  initChart();
  loadPairs();
  loadOverview();
  loadChartMarkers(activeSymbol);
  loadEconomistAdvice(activeSymbol);
  loadNews(activeSymbol);
  loadMultiAssetData();
  initSSELogStream();

  // Refresh interval every 15s
  setInterval(() => {
    loadOverview();
    loadChartMarkers(activeSymbol);
  }, 15000);
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

  fetchCandlesAndRender(activeSymbol);

  window.addEventListener('resize', () => {
    chart.applyOptions({ width: container.clientWidth });
  });
}

// Fetch Candlestick Data from Binance Free API or Fallback Simulation
async function fetchCandlesAndRender(symbol) {
  let binanceSymbol = symbol.replace('/', '').replace('WBTC', 'BTC');
  if (symbol === 'SPY' || symbol === 'QQQ' || symbol === 'NVDA' || symbol === 'AAPL') {
    binanceSymbol = 'BTCUSDT'; // Use BTC price action as chart baseline for equities in paper mode
  }

  try {
    const res = await fetch(`https://api.binance.com/api/v3/klines?symbol=${binanceSymbol}&interval=1m&limit=150`);
    const data = await res.json();

    if (Array.isArray(data)) {
      const candles = data.map(d => ({
        time: Math.floor(d[0] / 1000),
        open: parseFloat(d[1]),
        high: parseFloat(d[2]),
        low: parseFloat(d[3]),
        close: parseFloat(d[4])
      }));

      candlestickSeries.setData(candles);
    }
  } catch (err) {
    console.warn('Binance candles fallback:', err.message);
    generateSimulatedCandles();
  }
}

function generateSimulatedCandles() {
  const candles = [];
  let basePrice = activeSymbol.includes('ETH') ? 3450 : (activeSymbol.includes('BTC') ? 91200 : 100);
  let now = Math.floor(Date.now() / 1000) - 150 * 60;

  for (let i = 0; i < 150; i++) {
    const open = basePrice + (Math.random() - 0.48) * 10;
    const high = open + Math.random() * 5;
    const low = open - Math.random() * 5;
    const close = (high + low) / 2;
    basePrice = close;

    candles.push({ time: now + i * 60, open, high, low, close });
  }
  candlestickSeries.setData(candles);
}

// Load DB Chart Overlays / Markers
async function loadChartMarkers(symbol) {
  try {
    const res = await fetch(`/api/trading/chart-markers?symbol=${encodeURIComponent(symbol)}`);
    const data = await res.json();

    if (data.success && data.markers) {
      candlestickSeries.setMarkers(data.markers);
    }
  } catch (err) {
    console.error('Error loading markers:', err);
  }
}

// Load All Instruments from Database
async function loadPairs() {
  try {
    const res = await fetch('/api/trading/pairs');
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

  tbody.innerHTML = pairs.map(p => {
    const isPos = parseFloat(p.change_24h_pct || 0) >= 0;
    const pillClass = p.category === 'DEX' ? 'pill-purple' : (p.category === 'TRADFI' ? 'pill-blue' : 'pill-green');

    return `
      <tr onclick="selectPair('${p.symbol}', '${p.category}')">
        <td style="font-weight: 700; color: #f8fafc;">${p.symbol}</td>
        <td><span class="pill ${pillClass}">${p.category}</span></td>
        <td>${p.exchange || 'N/A'}</td>
        <td style="font-family: 'JetBrains Mono', monospace;">$${parseFloat(p.last_price || 0).toLocaleString()}</td>
        <td style="font-weight: 700; color: ${isPos ? '#34d399' : '#fb7185'};">${isPos ? '+' : ''}${p.change_24h_pct}%</td>
        <td>$${(parseFloat(p.volume_24h_usd || 0) / 1000000).toFixed(1)}M</td>
        <td><span class="pill pill-green">${p.profit_score || '85.0'} / 100</span></td>
        <td><button class="pill pill-blue" style="cursor: pointer;"><i class="fa-solid fa-chart-line"></i> Grafik Aç</button></td>
      </tr>
    `;
  }).join('');
}

// Select Pair and Synchronize Dashboard Context
function selectPair(symbol, category) {
  activeSymbol = symbol;
  activeCategory = category || 'DEX';

  document.getElementById('active-symbol-title').innerText = symbol;
  document.getElementById('active-category-pill').innerText = activeCategory;
  document.getElementById('order-symbol').value = symbol;
  document.getElementById('econ-symbol').innerText = symbol;

  fetchCandlesAndRender(symbol);
  loadChartMarkers(symbol);
  loadEconomistAdvice(symbol);
  loadNews(symbol);

  switchTab('chart');
}

// Filter Market Screener
function filterScreener() {
  const query = document.getElementById('screener-search').value.toLowerCase();
  const filtered = allPairs.filter(p => p.symbol.toLowerCase().includes(query) || p.category.toLowerCase().includes(query));
  renderScreener(filtered);
}

// Load Economist Advice
async function loadEconomistAdvice(symbol) {
  try {
    const res = await fetch(`/api/trading/economist?symbol=${encodeURIComponent(symbol)}`);
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
    const res = await fetch(`/api/trading/news?symbol=${encodeURIComponent(symbol)}`);
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

// Submit Test Order
async function submitTestOrder() {
  const symbol = document.getElementById('order-symbol').value;
  const side = document.getElementById('order-side').value;
  const amount = parseFloat(document.getElementById('order-amount').value || 100);

  try {
    const res = await fetch('/api/trading/orders', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ symbol, side, amount })
    });
    const data = await res.json();

    if (data.success) {
      alert(`✅ Test Emir Başarıyla İletildi!\n${symbol} - ${side} ($${amount})`);
      loadChartMarkers(symbol);
    } else {
      alert(`❌ Hata: ${data.error}`);
    }
  } catch (e) {
    alert(`❌ Bağlantı Hatası: ${e.message}`);
  }
}

// Load Multi-Asset Data
async function loadMultiAssetData() {
  try {
    const res = await fetch('/api/trading/multi-asset');
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
    const res = await fetch('/api/trading/overview');
    const data = await res.json();

    if (data.success && data.summary) {
      document.getElementById('kpi-pnl').innerText = `$${data.summary.totalRealizedPnlUsd} USD`;
      document.getElementById('kpi-winrate').innerText = `${data.summary.winRatePercent}%`;
      document.getElementById('kpi-score').innerText = `${data.summary.profitScore} / 100`;
    }
  } catch (e) {}
}

// Real-Time SSE Log Stream
function initSSELogStream() {
  const consoleBox = document.getElementById('log-console');
  if (!consoleBox) return;

  const evtSource = new EventSource('/api/trading/logs/stream');
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

// Tab Switching
function switchTab(tabId) {
  document.querySelectorAll('.tab-content').forEach(el => el.classList.add('hidden'));
  document.querySelectorAll('.tab-btn').forEach(btn => btn.classList.remove('active'));

  const selected = document.getElementById(`tab-${tabId}`);
  if (selected) selected.classList.remove('hidden');

  event.target.classList.add('active');

  if (tabId === 'chart' && chart) {
    setTimeout(() => {
      const container = document.getElementById('chart-wrapper');
      chart.applyOptions({ width: container.clientWidth });
    }, 100);
  }
}
