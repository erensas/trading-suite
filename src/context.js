// Builds the services from the config. Tests pass `overrides` (a fake db, a fake Freqtrade
// client, ...) to replace any of them.
const { loadConfig } = require('./config');
const { createLogger } = require('./logger');
const { createPool } = require('./db');
const { ProviderGuard } = require('../lib/resilience');
const { createFreqtradeClient } = require('./services/freqtrade');
const { createIdentity } = require('./services/identity');
const { createAudit } = require('./services/audit');
const { createSettings } = require('./services/settings');
const { createProviders } = require('./services/providers');
const { createInstruments } = require('./services/instruments');
const { createWatchlists } = require('./services/watchlists');
const { createSearch } = require('./services/search');
const { createAlerts } = require('./services/alerts');
const { createMarketData } = require('./services/market-data');
const { createControl } = require('./services/control');
const { createReports } = require('./services/reports');
const { createSysd } = require('./services/sysd');
const { createStrategies } = require('./services/strategies');
const { createBacktests } = require('./services/backtests');
const { createBots } = require('./services/bots');
const { createTickerRefresh } = require('./jobs/ticker-refresh');
const { requireControl } = require('./http/middleware');

function createContext(overrides = {}) {
  const ctx = { shuttingDown: false, logStreams: new Set() };
  const make = (name, factory) => {
    ctx[name] = overrides[name] !== undefined ? overrides[name] : factory();
  };
  make('config', () => loadConfig());
  make('log', () => createLogger(ctx.config.logLevel));
  make('db', () => createPool(ctx.config.db, ctx.log));
  make('freqtrade', () => createFreqtradeClient(ctx.config.freqtrade));
  // Clients for the managed bots' APIs.
  make('freqtradeFactory', () => createFreqtradeClient);
  make('guard', () => new ProviderGuard());
  make('identity', () => createIdentity());
  make('audit', () => createAudit(ctx));
  make('settings', () => createSettings(ctx));
  make('instruments', () => createInstruments(ctx));
  make('providers', () =>
    createProviders({
      db: ctx.db,
      guard: ctx.guard,
      freqtradeUrl: ctx.config.freqtrade.url,
      // Passed to adapters: the Freqtrade client, and GeckoTerminal's pool pinning.
      ctx: {
        freqtradeApi: (...args) => ctx.freqtrade.api(...args),
        pinPool: (symbol, providerSymbol) =>
          ctx.instruments.pinPool(symbol, providerSymbol).catch((e) => ctx.log.warn({ symbol, error: e.message }, 'pinning the GeckoTerminal pool failed')),
      },
    })
  );
  make('marketData', () => createMarketData(ctx));
  make('watchlists', () => createWatchlists(ctx));
  make('search', () => createSearch(ctx));
  make('alerts', () => createAlerts(ctx));
  make('control', () => createControl(ctx));
  // Strategy center: the user's systemd manager, the strategy library, backtests, bots.
  make('sysd', () => createSysd(ctx));
  make('strategies', () => createStrategies(ctx));
  make('backtests', () => createBacktests(ctx));
  make('bots', () => createBots(ctx));
  make('reports', () => createReports(ctx));
  make('tickerRefresh', () => createTickerRefresh(ctx));
  // Price alerts are checked against the prices each refresh has just written.
  ctx.tickerRefresh.afterRun(() => ctx.alerts.evaluatePrices().catch((e) => ctx.log.warn({ error: e.message }, 'price alert check failed')));
  make('requireControl', () => requireControl(ctx.identity));

  // Side effects of a settings change: the web3 scanner reads its profit guard from
  // economist_signals, and the ticker interval may have changed.
  ctx.settings.onChange(async (values) => {
    await ctx.db
      .query('UPDATE economist_signals SET min_profit_threshold = $1, updated_at = CURRENT_TIMESTAMP', [values.profitGuardThresholdUsd])
      .catch((e) => ctx.log.error({ error: e.message }, 'economist_signals update failed'));
    ctx.tickerRefresh.schedule();
  });
  return ctx;
}

module.exports = { createContext };
