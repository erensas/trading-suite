// Pine scripts (the chart's Pine panel).
const express = require('express');
const { validate } = require('../http/middleware');
const schemas = require('../schemas');

module.exports = function pineRoutes({ pineScripts, identity, audit, requireControl }) {
  const router = express.Router();
  const byId = validate({ params: schemas.idParam });

  router.get('/api/pine/scripts', async (req, res) => {
    res.json({ success: true, scripts: await pineScripts.list() });
  });

  router.get('/api/pine/scripts/:id', byId, async (req, res) => {
    res.json({ success: true, script: await pineScripts.get(req.valid.params.id) });
  });

  router.post('/api/pine/scripts', requireControl, validate({ body: schemas.patch }), async (req, res) => {
    const s = await pineScripts.create(req.valid.body, identity.actorLabel(req));
    await audit(req, 'create', 'pine script', s.id, null, { name: s.name });
    res.json({ success: true, script: s });
  });

  router.put('/api/pine/scripts/:id', requireControl, byId, validate({ body: schemas.patch }), async (req, res) => {
    const { before, after } = await pineScripts.update(req.valid.params.id, req.valid.body);
    await audit(req, 'update', 'pine script', after.id, before, { name: after.name });
    res.json({ success: true, script: after });
  });

  router.delete('/api/pine/scripts/:id', requireControl, byId, async (req, res) => {
    const s = await pineScripts.remove(req.valid.params.id);
    await audit(req, 'delete', 'pine script', s.id, { name: s.name }, null);
    res.json({ success: true });
  });

  return router;
};
