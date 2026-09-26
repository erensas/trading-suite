// Trading suite entry point: builds the services (src/context.js) and the Express app
// (src/app.js), starts the background jobs and handles shutdown.
const { createContext } = require('./src/context');
const { createApp } = require('./src/app');
const { startHaltGuard } = require('./src/jobs/halt-guard');

const ctx = createContext();
const { config, log, db } = ctx;
const app = createApp(ctx);
let server = null;
let haltGuard = null;

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
  if (config.jobs) {
    ctx.tickerRefresh.schedule(3000);
    haltGuard = startHaltGuard(ctx);
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
