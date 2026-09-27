// Trading venues: exchange and broker accounts, their write-only API keys, connection tests,
// and the Web3 engine as a read-only DEX venue.
const express = require('express');
const { validate } = require('../http/middleware');
const schemas = require('../schemas');

const BROKERS = [{ id: 'alpaca', name: 'Alpaca (US stocks and ETFs)', modes: ['paper'] }];

module.exports = function venueRoutes({ venues, identity, audit, requireControl }) {
  const router = express.Router();
  const byId = validate({ params: schemas.idParam });

  router.get('/api/venues', async (req, res) => {
    const [list, exchanges] = await Promise.all([venues.list(), venues.exchanges()]);
    res.json({ success: true, venues: list, exchanges, brokers: BROKERS });
  });

  router.get('/api/venues/dex', async (req, res) => {
    res.json({ success: true, ...(await venues.dex()) });
  });

  router.post('/api/venues', requireControl, validate({ body: schemas.patch }), async (req, res) => {
    const v = await venues.create(req.valid.body, identity.actorLabel(req));
    await audit(req, 'create', 'trading venue', v.id, null, { name: v.name, exchange: v.exchange, mode: v.mode });
    res.json({ success: true, venue: v });
  });

  router.put('/api/venues/:id', requireControl, byId, validate({ body: schemas.patch }), async (req, res) => {
    const { before, after } = await venues.update(req.valid.params.id, req.valid.body);
    await audit(req, 'update', 'trading venue', after.id, { name: before.name, mode: before.mode, enabled: before.enabled }, { name: after.name, mode: after.mode, enabled: after.enabled });
    res.json({ success: true, venue: after });
  });

  router.delete('/api/venues/:id', requireControl, byId, async (req, res) => {
    const v = await venues.remove(req.valid.params.id);
    await audit(req, 'delete', 'trading venue', v.id, { name: v.name, exchange: v.exchange }, null);
    res.json({ success: true });
  });

  // Keys are write-only: the answer only says whether they are set.
  router.put('/api/venues/:id/keys', requireControl, byId, validate({ body: schemas.exchangeKeys }), async (req, res) => {
    const keys = await venues.setKeys(req.valid.params.id, req.valid.body, identity.actorLabel(req));
    await audit(req, 'update', 'trading venue keys', req.valid.params.id, null, { hint: keys.hint });
    res.json({ success: true, keys });
  });

  router.delete('/api/venues/:id/keys', requireControl, byId, async (req, res) => {
    await venues.removeKeys(req.valid.params.id);
    await audit(req, 'delete', 'trading venue keys', req.valid.params.id, null, null);
    res.json({ success: true });
  });

  router.post('/api/venues/:id/test', requireControl, byId, async (req, res) => {
    res.json({ success: true, result: await venues.test(req.valid.params.id) });
  });

  return router;
};
