// Market data providers: CRUD and connection test.
const express = require('express');
const { TIMEFRAMES } = require('../../lib/providers');
const { validate } = require('../http/middleware');
const { UNDEFINED_TABLE } = require('../db');
const schemas = require('../schemas');

module.exports = function providerRoutes({ providers, marketData, audit, requireControl }) {
  const router = express.Router();
  const byId = validate({ params: schemas.idParam });

  router.get('/api/providers/kinds', (req, res) => {
    res.json({ success: true, kinds: providers.kinds(), timeframes: TIMEFRAMES });
  });

  router.get('/api/providers', async (req, res) => {
    try {
      res.json({ success: true, providers: await providers.list() });
    } catch (err) {
      if (err.code === UNDEFINED_TABLE) return res.json({ success: true, providers: [], notInstalled: true });
      throw err;
    }
  });

  router.post('/api/providers', requireControl, validate({ body: schemas.patch }), async (req, res) => {
    const provider = await providers.create(req.valid.body);
    await audit(req, 'create', 'provider', provider.id, null, provider);
    res.json({ success: true, provider });
  });

  router.put('/api/providers/:id', requireControl, byId, validate({ body: schemas.patch }), async (req, res) => {
    const { before, after } = await providers.update(req.valid.params.id, req.valid.body);
    await audit(req, 'update', 'provider', before.id, before, after);
    marketData.clear();
    res.json({ success: true, provider: after });
  });

  router.delete('/api/providers/:id', requireControl, byId, async (req, res) => {
    const removed = await providers.remove(req.valid.params.id);
    await audit(req, 'delete', 'provider', removed.id, removed, null);
    marketData.clear();
    res.json({ success: true, message: `${removed.name} removed; its instruments have no provider now.` });
  });

  router.post('/api/providers/:id/test', requireControl, byId, async (req, res) => {
    const provider = await providers.mustGet(req.valid.params.id);
    res.json({ success: true, ...(await providers.test(provider)) });
  });

  return router;
};
