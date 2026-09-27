// Instrument details, sources (listings), symbol search and import, watchlists.
const express = require('express');
const { z } = require('zod');
const { validate } = require('../http/middleware');
const { notFound } = require('../http/errors');
const schemas = require('../schemas');

module.exports = function instrumentRoutes({ instruments, watchlists, search, marketData, audit, tickerRefresh, requireControl }) {
  const router = express.Router();
  const bySymbol = validate({ params: schemas.symbolParam });
  const byId = validate({ params: schemas.idParam });
  const changed = (symbol) => {
    marketData.forgetSymbol(symbol);
    tickerRefresh.schedule(2000);
  };

  // ---- search and import ------------------------------------------------------------------
  router.get('/api/search', validate({ query: schemas.searchQuery.extend({ scope: z.enum(['default', 'cex', 'dex', 'tradfi', 'all']).default('default') }) }), async (req, res) => {
    const { q, scope } = req.valid.query;
    res.json({ success: true, query: q, scope, ...(await search.search(q, { scope })) });
  });

  router.post('/api/instruments/import', requireControl, validate({ body: schemas.importInstrument }), async (req, res) => {
    const out = await instruments.importInstrument(req.valid.body);
    await audit(req, out.created ? 'create' : 'add-sources', 'instrument', out.symbol, null, { ...req.valid.body, listings: out.listings });
    changed(out.symbol);
    res.json({ success: true, ...out });
  });

  // ---- one instrument -------------------------------------------------------------------------
  router.get('/api/instruments/:symbol', bySymbol, async (req, res) => {
    const found = await instruments.get(req.valid.params.symbol);
    if (!found) throw notFound('Instrument not found');
    const symbol = found.inst.symbol;
    const [listings, lists] = await Promise.all([instruments.listings(symbol), watchlists.containing(symbol)]);
    const inst = Object.fromEntries(Object.entries(found.inst).filter(([k]) => !k.startsWith('p_')));
    res.json({ success: true, instrument: inst, listings, watchlists: lists });
  });

  router.get('/api/instruments/:symbol/candidates', bySymbol, async (req, res) => {
    const out = await search.candidates(req.valid.params.symbol);
    if (!out) throw notFound('Instrument not found');
    res.json({ success: true, ...out });
  });

  router.post('/api/instruments/:symbol/listings', requireControl, bySymbol, validate({ body: schemas.patch }), async (req, res) => {
    const found = await instruments.get(req.valid.params.symbol);
    if (!found) throw notFound('Instrument not found');
    const listing = await instruments.addListing(found.inst.symbol, req.valid.body);
    await audit(req, 'create', 'listing', listing.id, null, listing);
    changed(found.inst.symbol);
    res.json({ success: true, listing });
  });

  router.put('/api/instruments/:symbol/listings/order', requireControl, bySymbol, validate({ body: schemas.reorderIds }), async (req, res) => {
    await instruments.reorderListings(req.valid.params.symbol, req.valid.body.ids);
    await audit(req, 'reorder', 'listing', req.valid.params.symbol, null, req.valid.body);
    changed(req.valid.params.symbol);
    res.json({ success: true, listings: await instruments.listings(req.valid.params.symbol) });
  });

  router.put('/api/listings/:id', requireControl, byId, validate({ body: schemas.patch }), async (req, res) => {
    const { before, after } = await instruments.updateListing(req.valid.params.id, req.valid.body);
    await audit(req, 'update', 'listing', after.id, before, after);
    changed(after.symbol);
    res.json({ success: true, listing: after });
  });

  router.delete('/api/listings/:id', requireControl, byId, async (req, res) => {
    const removed = await instruments.removeListing(req.valid.params.id);
    await audit(req, 'delete', 'listing', removed.id, removed, null);
    changed(removed.symbol);
    res.json({ success: true });
  });

  router.post('/api/listings/:id/test', requireControl, byId, async (req, res) => {
    const l = await instruments.getListing(req.valid.params.id);
    res.json({ success: true, ...(await marketData.testListing(l.symbol, l.id)) });
  });

  // ---- watchlists -----------------------------------------------------------------------------
  router.get('/api/watchlists', async (req, res) => {
    res.json({ success: true, watchlists: await watchlists.list(), columns: schemas.WATCHLIST_COLUMNS });
  });

  router.post('/api/watchlists', requireControl, validate({ body: schemas.patch }), async (req, res) => {
    const w = await watchlists.create(req.valid.body);
    await audit(req, 'create', 'watchlist', w.id, null, w);
    res.json({ success: true, watchlist: w });
  });

  router.put('/api/watchlists/:id', requireControl, byId, validate({ body: schemas.patch }), async (req, res) => {
    const { before, after } = await watchlists.update(req.valid.params.id, req.valid.body);
    await audit(req, 'update', 'watchlist', after.id, before, after);
    res.json({ success: true, watchlist: after });
  });

  router.delete('/api/watchlists/:id', requireControl, byId, async (req, res) => {
    const removed = await watchlists.remove(req.valid.params.id);
    await audit(req, 'delete', 'watchlist', removed.id, removed, null);
    res.json({ success: true });
  });

  router.get('/api/watchlists/:id/items', byId, async (req, res) => {
    res.json({ success: true, items: await watchlists.items(req.valid.params.id) });
  });

  router.post('/api/watchlists/:id/items', requireControl, byId, validate({ body: schemas.watchlistItem }), async (req, res) => {
    const out = await watchlists.addItem(req.valid.params.id, req.valid.body.symbol);
    res.json({ success: true, ...out });
  });

  router.delete('/api/watchlists/:id/items/:symbol', requireControl, validate({ params: schemas.watchlistItemParams }), async (req, res) => {
    await watchlists.removeItem(req.valid.params.id, req.valid.params.symbol);
    res.json({ success: true });
  });

  router.put('/api/watchlists/:id/items', requireControl, byId, validate({ body: schemas.reorderSymbols }), async (req, res) => {
    res.json({ success: true, order: await watchlists.reorder(req.valid.params.id, req.valid.body.symbols) });
  });

  return router;
};
