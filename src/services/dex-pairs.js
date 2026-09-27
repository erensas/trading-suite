// Per-pair controls of the Web3 engine (trade_db.dex_pair_controls, migration 011).
//
// The engine reports every token pair it scans (per network, with its pools and DEXes) and
// reads the two flags every cycle:
//   arbitrage_enabled  the pair is evaluated for arbitrage at all
//   flashloan_enabled  an opportunity on the pair may borrow its capital in a flash loan;
//                      off, the engine only considers its own capital (no loan, no loan fee)
// Pairs the engine has not reported yet do not exist here; new pairs start with both on.
// The UI and API callers switch them; every change is audited.
const { badRequest, notFound } = require('../http/errors');

const FLAGS = ['arbitrage_enabled', 'flashloan_enabled'];

function createDexPairs({ db }) {
  function flagsOf(body) {
    const out = {};
    for (const f of FLAGS) {
      if (body[f] === undefined) continue;
      if (typeof body[f] !== 'boolean') throw badRequest(`${f}: true or false`);
      out[f] = body[f];
    }
    if (!Object.keys(out).length) throw badRequest(`set ${FLAGS.join(' and/or ')}`);
    return out;
  }

  async function list({ network } = {}) {
    const r = await db.query(
      `SELECT *, EXTRACT(EPOCH FROM (NOW() - last_seen_at))::int AS seen_ago_s FROM dex_pair_controls
       WHERE $1::text IS NULL OR network = $1 ORDER BY network, token_a, token_b`,
      [network || null]
    );
    return r.rows;
  }

  async function get(id) {
    const r = await db.query('SELECT * FROM dex_pair_controls WHERE id = $1', [id]);
    if (!r.rows[0]) throw notFound('Pair not found');
    return r.rows[0];
  }

  const assignments = (flags, start) => Object.keys(flags).map((f, i) => `${f} = $${start + i}`).join(', ');

  async function update(id, body, actor) {
    const flags = flagsOf(body);
    const before = await get(id);
    const r = await db.query(
      `UPDATE dex_pair_controls SET ${assignments(flags, 3)}, updated_by = $2, updated_at = NOW() WHERE id = $1 RETURNING *`,
      [id, actor, ...Object.values(flags)]
    );
    return { before, after: r.rows[0] };
  }

  // Several pairs at once: by ids, or every pair of a network, or all pairs.
  async function updateMany(body, actor) {
    const flags = flagsOf(body);
    const ids = Array.isArray(body.ids) ? body.ids.map(Number) : null;
    if (ids && (!ids.length || ids.length > 500 || !ids.every((n) => Number.isInteger(n) && n > 0))) throw badRequest('ids: 1 to 500 pair ids');
    const network = body.network ? String(body.network) : null;
    if (network && !/^[a-z0-9_-]{1,40}$/.test(network)) throw badRequest('network: a network name such as ethereum or arbitrum');
    if (!ids && !network && body.all !== true) throw badRequest('name the pairs: ids, network, or all: true');
    const n = Object.keys(flags).length;
    const r = await db.query(
      `UPDATE dex_pair_controls SET ${assignments(flags, 4)}, updated_by = $3, updated_at = NOW()
       WHERE ($1::int[] IS NULL OR id = ANY($1)) AND ($2::text IS NULL OR network = $2) RETURNING id`,
      [ids, network, actor, ...Object.values(flags)].slice(0, 3 + n)
    );
    return { updated: r.rowCount, ids: r.rows.map((x) => x.id), flags };
  }

  return { list, get, update, updateMany };
}

module.exports = { createDexPairs, FLAGS };
