// Market data providers (trade_db.market_providers) and the calls to their adapters.
// Every adapter call goes through the ProviderGuard (rate limit + circuit breaker).
const { KINDS, adapterFor, validateBaseUrl } = require('../../lib/providers');
const { provider: providerSchema } = require('../schemas');
const { badRequest, notFound, onDuplicate } = require('../http/errors');

const COLUMNS = ['id', 'name', 'kind', 'base_url', 'enabled', 'config', 'credential_env', 'last_test_ok', 'last_test_at', 'last_test_msg'];
const COLUMN_LIST = COLUMNS.join(', ');
const EDITABLE = ['name', 'kind', 'base_url', 'enabled', 'config', 'credential_env'];

function createProviders({ db, guard, freqtradeUrl, ctx }) {
  // Cross-field rules that the schema cannot express.
  function checked(p) {
    if (p.kind === 'freqtrade') p.base_url = freqtradeUrl;
    const urlError = validateBaseUrl(p.kind, p.base_url);
    if (urlError) throw badRequest(urlError);
    // Template URLs may only point at the provider's own base_url.
    for (const key of ['candles_url', 'ticker_url']) {
      const t = p.config[key];
      if (t && !String(t).startsWith('/') && !String(t).startsWith(p.base_url + '/')) {
        throw badRequest(`config.${key} must start with "/" or with base_url`);
      }
    }
    const rate = p.config.rate_limit_per_min;
    if (rate !== undefined && !(Number(rate) > 0 && Number(rate) <= 6000)) throw badRequest('config.rate_limit_per_min must be between 1 and 6000');
    return p;
  }

  function parse(input) {
    const result = providerSchema.safeParse(input);
    if (!result.success) {
      const i = result.error.issues[0];
      throw badRequest(i.message.startsWith(String(i.path[0])) ? i.message : `${i.path.join('.')}: ${i.message}`);
    }
    return checked(result.data);
  }

  async function list() {
    const r = await db.query(`
      SELECT ${COLUMNS.map((c) => 'p.' + c).join(', ')},
             (SELECT count(*) FROM instrument_registry i WHERE i.provider_id = p.id)::int AS instrument_count
      FROM market_providers p ORDER BY p.id`);
    return r.rows.map((p) => ({ ...p, circuit: guard.status(p) }));
  }

  async function get(id) {
    const r = await db.query(`SELECT ${COLUMN_LIST} FROM market_providers WHERE id = $1`, [id]);
    return r.rows[0] || null;
  }

  async function mustGet(id) {
    const p = await get(id);
    if (!p) throw notFound('Provider not found');
    return p;
  }

  async function create(body) {
    const p = parse(body);
    const r = await db
      .query(
        `INSERT INTO market_providers (name, kind, base_url, enabled, config, credential_env)
         VALUES ($1, $2, $3, $4, $5, $6) RETURNING ${COLUMN_LIST}`,
        [p.name, p.kind, p.base_url, p.enabled, p.config, p.credential_env]
      )
      .catch(onDuplicate('A provider with this name exists'));
    return r.rows[0];
  }

  async function update(id, body) {
    const existing = await mustGet(id);
    const merged = Object.fromEntries(EDITABLE.map((k) => [k, body[k] !== undefined ? body[k] : existing[k]]));
    const p = parse(merged);
    const r = await db
      .query(
        `UPDATE market_providers SET name = $2, kind = $3, base_url = $4, enabled = $5, config = $6, credential_env = $7, updated_at = NOW()
         WHERE id = $1 RETURNING ${COLUMN_LIST}`,
        [existing.id, p.name, p.kind, p.base_url, p.enabled, p.config, p.credential_env]
      )
      .catch(onDuplicate('A provider with this name exists'));
    guard.forget(existing);
    return { before: existing, after: r.rows[0] };
  }

  async function remove(id) {
    const r = await db.query(`DELETE FROM market_providers WHERE id = $1 RETURNING ${COLUMN_LIST}`, [id]);
    if (!r.rows.length) throw notFound('Provider not found');
    guard.forget(r.rows[0]);
    return r.rows[0];
  }

  // Calls adapter[method](provider, ...args, ctx) through the guard.
  function call(provider, method, ...args) {
    const adapter = adapterFor(provider);
    return guard.run(provider, () => adapter[method](provider, ...args, ctx));
  }

  async function test(provider) {
    const started = Date.now();
    let ok = false;
    let msg;
    try {
      msg = await call(provider, 'test');
      ok = true;
    } catch (e) {
      msg = e.message;
    }
    msg = `${String(msg).slice(0, 300)} (${Date.now() - started} ms)`;
    await db
      .query('UPDATE market_providers SET last_test_ok = $2, last_test_at = NOW(), last_test_msg = $3 WHERE id = $1', [provider.id, ok, msg])
      .catch(() => {});
    return { ok, message: msg };
  }

  function kinds() {
    return Object.fromEntries(
      Object.entries(KINDS).map(([k, v]) => [
        k,
        { label: v.label, defaults: v.defaults, symbolHint: v.symbolHint, config: v.config, credentials: !!v.credentials, ratePerMin: v.ratePerMin || null },
      ])
    );
  }

  return { list, get, mustGet, create, update, remove, call, test, kinds };
}

module.exports = { createProviders, COLUMNS };
