// Suite settings, persisted in trade_db.suite_settings (db/migrations/003) under key 'suite'.
const { SETTING_RULES, SETTING_SCHEMAS } = require('../schemas');
const { UNDEFINED_TABLE } = require('../db');

function createSettings({ db, log }) {
  const values = Object.fromEntries(Object.entries(SETTING_RULES).map(([k, r]) => [k, r.default]));
  const state = { persisted: false };
  const listeners = [];

  async function load() {
    try {
      const r = await db.query("SELECT value FROM suite_settings WHERE key = 'suite'");
      state.persisted = true;
      for (const [k, v] of Object.entries((r.rows[0] && r.rows[0].value) || {})) {
        const schema = SETTING_SCHEMAS[k];
        if (!schema) continue;
        const parsed = schema.safeParse(v);
        if (parsed.success) values[k] = parsed.data;
        else log.warn({ key: k }, 'stored setting is invalid; using the default');
      }
    } catch (e) {
      if (e.code !== UNDEFINED_TABLE) log.error({ error: e.message }, 'loading settings failed');
    }
  }

  // patch: output of schemas.settingsPatch. Returns { before, after }.
  async function update(patch, actor) {
    const before = { ...values };
    const next = { ...values, ...patch };
    await db.query(
      `INSERT INTO suite_settings (key, value, updated_by, updated_at) VALUES ('suite', $1, $2, NOW())
       ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_by = EXCLUDED.updated_by, updated_at = NOW()`,
      [next, actor]
    );
    Object.assign(values, next);
    state.persisted = true;
    for (const fn of listeners) await fn(values, before);
    return { before, after: { ...values } };
  }

  return {
    values,
    rules: SETTING_RULES,
    get persisted() {
      return state.persisted;
    },
    load,
    update,
    onChange: (fn) => listeners.push(fn),
  };
}

module.exports = { createSettings };
