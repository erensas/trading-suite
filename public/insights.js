// Rule-based reading of an instrument's recent candles: market regime (trend, range,
// squeeze), key readings, and which indicators and strategy templates suit that regime.
// Shared by the browser (window.Insights) and the server (require('../public/insights')).
// Plain rules with the numbers behind them; not a forecast and not advice.
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory(require('./indicators'));
  else root.Insights = factory(root.Indicators);
})(typeof self !== 'undefined' ? self : this, function (Indicators) {
  'use strict';

  const { ema, rsi, stdev, sma, rma, trueRange } = Indicators.core;
  const last = (a) => {
    for (let i = a.length - 1; i >= 0; i--) if (typeof a[i] === 'number' && Number.isFinite(a[i])) return a[i];
    return null;
  };
  const at = (a, back) => {
    const v = a[a.length - 1 - back];
    return typeof v === 'number' && Number.isFinite(v) ? v : null;
  };
  // Where the last value sits among the last n values (0 to 100).
  function percentile(a, n) {
    const vals = a.slice(-n).filter((v) => typeof v === 'number' && Number.isFinite(v));
    const x = vals[vals.length - 1];
    if (vals.length < 20 || x === undefined) return null;
    return Math.round((vals.filter((v) => v <= x).length / vals.length) * 100);
  }
  const ordinal = (n) => `${n}${n % 100 >= 11 && n % 100 <= 13 ? 'th' : ['th', 'st', 'nd', 'rd'][n % 10] || 'th'}`;
  const round = (v, d = 2) => (v === null || !Number.isFinite(v) ? null : Number(v.toFixed(d)));
  const INTRADAY = ['1m', '5m', '15m', '1h'];

  function analyze(candles, { timeframe = '' } = {}) {
    const n = candles.length;
    if (n < 60) return { ok: false, message: `needs at least 60 candles (${n} on the chart)` };
    const close = candles.map((c) => c.close);
    const price = close[n - 1];
    const longLen = n >= 230 ? 200 : 100;
    const e50 = ema(close, 50);
    const eLong = ema(close, longLen);
    const adxOut = Indicators.compute('adx', candles, { length: 14 });
    const vals = (series) => series.map((p) => (p && Number.isFinite(p.value) ? p.value : null));
    const adx = last(vals(adxOut.adx));
    const plusDi = last(vals(adxOut.plus));
    const minusDi = last(vals(adxOut.minus));
    const atr = rma(trueRange(candles), 14);
    const atrPct = atr.map((a, i) => (a === null ? null : (a / close[i]) * 100));
    const basis = sma(close, 20);
    const dev = stdev(close, 20);
    const bbw = basis.map((b, i) => (b === null || dev[i] === null ? null : ((4 * dev[i]) / b) * 100));
    const r = rsi(close, 14);
    const macdOut = Indicators.compute('macd', candles, { fast: 12, slow: 26, signal: 9 });
    const hist = vals(macdOut.hist);
    const vol = candles.map((c) => c.volume || 0);
    const volNow = vol.slice(-20).reduce((s, v) => s + v, 0);
    const volBefore = vol.slice(-40, -20).reduce((s, v) => s + v, 0);

    const e50v = last(e50);
    const eLongv = last(eLong);
    const e50Slope = at(e50, 0) !== null && at(e50, 10) !== null ? ((at(e50, 0) / at(e50, 10) - 1) * 100) : null;
    const atrNow = last(atrPct);
    const atrRank = percentile(atrPct, 200);
    const bbwRank = percentile(bbw, 120);
    const rsiNow = last(r);
    const histNow = at(hist, 0);
    const histPrev = at(hist, 1);
    const change20 = n > 20 ? (price / close[n - 21] - 1) * 100 : null;

    const reasons = [];
    let kind = 'mixed';
    // Moving averages and the directional indicators have to agree.
    const up = e50v !== null && eLongv !== null && e50v > eLongv && price > e50v && plusDi - minusDi >= 5;
    const down = e50v !== null && eLongv !== null && e50v < eLongv && price < e50v && minusDi - plusDi >= 5;
    if (adx !== null && adx >= 25 && up) {
      kind = 'uptrend';
      reasons.push(`ADX ${adx.toFixed(0)} (≥ 25: a trend), +DI ${plusDi.toFixed(0)} over −DI ${minusDi.toFixed(0)}`);
      reasons.push(`price above EMA 50, EMA 50 above EMA ${longLen}`);
    } else if (adx !== null && adx >= 25 && down) {
      kind = 'downtrend';
      reasons.push(`ADX ${adx.toFixed(0)} (≥ 25: a trend), −DI ${minusDi.toFixed(0)} over +DI ${plusDi.toFixed(0)}`);
      reasons.push(`price below EMA 50, EMA 50 below EMA ${longLen}`);
    } else if (bbwRank !== null && bbwRank <= 20) {
      kind = 'squeeze';
      reasons.push(`Bollinger width at the ${ordinal(bbwRank)} percentile of the last 120 bars (narrow: volatility compressed)`);
      if (adx !== null) reasons.push(`ADX ${adx.toFixed(0)}${adx >= 25 ? ', left over from the last move' : ': no trend'}`);
    } else if (adx !== null && adx < 20) {
      kind = 'range';
      reasons.push(`ADX ${adx.toFixed(0)} (< 20: no trend)`);
      if (e50Slope !== null) reasons.push(`EMA 50 ${Math.abs(e50Slope) < 0.5 ? 'flat' : e50Slope > 0 ? 'rising slowly' : 'falling slowly'} (${e50Slope.toFixed(2)}% over 10 bars)`);
    } else {
      if (adx !== null) reasons.push(adx >= 25 ? `ADX ${adx.toFixed(0)}, but +DI ${plusDi.toFixed(0)} / −DI ${minusDi.toFixed(0)} and the moving averages do not agree on a direction` : `ADX ${adx.toFixed(0)}: a weak trend at most`);
      reasons.push(up ? 'moving averages point up' : down ? 'moving averages point down' : 'price and moving averages disagree');
    }
    const volatility = atrRank === null ? null : atrRank >= 80 ? 'high' : atrRank <= 20 ? 'low' : 'normal';
    const LABELS = { uptrend: 'Uptrend', downtrend: 'Downtrend', range: 'Range', squeeze: 'Squeeze (breakout pending)', mixed: 'Mixed / transition' };

    const readings = [];
    if (rsiNow !== null) readings.push({ name: 'RSI 14', value: round(rsiNow, 1), note: rsiNow >= 70 ? 'overbought' : rsiNow <= 30 ? 'oversold' : rsiNow >= 50 ? 'above 50' : 'below 50', tone: rsiNow >= 70 ? -1 : rsiNow <= 30 ? 1 : 0 });
    if (histNow !== null) readings.push({ name: 'MACD histogram', value: round(histNow, 4), note: `${histNow >= 0 ? 'positive' : 'negative'}, ${histPrev !== null && Math.abs(histNow) > Math.abs(histPrev) ? 'widening' : 'narrowing'}`, tone: Math.sign(histNow) });
    if (e50v !== null) readings.push({ name: 'Price vs EMA 50', value: `${round((price / e50v - 1) * 100, 2)}%`, note: price >= e50v ? 'above' : 'below', tone: price >= e50v ? 1 : -1 });
    if (eLongv !== null) readings.push({ name: `Price vs EMA ${longLen}`, value: `${round((price / eLongv - 1) * 100, 2)}%`, note: price >= eLongv ? 'above' : 'below', tone: price >= eLongv ? 1 : -1 });
    if (adx !== null) readings.push({ name: 'ADX 14', value: round(adx, 1), note: adx >= 25 ? 'trending' : adx < 20 ? 'no trend' : 'weak trend', tone: 0 });
    if (atrNow !== null) readings.push({ name: 'ATR 14', value: `${round(atrNow, 2)}% of price`, note: atrRank === null ? '' : `${ordinal(atrRank)} percentile (${volatility} volatility)`, tone: 0 });
    if (change20 !== null) readings.push({ name: '20-bar change', value: `${round(change20, 2)}%`, note: '', tone: Math.sign(change20) });
    if (volBefore > 0) readings.push({ name: 'Volume, last 20 bars', value: `${round((volNow / volBefore - 1) * 100, 0)}%`, note: 'vs the 20 before', tone: 0 });

    const ind = (id, params, why) => ({ id, params, why, label: Indicators.label(id, Indicators.normalizeParams(id, params)) });
    const indicators = [];
    const strategies = [];
    if (kind === 'uptrend' || kind === 'downtrend') {
      indicators.push(ind('ema', { length: 50 }, 'trend direction and dynamic support / resistance'));
      indicators.push(ind('ema', { length: longLen }, 'the long trend filter'));
      indicators.push(ind('supertrend', { length: 10, mult: 3 }, 'a trailing line that flips when the trend breaks'));
      indicators.push(ind('adx', { length: 14 }, 'whether the trend keeps its strength'));
      indicators.push(ind('macd', {}, 'momentum; divergences warn of a turn'));
      if (kind === 'uptrend') {
        strategies.push({ template: 'EmaCrossStrategy', fit: 'good', why: 'trend-following entries on EMA crosses above the long trend' });
        strategies.push({ template: 'MacdTrendStrategy', fit: 'good', why: 'MACD momentum entries with a trend filter' });
      } else {
        strategies.push({ template: 'MacdTrendStrategy', fit: 'possible', why: 'its trend filter keeps it out while price is under the long EMA; long-only templates mostly wait here' });
        strategies.push({ template: 'RsiMeanReversionStrategy', fit: 'weak', why: 'buying dips against a downtrend is risky; test before use' });
      }
    } else if (kind === 'range') {
      indicators.push(ind('bb', { length: 20, mult: 2 }, 'the edges of the range'));
      indicators.push(ind('rsi', { length: 14 }, 'overbought / oversold turns inside the range'));
      indicators.push(ind('stoch', {}, 'short-term turning points'));
      if (INTRADAY.includes(timeframe)) indicators.push(ind('vwap', {}, 'the session average that price tends to revert to'));
      strategies.push({ template: 'RsiMeanReversionStrategy', fit: 'good', why: 'buys oversold dips and sells into strength, which suits a range' });
      strategies.push({ template: 'BollingerBreakoutStrategy', fit: 'possible', why: 'for when the range breaks' });
    } else if (kind === 'squeeze') {
      indicators.push(ind('bb', { length: 20, mult: 2 }, 'narrow bands mark the squeeze; a close outside marks the break'));
      indicators.push(ind('kc', {}, 'Bollinger inside Keltner is the classic squeeze signal'));
      indicators.push(ind('atr', { length: 14 }, 'volatility expanding again'));
      indicators.push(ind('obv', {}, 'volume confirming the breakout side'));
      strategies.push({ template: 'BollingerBreakoutStrategy', fit: 'good', why: 'enters when price breaks out of compressed bands' });
      strategies.push({ template: 'EmaCrossStrategy', fit: 'possible', why: 'catches the trend if the breakout follows through' });
    } else {
      indicators.push(ind('ema', { length: 50 }, 'which way the market leans'));
      indicators.push(ind('rsi', { length: 14 }, 'momentum extremes'));
      indicators.push(ind('macd', {}, 'momentum turning'));
      indicators.push(ind('atr', { length: 14 }, 'position sizing and stops in a choppy market'));
      strategies.push({ template: 'RsiMeanReversionStrategy', fit: 'possible', why: 'works while there is no clear trend' });
      strategies.push({ template: 'EmaCrossStrategy', fit: 'possible', why: 'if a trend forms; expect whipsaws until then' });
    }
    if (volatility === 'high' && !indicators.some((i) => i.id === 'atr')) indicators.push(ind('atr', { length: 14 }, 'volatility is high: size positions and stops by ATR'));

    return {
      ok: true,
      bars: n,
      timeframe,
      price,
      regime: { kind, label: LABELS[kind], volatility, reasons },
      readings,
      indicators,
      strategies,
      note: `Rules on the last ${n} candles (EMA 50 / ${longLen}, ADX 14, Bollinger width, ATR, RSI, MACD). A description of the recent past, not a forecast or advice.`,
    };
  }

  return { analyze };
});
