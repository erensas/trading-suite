// Web3 engine pair controls: arbitrage and flash loans on or off per scanned pair.
// GET is open to the tailnet; changes need the control header and are audited, so scripts
// and agents can switch pairs the same way the UI does:
//   curl -X PUT -H 'X-Trading-Control: 1' -H 'Content-Type: application/json' \
//        -d '{"flashloan_enabled": false}' http://127.0.0.1:18795/api/dex/pairs/12
const express = require('express');
const { validate } = require('../http/middleware');
const schemas = require('../schemas');

module.exports = function dexRoutes({ dexPairs, venues, identity, audit, requireControl }) {
  const router = express.Router();
  const byId = validate({ params: schemas.idParam });

  router.get('/api/dex/pairs', validate({ query: schemas.dexPairsQuery }), async (req, res) => {
    const [pairs, engine] = await Promise.all([dexPairs.list({ network: req.valid.query.network }), venues.dex().then((d) => d.engine).catch(() => null)]);
    res.json({ success: true, engine, pairs });
  });

  router.get('/api/dex/pairs/:id', byId, async (req, res) => {
    res.json({ success: true, pair: await dexPairs.get(req.valid.params.id) });
  });

  router.put('/api/dex/pairs/:id', requireControl, byId, validate({ body: schemas.dexPairFlags }), async (req, res) => {
    const { before, after } = await dexPairs.update(req.valid.params.id, req.valid.body, identity.actorLabel(req));
    const pick = (p) => ({ pair: `${p.network}:${p.token_a}/${p.token_b}`, arbitrage_enabled: p.arbitrage_enabled, flashloan_enabled: p.flashloan_enabled });
    await audit(req, 'update', 'dex pair', after.id, pick(before), pick(after));
    res.json({ success: true, pair: after });
  });

  router.put('/api/dex/pairs', requireControl, validate({ body: schemas.dexPairsBulk }), async (req, res) => {
    const r = await dexPairs.updateMany(req.valid.body, identity.actorLabel(req));
    await audit(req, 'update', 'dex pairs', null, null, { updated: r.updated, network: req.valid.body.network || null, ids: req.valid.body.ids || null, ...r.flags });
    res.json({ success: true, ...r });
  });

  return router;
};
