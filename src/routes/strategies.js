// Strategy center: the strategy library, checks and backtests.
const express = require('express');
const { validate } = require('../http/middleware');
const { notFound } = require('../http/errors');
const schemas = require('../schemas');

module.exports = function strategyRoutes({ strategies, backtests, identity, audit, requireControl }) {
  const router = express.Router();
  const byName = validate({ params: schemas.strategyParam });
  const byId = validate({ params: schemas.idParam });

  router.get('/api/strategies', async (req, res) => {
    res.json({ success: true, ...(await strategies.list()) });
  });

  // A template's source, as a starting point in the editor.
  router.get('/api/strategy-templates/:name', byName, (req, res) => {
    const source = strategies.templateSource(req.valid.params.name);
    if (!source) throw notFound('No such template');
    res.json({ success: true, name: req.valid.params.name, source });
  });

  router.get('/api/strategies/:name', byName, async (req, res) => {
    res.json({ success: true, strategy: await strategies.get(req.valid.params.name) });
  });

  router.put('/api/strategies/:name', requireControl, byName, validate({ body: schemas.strategySource }), async (req, res) => {
    const { name } = req.valid.params;
    const out = await strategies.save(name, req.valid.body.source, { actor: identity.actorLabel(req), description: req.valid.body.description, origin: req.valid.body.origin });
    if (out.changed) await audit(req, out.created ? 'create' : 'update', 'strategy', name, null, { sha: out.sha });
    res.json({ success: true, ...out });
  });

  router.post('/api/strategies/import', requireControl, validate({ body: schemas.strategyImport }), async (req, res) => {
    const { kind, name } = req.valid.body;
    const out = await strategies.importFrom(kind, name, identity.actorLabel(req));
    await audit(req, 'import', 'strategy', name, null, { from: kind, sha: out.sha });
    res.json({ success: true, ...out });
  });

  router.post('/api/strategies/:name/check', requireControl, byName, async (req, res) => {
    res.json({ success: true, result: await strategies.check(req.valid.params.name) });
  });

  router.delete('/api/strategies/:name', requireControl, byName, async (req, res) => {
    const removed = await strategies.remove(req.valid.params.name);
    await audit(req, 'delete', 'strategy', removed.name, { sha: removed.sha, origin: removed.origin }, null);
    res.json({ success: true });
  });

  router.get('/api/strategies/:name/versions', byName, async (req, res) => {
    res.json({ success: true, versions: await strategies.versions(req.valid.params.name) });
  });

  router.get('/api/strategies/:name/versions/:id', validate({ params: schemas.versionParams }), async (req, res) => {
    res.json({ success: true, version: await strategies.version(req.valid.params.name, req.valid.params.id) });
  });

  router.get('/api/backtests', validate({ query: schemas.backtestsQuery }), async (req, res) => {
    res.json({ success: true, backtests: await backtests.list(req.valid.query), running: backtests.running(), exchanges: backtests.EXCHANGES });
  });

  router.post('/api/backtests', requireControl, validate({ body: schemas.patch }), async (req, res) => {
    res.json({ success: true, backtest: await backtests.create(req.valid.body, identity.actorLabel(req)) });
  });

  router.get('/api/backtests/:id', byId, async (req, res) => {
    res.json({ success: true, backtest: await backtests.get(req.valid.params.id) });
  });

  router.post('/api/backtests/:id/cancel', requireControl, byId, async (req, res) => {
    await backtests.cancel(req.valid.params.id);
    res.json({ success: true });
  });

  return router;
};
