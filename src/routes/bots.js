// Trading bots: overview, process and trading-loop actions, strategy switch, managed bots
// (create, edit, delete), and the steps to live trading.
const express = require('express');
const { validate } = require('../http/middleware');
const { badRequest } = require('../http/errors');
const schemas = require('../schemas');

module.exports = function botRoutes({ bots, identity, audit, requireControl }) {
  const router = express.Router();
  const byName = validate({ params: schemas.botParam });
  const actor = (req) => identity.actorLabel(req);

  router.get('/api/bots', async (req, res) => {
    res.json({ success: true, bots: await bots.list(), exchanges: bots.EXCHANGES });
  });

  router.get('/api/bots/:name', byName, async (req, res) => {
    res.json({ success: true, bot: await bots.get(req.valid.params.name) });
  });

  router.post('/api/bots', requireControl, validate({ body: schemas.patch }), async (req, res) => {
    const bot = await bots.create(req.valid.body, actor(req));
    await audit(req, 'create', 'bot', bot.name, null, { strategy: bot.strategy, exchange: bot.exchange, port: bot.api_port });
    res.json({ success: true, bot: { ...bot, credentials_file: undefined } });
  });

  router.patch('/api/bots/:name', requireControl, byName, validate({ body: schemas.patch }), async (req, res) => {
    res.json({ success: true, ...(await bots.edit(req.valid.params.name, req.valid.body, actor(req))) });
  });

  router.delete('/api/bots/:name', requireControl, byName, validate({ body: schemas.botDelete }), async (req, res) => {
    const { name } = req.valid.params;
    if (req.valid.body.confirm !== name) throw badRequest(`Type the bot name (${name}) to confirm`);
    const out = await bots.remove(name, actor(req));
    await audit(req, 'delete', 'bot', name, null, out);
    res.json({ success: true, ...out });
  });

  router.post('/api/bots/:name/action', requireControl, byName, validate({ body: schemas.botAction }), async (req, res) => {
    res.json({ success: true, ...(await bots.act(req.valid.params.name, req.valid.body.action, actor(req))) });
  });

  router.post('/api/bots/:name/strategy', requireControl, byName, validate({ body: schemas.botStrategy }), async (req, res) => {
    const { name } = req.valid.params;
    const out = await bots.setStrategy(name, req.valid.body.strategy, actor(req));
    await audit(req, 'update', 'bot strategy', name, { strategy: out.from }, { strategy: out.to });
    res.json({ success: true, ...out });
  });

  router.get('/api/bots/:name/journal', byName, validate({ query: schemas.journalQuery }), async (req, res) => {
    res.json({ success: true, lines: await bots.journal(req.valid.params.name, req.valid.query.lines) });
  });

  // ---- live trading ------------------------------------------------------------------------
  router.get('/api/bots/:name/live-checks', byName, async (req, res) => {
    res.json({ success: true, ...(await bots.liveChecks(req.valid.params.name)) });
  });

  router.post('/api/bots/:name/live', requireControl, byName, validate({ body: schemas.goLive }), async (req, res) => {
    const { name } = req.valid.params;
    const out = await bots.goLive(name, req.valid.body.confirm, actor(req));
    await audit(req, 'go live', 'bot', name, { dry_run: true }, { dry_run: false });
    res.json({ success: true, ...out });
  });

  router.post('/api/bots/:name/dry-run', requireControl, byName, async (req, res) => {
    const { name } = req.valid.params;
    const out = await bots.goDryRun(name, actor(req));
    await audit(req, 'go dry-run', 'bot', name, null, { dry_run: true });
    res.json({ success: true, ...out });
  });

  // Exchange keys are write-only: the answer says whether they are set, with the key's last
  // four characters, never the values.
  router.get('/api/bots/:name/exchange-keys', byName, async (req, res) => {
    res.json({ success: true, keys: await bots.exchangeKeys(req.valid.params.name) });
  });

  router.put('/api/bots/:name/exchange-keys', requireControl, byName, validate({ body: schemas.exchangeKeys }), async (req, res) => {
    const { name } = req.valid.params;
    const keys = await bots.setExchangeKeys(name, req.valid.body, actor(req));
    await audit(req, 'update', 'bot exchange keys', name, null, { hint: keys.hint });
    res.json({ success: true, keys });
  });

  router.delete('/api/bots/:name/exchange-keys', requireControl, byName, async (req, res) => {
    const { name } = req.valid.params;
    await bots.removeExchangeKeys(name, actor(req));
    await audit(req, 'delete', 'bot exchange keys', name, null, null);
    res.json({ success: true });
  });

  router.put('/api/bots/:name/capital-limit', requireControl, byName, validate({ body: schemas.capitalLimit }), async (req, res) => {
    const { name } = req.valid.params;
    await bots.setCapitalLimit(name, req.valid.body.amount, actor(req));
    await audit(req, 'update', 'bot capital limit', name, null, { amount: req.valid.body.amount });
    res.json({ success: true });
  });

  return router;
};
