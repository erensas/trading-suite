// Chart layouts and alerts (db/migrations/006).
//
// Price and 24 h change alerts are checked after every price refresh, against the values
// just written to instrument_registry. Indicator alerts are checked every few minutes on the
// last closed candle of their timeframe. A one-shot alert disables itself when it fires; a
// repeating one fires again only after its condition was false once (re-armed).
const Indicators = require('../../public/indicators');
const { alert: alertSchema } = require('../schemas');
const { badRequest, notFound } = require('../http/errors');

const KIND_TEXT = {
  price_above: 'price above', price_below: 'price below', change_above: '24h change above', change_below: '24h change below',
  indicator_above: 'above', indicator_below: 'below',
};
const MAX_INDICATOR_ALERTS = 40;

function describe(a) {
  if (a.kind.startsWith('indicator_')) {
    const ind = a.indicator || {};
    const def = Indicators.DEFS[ind.id];
    const out = ind.output && def && def.outputs.length > 1 ? ` ${ind.output}` : '';
    return `${a.symbol} ${Indicators.label(ind.id, ind.params)}${out} (${a.timeframe}) ${KIND_TEXT[a.kind]} ${Number(a.value)}`;
  }
  return `${a.symbol} ${KIND_TEXT[a.kind]} ${Number(a.value)}${a.kind.startsWith('change') ? '%' : ''}`;
}

function createAlerts({ db, marketData, log }) {
  // ---- chart layouts ----------------------------------------------------------------------
  async function getLayout(symbol) {
    const r = await db.query('SELECT scope, layout, updated_at FROM chart_layouts WHERE scope = ANY($1)', [[symbol || 'default', 'default']]);
    const own = r.rows.find((x) => x.scope === symbol);
    const def = r.rows.find((x) => x.scope === 'default');
    const pick = own || def;
    return { scope: pick ? pick.scope : 'default', layout: pick ? pick.layout : { indicators: [], showVolume: true }, hasOwn: !!own };
  }

  async function saveLayout(scope, layout, actor) {
    await db.query(
      `INSERT INTO chart_layouts (scope, layout, updated_by, updated_at) VALUES ($1, $2, $3, NOW())
       ON CONFLICT (scope) DO UPDATE SET layout = EXCLUDED.layout, updated_by = EXCLUDED.updated_by, updated_at = NOW()`,
      [scope, JSON.stringify(layout), actor]
    );
  }

  const deleteLayout = (scope) => db.query("DELETE FROM chart_layouts WHERE scope = $1 AND scope <> 'default'", [scope]);

  // ---- alerts ------------------------------------------------------------------------------
  function parse(input) {
    const result = alertSchema.safeParse(input);
    if (!result.success) {
      const i = result.error.issues[0];
      throw badRequest(`${i.path.join('.') || 'alert'}: ${i.message}`);
    }
    return result.data;
  }

  async function list({ symbol } = {}) {
    const r = await db.query(
      `SELECT a.*, ir.last_price, ir.change_24h_pct FROM alerts a JOIN instrument_registry ir ON ir.symbol = a.symbol
       ${symbol ? 'WHERE a.symbol = $1' : ''} ORDER BY a.enabled DESC, a.created_at DESC`,
      symbol ? [symbol] : []
    );
    return r.rows.map((a) => ({ ...a, text: describe(a) }));
  }

  async function get(id) {
    const r = await db.query('SELECT * FROM alerts WHERE id = $1', [id]);
    if (!r.rows[0]) throw notFound('Alert not found');
    return r.rows[0];
  }

  async function create(body, actor) {
    const a = parse(body);
    const inst = await db.query('SELECT symbol FROM instrument_registry WHERE symbol = $1', [a.symbol]);
    if (!inst.rows[0]) throw notFound(`${a.symbol} is not a registered instrument`);
    const r = await db.query(
      `INSERT INTO alerts (symbol, kind, value, indicator, timeframe, note, repeat, enabled, created_by)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9) RETURNING *`,
      [a.symbol, a.kind, a.value, a.indicator ? JSON.stringify(a.indicator) : null, a.timeframe || null, a.note, a.repeat, a.enabled, actor]
    );
    return { ...r.rows[0], text: describe(r.rows[0]) };
  }

  async function update(id, body) {
    const before = await get(id);
    const merged = {};
    for (const k of ['symbol', 'kind', 'value', 'indicator', 'timeframe', 'note', 'repeat', 'enabled']) merged[k] = body[k] !== undefined ? body[k] : before[k] ?? undefined;
    const a = parse(merged);
    // Re-enabling or changing the condition re-arms it.
    const r = await db.query(
      `UPDATE alerts SET kind = $2, value = $3, indicator = $4, timeframe = $5, note = $6, repeat = $7, enabled = $8, armed = TRUE
       WHERE id = $1 RETURNING *`,
      [id, a.kind, a.value, a.indicator ? JSON.stringify(a.indicator) : null, a.timeframe || null, a.note, a.repeat, a.enabled]
    );
    return { before, after: { ...r.rows[0], text: describe(r.rows[0]) } };
  }

  async function remove(id) {
    const before = await get(id);
    await db.query('DELETE FROM alerts WHERE id = $1', [id]);
    return before;
  }

  async function events({ after = 0, limit = 50 } = {}) {
    const r = await db.query('SELECT * FROM alert_events WHERE id > $1 ORDER BY id DESC LIMIT $2', [after, limit]);
    const unseen = await db.query('SELECT count(*)::int AS n FROM alert_events WHERE NOT seen');
    return { events: r.rows, unseen: unseen.rows[0].n };
  }

  async function markSeen({ ids, all }) {
    if (all) await db.query('UPDATE alert_events SET seen = TRUE WHERE NOT seen');
    else if (ids && ids.length) await db.query('UPDATE alert_events SET seen = TRUE WHERE id = ANY($1)', [ids]);
  }

  // ---- evaluation ----------------------------------------------------------------------------
  const conditionMet = (kind, current, level) => (kind.endsWith('_above') ? current >= level : current <= level);

  // Applies one observation to an alert: fire, re-arm, or just record the value.
  async function observe(a, current) {
    const met = conditionMet(a.kind, current, Number(a.value));
    if (met && a.armed) {
      const message = `${describe(a)} (now ${Number(current.toPrecision(8))})${a.note ? ` · ${a.note}` : ''}`;
      await db.query('INSERT INTO alert_events (alert_id, symbol, value, message) VALUES ($1, $2, $3, $4)', [a.id, a.symbol, current, message]);
      await db.query('UPDATE alerts SET armed = FALSE, triggered_at = NOW(), enabled = $2, last_value = $3, last_checked = NOW() WHERE id = $1', [a.id, !!a.repeat, current]);
      log.info({ alert: a.id, symbol: a.symbol, value: current }, 'alert fired');
      return true;
    }
    await db.query('UPDATE alerts SET armed = armed OR ($2 AND NOT $3), last_value = $4, last_checked = NOW() WHERE id = $1', [a.id, !!a.repeat, met, current]);
    return false;
  }

  async function evaluatePrices() {
    const r = await db.query(`
      SELECT a.*, ir.last_price, ir.change_24h_pct FROM alerts a JOIN instrument_registry ir ON ir.symbol = a.symbol
      WHERE a.enabled AND a.kind IN ('price_above', 'price_below', 'change_above', 'change_below')`);
    let fired = 0;
    for (const a of r.rows) {
      const current = Number(a.kind.startsWith('price') ? a.last_price : a.change_24h_pct);
      if (a.last_price === null || !Number.isFinite(current)) continue;
      if (await observe(a, current)) fired++;
    }
    return fired;
  }

  // Indicator value on the last closed bar (the newest bar is still forming).
  async function indicatorValue(a) {
    const ind = a.indicator;
    const { candles } = await marketData.candles({ symbol: a.symbol, tf: a.timeframe, limit: 400 });
    if (!candles || candles.length < 3) throw new Error('not enough candles');
    const closed = candles.slice(0, -1);
    const out = Indicators.compute(ind.id, closed, ind.params);
    const key = ind.output || Indicators.DEFS[ind.id].outputs.find((o) => !o.histogram)?.key || Indicators.DEFS[ind.id].outputs[0].key;
    const series = out[key] || [];
    const last = series[series.length - 1];
    if (!last || last.time !== closed[closed.length - 1].time) throw new Error('no value on the last closed bar');
    return last.value;
  }

  async function evaluateIndicators() {
    const r = await db.query(
      `SELECT * FROM alerts WHERE enabled AND kind IN ('indicator_above', 'indicator_below') ORDER BY last_checked NULLS FIRST LIMIT ${MAX_INDICATOR_ALERTS}`
    );
    let fired = 0;
    for (const a of r.rows) {
      try {
        if (await observe(a, await indicatorValue(a))) fired++;
      } catch (e) {
        log.debug({ alert: a.id, error: e.message }, 'indicator alert not checked');
        await db.query('UPDATE alerts SET last_checked = NOW() WHERE id = $1', [a.id]).catch(() => {});
      }
    }
    return fired;
  }

  return { getLayout, saveLayout, deleteLayout, list, get, create, update, remove, events, markSeen, evaluatePrices, evaluateIndicators, describe };
}

module.exports = { createAlerts };
