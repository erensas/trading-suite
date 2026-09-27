// Instruments (trade_db.instrument_registry) and where their data comes from
// (instrument_listings: one row per provider, tried in priority order; db/migrations/005).
// The primary listing is mirrored into instrument_registry.provider_id / provider_symbol,
// because other scripts (dynamic_market_populator.py, tradingview_bridge.py) read those.
const { ProviderError } = require('../../lib/providers');
const { instrument: instrumentSchema, listing: listingSchema, INSTRUMENT_CATEGORIES } = require('../schemas');
const { badRequest, notFound, onDuplicate } = require('../http/errors');
const { withTransaction } = require('../db');

const EDITABLE = ['name', 'category', 'base_asset', 'quote_asset', 'exchange', 'contract_address', 'network', 'provider_id', 'provider_symbol', 'is_active'];
const FOREIGN_KEY_VIOLATION = '23503';

// Provider columns joined as p_* onto a row -> provider object.
const providerFromRow = (row) =>
  row.p_id
    ? { id: row.p_id, name: row.p_name, kind: row.p_kind, base_url: row.p_base_url, enabled: row.p_enabled, config: row.p_config || {}, credential_env: row.p_credential_env }
    : null;

const PROVIDER_COLS = `mp.id AS p_id, mp.name AS p_name, mp.kind AS p_kind, mp.base_url AS p_base_url, mp.enabled AS p_enabled,
                       mp.config AS p_config, mp.credential_env AS p_credential_env`;

function firstIssue(result) {
  const i = result.error.issues[0];
  return badRequest(i.message.startsWith(String(i.path[0])) ? i.message : `${i.path.join('.')}: ${i.message}`);
}

function createInstruments({ db }) {
  function parse(input) {
    const result = instrumentSchema.safeParse(input);
    if (!result.success) throw firstIssue(result);
    return result.data;
  }

  const fkError = (message) => (e) => {
    if (e.code === FOREIGN_KEY_VIOLATION) throw badRequest(message);
    throw e;
  };

  async function list({ activeOnly = false } = {}) {
    const r = await db.query(`
      SELECT ir.symbol, ir.name, ir.category, ir.base_asset, ir.quote_asset, ir.contract_address, ir.exchange,
             ir.is_active, ir.last_price, ir.change_24h_pct, ir.volume_24h_usd, ir.updated_at,
             ir.provider_id, ir.provider_symbol, ir.network,
             mp.name AS provider_name, mp.kind AS provider_kind, mp.enabled AS provider_enabled,
             (SELECT count(*) FROM instrument_listings l WHERE l.symbol = ir.symbol)::int AS listing_count,
             es.profit_score, es.score_grade
      FROM instrument_registry ir
      LEFT JOIN market_providers mp ON mp.id = ir.provider_id
      LEFT JOIN economist_signals es ON es.symbol = ir.symbol
      ${activeOnly ? 'WHERE ir.is_active IS NOT FALSE' : ''}
      ORDER BY ir.category ASC, ir.volume_24h_usd DESC NULLS LAST, ir.symbol ASC`);
    return r.rows;
  }

  async function get(symbol) {
    const r = await db.query(`SELECT ir.*, ${PROVIDER_COLS} FROM instrument_registry ir LEFT JOIN market_providers mp ON mp.id = ir.provider_id WHERE ir.symbol = $1`, [symbol]);
    const row = r.rows[0];
    if (!row) return null;
    return { inst: row, provider: providerFromRow(row) };
  }

  // ---- listings ----------------------------------------------------------------------------
  async function listings(symbol) {
    const r = await db.query(
      `SELECT l.id, l.symbol, l.provider_id, l.provider_symbol, l.network, l.priority, l.enabled, l.created_at, ${PROVIDER_COLS}
       FROM instrument_listings l JOIN market_providers mp ON mp.id = l.provider_id
       WHERE l.symbol = $1 ORDER BY l.priority, l.id`,
      [symbol]
    );
    return r.rows.map((row) => ({
      id: row.id, symbol: row.symbol, provider_id: row.provider_id, provider_symbol: row.provider_symbol, network: row.network,
      priority: row.priority, enabled: row.enabled, created_at: row.created_at, provider: providerFromRow(row),
    }));
  }

  // The instrument as an adapter sees it through one listing.
  const instFor = (inst, l) => ({ ...inst, provider_symbol: l.provider_symbol || null, network: l.network || inst.network || null, listing_id: l.id });

  // Usable listings in order (enabled listing, enabled provider), or a 404 / 409 explaining
  // why there is none. `listingId` narrows it to one listing.
  async function sources(symbol, { listingId } = {}) {
    const found = await get(symbol);
    if (!found) throw new ProviderError(`Unknown instrument ${symbol}`, { status: 404, code: 'not_found' });
    let rows = await listings(found.inst.symbol);
    // Instruments added by other scripts have a provider but no listing yet.
    if (!rows.length && found.provider) {
      rows = [{ id: null, provider_id: found.provider.id, provider_symbol: found.inst.provider_symbol, network: found.inst.network, priority: 0, enabled: true, provider: found.provider }];
    }
    if (listingId) rows = rows.filter((l) => l.id === listingId);
    if (!rows.length) {
      throw new ProviderError(listingId ? `Listing ${listingId} does not belong to ${symbol}` : `${symbol} has no data provider; add one with Sources in the instrument menu`, { status: listingId ? 404 : 409, code: 'no_provider' });
    }
    const usable = rows.filter((l) => l.enabled && l.provider.enabled);
    if (!usable.length) {
      throw new ProviderError(`Every provider of ${symbol} is disabled (${rows.map((l) => l.provider.name).join(', ')})`, { status: 409, code: 'provider_disabled' });
    }
    return usable.map((l) => ({ listing: l, provider: l.provider, inst: instFor(found.inst, l) }));
  }

  // Mirrors the first enabled listing into instrument_registry.
  async function syncPrimary(symbol, client = db) {
    await client.query(
      `UPDATE instrument_registry ir SET provider_id = p.provider_id, provider_symbol = p.provider_symbol, updated_at = ir.updated_at
       FROM (SELECT provider_id, provider_symbol FROM instrument_listings WHERE symbol = $1::varchar AND enabled ORDER BY priority, id LIMIT 1) p
       WHERE ir.symbol = $1::varchar`,
      [symbol]
    );
  }

  function parseListing(input) {
    const result = listingSchema.safeParse(input);
    if (!result.success) throw firstIssue(result);
    return result.data;
  }

  async function addListing(symbol, body, client = db) {
    const l = parseListing(body);
    const r = await client
      .query(
        `INSERT INTO instrument_listings (symbol, provider_id, provider_symbol, network, priority, enabled)
         VALUES ($1::varchar, $2, $3, $4, COALESCE($5::int, (SELECT COALESCE(max(priority) + 1, 0) FROM instrument_listings WHERE symbol = $1::varchar)), $6)
         RETURNING *`,
        [symbol, l.provider_id, l.provider_symbol, l.network, l.priority ?? null, l.enabled]
      )
      .catch(onDuplicate('This provider and provider symbol are already a source of the instrument'))
      .catch(fkError('Unknown instrument or provider'));
    await syncPrimary(symbol, client);
    return r.rows[0];
  }

  async function getListing(id) {
    const r = await db.query('SELECT * FROM instrument_listings WHERE id = $1', [id]);
    if (!r.rows[0]) throw notFound('Listing not found');
    return r.rows[0];
  }

  async function updateListing(id, body) {
    const before = await getListing(id);
    const merged = {};
    for (const k of ['provider_id', 'provider_symbol', 'network', 'priority', 'enabled']) merged[k] = body[k] !== undefined ? body[k] : before[k] ?? undefined;
    const l = parseListing(merged);
    const r = await db
      .query(
        `UPDATE instrument_listings SET provider_id = $2, provider_symbol = $3, network = $4, priority = $5, enabled = $6, updated_at = NOW()
         WHERE id = $1 RETURNING *`,
        [id, l.provider_id, l.provider_symbol, l.network, l.priority ?? before.priority, l.enabled]
      )
      .catch(onDuplicate('This provider and provider symbol are already a source of the instrument'))
      .catch(fkError('Unknown provider'));
    await syncPrimary(before.symbol);
    return { before, after: r.rows[0] };
  }

  async function removeListing(id) {
    const before = await getListing(id);
    await db.query('DELETE FROM instrument_listings WHERE id = $1', [id]);
    const left = await db.query('SELECT count(*)::int AS n FROM instrument_listings WHERE symbol = $1', [before.symbol]);
    if (left.rows[0].n === 0) await db.query('UPDATE instrument_registry SET provider_id = NULL, provider_symbol = NULL WHERE symbol = $1', [before.symbol]);
    else await syncPrimary(before.symbol);
    return before;
  }

  // ids: the instrument's listings in the new order (priority 0, 1, 2, ...).
  async function reorderListings(symbol, ids) {
    return withTransaction(db, async (client) => {
      const r = await client.query('SELECT id FROM instrument_listings WHERE symbol = $1', [symbol]);
      const own = new Set(r.rows.map((x) => x.id));
      if (ids.length !== own.size || !ids.every((id) => own.has(id))) throw badRequest('ids must list every source of the instrument exactly once');
      for (const [i, id] of ids.entries()) await client.query('UPDATE instrument_listings SET priority = $2, updated_at = NOW() WHERE id = $1', [id, i]);
      await syncPrimary(symbol, client);
    });
  }

  // Registry rows written by other scripts (provider set, no listing) get their listing.
  async function backfillListings() {
    const r = await db.query(`
      INSERT INTO instrument_listings (symbol, provider_id, provider_symbol, network, priority)
      SELECT ir.symbol, ir.provider_id, NULLIF(ir.provider_symbol, ''), NULLIF(ir.network, ''), 0
      FROM instrument_registry ir
      WHERE ir.provider_id IS NOT NULL AND NOT EXISTS (SELECT 1 FROM instrument_listings l WHERE l.symbol = ir.symbol)
      ON CONFLICT DO NOTHING`);
    return r.rowCount || 0;
  }

  // ---- registry rows ---------------------------------------------------------------------
  async function create(body, client = db) {
    const i = parse(body);
    await client
      .query(
        `INSERT INTO instrument_registry (symbol, name, category, base_asset, quote_asset, exchange, contract_address, network, provider_id, provider_symbol, is_active, route_type, updated_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, NOW())`,
        [i.symbol, i.name, i.category, i.base_asset, i.quote_asset, i.exchange, i.contract_address, i.network, i.provider_id, i.provider_symbol, i.is_active, i.category === 'DEX' ? 'DEX' : 'CEX']
      )
      .catch(onDuplicate('This symbol is already registered'))
      .catch(fkError('provider_id does not match a provider'));
    // The old single-provider form: the given provider becomes the primary listing.
    if (i.provider_id) await makePrimary(i.symbol, i.provider_id, i.provider_symbol, i.network, client);
    return i;
  }

  // Adds (or finds) the listing for this provider/symbol and moves it to the top.
  async function makePrimary(symbol, providerId, providerSymbol, network, client = db) {
    await client.query('UPDATE instrument_listings SET priority = priority + 1 WHERE symbol = $1', [symbol]);
    await client.query(
      `INSERT INTO instrument_listings (symbol, provider_id, provider_symbol, network, priority) VALUES ($1, $2, $3, $4, 0)
       ON CONFLICT (symbol, provider_id, COALESCE(provider_symbol, '')) DO UPDATE SET priority = 0, enabled = TRUE, updated_at = NOW()`,
      [symbol, providerId, providerSymbol || null, network || null]
    );
    await syncPrimary(symbol, client);
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
                network = $8, is_active = $9, updated_at = NOW()
         WHERE symbol = $1`,
        [i.symbol, i.name, i.category, i.base_asset, i.quote_asset, i.exchange, i.contract_address, i.network, i.is_active]
      );
    const providerChanged = body.provider_id !== undefined || body.provider_symbol !== undefined;
    if (providerChanged && i.provider_id) {
      await makePrimary(i.symbol, i.provider_id, i.provider_symbol, i.network).catch(fkError('provider_id does not match a provider'));
    }
    const before = Object.fromEntries(Object.entries(found.inst).filter(([k]) => !k.startsWith('p_')));
    return { before, after: i };
  }

  // Creates the instrument when it is new, adds the given sources and, optionally, puts it on
  // a watchlist. Used by symbol search ("add").
  async function importInstrument(body) {
    return withTransaction(db, async (client) => {
      const exists = await client.query('SELECT symbol FROM instrument_registry WHERE upper(symbol) = upper($1)', [body.symbol]);
      let symbol;
      let created = false;
      if (exists.rows[0]) {
        symbol = exists.rows[0].symbol;
      } else {
        const category = String(body.category || '').toUpperCase();
        if (!INSTRUMENT_CATEGORIES.includes(category)) throw badRequest(`category must be one of ${INSTRUMENT_CATEGORIES.join(', ')}`);
        const i = await create(
          {
            symbol: body.symbol, category, name: body.name ? String(body.name).slice(0, 100) : null, base_asset: body.base_asset, quote_asset: body.quote_asset,
            exchange: body.exchange, contract_address: body.contract_address, network: body.network, is_active: true,
          },
          client
        );
        symbol = i.symbol;
        created = true;
      }
      const added = [];
      for (const l of body.listings) {
        const dup = await client.query(
          "SELECT id FROM instrument_listings WHERE symbol = $1 AND provider_id = $2 AND COALESCE(provider_symbol, '') = COALESCE($3, '')",
          [symbol, l.provider_id, l.provider_symbol || null]
        );
        if (dup.rows[0]) continue;
        added.push(await addListing(symbol, l, client));
      }
      if (body.watchlist_id) {
        await client
          .query(
            `INSERT INTO watchlist_items (watchlist_id, symbol, position)
             VALUES ($1::int, $2, (SELECT COALESCE(max(position) + 1, 0) FROM watchlist_items WHERE watchlist_id = $1::int))
             ON CONFLICT DO NOTHING`,
            [body.watchlist_id, symbol]
          )
          .catch(fkError('Unknown watchlist'));
      }
      return { symbol, created, listings: added };
    });
  }

  // GeckoTerminal: remember the pool found by search on the listing (and the registry, for
  // the primary one), unless the user set a provider symbol.
  async function pinPool(symbol, providerSymbol) {
    await db.query(
      `UPDATE instrument_listings SET provider_symbol = $2, updated_at = NOW()
       WHERE symbol = $1 AND COALESCE(provider_symbol, '') = '' AND provider_id IN (SELECT id FROM market_providers WHERE kind = 'geckoterminal')`,
      [symbol, providerSymbol]
    ).catch(() => {});
    await db.query("UPDATE instrument_registry SET provider_symbol = $2 WHERE symbol = $1 AND COALESCE(provider_symbol, '') = ''", [symbol, providerSymbol]);
  }

  return {
    list, get, listings, sources, create, update, importInstrument, pinPool,
    addListing, updateListing, removeListing, reorderListings, getListing, backfillListings, syncPrimary,
  };
}

module.exports = { createInstruments, providerFromRow };
