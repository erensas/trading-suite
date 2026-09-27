// Candles and order books through an instrument's sources (instrument_listings), with a
// short cache. Without a chosen listing the sources are tried in priority order and the
// first one that answers wins; the response says which one and why others were skipped.
const { ProviderError, adapterFor } = require('../../lib/providers');

const CANDLE_TTL_MS = { geckoterminal: 60000, yahoo: 60000, default: 10000 };
const CACHE_ENTRIES = 300;

const listingInfo = (s) => ({ id: s.listing.id, provider_id: s.provider.id, provider: s.provider.name, kind: s.provider.kind, provider_symbol: s.listing.provider_symbol });

function createMarketData({ instruments, providers }) {
  const candleCache = new Map();

  async function candlesFrom(source, symbol, tf, limit) {
    const { provider, inst } = source;
    const key = `${symbol}|${provider.id}|${source.listing.id}|${tf}|${limit}`;
    const hit = candleCache.get(key);
    const ttl = CANDLE_TTL_MS[provider.kind] || CANDLE_TTL_MS.default;
    if (hit && Date.now() - hit.at < ttl) return hit.body;
    let rows;
    try {
      rows = await providers.call(provider, 'candles', inst, tf, limit);
      if (!rows.length) throw new ProviderError(`${provider.name} returned no ${tf} candles`);
    } catch (e) {
      // The last good response (marked stale) beats an empty chart.
      if (hit && !e.unsupported) return { ...hit.body, stale: true, staleReason: e.message, fetchedAt: new Date(hit.at).toISOString() };
      throw e;
    }
    let sourceText = provider.name;
    if (adapterFor(provider).describe) sourceText = await providers.call(provider, 'describe', inst).catch(() => sourceText);
    const body = { success: true, symbol, timeframe: tf, provider: { id: provider.id, name: provider.name, kind: provider.kind }, listing: listingInfo(source), source: sourceText, candles: rows };
    candleCache.delete(key);
    candleCache.set(key, { at: Date.now(), body });
    if (candleCache.size > CACHE_ENTRIES) candleCache.delete(candleCache.keys().next().value);
    return body;
  }

  async function candles({ symbol, tf, limit, listingId }) {
    const sources = await instruments.sources(symbol, { listingId });
    const skipped = [];
    let lastError = null;
    for (const source of sources) {
      try {
        const body = await candlesFrom(source, symbol, tf, limit);
        return skipped.length ? { ...body, fallbackFrom: skipped } : body;
      } catch (e) {
        lastError = e;
        skipped.push({ provider: source.provider.name, error: e.message });
      }
    }
    if (sources.length > 1) {
      const err = new ProviderError(`No source answered: ${skipped.map((s) => `${s.provider}: ${s.error}`).join('; ')}`, { status: lastError.status || 502 });
      err.unsupported = skipped.length > 0 && lastError.unsupported;
      throw err;
    }
    throw lastError;
  }

  // The first source that has an order book.
  async function orderbook(symbol) {
    const sources = await instruments.sources(symbol);
    let lastError = null;
    for (const source of sources) {
      try {
        const book = await providers.call(source.provider, 'orderbook', source.inst);
        if (!book.bids.length && !book.asks.length) throw new ProviderError(`${source.provider.name} returned an empty order book`);
        return { provider: source.provider, listing: listingInfo(source), book };
      } catch (e) {
        lastError = e;
      }
    }
    throw lastError;
  }

  // Quick check of one listing: a ticker, or candles when the provider has no ticker.
  async function testListing(symbol, listingId) {
    const [source] = await instruments.sources(symbol, { listingId });
    const started = Date.now();
    try {
      const t = await providers.call(source.provider, 'ticker', source.inst);
      return { ok: Number.isFinite(t.price), message: `price ${t.price}`, ms: Date.now() - started };
    } catch (e) {
      if (!e.unsupported) return { ok: false, message: e.message, ms: Date.now() - started };
    }
    try {
      const rows = await providers.call(source.provider, 'candles', source.inst, '1h', 5);
      return { ok: rows.length > 0, message: rows.length ? `${rows.length} candles, last close ${rows[rows.length - 1].close}` : 'no candles', ms: Date.now() - started };
    } catch (e) {
      return { ok: false, message: e.message, ms: Date.now() - started };
    }
  }

  // Binance spot depth by exchange symbol, for existing callers (software_tester).
  const LEGACY_BINANCE = { kind: 'binance', name: 'Binance (legacy order book route)', base_url: 'https://api.binance.com', config: {} };
  function binanceOrderbook(symbol) {
    return providers.call(LEGACY_BINANCE, 'orderbook', { symbol, provider_symbol: symbol });
  }

  function forgetSymbol(symbol) {
    for (const key of candleCache.keys()) if (key.startsWith(`${symbol}|`)) candleCache.delete(key);
  }

  return { candles, orderbook, testListing, binanceOrderbook, forgetSymbol, clear: () => candleCache.clear() };
}

module.exports = { createMarketData };
