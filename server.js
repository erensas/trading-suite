// Trading suite entry point: builds the services (src/context.js) and the Express app
// (src/app.js), starts the background jobs and handles shutdown.
const { createContext } = require('./src/context');
const { createApp } = require('./src/app');
const { startHaltGuard } = require('./src/jobs/halt-guard');
const { startInterval } = require('./src/jobs/interval');

const ctx = createContext();
const { config, log, db } = ctx;
const app = createApp(ctx);
let server = null;
let haltGuard = null;
let indicatorAlerts = null;
let backtestQueue = null;
let newsJob = null;
let portfolioJob = null;

// SIGTERM (systemctl stop/restart, deploy): stop taking requests, close log streams and
// jobs, let running requests finish, close the DB pool. Forced exit after 10 s.
function shutdown(signal) {
  if (ctx.shuttingDown) return;
  ctx.shuttingDown = true;
  log.info({ signal }, 'shutting down');
  setTimeout(() => {
    log.error('shutdown timed out after 10 s; exiting');
    process.exit(1);
  }, 10000).unref();
  ctx.tickerRefresh.stop();
  if (haltGuard) haltGuard.stop();
  if (indicatorAlerts) indicatorAlerts.stop();
  if (backtestQueue) backtestQueue.stop();
  if (newsJob) newsJob.stop();
  if (portfolioJob) portfolioJob.stop();
  for (const res of ctx.logStreams) res.end();
  const closeServer = server ? new Promise((resolve) => server.close(resolve)) : Promise.resolve();
  closeServer
    .then(() => db.end())
    .then(() => {
      log.info('shutdown done');
      process.exit(0);
    })
    .catch((e) => {
      log.error({ err: e }, 'shutdown failed');
      process.exit(1);
    });
}
process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));
process.on('unhandledRejection', (err) => log.error({ err }, 'unhandled promise rejection'));

ctx.settings.load().finally(() => {
  // Library files from the database; runs cut off by the last stop are marked failed and the
  // queue continues.
  ctx.strategies.syncFiles();
  if (config.bots.worker) {
    ctx.backtests
      .recover()
      .then(() => ctx.backtests.drain())
      .catch((e) => log.warn({ error: e.message }, 'backtest queue not started'));
    // Also picks up runs queued by another suite process (a dev instance without a worker).
    backtestQueue = startInterval('backtest queue', 60 * 1000, () => ctx.backtests.recover().then(() => ctx.backtests.drain()), log);
  }
  if (config.jobs) {
    ctx.tickerRefresh.schedule(3000);
    haltGuard = startHaltGuard(ctx);
    // Indicator alerts need candles, so they are checked every 5 minutes, not on each refresh.
    indicatorAlerts = startInterval('indicator alerts', 5 * 60 * 1000, () => ctx.alerts.evaluateIndicators(), log);
    // News feeds every 15 minutes, the first time shortly after start.
    newsJob = startInterval('news', 15 * 60 * 1000, () => ctx.news.refresh(), log);
    setTimeout(() => !ctx.shuttingDown && ctx.news.refresh().catch((e) => log.warn({ error: e.message }, 'news refresh failed')), 30000).unref();
    // Portfolio: every account valued and the totals kept, hourly by default (no accounts: a no-op).
    if (config.portfolioRefreshMinutes > 0) portfolioJob = startInterval('portfolio', config.portfolioRefreshMinutes * 60 * 1000, () => ctx.portfolio.refresh(), log);
  }
  server = app.listen(config.port, config.host, (err) => {
    if (err) {
      log.fatal({ err }, 'listen failed');
      process.exit(1);
    }
    log.info({ host: config.host, port: config.port }, 'trading suite listening');
  });
  server.keepAliveTimeout = 5000;
});
