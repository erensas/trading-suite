// One status view over everything the suite talks to, and the Freqtrade details.
const express = require('express');
const { execFile } = require('child_process');
const { validate } = require('../http/middleware');
const { asUpstream, badRequest, forbidden } = require('../http/errors');
const schemas = require('../schemas');

async function timed(fn) {
  const started = Date.now();
  try {
    const detail = await fn();
    return { ok: true, detail, ms: Date.now() - started };
  } catch (e) {
    return { ok: false, detail: e.message, ms: Date.now() - started };
  }
}

const STATUS_SERVICES = ['trading-suite.service', 'web3-dex-bot.service', 'freqtrade.service', 'system-dashboard.service'];

module.exports = function integrationRoutes({ db, freqtrade, control, providers, tickerRefresh, config, requireControl }) {
  const router = express.Router();

  router.get('/api/integrations', async (req, res) => {
    const [database, ft, dash, heartbeat] = await Promise.all([
      timed(async () => {
        const r = await db.query('SELECT current_database() AS db, pg_size_pretty(pg_database_size(current_database())) AS size');
        return `${r.rows[0].db}, ${r.rows[0].size}`;
      }),
      timed(async () => {
        const cfg = await freqtrade.api('GET', '/show_config');
        return `${cfg.strategy}, ${cfg.dry_run ? 'dry-run' : 'LIVE'}, state ${cfg.state}`;
      }),
      timed(async () => {
        const r = await fetch(config.systemDashboardHealth, { signal: AbortSignal.timeout(3000) });
        if (!r.ok) throw new Error(`HTTP ${r.status}`);
        return 'healthy';
      }),
      timed(async () => {
        const rows = await control.heartbeatEngines();
        const w = rows.find((r) => r.engine === 'web3-dex-bot');
        if (!w || w.state === 'OFFLINE' || w.state === 'NOT_REPORTING') throw new Error(`web3-dex-bot ${w ? w.state : 'not reporting'}`);
        return `web3-dex-bot ${w.mode}, ${w.state}`;
      }),
    ]);
    let list = [];
    try {
      list = (await providers.list()).map((p) => ({
        id: p.id, name: p.name, kind: p.kind, enabled: p.enabled, instruments: p.instrument_count,
        ok: p.last_test_ok, tested_at: p.last_test_at, detail: p.last_test_msg, circuit: p.circuit,
      }));
    } catch (e) {}
    res.json({
      success: true,
      services: [
        { name: 'PostgreSQL trade_db', ...database },
        { name: 'Freqtrade API', ...ft },
        { name: 'Web3 DEX engine heartbeat', ...heartbeat },
        { name: 'System dashboard', ...dash },
      ],
      providers: list,
      tickerRefresh: tickerRefresh.state,
    });
  });

  router.get('/api/integrations/freqtrade', async (req, res) => {
    const [cfg, status, profit, whitelist] = await Promise.all([
      freqtrade.api('GET', '/show_config').catch(asUpstream),
      freqtrade.api('GET', '/status').catch(() => []),
      freqtrade.api('GET', '/profit').catch(() => null),
      freqtrade.api('GET', '/whitelist').catch(() => ({ whitelist: [] })),
    ]);
    res.json({
      success: true,
      config: {
        strategy: cfg.strategy, state: cfg.state, dry_run: cfg.dry_run, timeframe: cfg.timeframe, exchange: cfg.exchange,
        stake_currency: cfg.stake_currency, stake_amount: cfg.stake_amount, max_open_trades: cfg.max_open_trades,
        stoploss: cfg.stoploss, minimal_roi: cfg.minimal_roi, trailing_stop: cfg.trailing_stop, trading_mode: cfg.trading_mode,
        bot_name: cfg.bot_name, version: cfg.version,
      },
      whitelist: whitelist.whitelist || [],
      openTrades: (status || []).map((t) => ({
        id: t.trade_id, pair: t.pair, open_rate: t.open_rate, current_rate: t.current_rate, stake_amount: t.stake_amount,
        profit_abs: t.profit_abs, profit_pct: t.profit_pct, open_date: t.open_date,
        amount: t.amount, is_short: !!t.is_short, leverage: t.leverage,
        stop_loss_abs: t.stop_loss_abs, liquidation_price: t.liquidation_price,
      })),
      profit,
    });
  });

  // Service control is left to the system dashboard; this route only reports status.
  router.post('/api/trading/services/:id/:action', requireControl, validate({ params: schemas.serviceParams }), async (req, res) => {
    const { id, action } = req.valid.params;
    if (!STATUS_SERVICES.includes(id)) throw forbidden('Unauthorized service control.');
    if (action !== 'status') throw badRequest('Only "status" is supported here; use the System view to start or stop services.');
    const state = await new Promise((resolve) => {
      execFile('systemctl', ['is-active', id], { timeout: 5000 }, (error, stdout) => resolve(String(stdout || '').trim() || 'unknown'));
    });
    res.json({ success: true, service: id, state });
  });

  return router;
};
