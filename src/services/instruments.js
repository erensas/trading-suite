// Instruments (trade_db.instrument_registry) and their provider routing.
const { ProviderError } = require('../../lib/providers');
const { instrument: instrumentSchema } = require('../schemas');
const { badRequest, onDuplicate } = require('../http/errors');

const EDITABLE = ['name', 'category', 'base_asset', 'quote_asset', 'exchange', 'contract_address', 'network', 'provider_id', 'provider_symbol', 'is_active'];

// Provider columns joined as p_* onto an instrument row -> provider object.
const providerFromRow = (row) =>
  row.p_id
    ? { id: row.p_id, name: row.p_name, kind: row.p_kind, base_url: row.p_base_url, enabled: row.p_enabled, config: row.p_config || {}, credential_env: row.p_credential_env }
    : null;

function createInstruments({ db }) {
  function parse(input) {
    const result = instrumentSchema.safeParse(input);
    if (!result.success) {
      const i = result.error.issues[0];
      throw badRequest(i.message.startsWith(String(i.path[0])) ? i.message : `${i.path.join('.')}: ${i.message}`);
    }
    return result.data;
  }

  async function list({ activeOnly = false } = {}) {
    const r = await db.query(`
      SELECT ir.symbol, ir.name, ir.category, ir.base_asset, ir.quote_asset, ir.contract_address, ir.exchange,
             ir.is_active, ir.last_price, ir.change_24h_pct, ir.volume_24h_usd, ir.updated_at,
             ir.provider_id, ir.provider_symbol, ir.network,
             mp.name AS provider_name, mp.kind AS provider_kind, mp.enabled AS provider_enabled,
             es.profit_score, es.score_grade
      FROM instrument_registry ir
      LEFT JOIN market_providers mp ON mp.id = ir.provider_id
      LEFT JOIN economist_signals es ON es.symbol = ir.symbol
      ${activeOnly ? 'WHERE ir.is_active IS NOT FALSE' : ''}
      ORDER BY ir.category ASC, ir.volume_24h_usd DESC NULLS LAST, ir.symbol ASC`);
    return r.rows;
  }

  async function get(symbol) {
    const r = await db.query(
      `SELECT ir.*, mp.id AS p_id, mp.name AS p_name, mp.kind AS p_kind, mp.base_url AS p_base_url, mp.enabled AS p_enabled,
              mp.config AS p_config, mp.credential_env AS p_credential_env
       FROM instrument_registry ir LEFT JOIN market_providers mp ON mp.id = ir.provider_id
       WHERE ir.symbol = $1`,
      [symbol]
    );
    const row = r.rows[0];
    if (!row) return null;
    return { inst: row, provider: providerFromRow(row) };
  }

  // An instrument with an enabled provider, or a 404 / 409 explaining why not.
  async function resolve(symbol) {
    const found = await get(symbol);
    if (!found) throw new ProviderError(`Unknown instrument ${symbol}`, { status: 404, code: 'not_found' });
    if (!found.provider) throw new ProviderError(`${symbol} has no data provider; pick one in Settings → Instruments`, { status: 409, code: 'no_provider' });
    if (!found.provider.enabled) throw new ProviderError(`Provider ${found.provider.name} is disabled`, { status: 409, code: 'provider_disabled' });
    return found;
  }

  async function create(body) {
    const i = parse(body);
    await db
      .query(
        `INSERT INTO instrument_registry (symbol, name, category, base_asset, quote_asset, exchange, contract_address, network, provider_id, provider_symbol, is_active, route_type, updated_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, NOW())`,
        [i.symbol, i.name, i.category, i.base_asset, i.quote_asset, i.exchange, i.contract_address, i.network, i.provider_id, i.provider_symbol, i.is_active, i.category === 'DEX' ? 'DEX' : 'CEX']
      )
      .catch(onDuplicate('This symbol is already registered'))
      .catch((e) => {
        if (e.code === '23503') throw badRequest('provider_id does not match a provider');
        throw e;
      });
    return i;
  }

  // Returns { before, after } or null when the symbol is unknown.
  async function update(symbol, body) {
    const found = await get(symbol);
    if (!found) return null;
    const merged = { symbol: found.inst.symbol };
    for (const k of EDITABLE) merged[k] = body[k] !== undefined ? body[k] : (found.inst[k] ?? undefined);
    const i = parse(merged);
    await db
      .query(
        `UPDATE instrument_registry SET name = $2, category = $3, base_asset = $4, quote_asset = $5, exchange = $6, contract_address = $7,
                network = $8, provider_id = $9, provider_symbol = $10, is_active = $11, updated_at = NOW()
         WHERE symbol = $1`,
        [i.symbol, i.name, i.category, i.base_asset, i.quote_asset, i.exchange, i.contract_address, i.network, i.provider_id, i.provider_symbol, i.is_active]
      )
      .catch((e) => {
        if (e.code === '23503') throw badRequest('provider_id does not match a provider');
        throw e;
      });
    const before = Object.fromEntries(Object.entries(found.inst).filter(([k]) => !k.startsWith('p_')));
    return { before, after: i };
  }

  // GeckoTerminal: remember the pool found by search, unless the user set a provider symbol.
  function pinPool(symbol, providerSymbol) {
    return db.query("UPDATE instrument_registry SET provider_symbol = $2 WHERE symbol = $1 AND COALESCE(provider_symbol, '') = ''", [symbol, providerSymbol]);
  }

  return { list, get, resolve, create, update, pinPool };
}

module.exports = { createInstruments, providerFromRow };
