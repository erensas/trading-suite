// Candles and order books through each instrument's provider, with a short cache.
const { ProviderError, adapterFor } = require('../../lib/providers');

const CANDLE_TTL_MS = { geckoterminal: 60000, yahoo: 60000, default: 10000 };
const CACHE_ENTRIES = 300;

function createMarketData({ instruments, providers }) {
  const candleCache = new Map();

  async function candles({ symbol, tf, limit }) {
    const { inst, provider } = await instruments.resolve(symbol);
    const key = `${symbol}|${provider.id}|${tf}|${limit}`;
    const hit = candleCache.get(key);
    const ttl = CANDLE_TTL_MS[provider.kind] || CANDLE_TTL_MS.default;
    if (hit && Date.now() - hit.at < ttl) return hit.body;

    let rows;
    try {
      rows = await providers.call(provider, 'candles', inst, tf, limit);
    } catch (e) {
      // Serve the last good response (marked stale) rather than an empty chart.
      if (hit && !e.unsupported) return { ...hit.body, stale: true, staleReason: e.message, fetchedAt: new Date(hit.at).toISOString() };
      throw e;
    }
    let source = provider.name;
    if (adapterFor(provider).describe) source = await providers.call(provider, 'describe', inst).catch(() => source);
    const body = { success: true, symbol, timeframe: tf, provider: { id: provider.id, name: provider.name, kind: provider.kind }, source, candles: rows };
    candleCache.delete(key);
    candleCache.set(key, { at: Date.now(), body });
    if (candleCache.size > CACHE_ENTRIES) candleCache.delete(candleCache.keys().next().value);
    return body;
  }

  async function orderbook(symbol) {
    const { inst, provider } = await instruments.resolve(symbol);
    const book = await providers.call(provider, 'orderbook', inst);
    if (!book.bids.length && !book.asks.length) throw new ProviderError(`${provider.name} returned an empty order book`);
    return { provider, book };
  }

  // Binance spot depth by exchange symbol, for existing callers (software_tester).
  const LEGACY_BINANCE = { kind: 'binance', name: 'Binance (legacy order book route)', base_url: 'https://api.binance.com', config: {} };
  function binanceOrderbook(symbol) {
    return providers.call(LEGACY_BINANCE, 'orderbook', { symbol, provider_symbol: symbol });
  }

  function forgetSymbol(symbol) {
    for (const key of candleCache.keys()) if (key.startsWith(`${symbol}|`)) candleCache.delete(key);
  }

  return { candles, orderbook, binanceOrderbook, forgetSymbol, clear: () => candleCache.clear() };
}

module.exports = { createMarketData };
