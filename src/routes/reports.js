// Overview, markers, signals, news, test orders, trade tables, export and the log stream.
const express = require('express');
const fs = require('fs');
const { validate } = require('../http/middleware');
const { toCsv } = require('../services/reports');
const schemas = require('../schemas');

module.exports = function reportRoutes(ctx) {
  const { reports, settings, config, logStreams } = ctx;
  const router = express.Router();
  const withSymbol = validate({ query: schemas.symbolQuery });
  const symbolOf = (req) => req.valid.query.symbol || settings.values.defaultSymbol;

  router.get('/api/trading/overview', async (req, res) => {
    res.json({ success: true, summary: await reports.overview() });
  });

  router.get('/api/trading/chart-markers', withSymbol, async (req, res) => {
    const symbol = symbolOf(req);
    res.json({ success: true, symbol, markers: await reports.chartMarkers(symbol) });
  });

  router.get('/api/trading/economist', withSymbol, async (req, res) => {
    res.json({ success: true, signal: await reports.economist(symbolOf(req)) });
  });

  router.get('/api/trading/news', withSymbol, async (req, res) => {
    res.json({ success: true, news: await reports.news(symbolOf(req)) });
  });

  // Simulated test order from the Markets side panel (no exchange call).
  router.post('/api/trading/orders', validate({ body: schemas.order }), async (req, res) => {
    const o = req.valid.body;
    const order = await reports.recordOrder(o);
    res.json({ success: true, order, message: `Simulated ${o.side} order recorded for ${o.symbol}` });
  });

  router.get('/api/trading/dex-arbitrage', async (req, res) => {
    const trades = await reports.dexTrades();
    res.json({ success: true, count: trades.length, trades });
  });

  router.get('/api/trading/freqtrade', async (req, res) => {
    const trades = await reports.freqtradeTrades();
    res.json({ success: true, count: trades.length, trades });
  });

  router.get('/api/trading/export/trades', validate({ query: schemas.exportQuery }), async (req, res) => {
    const { format, limit } = req.valid.query;
    const rows = await reports.exportTradeLogs(limit);
    res.setHeader('Content-Disposition', `attachment; filename="trade_logs_${Date.now()}.${format}"`);
    if (format === 'csv') {
      res.setHeader('Content-Type', 'text/csv');
      return res.send(toCsv(rows));
    }
    res.json({ success: true, count: rows.length, data: rows });
  });

  // Server-sent events: new lines of the web3 supervisor log.
  router.get('/api/trading/logs/stream', (req, res) => {
    const file = config.supervisorLogPath;
    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('Connection', 'keep-alive');
    const send = (data) => res.write(`data: ${JSON.stringify(data)}\n\n`);
    logStreams.add(res);
    send({ type: 'connected', message: `Streaming ${file}` });

    let position = null;
    let first = true;
    const tick = () => {
      try {
        const { size } = fs.statSync(file);
        if (position === null || size < position) position = Math.max(0, size - 4000);
        if (size === position) return;
        const length = Math.min(size - position, 64 * 1024);
        const fd = fs.openSync(file, 'r');
        const buffer = Buffer.alloc(length);
        fs.readSync(fd, buffer, 0, length, position);
        fs.closeSync(fd);
        let text = buffer.toString('utf8');
        let skipped = 0;
        if (first && position > 0) {
          // The initial tail starts mid-file: drop the partial first line.
          const nl = text.indexOf('\n');
          if (nl < 0) return;
          skipped = Buffer.byteLength(text.slice(0, nl + 1));
          text = text.slice(nl + 1);
        }
        first = false;
        const lastNewline = text.lastIndexOf('\n');
        if (lastNewline < 0) {
          position += skipped;
          return;
        }
        position += skipped + Buffer.byteLength(text.slice(0, lastNewline + 1));
        text
          .slice(0, lastNewline)
          .split('\n')
          .filter(Boolean)
          .forEach((log) => send({ type: 'log', log }));
      } catch (e) {}
    };
    tick();
    const interval = setInterval(tick, 2000);
    req.on('close', () => {
      clearInterval(interval);
      logStreams.delete(res);
    });
  });

  return router;
};
