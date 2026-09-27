// Pine scripts saved from the chart's Pine panel (trade_db.pine_scripts, migration 008).
// They run in the browser; the server only stores them.
const { badRequest, notFound, onDuplicate } = require('../http/errors');

const MAX_SOURCE = 200000;

function createPineScripts({ db }) {
  async function list() {
    const r = await db.query('SELECT id, name, example, created_by, updated_at, length(source) AS size FROM pine_scripts ORDER BY example DESC, lower(name)');
    return r.rows;
  }

  async function get(id) {
    const r = await db.query('SELECT * FROM pine_scripts WHERE id = $1', [id]);
    if (!r.rows[0]) throw notFound('Script not found');
    return r.rows[0];
  }

  function check({ name, source }, partial) {
    if (!partial || name !== undefined) {
      if (typeof name !== 'string' || !name.trim() || name.trim().length > 80) throw badRequest('name: 1 to 80 characters');
    }
    if (!partial || source !== undefined) {
      if (typeof source !== 'string' || !source.trim()) throw badRequest('source: the script is empty');
      if (source.length > MAX_SOURCE) throw badRequest('source: at most 200,000 characters');
    }
  }

  async function create(body, actor) {
    check(body, false);
    const r = await db
      .query('INSERT INTO pine_scripts (name, source, created_by) VALUES ($1, $2, $3) RETURNING id, name, example, updated_at', [body.name.trim(), body.source, actor])
      .catch(onDuplicate(`A script named "${body.name.trim()}" exists`));
    return r.rows[0];
  }

  async function update(id, body) {
    check(body, true);
    const before = await get(id);
    const r = await db
      .query('UPDATE pine_scripts SET name = COALESCE($2, name), source = COALESCE($3, source), updated_at = NOW() WHERE id = $1 RETURNING id, name, example, updated_at', [
        id,
        body.name === undefined ? null : body.name.trim(),
        body.source === undefined ? null : body.source,
      ])
      .catch(onDuplicate(`A script named "${String(body.name).trim()}" exists`));
    return { before: { id: before.id, name: before.name }, after: r.rows[0] };
  }

  async function remove(id) {
    const s = await get(id);
    await db.query('DELETE FROM pine_scripts WHERE id = $1', [id]);
    return s;
  }

  return { list, get, create, update, remove };
}

module.exports = { createPineScripts };
