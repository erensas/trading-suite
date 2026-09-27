// Technical indicators, shared by the browser (window.Indicators) and the server
// (require('../public/indicators')): chart overlays, alert checks and recommendations.
//
// Every core function takes an array of numbers (null for "no value") and returns an array
// of the same length. Definitions follow TradingView's Pine built-ins (ta.sma, ta.ema with an
// SMA seed, ta.rma for Wilder smoothing, population standard deviation, and so on), so
// values match the charts traders are used to.
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.Indicators = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  const isNum = (v) => typeof v === 'number' && Number.isFinite(v);
  const nulls = (n) => new Array(n).fill(null);

  // ---- core series functions ---------------------------------------------------------------
  function sma(src, n) {
    const out = nulls(src.length);
    let sum = 0;
    let count = 0;
    for (let i = 0; i < src.length; i++) {
      const v = src[i];
      if (isNum(v)) {
        sum += v;
        count++;
      }
      if (i >= n) {
        const old = src[i - n];
        if (isNum(old)) {
          sum -= old;
          count--;
        }
      }
      if (i >= n - 1 && count === n) out[i] = sum / n;
    }
    return out;
  }

  // Exponential average seeded with the SMA of the first n values (Pine's ta.ema).
  function emaAlpha(src, n, alpha) {
    const out = nulls(src.length);
    let prev = null;
    let seed = [];
    for (let i = 0; i < src.length; i++) {
      const v = src[i];
      if (!isNum(v)) {
        if (prev !== null) out[i] = prev;
        continue;
      }
      if (prev === null) {
        seed.push(v);
        if (seed.length === n) {
          prev = seed.reduce((a, b) => a + b, 0) / n;
          out[i] = prev;
          seed = null;
        }
        continue;
      }
      prev = alpha * v + (1 - alpha) * prev;
      out[i] = prev;
    }
    return out;
  }
  const ema = (src, n) => emaAlpha(src, n, 2 / (n + 1));
  const rma = (src, n) => emaAlpha(src, n, 1 / n);

  function wma(src, n) {
    const out = nulls(src.length);
    const denom = (n * (n + 1)) / 2;
    for (let i = n - 1; i < src.length; i++) {
      let s = 0;
      let ok = true;
      for (let j = 0; j < n; j++) {
        const v = src[i - j];
        if (!isNum(v)) {
          ok = false;
          break;
        }
        s += v * (n - j);
      }
      if (ok) out[i] = s / denom;
    }
    return out;
  }

  function hma(src, n) {
    const half = wma(src, Math.max(1, Math.round(n / 2)));
    const full = wma(src, n);
    const diff = half.map((h, i) => (isNum(h) && isNum(full[i]) ? 2 * h - full[i] : null));
    return wma(diff, Math.max(1, Math.round(Math.sqrt(n))));
  }

  // Population standard deviation over n values (Pine's ta.stdev default).
  function stdev(src, n) {
    const mean = sma(src, n);
    return mean.map((m, i) => {
      if (!isNum(m)) return null;
      let s = 0;
      for (let j = 0; j < n; j++) s += (src[i - j] - m) ** 2;
      return Math.sqrt(s / n);
    });
  }

  function highest(src, n) {
    return src.map((_, i) => {
      if (i < n - 1) return null;
      let m = -Infinity;
      for (let j = 0; j < n; j++) if (isNum(src[i - j]) && src[i - j] > m) m = src[i - j];
      return m === -Infinity ? null : m;
    });
  }
  function lowest(src, n) {
    return src.map((_, i) => {
      if (i < n - 1) return null;
      let m = Infinity;
      for (let j = 0; j < n; j++) if (isNum(src[i - j]) && src[i - j] < m) m = src[i - j];
      return m === Infinity ? null : m;
    });
  }

  const change = (src, n = 1) => src.map((v, i) => (i >= n && isNum(v) && isNum(src[i - n]) ? v - src[i - n] : null));

  function trueRange(c) {
    return c.map((x, i) => (i === 0 ? x.high - x.low : Math.max(x.high - x.low, Math.abs(x.high - c[i - 1].close), Math.abs(x.low - c[i - 1].close))));
  }

  function rsi(src, n) {
    const ch = change(src);
    const up = rma(ch.map((v) => (isNum(v) ? Math.max(v, 0) : null)), n);
    const down = rma(ch.map((v) => (isNum(v) ? Math.max(-v, 0) : null)), n);
    return up.map((u, i) => {
      const d = down[i];
      if (!isNum(u) || !isNum(d)) return null;
      if (d === 0) return 100;
      if (u === 0) return 0;
      return 100 - 100 / (1 + u / d);
    });
  }

  const crossover = (a, b) => a.map((v, i) => i > 0 && isNum(v) && isNum(b[i]) && isNum(a[i - 1]) && isNum(b[i - 1]) && v > b[i] && a[i - 1] <= b[i - 1]);
  const crossunder = (a, b) => a.map((v, i) => i > 0 && isNum(v) && isNum(b[i]) && isNum(a[i - 1]) && isNum(b[i - 1]) && v < b[i] && a[i - 1] >= b[i - 1]);

  const SOURCES = {
    close: (c) => c.close,
    open: (c) => c.open,
    high: (c) => c.high,
    low: (c) => c.low,
    hl2: (c) => (c.high + c.low) / 2,
    hlc3: (c) => (c.high + c.low + c.close) / 3,
    ohlc4: (c) => (c.open + c.high + c.low + c.close) / 4,
  };
  const source = (candles, name = 'close') => candles.map(SOURCES[name] || SOURCES.close);

  // ---- indicators ---------------------------------------------------------------------------
  const P = (key, label, def, min = 1, max = 500, step = 1) => ({ key, label, default: def, min, max, step });
  const SRC_PARAM = { key: 'source', label: 'Source', default: 'close', options: Object.keys(SOURCES) };

  const DEFS = {
    sma: { name: 'SMA', long: 'Simple moving average', group: 'Moving averages', overlay: true, params: [P('length', 'Length', 20), SRC_PARAM], outputs: [{ key: 'ma', color: '#38bdf8' }],
      calc: (c, p) => ({ ma: sma(source(c, p.source), p.length) }) },
    ema: { name: 'EMA', long: 'Exponential moving average', group: 'Moving averages', overlay: true, params: [P('length', 'Length', 50), SRC_PARAM], outputs: [{ key: 'ma', color: '#f59e0b' }],
      calc: (c, p) => ({ ma: ema(source(c, p.source), p.length) }) },
    wma: { name: 'WMA', long: 'Weighted moving average', group: 'Moving averages', overlay: true, params: [P('length', 'Length', 20), SRC_PARAM], outputs: [{ key: 'ma', color: '#22d3ee' }],
      calc: (c, p) => ({ ma: wma(source(c, p.source), p.length) }) },
    hma: { name: 'HMA', long: 'Hull moving average', group: 'Moving averages', overlay: true, params: [P('length', 'Length', 21), SRC_PARAM], outputs: [{ key: 'ma', color: '#e879f9' }],
      calc: (c, p) => ({ ma: hma(source(c, p.source), p.length) }) },
    vwap: { name: 'VWAP', long: 'Volume-weighted average price, reset each UTC day', group: 'Moving averages', overlay: true, params: [], outputs: [{ key: 'vwap', color: '#fbbf24' }],
      calc: (c) => {
        let pv = 0;
        let vol = 0;
        let day = null;
        return {
          vwap: c.map((x) => {
            const d = Math.floor(x.time / 86400);
            if (d !== day) {
              day = d;
              pv = 0;
              vol = 0;
            }
            const tp = (x.high + x.low + x.close) / 3;
            pv += tp * (x.volume || 0);
            vol += x.volume || 0;
            return vol > 0 ? pv / vol : tp;
          }),
        };
      } },
    bb: { name: 'BB', long: 'Bollinger Bands', group: 'Volatility', overlay: true, params: [P('length', 'Length', 20), P('mult', 'Std. dev.', 2, 0.1, 10, 0.1), SRC_PARAM],
      outputs: [{ key: 'upper', color: '#60a5fa' }, { key: 'basis', color: '#f59e0b' }, { key: 'lower', color: '#60a5fa' }],
      calc: (c, p) => {
        const s = source(c, p.source);
        const basis = sma(s, p.length);
        const dev = stdev(s, p.length);
        return { basis, upper: basis.map((b, i) => (isNum(b) ? b + p.mult * dev[i] : null)), lower: basis.map((b, i) => (isNum(b) ? b - p.mult * dev[i] : null)) };
      } },
    kc: { name: 'KC', long: 'Keltner Channels', group: 'Volatility', overlay: true, params: [P('length', 'Length', 20), P('mult', 'ATR multiple', 2, 0.1, 10, 0.1), P('atr', 'ATR length', 10)],
      outputs: [{ key: 'upper', color: '#34d399' }, { key: 'basis', color: '#94a3b8' }, { key: 'lower', color: '#34d399' }],
      calc: (c, p) => {
        const basis = ema(source(c), p.length);
        const a = rma(trueRange(c), p.atr);
        return { basis, upper: basis.map((b, i) => (isNum(b) && isNum(a[i]) ? b + p.mult * a[i] : null)), lower: basis.map((b, i) => (isNum(b) && isNum(a[i]) ? b - p.mult * a[i] : null)) };
      } },
    donchian: { name: 'Donchian', long: 'Donchian channel (highest high, lowest low)', group: 'Volatility', overlay: true, params: [P('length', 'Length', 20)],
      outputs: [{ key: 'upper', color: '#a78bfa' }, { key: 'mid', color: '#64748b' }, { key: 'lower', color: '#a78bfa' }],
      calc: (c, p) => {
        const upper = highest(c.map((x) => x.high), p.length);
        const lower = lowest(c.map((x) => x.low), p.length);
        return { upper, lower, mid: upper.map((u, i) => (isNum(u) && isNum(lower[i]) ? (u + lower[i]) / 2 : null)) };
      } },
    supertrend: { name: 'Supertrend', long: 'Supertrend (ATR trailing line; green up, red down)', group: 'Trend', overlay: true, params: [P('length', 'ATR length', 10), P('mult', 'Factor', 3, 0.1, 20, 0.1)],
      outputs: [{ key: 'line', color: '#34d399', perPointColor: true }],
      calc: (c, p) => {
        // As Pine's ta.supertrend: bands tighten only in the trend's direction; the trend
        // flips when the close crosses the band that was the line on the previous bar.
        const a = rma(trueRange(c), p.length);
        const line = nulls(c.length);
        const colors = nulls(c.length);
        let upper = null;
        let lower = null;
        let st = null;
        let dir = -1; // 1 up, -1 down (Pine starts in the down state)
        for (let i = 0; i < c.length; i++) {
          if (!isNum(a[i])) continue;
          const hl2 = (c[i].high + c[i].low) / 2;
          let up = hl2 + p.mult * a[i];
          let lo = hl2 - p.mult * a[i];
          const prevClose = i > 0 ? c[i - 1].close : c[i].close;
          if (lower !== null) lo = lo > lower || prevClose < lower ? lo : lower;
          if (upper !== null) up = up < upper || prevClose > upper ? up : upper;
          if (st !== null) {
            if (st === upper) dir = c[i].close > up ? 1 : -1;
            else dir = c[i].close < lo ? -1 : 1;
          }
          upper = up;
          lower = lo;
          st = dir === 1 ? lo : up;
          line[i] = st;
          colors[i] = dir === 1 ? '#34d399' : '#fb7185';
        }
        return { line, _colors: { line: colors } };
      } },
    psar: { name: 'SAR', long: 'Parabolic SAR', group: 'Trend', overlay: true, params: [P('start', 'Start', 0.02, 0.001, 1, 0.001), P('inc', 'Increment', 0.02, 0.001, 1, 0.001), P('max', 'Maximum', 0.2, 0.01, 1, 0.01)],
      outputs: [{ key: 'sar', color: '#e2e8f0', dots: true }],
      calc: (c, p) => {
        const out = nulls(c.length);
        if (c.length < 2) return { sar: out };
        let long = c[1].close >= c[0].close;
        let af = p.start;
        let ep = long ? c[0].high : c[0].low;
        let sar = long ? c[0].low : c[0].high;
        for (let i = 1; i < c.length; i++) {
          sar = sar + af * (ep - sar);
          if (long) {
            sar = Math.min(sar, c[i - 1].low, i > 1 ? c[i - 2].low : c[i - 1].low);
            if (c[i].low < sar) {
              long = false;
              sar = ep;
              ep = c[i].low;
              af = p.start;
            } else if (c[i].high > ep) {
              ep = c[i].high;
              af = Math.min(af + p.inc, p.max);
            }
          } else {
            sar = Math.max(sar, c[i - 1].high, i > 1 ? c[i - 2].high : c[i - 1].high);
            if (c[i].high > sar) {
              long = true;
              sar = ep;
              ep = c[i].high;
              af = p.start;
            } else if (c[i].low < ep) {
              ep = c[i].low;
              af = Math.min(af + p.inc, p.max);
            }
          }
          out[i] = sar;
        }
        return { sar: out };
      } },
    rsi: { name: 'RSI', long: 'Relative strength index', group: 'Oscillators', overlay: false, levels: [30, 70], range: [0, 100], params: [P('length', 'Length', 14), SRC_PARAM], outputs: [{ key: 'rsi', color: '#c084fc' }],
      calc: (c, p) => ({ rsi: rsi(source(c, p.source), p.length) }) },
    macd: { name: 'MACD', long: 'Moving average convergence divergence', group: 'Oscillators', overlay: false, levels: [0], params: [P('fast', 'Fast', 12), P('slow', 'Slow', 26), P('signal', 'Signal', 9)],
      outputs: [{ key: 'hist', color: '#64748b', histogram: true }, { key: 'macd', color: '#38bdf8' }, { key: 'signal', color: '#f59e0b' }],
      calc: (c, p) => {
        const s = source(c);
        const f = ema(s, p.fast);
        const sl = ema(s, p.slow);
        const macd = f.map((v, i) => (isNum(v) && isNum(sl[i]) ? v - sl[i] : null));
        const signal = ema(macd, p.signal);
        const hist = macd.map((v, i) => (isNum(v) && isNum(signal[i]) ? v - signal[i] : null));
        return { macd, signal, hist, _colors: { hist: hist.map((h, i) => (h === null ? null : h >= 0 ? (i > 0 && hist[i - 1] !== null && h < hist[i - 1] ? '#1f7a5a' : '#34d399') : i > 0 && hist[i - 1] !== null && h > hist[i - 1] ? '#8a2b3c' : '#fb7185')) } };
      } },
    stoch: { name: 'Stoch', long: 'Stochastic oscillator', group: 'Oscillators', overlay: false, levels: [20, 80], range: [0, 100], params: [P('k', '%K length', 14), P('smooth', '%K smoothing', 3), P('d', '%D length', 3)],
      outputs: [{ key: 'k', color: '#38bdf8' }, { key: 'd', color: '#f59e0b' }],
      calc: (c, p) => {
        const hh = highest(c.map((x) => x.high), p.k);
        const ll = lowest(c.map((x) => x.low), p.k);
        const raw = c.map((x, i) => (isNum(hh[i]) && isNum(ll[i]) ? (hh[i] === ll[i] ? 50 : (100 * (x.close - ll[i])) / (hh[i] - ll[i])) : null));
        const k = sma(raw, p.smooth);
        return { k, d: sma(k, p.d) };
      } },
    stochrsi: { name: 'Stoch RSI', long: 'Stochastic RSI', group: 'Oscillators', overlay: false, levels: [20, 80], range: [0, 100], params: [P('rsi', 'RSI length', 14), P('length', 'Stoch length', 14), P('k', '%K', 3), P('d', '%D', 3)],
      outputs: [{ key: 'k', color: '#38bdf8' }, { key: 'd', color: '#f59e0b' }],
      calc: (c, p) => {
        const r = rsi(source(c), p.rsi);
        const hh = highest(r, p.length);
        const ll = lowest(r, p.length);
        const raw = r.map((v, i) => (isNum(v) && isNum(hh[i]) && isNum(ll[i]) ? (hh[i] === ll[i] ? 50 : (100 * (v - ll[i])) / (hh[i] - ll[i])) : null));
        const k = sma(raw, p.k);
        return { k, d: sma(k, p.d) };
      } },
    cci: { name: 'CCI', long: 'Commodity channel index', group: 'Oscillators', overlay: false, levels: [-100, 100], params: [P('length', 'Length', 20)], outputs: [{ key: 'cci', color: '#22d3ee' }],
      calc: (c, p) => {
        const tp = source(c, 'hlc3');
        const m = sma(tp, p.length);
        return {
          cci: m.map((mean, i) => {
            if (!isNum(mean)) return null;
            let dev = 0;
            for (let j = 0; j < p.length; j++) dev += Math.abs(tp[i - j] - mean);
            dev /= p.length;
            return dev === 0 ? 0 : (tp[i] - mean) / (0.015 * dev);
          }),
        };
      } },
    willr: { name: '%R', long: 'Williams %R', group: 'Oscillators', overlay: false, levels: [-80, -20], range: [-100, 0], params: [P('length', 'Length', 14)], outputs: [{ key: 'r', color: '#f472b6' }],
      calc: (c, p) => {
        const hh = highest(c.map((x) => x.high), p.length);
        const ll = lowest(c.map((x) => x.low), p.length);
        return { r: c.map((x, i) => (isNum(hh[i]) && isNum(ll[i]) && hh[i] !== ll[i] ? (-100 * (hh[i] - x.close)) / (hh[i] - ll[i]) : null)) };
      } },
    roc: { name: 'ROC', long: 'Rate of change (%)', group: 'Oscillators', overlay: false, levels: [0], params: [P('length', 'Length', 9)], outputs: [{ key: 'roc', color: '#a3e635' }],
      calc: (c, p) => {
        const s = source(c);
        return { roc: s.map((v, i) => (i >= p.length && s[i - p.length] ? (100 * (v - s[i - p.length])) / s[i - p.length] : null)) };
      } },
    adx: { name: 'ADX', long: 'Average directional index with +DI / -DI', group: 'Trend', overlay: false, levels: [20, 25], params: [P('length', 'Length', 14)],
      outputs: [{ key: 'adx', color: '#fbbf24' }, { key: 'plus', color: '#34d399' }, { key: 'minus', color: '#fb7185' }],
      calc: (c, p) => {
        const up = c.map((x, i) => (i === 0 ? null : x.high - c[i - 1].high));
        const down = c.map((x, i) => (i === 0 ? null : c[i - 1].low - x.low));
        const plusDM = up.map((u, i) => (u === null ? null : u > down[i] && u > 0 ? u : 0));
        const minusDM = down.map((d, i) => (d === null ? null : d > up[i] && d > 0 ? d : 0));
        const tr = rma(trueRange(c).map((v, i) => (i === 0 ? null : v)), p.length);
        const plus = rma(plusDM, p.length).map((v, i) => (isNum(v) && tr[i] ? (100 * v) / tr[i] : null));
        const minus = rma(minusDM, p.length).map((v, i) => (isNum(v) && tr[i] ? (100 * v) / tr[i] : null));
        const dx = plus.map((pl, i) => (isNum(pl) && isNum(minus[i]) && pl + minus[i] > 0 ? (100 * Math.abs(pl - minus[i])) / (pl + minus[i]) : null));
        return { adx: rma(dx, p.length), plus, minus };
      } },
    atr: { name: 'ATR', long: 'Average true range', group: 'Volatility', overlay: false, params: [P('length', 'Length', 14)], outputs: [{ key: 'atr', color: '#fb923c' }],
      calc: (c, p) => ({ atr: rma(trueRange(c), p.length) }) },
    obv: { name: 'OBV', long: 'On-balance volume', group: 'Volume', overlay: false, params: [], outputs: [{ key: 'obv', color: '#38bdf8' }],
      calc: (c) => {
        let acc = 0;
        return { obv: c.map((x, i) => (i === 0 ? acc : (acc += x.close > c[i - 1].close ? x.volume || 0 : x.close < c[i - 1].close ? -(x.volume || 0) : 0))) };
      } },
    mfi: { name: 'MFI', long: 'Money flow index', group: 'Volume', overlay: false, levels: [20, 80], range: [0, 100], params: [P('length', 'Length', 14)], outputs: [{ key: 'mfi', color: '#4ade80' }],
      calc: (c, p) => {
        const tp = source(c, 'hlc3');
        const pos = tp.map((v, i) => (i > 0 && v > tp[i - 1] ? v * (c[i].volume || 0) : 0));
        const neg = tp.map((v, i) => (i > 0 && v < tp[i - 1] ? v * (c[i].volume || 0) : 0));
        return {
          mfi: tp.map((_, i) => {
            if (i < p.length) return null;
            let ps = 0;
            let ns = 0;
            for (let j = 0; j < p.length; j++) {
              ps += pos[i - j];
              ns += neg[i - j];
            }
            return ns === 0 ? 100 : 100 - 100 / (1 + ps / ns);
          }),
        };
      } },
  };

  // Params with defaults filled in and clamped to their range.
  function normalizeParams(id, params = {}) {
    const def = DEFS[id];
    if (!def) throw new Error(`Unknown indicator ${id}`);
    const out = {};
    for (const p of def.params) {
      const v = params[p.key];
      if (p.options) out[p.key] = p.options.includes(v) ? v : p.default;
      else {
        const n = Number(v);
        out[p.key] = Number.isFinite(n) ? Math.min(p.max, Math.max(p.min, n)) : p.default;
      }
    }
    return out;
  }

  // { key: [{ time, value, color? }] } without the warm-up bars.
  function compute(id, candles, params) {
    const def = DEFS[id];
    const p = normalizeParams(id, params);
    const raw = def.calc(candles, p);
    const colors = raw._colors || {};
    const out = {};
    for (const o of def.outputs) {
      const values = raw[o.key] || [];
      const pts = [];
      for (let i = 0; i < candles.length; i++) {
        if (!isNum(values[i])) continue;
        const pt = { time: candles[i].time, value: values[i] };
        if (colors[o.key] && colors[o.key][i]) pt.color = colors[o.key][i];
        pts.push(pt);
      }
      out[o.key] = pts;
    }
    return out;
  }

  // "RSI 14", "BB 20 2"
  function label(id, params) {
    const def = DEFS[id];
    const p = normalizeParams(id, params);
    const shown = def.params.filter((x) => !x.options || p[x.key] !== x.default).map((x) => p[x.key]);
    return `${def.name}${shown.length ? ` ${shown.join(' ')}` : ''}`;
  }

  return {
    DEFS,
    compute,
    label,
    normalizeParams,
    core: { sma, ema, rma, wma, hma, stdev, highest, lowest, change, rsi, trueRange, crossover, crossunder, source, isNum },
  };
});
