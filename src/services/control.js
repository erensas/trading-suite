// Trading control plane: kill switch and real engine modes (db/migrations/001).
// Each engine reads the switch on its own; this service writes it, pauses every Freqtrade bot
// (src/services/bots.js: the main bot and the managed bots), and reports engine modes from
// Freqtrade's API and the engine_status heartbeat table.
const { UNDEFINED_TABLE, withTransaction } = require('../db');

const ENGINE_STALE_SECONDS = 180;

// ctx.bots is read when needed (the bots service also reads the kill switch from here).
function createControl(ctx) {
  const { db, freqtrade } = ctx;
  async function state() {
    try {
      const r = await db.query('SELECT halted, reason, changed_by, changed_at FROM trading_control WHERE id = 1');
      if (!r.rows.length) return { installed: false };
      return { installed: true, ...r.rows[0] };
    } catch (e) {
      if (e.code === UNDEFINED_TABLE) return { installed: false };
      throw e;
    }
  }

  async function freqtradeEngine() {
    try {
      const cfg = await freqtrade.api('GET', '/show_config');
      return {
        engine: 'freqtrade',
        mode: cfg.dry_run ? 'DRY_RUN' : 'LIVE',
        state: String(cfg.state || 'unknown').toUpperCase(),
        detail: { strategy: cfg.strategy, runmode: cfg.runmode },
      };
    } catch (e) {
      return { engine: 'freqtrade', mode: 'UNKNOWN', state: 'OFFLINE', detail: { error: e.message } };
    }
  }

  async function heartbeatEngines() {
    let rows = [];
    try {
      const r = await db.query(`
        SELECT engine, mode, state, detail, last_seen,
               EXTRACT(EPOCH FROM (NOW() - last_seen)) AS age_seconds
        FROM engine_status ORDER BY engine`);
      rows = r.rows.map((row) => ({
        engine: row.engine,
        mode: row.mode,
        state: Number(row.age_seconds) > ENGINE_STALE_SECONDS ? 'OFFLINE' : row.state,
        last_seen: row.last_seen,
        detail: row.detail,
      }));
    } catch (e) {
      if (e.code !== UNDEFINED_TABLE) throw e;
    }
    if (!rows.some((row) => row.engine === 'web3-dex-bot')) {
      rows.push({ engine: 'web3-dex-bot', mode: 'UNKNOWN', state: 'NOT_REPORTING', detail: null });
    }
    return rows;
  }

  function write(halted, reason, changedBy) {
    return withTransaction(db, async (client) => {
      await client.query('UPDATE trading_control SET halted = $1, reason = $2, changed_by = $3, changed_at = NOW() WHERE id = 1', [halted, reason, changedBy]);
      await client.query('INSERT INTO trading_control_audit (halted, reason, changed_by) VALUES ($1, $2, $3)', [halted, reason, changedBy]);
    });
  }

  async function halt(reason, actor) {
    await write(true, reason, actor);
    const results = { database: 'halted' };
    if (ctx.bots) {
      Object.assign(results, botResults(await ctx.bots.pauseAll(reason)));
    } else {
      try {
        await freqtrade.api('POST', '/pause');
        results.freqtrade = 'paused (open trades managed, no new entries)';
      } catch (e) {
        results.freqtrade = `pause failed: ${e.message}; entries stay blocked by confirm_trade_entry`;
      }
    }
    results['web3-dex-bot'] = 'reads trading_control; scanner stops transmitting';
    return results;
  }

  async function resume(actor) {
    await write(false, 'Resumed from trading-suite UI', actor);
    const results = { database: 'resumed' };
    if (ctx.bots) {
      Object.assign(results, botResults(await ctx.bots.startAll(actor)));
      return results;
    }
    try {
      await freqtrade.api('POST', '/start');
      results.freqtrade = 'running';
    } catch (e) {
      results.freqtrade = `start failed: ${e.message}`;
    }
    return results;
  }

  // The main bot keeps its old key ("freqtrade") in the results; managed bots are "bot <name>".
  const botResults = (byName) => Object.fromEntries(Object.entries(byName).map(([name, r]) => [name === 'main' ? 'freqtrade' : `bot ${name}`, r]));

  return { state, freqtradeEngine, heartbeatEngines, halt, resume };
}

module.exports = { createControl, ENGINE_STALE_SECONDS };
