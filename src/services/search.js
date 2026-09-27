// Symbol search across every enabled provider that can list its instruments, merged by
// instrument symbol and marked with what is already registered.
const { adapterFor } = require('../../lib/providers');

const RESULT_TTL_MS = 60 * 1000;
// Which provider kinds a search scope asks. GeckoTerminal is rate limited to a few calls a
// minute, so it is searched only for the "dex" scope or when the query is a token address.
const SCOPES = {
  default: ['binance', 'binance_futures', 'okx', 'bybit', 'yahoo'],
  cex: ['binance', 'binance_futures', 'okx', 'bybit'],
  dex: ['geckoterminal'],
  tradfi: ['yahoo'],
};
const looksLikeAddress = (q) => /^(0x[0-9a-fA-F]{6,}|[1-9A-HJ-NP-Za-km-z]{32,44})$/.test(q);
const PER_PROVIDER_TIMEOUT_MS = 12000;

const withTimeout = (promise, ms, label) =>
  Promise.race([promise, new Promise((_, reject) => setTimeout(() => reject(new Error(`${label}: no answer within ${ms / 1000} s`)), ms))]);

function createSearch({ db, providers, instruments }) {
  const cache = new Map();

  // Local matches first: registered instruments by symbol, name or base asset.
  async function local(q) {
    const like = `%${q.replace(/[%_]/g, '')}%`;
    const r = await db.query(
      `SELECT ir.symbol, ir.name, ir.category, ir.base_asset, ir.quote_asset, ir.last_price, ir.change_24h_pct, ir.is_active,
              (SELECT array_agg(l.provider_id ORDER BY l.priority) FROM instrument_listings l WHERE l.symbol = ir.symbol) AS provider_ids
       FROM instrument_registry ir
       WHERE ir.symbol ILIKE $1 OR ir.name ILIKE $1 OR ir.base_asset ILIKE $1 OR ir.contract_address ILIKE $1
       ORDER BY (upper(ir.base_asset) = upper($2)) DESC, (ir.symbol ILIKE $3) DESC, ir.volume_24h_usd DESC NULLS LAST
       LIMIT 20`,
      [like, q, `${q.replace(/[%_]/g, '')}%`]
    );
    return r.rows;
  }

  async function searchProvider(p, q) {
    const key = `${p.id}|${q.toLowerCase()}`;
    const hit = cache.get(key);
    if (hit && hit.expires > Date.now()) return hit.rows;
    const rows = await withTimeout(providers.call(p, 'search', q), PER_PROVIDER_TIMEOUT_MS, p.name);
    cache.set(key, { rows, expires: Date.now() + RESULT_TTL_MS });
    if (cache.size > 500) cache.delete(cache.keys().next().value);
    return rows;
  }

  // scope: default | cex | dex | tradfi | all. Returns { local, results, errors, searched }.
  async function search(q, { scope = 'default' } = {}) {
    const all = (await providers.list()).filter((p) => p.enabled && adapterFor(p).search);
    const kinds = scope === 'all' ? null : looksLikeAddress(q) ? SCOPES.dex : SCOPES[scope] || SCOPES.default;
    const targets = kinds ? all.filter((p) => kinds.includes(p.kind)) : all;
    const settled = await Promise.allSettled(targets.map((p) => searchProvider(p, q)));
    const localRows = await local(q);
    const bySymbol = new Map();
    const errors = [];
    settled.forEach((s, i) => {
      const p = targets[i];
      if (s.status === 'rejected') {
        errors.push({ provider_id: p.id, provider: p.name, error: s.reason.message });
        return;
      }
      for (const row of s.value) {
        const key = `${row.symbol.toUpperCase()}|${row.category}`;
        if (!bySymbol.has(key)) {
          bySymbol.set(key, {
            symbol: row.symbol, base: row.base, quote: row.quote, category: row.category, name: row.name || null,
            contract_address: row.contract_address || null, network: row.network || null, sources: [],
          });
        }
        const entry = bySymbol.get(key);
        entry.sources.push({
          provider_id: p.id, provider: p.name, kind: p.kind, provider_symbol: row.provider_symbol, network: row.network || null,
          name: row.name || null, liquidity_usd: row.liquidity_usd ?? null, volume_24h_usd: row.volume_24h_usd ?? null,
        });
        if (!entry.name && row.name) entry.name = row.name;
      }
    });
    const regRows = await db.query(
      `SELECT ir.symbol, (SELECT array_agg(l.provider_id) FROM instrument_listings l WHERE l.symbol = ir.symbol) AS provider_ids
       FROM instrument_registry ir WHERE upper(ir.symbol) = ANY($1)`,
      [[...bySymbol.values()].map((r) => r.symbol.toUpperCase())]
    );
    const registered = new Map(regRows.rows.map((r) => [r.symbol.toUpperCase(), r]));
    const results = [...bySymbol.values()].map((r) => {
      const reg = registered.get(r.symbol.toUpperCase());
      const listed = new Set(reg && reg.provider_ids ? reg.provider_ids : []);
      return { ...r, registered: !!reg, registered_symbol: reg ? reg.symbol : null, sources: r.sources.map((s) => ({ ...s, listed: listed.has(s.provider_id) })) };
    });
    // Registered first, then by how many providers carry the symbol.
    results.sort((a, b) => b.registered - a.registered || b.sources.length - a.sources.length);
    return { local: localRows, results: results.slice(0, 60), errors, searched: targets.map((p) => p.name) };
  }

  // Other providers that carry an instrument (same base and quote), for "add source".
  async function candidates(symbol) {
    const found = await instruments.get(symbol);
    if (!found) return null;
    const base = String(found.inst.base_asset || symbol.split('/')[0]).toUpperCase();
    const quote = String(found.inst.quote_asset || String(symbol.split('/')[1] || '').split(':')[0]).toUpperCase();
    const query = found.inst.category === 'DEX' && found.inst.contract_address ? found.inst.contract_address : base;
    const scope = found.inst.category === 'DEX' ? 'dex' : found.inst.category === 'TRADFI' ? 'tradfi' : 'cex';
    const { results, errors } = await search(query, { scope });
    // Same base and quote, and the same market type: spot sources for a spot instrument,
    // perpetuals for a futures one.
    const same = (r) => r.category === found.inst.category && r.base.toUpperCase() === base && (!quote || r.quote.toUpperCase() === quote || found.inst.category === 'TRADFI');
    const matches = results.filter(same).flatMap((r) => r.sources.filter((s) => !s.listed).map((s) => ({ ...s, category: r.category, symbol: r.symbol })));
    return { symbol: found.inst.symbol, matches, errors };
  }

  return { search, candidates };
}

module.exports = { createSearch };
