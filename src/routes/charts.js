// Chart layouts (indicators) and alerts.
const express = require('express');
const { z } = require('zod');
const { validate } = require('../http/middleware');
const schemas = require('../schemas');
const Indicators = require('../../public/indicators');

module.exports = function chartRoutes({ alerts, identity, audit, requireControl }) {
  const router = express.Router();
  const byId = validate({ params: schemas.idParam });

  // The indicator library (names, groups, params, outputs) for the UI.
  router.get('/api/indicators', (req, res) => {
    const defs = Object.fromEntries(
      Object.entries(Indicators.DEFS).map(([id, d]) => [id, { name: d.name, long: d.long, group: d.group, overlay: d.overlay, levels: d.levels || [], params: d.params, outputs: d.outputs.map(({ key, color, histogram }) => ({ key, color, histogram: !!histogram })) }])
    );
    res.json({ success: true, indicators: defs });
  });

  router.get('/api/chart-layout', validate({ query: z.object({ symbol: z.string().max(60).optional() }) }), async (req, res) => {
    res.json({ success: true, ...(await alerts.getLayout(req.valid.query.symbol)) });
  });

  router.put('/api/chart-layout', requireControl, validate({ body: schemas.chartLayout }), async (req, res) => {
    const { scope, layout } = req.valid.body;
    await alerts.saveLayout(scope, layout, identity.actorLabel(req));
    res.json({ success: true, scope });
  });

  // Back to the default layout for one symbol.
  router.delete('/api/chart-layout/:symbol', requireControl, validate({ params: schemas.symbolParam }), async (req, res) => {
    await alerts.deleteLayout(req.valid.params.symbol);
    res.json({ success: true });
  });

  router.get('/api/alerts', validate({ query: z.object({ symbol: z.string().max(60).optional() }) }), async (req, res) => {
    res.json({ success: true, alerts: await alerts.list({ symbol: req.valid.query.symbol }) });
  });

  router.post('/api/alerts', requireControl, validate({ body: schemas.patch }), async (req, res) => {
    const a = await alerts.create(req.valid.body, identity.actorLabel(req));
    await audit(req, 'create', 'alert', a.id, null, a);
    res.json({ success: true, alert: a });
  });

  router.put('/api/alerts/:id', requireControl, byId, validate({ body: schemas.patch }), async (req, res) => {
    const { before, after } = await alerts.update(req.valid.params.id, req.valid.body);
    await audit(req, 'update', 'alert', after.id, before, after);
    res.json({ success: true, alert: after });
  });

  router.delete('/api/alerts/:id', requireControl, byId, async (req, res) => {
    const removed = await alerts.remove(req.valid.params.id);
    await audit(req, 'delete', 'alert', removed.id, removed, null);
    res.json({ success: true });
  });

  router.get('/api/alert-events', validate({ query: schemas.alertEventsQuery }), async (req, res) => {
    res.json({ success: true, ...(await alerts.events(req.valid.query)) });
  });

  router.post('/api/alert-events/seen', requireControl, validate({ body: schemas.alertsSeen }), async (req, res) => {
    await alerts.markSeen(req.valid.body);
    res.json({ success: true });
  });

  return router;
};
