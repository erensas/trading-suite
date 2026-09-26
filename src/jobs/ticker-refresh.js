// Background ticker refresh: keeps last_price / change_24h_pct / volume_24h_usd of active
// instruments current. Runs every settings.tickerRefreshSeconds; GeckoTerminal instruments
// at most every 5 minutes, in one batch call per network.
const { UNDEFINED_TABLE } = require('../db');
const { providerFromRow } = require('../services/instruments');

const GECKO_MIN_INTERVAL_MS = 5 * 60 * 1000;
const WORKERS = 3;

function createTickerRefresh({ db, providers, settings, log }) {
  const state = { running: false, lastRunAt: null, updated: 0, failed: 0, errors: {} };
  let timer = null;
  let stopped = false;
  let lastGeckoRefresh = 0;

  const clampPct = (v) => (Number.isFinite(v) ? Math.max(-999999, Math.min(999999, v)) : null);
  const clampVol = (v) => (Number.isFinite(v) ? Math.min(v, 9.9e15) : null);

  async function save(row, t) {
    if (t instanceof Error) throw t;
    if (t.price === null || !Number.isFinite(t.price)) throw new Error('no price');
    await db.query('UPDATE instrument_registry SET last_price = $2, change_24h_pct = $3, volume_24h_usd = $4, updated_at = NOW() WHERE symbol = $1', [
      row.symbol,
      t.price,
      clampPct(t.changePct),
      clampVol(t.volumeUsd),
    ]);
  }

  async function run() {
    if (state.running) return;
    state.running = true;
    const started = Date.now();
    let updated = 0;
    let failed = 0;
    const errors = {};
    const fail = (symbol, e) => {
      failed++;
      errors[symbol] = String(e.message || e).slice(0, 200);
    };
    try {
      const r = await db.query(`
        SELECT ir.*, mp.id AS p_id, mp.name AS p_name, mp.kind AS p_kind, mp.base_url AS p_base_url, mp.enabled AS p_enabled,
               mp.config AS p_config, mp.credential_env AS p_credential_env
        FROM instrument_registry ir JOIN market_providers mp ON mp.id = ir.provider_id
        WHERE ir.is_active IS NOT FALSE AND mp.enabled`);
      const doGecko = Date.now() - lastGeckoRefresh >= GECKO_MIN_INTERVAL_MS;
      if (doGecko) lastGeckoRefresh = Date.now();
      const jobs = r.rows.filter((row) => row.p_kind !== 'freqtrade' && (row.p_kind !== 'geckoterminal' || doGecko));
      // GeckoTerminal is rate limited per IP, so its instruments go through one batch.
      const geckoRows = jobs.filter((row) => row.p_kind === 'geckoterminal');
      const queue = jobs.filter((row) => row.p_kind !== 'geckoterminal');

      const batch = async (rows) => {
        const groups = new Map();
        for (const row of rows) {
          if (!groups.has(row.p_id)) groups.set(row.p_id, []);
          groups.get(row.p_id).push(row);
        }
        for (const group of groups.values()) {
          let results;
          try {
            results = await providers.call(providerFromRow(group[0]), 'tickers', group);
          } catch (e) {
            group.forEach((row) => fail(row.symbol, e));
            continue;
          }
          for (const row of group) {
            try {
              await save(row, results.get(row.symbol) || new Error('no result'));
              updated++;
            } catch (e) {
              fail(row.symbol, e);
            }
          }
        }
      };
      const worker = async () => {
        while (queue.length && !stopped) {
          const row = queue.shift();
          try {
            await save(row, await providers.call(providerFromRow(row), 'ticker', row));
            updated++;
          } catch (e) {
            if (!e.unsupported) fail(row.symbol, e);
          }
        }
      };
      await Promise.all([...Array.from({ length: WORKERS }, worker), batch(geckoRows)]);
    } catch (e) {
      if (e.code !== UNDEFINED_TABLE) errors._ = e.message;
    } finally {
      Object.assign(state, { running: false, lastRunAt: new Date().toISOString(), updated, failed, errors });
      log.debug({ updated, failed, ms: Date.now() - started }, 'ticker refresh');
      if (failed || errors._) log.info({ updated, failed, errors }, 'ticker refresh had failures');
    }
  }

  // Next run after delayMs (default: the configured interval), then every interval.
  function schedule(delayMs) {
    if (stopped) return;
    clearTimeout(timer);
    timer = setTimeout(
      async function tick() {
        await run();
        if (!stopped) timer = setTimeout(tick, settings.values.tickerRefreshSeconds * 1000);
      },
      delayMs === undefined ? settings.values.tickerRefreshSeconds * 1000 : delayMs
    );
  }

  function stop() {
    stopped = true;
    clearTimeout(timer);
  }

  return { state, run, schedule, stop };
}

module.exports = { createTickerRefresh };
