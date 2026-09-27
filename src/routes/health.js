// Liveness, readiness and metrics.
const express = require('express');

module.exports = function healthRoutes(ctx) {
  const { db, freqtrade, settings, tickerRefresh } = ctx;
  const router = express.Router();

  // Script errors from browsers (public/boot.js), into the service log. At most 60 a minute.
  let clientLogs = { minute: 0, count: 0 };
  router.post('/api/client-log', (req, res) => {
    const minute = Math.floor(Date.now() / 60000);
    if (clientLogs.minute !== minute) clientLogs = { minute, count: 0 };
    if (++clientLogs.count <= 60) {
      const b = req.body && typeof req.body === 'object' ? req.body : {};
      req.log.warn({ client: { kind: String(b.kind || '').slice(0, 30), detail: JSON.stringify(b.detail || null).slice(0, 1500), url: String(b.url || '').slice(0, 200), ua: String(b.ua || '').slice(0, 300), secure: !!b.secure } }, 'browser report');
    }
    res.status(204).end();
  });

  router.get(['/health', '/api/health'], (req, res) => {
    res.json({ status: 'ok', service: 'trading-suite', timestamp: new Date().toISOString() });
  });

  // Readiness: the database must answer; Freqtrade is reported but optional, since the
  // suite still serves charts and settings while the bot is stopped. deploy.sh checks this.
  router.get(['/ready', '/api/ready'], async (req, res) => {
    const checks = {};
    let ready = true;
    try {
      await db.query('SELECT 1');
      checks.database = 'ok';
    } catch (e) {
      checks.database = e.message;
      ready = false;
    }
    try {
      await freqtrade.api('GET', '/ping');
      checks.freqtrade = 'ok';
    } catch (e) {
      checks.freqtrade = `unavailable: ${e.message}`;
    }
    if (ctx.shuttingDown) {
      checks.shutdown = 'in progress';
      ready = false;
    }
    res.status(ready ? 200 : 503).json({ status: ready ? 'ready' : 'not ready', checks });
  });

  router.get(['/metrics', '/api/metrics'], async (req, res) => {
    const mem = process.memoryUsage();
    let dbStatus = 'ok';
    let totalLogs = 0;
    try {
      const r = await db.query('SELECT count(*) FROM trade_logs');
      totalLogs = parseInt(r.rows[0].count, 10);
    } catch (e) {
      dbStatus = 'error: ' + e.message;
    }
    const uptime = Math.floor(process.uptime());

    if (req.headers.accept && req.headers.accept.includes('text/plain')) {
      const lines = [
        '# HELP trading_suite_uptime_seconds Process uptime in seconds',
        '# TYPE trading_suite_uptime_seconds counter',
        `trading_suite_uptime_seconds ${uptime}`,
        '# HELP trading_suite_memory_rss_bytes Memory RSS in bytes',
        `trading_suite_memory_rss_bytes ${mem.rss}`,
        '# HELP trading_suite_trade_logs_total Total trade logs count',
        `trading_suite_trade_logs_total ${totalLogs}`,
        '# HELP trading_suite_db_pool_connections PostgreSQL pool connections by state',
        `trading_suite_db_pool_connections{state="total"} ${db.totalCount}`,
        `trading_suite_db_pool_connections{state="idle"} ${db.idleCount}`,
        `trading_suite_db_pool_connections{state="waiting"} ${db.waitingCount}`,
      ];
      res.setHeader('Content-Type', 'text/plain; version=0.0.4');
      return res.send(lines.join('\n') + '\n');
    }
    res.json({
      status: 'ok',
      service: 'trading-suite',
      timestamp: new Date().toISOString(),
      uptime_seconds: uptime,
      memory: { rss_bytes: mem.rss, heapTotal_bytes: mem.heapTotal, heapUsed_bytes: mem.heapUsed, external_bytes: mem.external },
      database: {
        status: dbStatus,
        total_trade_logs: totalLogs,
        pool_total_count: db.totalCount,
        pool_idle_count: db.idleCount,
        pool_waiting_count: db.waitingCount,
      },
      settings: settings.values,
      ticker_refresh: tickerRefresh.state,
    });
  });

  return router;
};
