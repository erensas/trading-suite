// Kill switch: status, halt, resume.
const express = require('express');
const { validate } = require('../http/middleware');
const { conflict } = require('../http/errors');
const schemas = require('../schemas');

module.exports = function controlRoutes({ control, identity, requireControl }) {
  const router = express.Router();

  router.get('/api/control/status', async (req, res) => {
    const [state, freqtrade, heartbeat] = await Promise.all([control.state(), control.freqtradeEngine(), control.heartbeatEngines()]);
    res.json({ success: true, control: state, engines: [freqtrade, ...heartbeat] });
  });

  router.post('/api/control/halt', requireControl, validate({ body: schemas.halt }), async (req, res) => {
    const state = await control.state();
    if (!state.installed) throw conflict('Control plane not installed: apply db/migrations/001_trading_control.sql');
    const results = await control.halt(req.valid.body.reason || 'Manual kill switch', identity.actorLabel(req));
    req.log.warn({ actor: req.actor, results }, 'trading halted');
    res.json({ success: true, results });
  });

  router.post('/api/control/resume', requireControl, validate({ body: schemas.resume }), async (req, res) => {
    const state = await control.state();
    if (!state.installed) throw conflict('Control plane not installed');
    const results = await control.resume(identity.actorLabel(req));
    req.log.warn({ actor: req.actor, results }, 'trading resumed');
    res.json({ success: true, results });
  });

  return router;
};
