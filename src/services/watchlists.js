// Watchlists (db/migrations/005): named lists of instruments with their own columns, sort
// order and manual item order.
const { watchlist: watchlistSchema } = require('../schemas');
const { badRequest, notFound, onDuplicate } = require('../http/errors');
const { withTransaction } = require('../db');

function createWatchlists({ db }) {
  function parse(input) {
    const result = watchlistSchema.safeParse(input);
    if (!result.success) {
      const i = result.error.issues[0];
      throw badRequest(i.message.startsWith(String(i.path[0])) ? i.message : `${i.path.join('.')}: ${i.message}`);
    }
    return result.data;
  }

  async function list() {
    const r = await db.query(`
      SELECT w.*, (SELECT count(*) FROM watchlist_items i WHERE i.watchlist_id = w.id)::int AS item_count
      FROM watchlists w ORDER BY w.position, w.id`);
    return r.rows;
  }

  async function get(id) {
    const r = await db.query('SELECT * FROM watchlists WHERE id = $1', [id]);
    if (!r.rows[0]) throw notFound('Watchlist not found');
    return r.rows[0];
  }

  async function items(id) {
    await get(id);
    const r = await db.query(
      `SELECT i.symbol, i.position, i.added_at, ir.name, ir.category, ir.exchange, ir.is_active, ir.last_price, ir.change_24h_pct,
              ir.volume_24h_usd, ir.updated_at, mp.name AS provider_name, mp.kind AS provider_kind,
              (SELECT count(*) FROM instrument_listings l WHERE l.symbol = i.symbol)::int AS listing_count,
              es.profit_score, es.score_grade
       FROM watchlist_items i
       JOIN instrument_registry ir ON ir.symbol = i.symbol
       LEFT JOIN market_providers mp ON mp.id = ir.provider_id
       LEFT JOIN economist_signals es ON es.symbol = i.symbol
       WHERE i.watchlist_id = $1 ORDER BY i.position, i.symbol`,
      [id]
    );
    return r.rows;
  }

  // Only one list is the default one.
  async function clearDefault(client, exceptId) {
    await client.query('UPDATE watchlists SET is_default = FALSE WHERE is_default AND id <> $1', [exceptId || 0]);
  }

  async function create(body) {
    const w = parse(body);
    return withTransaction(db, async (client) => {
      if (w.is_default) await clearDefault(client);
      const r = await client
        .query(
          `INSERT INTO watchlists (name, columns, sort, is_default, position)
           VALUES ($1, $2, $3, $4, COALESCE($5::int, (SELECT COALESCE(max(position) + 1, 0) FROM watchlists))) RETURNING *`,
          [w.name, JSON.stringify(w.columns), JSON.stringify(w.sort), w.is_default, w.position ?? null]
        )
        .catch(onDuplicate('A watchlist with this name exists'));
      return r.rows[0];
    });
  }

  async function update(id, body) {
    const before = await get(id);
    const merged = {};
    for (const k of ['name', 'columns', 'sort', 'is_default', 'position']) merged[k] = body[k] !== undefined ? body[k] : before[k];
    const w = parse(merged);
    return withTransaction(db, async (client) => {
      if (w.is_default) await clearDefault(client, id);
      const r = await client
        .query(
          `UPDATE watchlists SET name = $2, columns = $3, sort = $4, is_default = $5, position = $6, updated_at = NOW()
           WHERE id = $1 RETURNING *`,
          [id, w.name, JSON.stringify(w.columns), JSON.stringify(w.sort), w.is_default, w.position ?? before.position]
        )
        .catch(onDuplicate('A watchlist with this name exists'));
      return { before, after: r.rows[0] };
    });
  }

  async function remove(id) {
    const before = await get(id);
    const count = await db.query('SELECT count(*)::int AS n FROM watchlists');
    if (count.rows[0].n <= 1) throw badRequest('The last watchlist cannot be deleted');
    await db.query('DELETE FROM watchlists WHERE id = $1', [id]);
    if (before.is_default) {
      await db.query('UPDATE watchlists SET is_default = TRUE WHERE id = (SELECT id FROM watchlists ORDER BY position, id LIMIT 1)');
    }
    return before;
  }

  async function addItem(id, symbol) {
    await get(id);
    const inst = await db.query('SELECT symbol FROM instrument_registry WHERE symbol = $1 OR upper(symbol) = upper($1) ORDER BY symbol = $1 DESC LIMIT 1', [symbol]);
    if (!inst.rows[0]) throw notFound(`${symbol} is not a registered instrument; add it through search first`);
    const r = await db.query(
      `INSERT INTO watchlist_items (watchlist_id, symbol, position)
       VALUES ($1::int, $2, (SELECT COALESCE(max(position) + 1, 0) FROM watchlist_items WHERE watchlist_id = $1::int))
       ON CONFLICT DO NOTHING RETURNING *`,
      [id, inst.rows[0].symbol]
    );
    return { symbol: inst.rows[0].symbol, added: !!r.rows[0] };
  }

  async function removeItem(id, symbol) {
    const r = await db.query('DELETE FROM watchlist_items WHERE watchlist_id = $1 AND symbol = $2', [id, symbol]);
    if (!r.rowCount) throw notFound(`${symbol} is not on this watchlist`);
  }

  // symbols: the list's items in their new order. Items not named keep their order after them.
  async function reorder(id, symbols) {
    await get(id);
    return withTransaction(db, async (client) => {
      const r = await client.query('SELECT symbol FROM watchlist_items WHERE watchlist_id = $1 ORDER BY position, symbol', [id]);
      const current = r.rows.map((x) => x.symbol);
      const seen = new Set();
      const order = [...symbols.filter((s) => current.includes(s) && !seen.has(s) && seen.add(s)), ...current.filter((s) => !seen.has(s))];
      for (const [i, s] of order.entries()) await client.query('UPDATE watchlist_items SET position = $3 WHERE watchlist_id = $1 AND symbol = $2', [id, s, i]);
      return order;
    });
  }

  // Lists that contain a symbol (for the instrument menu).
  async function containing(symbol) {
    const r = await db.query('SELECT watchlist_id FROM watchlist_items WHERE symbol = $1', [symbol]);
    return r.rows.map((x) => x.watchlist_id);
  }

  return { list, get, items, create, update, remove, addItem, removeItem, reorder, containing };
}

module.exports = { createWatchlists };
