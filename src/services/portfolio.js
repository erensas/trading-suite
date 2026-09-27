// Portfolio (migration 011): accounts the suite tracks and what they are worth in USD.
//
//   manual     positions entered by hand: registered instruments (stocks, ETFs, coins) and
//              cash; real money or a paper portfolio (mode)
//   alpaca     an Alpaca paper venue (Settings -> Trading venues): equity and positions
//   freqtrade  a Freqtrade bot (main or managed): its wallet; paper while it runs dry
//   wallet     an EVM wallet (created, imported or watched): native and token balances on its
//              networks, read over public JSON-RPC
//
// A refresh values every enabled account, stores the result on the account row (last_*) and
// a snapshot of the totals; the page reads those, so it never waits on an exchange or a chain.
// Prices come from the instrument registry (the ticker refresh keeps last_price current).
const evm = require('../../lib/evm');
const { badRequest, notFound, onDuplicate } = require('../http/errors');

const KINDS = ['manual', 'alpaca', 'freqtrade', 'wallet'];
const MODES = ['real', 'paper'];
// Treated as 1 USD.
const USD_LIKE = new Set(['USD', 'USDT', 'USDC', 'USDC.E', 'USD1', 'FDUSD', 'DAI', 'BUSD', 'TUSD', 'USDE', 'RLUSD', 'USD₮', 'USD₮0', 'USDT0', 'PYUSD', 'USDS']);
// Wrapped and staked forms priced as their underlying when they have no price of their own.
const ALIASES = { WETH: 'ETH', WBTC: 'BTC', CBBTC: 'BTC', STETH: 'ETH', WSTETH: 'ETH', CBETH: 'ETH', WBNB: 'BNB', WPOL: 'POL', WMATIC: 'POL' };
const NAME = /^[\p{L}\p{N} ._()#/&:-]{1,60}$/u;
const round = (v, d = 2) => (v === null || v === undefined || !Number.isFinite(v) ? null : Math.round(v * 10 ** d) / 10 ** d);

// Prices in USD from registry rows: by instrument symbol, by asset (base against a USD-like
// quote, spot rows first), and by token contract per network (DEX rows).
function priceBook(rows) {
  const bySymbol = new Map();
  const byAsset = new Map();
  const byContract = new Map();
  const rank = (r) => ({ CEX: 0, TRADFI: 1, CEX_FUTURES: 2, DEX: 3 }[r.category] ?? 4);
  const sorted = [...rows].filter((r) => Number(r.last_price) > 0).sort((a, b) => rank(a) - rank(b));
  for (const r of sorted) {
    const price = Number(r.last_price);
    const quote = String(r.quote_asset || '').toUpperCase();
    bySymbol.set(String(r.symbol).toUpperCase(), { price, quote });
    const base = String(r.base_asset || String(r.symbol).split('/')[0]).toUpperCase();
    if (USD_LIKE.has(quote) && !byAsset.has(base)) byAsset.set(base, price);
    if (r.contract_address && r.network && USD_LIKE.has(quote)) byContract.set(`${r.network}:${String(r.contract_address).toLowerCase()}`, price);
  }
  function assetUsd(asset) {
    const a = String(asset || '').toUpperCase();
    if (USD_LIKE.has(a)) return 1;
    if (byAsset.has(a)) return byAsset.get(a);
    if (ALIASES[a] && byAsset.has(ALIASES[a])) return byAsset.get(ALIASES[a]);
    return null;
  }
  // An instrument's price in USD: its last price times the USD value of its quote.
  function instrumentUsd(symbol) {
    const hit = bySymbol.get(String(symbol).toUpperCase());
    if (!hit) return null;
    const q = assetUsd(hit.quote || 'USD');
    return q === null ? null : hit.price * q;
  }
  const contractUsd = (network, contract) => byContract.get(`${network}:${String(contract).toLowerCase()}`) ?? null;
  return { assetUsd, instrumentUsd, contractUsd };
}

// Positions of a manual account from its holdings.
function valueManual(holdings, book) {
  return holdings.map((h) => {
    const qty = Number(h.quantity);
    const price = h.kind === 'cash' ? book.assetUsd(h.symbol) : book.instrumentUsd(h.symbol) ?? book.assetUsd(h.symbol);
    const value = price === null ? null : qty * price;
    const cost = h.cost_basis === null || h.cost_basis === undefined ? null : Number(h.cost_basis);
    return {
      asset: h.symbol, kind: h.kind, quantity: qty, price_usd: price, value_usd: round(value),
      cost_basis: cost, pnl_usd: value !== null && cost !== null ? round(value - cost) : null,
    };
  });
}

const total = (positions) => round(positions.reduce((s, p) => s + (Number.isFinite(p.value_usd) ? p.value_usd : 0), 0));

function createPortfolio({ db, venues, bots, wallets, log, env = process.env, fetchImpl = (...a) => fetch(...a) }) {
  async function book() {
    const r = await db.query('SELECT symbol, category, base_asset, quote_asset, last_price, contract_address, network FROM instrument_registry');
    return priceBook(r.rows);
  }

  // ---- accounts ---------------------------------------------------------------------------
  async function getAccount(id) {
    const r = await db.query('SELECT * FROM portfolio_accounts WHERE id = $1', [id]);
    if (!r.rows[0]) throw notFound('Account not found');
    return r.rows[0];
  }

  async function validateAccount(body, before) {
    const a = { ...(before || {}), ...body };
    const name = String(a.name || '').trim();
    if (!NAME.test(name)) throw badRequest('name: 1 to 60 letters, digits, spaces or . _ - ( ) # / & :');
    if (!KINDS.includes(a.kind)) throw badRequest(`kind: one of ${KINDS.join(', ')}`);
    let ref = a.ref === undefined || a.ref === null || a.ref === '' ? null : String(a.ref);
    let mode = a.mode || 'real';
    if (!MODES.includes(mode)) throw badRequest('mode: real or paper');
    if (a.kind === 'manual') ref = null;
    if (a.kind === 'alpaca') {
      const v = await venues.get(Number(ref)).catch(() => null);
      if (!v || v.kind !== 'broker' || v.exchange !== 'alpaca') throw badRequest('ref: the id of an Alpaca venue (Settings -> Trading venues)');
      mode = 'paper';
    }
    if (a.kind === 'wallet') {
      await wallets.get(Number(ref)).catch(() => {
        throw badRequest('ref: the id of a wallet');
      });
      mode = 'real';
    }
    if (a.kind === 'freqtrade' && !/^[a-z0-9][a-z0-9-]{0,30}$/.test(ref || '')) throw badRequest('ref: the name of a Freqtrade bot');
    const notes = a.notes === undefined || a.notes === null ? null : String(a.notes).trim().slice(0, 300) || null;
    return { name, kind: a.kind, ref, mode, enabled: a.enabled !== false && a.enabled !== 'false', notes };
  }

  async function createAccount(body, actor) {
    const a = await validateAccount(body);
    const r = await db
      .query('INSERT INTO portfolio_accounts (name, kind, ref, mode, enabled, notes, created_by) VALUES ($1, $2, $3, $4, $5, $6, $7) RETURNING *', [a.name, a.kind, a.ref, a.mode, a.enabled, a.notes, actor])
      .catch(onDuplicate('An account with this name, or for this source, exists'));
    return r.rows[0];
  }

  async function updateAccount(id, body) {
    const before = await getAccount(id);
    // Kind and source stay; name, mode (manual and bots), enabled and notes change. Fields the
    // caller left out keep their stored value.
    const changes = Object.fromEntries(['name', 'mode', 'enabled', 'notes'].filter((k) => body[k] !== undefined).map((k) => [k, body[k]]));
    const a = await validateAccount({ ...changes, kind: before.kind, ref: before.ref }, before);
    const r = await db
      .query('UPDATE portfolio_accounts SET name = $2, mode = $3, enabled = $4, notes = $5, updated_at = NOW() WHERE id = $1 RETURNING *', [id, a.name, a.mode, a.enabled, a.notes])
      .catch(onDuplicate(`An account named ${a.name} exists`));
    return { before, after: r.rows[0] };
  }

  async function removeAccount(id) {
    const a = await getAccount(id);
    await db.query('DELETE FROM portfolio_accounts WHERE id = $1', [id]);
    return a;
  }

  // ---- manual holdings --------------------------------------------------------------------
  async function holdings(accountId) {
    await getAccount(accountId);
    return (await db.query('SELECT * FROM portfolio_holdings WHERE account_id = $1 ORDER BY kind, symbol', [accountId])).rows;
  }

  async function upsertHolding(accountId, body) {
    const acct = await getAccount(accountId);
    if (acct.kind !== 'manual') throw badRequest(`${acct.name} takes its positions from its source; only manual accounts have holdings`);
    const kind = body.kind === 'cash' ? 'cash' : 'asset';
    const symbol = String(body.symbol || '').trim().toUpperCase();
    if (!/^[A-Z0-9._₮^:/-]{1,40}$/u.test(symbol)) throw badRequest('symbol: an instrument such as AAPL or BTC/USDT, or a currency such as USD');
    if (kind === 'asset') {
      const r = await db.query('SELECT symbol FROM instrument_registry WHERE upper(symbol) = $1', [symbol]);
      if (!r.rows[0]) throw badRequest(`${symbol} is not a registered instrument; add it with Ctrl+K search first, or enter it as cash`);
    }
    const quantity = Number(body.quantity);
    if (!Number.isFinite(quantity) || quantity < 0 || quantity > 1e15) throw badRequest('quantity: a number, 0 or more');
    const cost = body.cost_basis === undefined || body.cost_basis === null || body.cost_basis === '' ? null : Number(body.cost_basis);
    if (cost !== null && (!Number.isFinite(cost) || cost < 0 || cost > 1e15)) throw badRequest('cost_basis: the total paid in USD, 0 or more');
    const note = body.note ? String(body.note).trim().slice(0, 200) : null;
    const r = await db.query(
      `INSERT INTO portfolio_holdings (account_id, kind, symbol, quantity, cost_basis, note) VALUES ($1, $2, $3, $4, $5, $6)
       ON CONFLICT (account_id, symbol) DO UPDATE SET kind = EXCLUDED.kind, quantity = EXCLUDED.quantity, cost_basis = EXCLUDED.cost_basis, note = EXCLUDED.note, updated_at = NOW()
       RETURNING *`,
      [accountId, kind, symbol, quantity, cost, note]
    );
    return r.rows[0];
  }

  async function removeHolding(id) {
    const r = await db.query('DELETE FROM portfolio_holdings WHERE id = $1 RETURNING *', [id]);
    if (!r.rows[0]) throw notFound('Holding not found');
    return r.rows[0];
  }

  // ---- valuation --------------------------------------------------------------------------
  async function tokensFor(network) {
    const core = (evm.CORE_TOKENS[network] || []).map(([symbol, address]) => ({ symbol, address }));
    const r = await db.query(
      "SELECT DISTINCT ON (lower(contract_address)) base_asset, contract_address FROM instrument_registry WHERE category = 'DEX' AND network = $1 AND contract_address ~* '^0x[0-9a-f]{40}$'",
      [network]
    );
    const seen = new Set(core.map((t) => t.address.toLowerCase()));
    for (const row of r.rows) {
      if (seen.has(row.contract_address.toLowerCase())) continue;
      seen.add(row.contract_address.toLowerCase());
      core.push({ symbol: String(row.base_asset || '?').toUpperCase(), address: row.contract_address });
    }
    return core;
  }

  async function valueWallet(acct, pb) {
    const w = await wallets.get(Number(acct.ref));
    const positions = [];
    const errors = [];
    await Promise.all(
      w.networks.map(async (network) => {
        try {
          const res = await evm.balances(network, w.address, await tokensFor(network), { env, fetchImpl });
          for (const b of res.balances) {
            const price = b.native ? pb.assetUsd(b.asset) : pb.contractUsd(network, b.contract) ?? pb.assetUsd(b.asset);
            positions.push({ asset: b.asset, network, contract: b.contract || null, quantity: b.quantity, price_usd: price, value_usd: price === null ? null : round(b.quantity * price) });
          }
          if (res.errors.length) errors.push(`${network}: no answer for ${res.errors.join(', ')}`);
        } catch (e) {
          errors.push(`${network}: ${e.message}`);
        }
      })
    );
    if (errors.length === w.networks.length && !positions.length) throw new Error(errors.join('; '));
    positions.sort((a, b) => (b.value_usd || 0) - (a.value_usd || 0));
    return { positions, error: errors.length ? errors.join('; ') : null };
  }

  async function valueAlpaca(acct) {
    const p = await venues.alpacaPortfolio(Number(acct.ref));
    const positions = p.positions.map((x) => ({ asset: x.symbol, kind: x.asset_class, quantity: x.quantity, price_usd: x.price, value_usd: round(x.value), cost_basis: x.cost_basis, pnl_usd: round(x.pnl) }));
    if (p.cash) positions.push({ asset: p.currency, kind: 'cash', quantity: p.cash, price_usd: 1, value_usd: round(p.cash) });
    return { positions, value: round(p.equity) };
  }

  async function valueFreqtrade(acct, pb) {
    const b = await bots.balance(acct.ref);
    const stakeUsd = pb.assetUsd(b.stake_currency);
    const positions = b.currencies.map((c) => {
      const isStake = c.currency.toUpperCase() === String(b.stake_currency).toUpperCase();
      const valueStake = isStake ? c.quantity : c.est_stake;
      return { asset: c.currency, quantity: c.quantity, price_usd: stakeUsd === null || !c.quantity ? null : (valueStake * stakeUsd) / c.quantity, value_usd: stakeUsd === null ? null : round(valueStake * stakeUsd) };
    });
    return { positions, value: stakeUsd === null ? null : round(b.total * stakeUsd), mode: b.dry_run ? 'paper' : 'real' };
  }

  async function valueAccount(acct, pb) {
    if (acct.kind === 'manual') {
      const h = (await db.query('SELECT * FROM portfolio_holdings WHERE account_id = $1 ORDER BY kind, symbol', [acct.id])).rows;
      const positions = valueManual(h, pb);
      const unpriced = positions.filter((p) => p.value_usd === null).map((p) => p.asset);
      return { positions, error: unpriced.length ? `no USD price for ${unpriced.join(', ')}` : null };
    }
    if (acct.kind === 'alpaca') return valueAlpaca(acct);
    if (acct.kind === 'freqtrade') return valueFreqtrade(acct, pb);
    return valueWallet(acct, pb);
  }

  // Values every enabled account (or one), stores the results and, for a full refresh, a
  // snapshot of the totals. An account that fails keeps its last value and gets the error.
  async function refresh({ accountId } = {}) {
    const pb = await book();
    const accts = (await db.query('SELECT * FROM portfolio_accounts WHERE enabled ORDER BY id')).rows.filter((a) => !accountId || a.id === accountId);
    const results = [];
    for (const acct of accts) {
      try {
        const v = await valueAccount(acct, pb);
        const value = v.value !== undefined && v.value !== null ? v.value : total(v.positions);
        const mode = v.mode || acct.mode;
        await db.query(
          'UPDATE portfolio_accounts SET last_value_usd = $2, last_positions = $3, last_refresh_at = NOW(), last_error = $4, mode = $5 WHERE id = $1',
          [acct.id, value, JSON.stringify(v.positions), v.error || null, mode]
        );
        results.push({ id: acct.id, name: acct.name, ok: true, value_usd: value, error: v.error || null });
      } catch (e) {
        await db.query('UPDATE portfolio_accounts SET last_error = $2, last_refresh_at = NOW() WHERE id = $1', [acct.id, String(e.message).slice(0, 500)]);
        results.push({ id: acct.id, name: acct.name, ok: false, error: e.message });
        (log && log.warn ? log : console).warn({ account: acct.name, error: e.message }, 'portfolio account not valued');
      }
    }
    if (!accountId) await snapshot();
    return results;
  }

  async function snapshot() {
    const r = await db.query('SELECT id, name, mode, last_value_usd FROM portfolio_accounts WHERE enabled AND last_value_usd IS NOT NULL');
    if (!r.rows.length) return null;
    const sum = (rows) => round(rows.reduce((s, a) => s + Number(a.last_value_usd), 0));
    const byAccount = Object.fromEntries(r.rows.map((a) => [a.id, Number(a.last_value_usd)]));
    const row = await db.query('INSERT INTO portfolio_snapshots (total_usd, real_usd, paper_usd, by_account) VALUES ($1, $2, $3, $4) RETURNING *', [
      sum(r.rows), sum(r.rows.filter((a) => a.mode === 'real')), sum(r.rows.filter((a) => a.mode === 'paper')), JSON.stringify(byAccount),
    ]);
    // Kept for a year.
    await db.query("DELETE FROM portfolio_snapshots WHERE at < NOW() - INTERVAL '365 days'");
    return row.rows[0];
  }

  // Everything the Portfolio tab shows, from the stored results.
  async function summary({ days = 90 } = {}) {
    const [accts, hist] = await Promise.all([
      db.query('SELECT * FROM portfolio_accounts ORDER BY enabled DESC, last_value_usd DESC NULLS LAST, name'),
      db.query('SELECT at, total_usd, real_usd, paper_usd FROM portfolio_snapshots WHERE at > NOW() - make_interval(days => $1) ORDER BY at', [days]),
    ]);
    const on = accts.rows.filter((a) => a.enabled);
    const sum = (rows) => round(rows.reduce((s, a) => s + (a.last_value_usd === null ? 0 : Number(a.last_value_usd)), 0));
    // Positions across accounts, by asset.
    const byAsset = new Map();
    for (const a of on) {
      for (const p of a.last_positions || []) {
        const key = String(p.asset).toUpperCase();
        const e = byAsset.get(key) || { asset: key, quantity: 0, value_usd: 0, priced: true, accounts: [] };
        e.quantity += Number(p.quantity) || 0;
        if (Number.isFinite(p.value_usd)) e.value_usd += p.value_usd;
        else e.priced = false;
        e.accounts.push(a.name);
        byAsset.set(key, e);
      }
    }
    const totalUsd = sum(on);
    const assets = [...byAsset.values()]
      .map((e) => ({ ...e, value_usd: round(e.value_usd), share_pct: totalUsd ? round((e.value_usd / totalUsd) * 100, 1) : null, accounts: [...new Set(e.accounts)] }))
      .sort((a, b) => b.value_usd - a.value_usd);
    return {
      totals: { total_usd: totalUsd, real_usd: sum(on.filter((a) => a.mode === 'real')), paper_usd: sum(on.filter((a) => a.mode === 'paper')), accounts: on.length },
      accounts: accts.rows.map((a) => ({ ...a, last_value_usd: a.last_value_usd === null ? null : Number(a.last_value_usd), share_pct: totalUsd && a.enabled && a.last_value_usd !== null ? round((Number(a.last_value_usd) / totalUsd) * 100, 1) : null })),
      assets,
      history: hist.rows.map((h) => ({ at: h.at, total_usd: Number(h.total_usd), real_usd: Number(h.real_usd), paper_usd: Number(h.paper_usd) })),
      last_refresh_at: on.reduce((m, a) => (a.last_refresh_at && (!m || a.last_refresh_at > m) ? a.last_refresh_at : m), null),
    };
  }

  return { summary, refresh, snapshot, createAccount, updateAccount, removeAccount, getAccount, holdings, upsertHolding, removeHolding };
}

module.exports = { createPortfolio, priceBook, valueManual, USD_LIKE, KINDS };
