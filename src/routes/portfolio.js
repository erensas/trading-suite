// Portfolio and wallets. Reads are open to the tailnet like every other view; changes need
// the control header (src/http/middleware.js requireControl) and are audited. Wallet secrets
// are write-only: no route returns a private key, and a generated wallet's recovery phrase
// only in its create response.
const express = require('express');
const { validate } = require('../http/middleware');
const schemas = require('../schemas');
const { NETWORKS } = require('../../lib/evm');

module.exports = function portfolioRoutes({ portfolio, wallets, identity, audit, requireControl }) {
  const router = express.Router();
  const byId = validate({ params: schemas.idParam });
  const actor = (req) => identity.actorLabel(req);

  router.get('/api/portfolio', validate({ query: schemas.portfolioQuery }), async (req, res) => {
    const [summary, walletList] = await Promise.all([portfolio.summary({ days: req.valid.query.days }), wallets.list()]);
    res.json({ success: true, ...summary, wallets: walletList, networks: Object.entries(NETWORKS).map(([id, n]) => ({ id, name: n.name, native: n.native })) });
  });

  router.post('/api/portfolio/refresh', requireControl, validate({ body: schemas.patch }), async (req, res) => {
    const accountId = req.valid.body.account_id ? Number(req.valid.body.account_id) : undefined;
    res.json({ success: true, results: await portfolio.refresh({ accountId }) });
  });

  router.post('/api/portfolio/accounts', requireControl, validate({ body: schemas.patch }), async (req, res) => {
    const a = await portfolio.createAccount(req.valid.body, actor(req));
    await audit(req, 'create', 'portfolio account', a.id, null, { name: a.name, kind: a.kind, ref: a.ref, mode: a.mode });
    // First valuation right away, so the new account shows a value.
    await portfolio.refresh({ accountId: a.id }).catch(() => {});
    res.json({ success: true, account: await portfolio.getAccount(a.id) });
  });

  router.put('/api/portfolio/accounts/:id', requireControl, byId, validate({ body: schemas.patch }), async (req, res) => {
    const { before, after } = await portfolio.updateAccount(req.valid.params.id, req.valid.body);
    await audit(req, 'update', 'portfolio account', after.id, { name: before.name, mode: before.mode, enabled: before.enabled }, { name: after.name, mode: after.mode, enabled: after.enabled });
    res.json({ success: true, account: after });
  });

  router.delete('/api/portfolio/accounts/:id', requireControl, byId, async (req, res) => {
    const a = await portfolio.removeAccount(req.valid.params.id);
    await audit(req, 'delete', 'portfolio account', a.id, { name: a.name, kind: a.kind, ref: a.ref }, null);
    res.json({ success: true });
  });

  router.get('/api/portfolio/accounts/:id/holdings', byId, async (req, res) => {
    res.json({ success: true, holdings: await portfolio.holdings(req.valid.params.id) });
  });

  router.put('/api/portfolio/accounts/:id/holdings', requireControl, byId, validate({ body: schemas.patch }), async (req, res) => {
    const h = await portfolio.upsertHolding(req.valid.params.id, req.valid.body);
    await audit(req, 'update', 'portfolio holding', h.id, null, { account_id: h.account_id, symbol: h.symbol, quantity: h.quantity, cost_basis: h.cost_basis });
    await portfolio.refresh({ accountId: req.valid.params.id }).catch(() => {});
    res.json({ success: true, holding: h });
  });

  router.delete('/api/portfolio/holdings/:id', requireControl, byId, async (req, res) => {
    const h = await portfolio.removeHolding(req.valid.params.id);
    await audit(req, 'delete', 'portfolio holding', h.id, { account_id: h.account_id, symbol: h.symbol, quantity: h.quantity }, null);
    await portfolio.refresh({ accountId: h.account_id }).catch(() => {});
    res.json({ success: true });
  });

  // ---- wallets ----------------------------------------------------------------------------
  router.get('/api/wallets', async (req, res) => {
    res.json({ success: true, wallets: await wallets.list() });
  });

  router.post('/api/wallets', requireControl, validate({ body: schemas.patch }), async (req, res) => {
    const body = req.valid.body;
    const { wallet, secret } = await wallets.create(body, actor(req));
    await audit(req, 'create', 'wallet', wallet.id, null, { name: wallet.name, address: wallet.address, origin: wallet.origin, networks: wallet.networks });
    // Tracked in the portfolio unless the caller says no.
    let account = null;
    if (body.track !== false && body.track !== 'false') {
      account = await portfolio.createAccount({ name: `Wallet: ${wallet.name}`.slice(0, 60), kind: 'wallet', ref: wallet.id }, actor(req)).catch(() => null);
      if (account) await portfolio.refresh({ accountId: account.id }).catch(() => {});
    }
    // The only response that carries a secret (a generated wallet's new recovery phrase).
    if (secret) res.set('Cache-Control', 'no-store');
    res.json({ success: true, wallet, account_id: account ? account.id : null, ...(secret ? { recovery_phrase: secret.mnemonic, derivation_path: secret.derivation_path } : {}) });
  });

  router.put('/api/wallets/:id', requireControl, byId, validate({ body: schemas.patch }), async (req, res) => {
    const { before, after } = await wallets.update(req.valid.params.id, req.valid.body);
    await audit(req, 'update', 'wallet', after.id, { name: before.name, networks: before.networks }, { name: after.name, networks: after.networks });
    res.json({ success: true, wallet: after });
  });

  router.delete('/api/wallets/:id', requireControl, byId, async (req, res) => {
    const { wallet, trashed } = await wallets.remove(req.valid.params.id);
    await audit(req, 'delete', 'wallet', wallet.id, { name: wallet.name, address: wallet.address, origin: wallet.origin }, trashed ? { secrets_moved_to: 'credentials/wallets/trash' } : null);
    res.json({ success: true, secrets_trashed: !!trashed });
  });

  return router;
};
