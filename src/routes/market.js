// Instruments, candles and order books.
const express = require('express');
const { validate } = require('../http/middleware');
const { asUpstream, notFound } = require('../http/errors');
const schemas = require('../schemas');

module.exports = function marketRoutes({ instruments, marketData, settings, audit, tickerRefresh, requireControl }) {
  const router = express.Router();
  const symbolOf = (req) => (req.valid.query && req.valid.query.symbol) || settings.values.defaultSymbol;

  router.get('/api/trading/pairs', validate({ query: schemas.pairsQuery }), async (req, res) => {
    res.json({ success: true, pairs: await instruments.list({ activeOnly: req.valid.query.all !== '1' }) });
  });

  router.post('/api/trading/pairs', requireControl, validate({ body: schemas.patch }), async (req, res) => {
    const i = await instruments.create(req.valid.body);
    await audit(req, 'create', 'instrument', i.symbol, null, i);
    tickerRefresh.schedule(2000);
    res.json({ success: true, symbol: i.symbol });
  });

  router.put('/api/trading/pairs/:symbol', requireControl, validate({ params: schemas.symbolParam, body: schemas.patch }), async (req, res) => {
    const changed = await instruments.update(req.valid.params.symbol, req.valid.body);
    if (!changed) throw notFound('Instrument not found');
    await audit(req, 'update', 'instrument', changed.after.symbol, changed.before, changed.after);
    marketData.forgetSymbol(changed.after.symbol);
    tickerRefresh.schedule(2000);
    res.json({ success: true, symbol: changed.after.symbol });
  });

  router.get('/api/trading/candles', validate({ query: schemas.candlesQuery }), async (req, res) => {
    const q = req.valid.query;
    const s = settings.values;
    const limit = Math.max(20, Math.min(q.limit || s.candleLimit, 1000));
    res.json(await marketData.candles({ symbol: symbolOf(req), tf: q.tf || s.defaultTimeframe, limit }).catch(asUpstream));
  });

  router.get('/api/trading/orderbook', validate({ query: schemas.symbolQuery }), async (req, res) => {
    const symbol = symbolOf(req);
    const { provider, book } = await marketData.orderbook(symbol).catch(asUpstream);
    res.json({ success: true, symbol, provider: provider.name, bids: book.bids, asks: book.asks });
  });

  // Kept for existing callers (software_tester): Binance spot depth by exchange symbol.
  router.get('/api/trading/binance/orderbook', validate({ query: schemas.binanceBookQuery }), async (req, res) => {
    const symbol = String(req.valid.query.symbol || 'ETHUSDT').replace('/', '').toUpperCase();
    const book = await marketData.binanceOrderbook(symbol).catch(asUpstream);
    res.json({
      success: true,
      symbol,
      bids: book.bids.slice(0, 10).map(([price, qty]) => ({ price, qty })),
      asks: book.asks.slice(0, 10).map(([price, qty]) => ({ price, qty })),
    });
  });

  return router;
};
