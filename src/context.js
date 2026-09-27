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
const { createMarketData } = require('./services/market-data');
const { createControl } = require('./services/control');
const { createReports } = require('./services/reports');
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
  make('control', () => createControl(ctx));
  make('reports', () => createReports(ctx));
  make('tickerRefresh', () => createTickerRefresh(ctx));
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
