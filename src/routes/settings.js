// Suite settings.
const express = require('express');
const { validate } = require('../http/middleware');
const schemas = require('../schemas');

module.exports = function settingsRoutes({ settings, audit, identity, requireControl }) {
  const router = express.Router();

  router.get('/api/trading/settings', (req, res) => {
    res.json({ success: true, settings: settings.values, persisted: settings.persisted, rules: settings.rules });
  });

  router.post('/api/trading/settings', requireControl, validate({ body: schemas.settingsPatch }), async (req, res) => {
    const { before, after } = await settings.update(req.valid.body, identity.actorLabel(req));
    await audit(req, 'update', 'settings', 'suite', before, after);
    res.json({ success: true, settings: settings.values, message: 'Settings saved.' });
  });

  return router;
};
