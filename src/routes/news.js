// News (RSS / Atom feeds tagged with assets) and rule-based insights per instrument.
const express = require('express');
const { z } = require('zod');
const { validate } = require('../http/middleware');
const { asUpstream } = require('../http/errors');
const { TIMEFRAMES } = require('../../lib/providers');
const Insights = require('../../public/insights');
const schemas = require('../schemas');

module.exports = function newsRoutes({ news, marketData, settings, audit, requireControl, log }) {
  const router = express.Router();
  const byId = validate({ params: schemas.idParam });
  const listQuery = z.object({
    symbol: z.string().trim().min(1).max(60).optional(),
    limit: z.coerce.number().int().min(1).max(100).default(20),
    feed: z.coerce.number().int().positive().optional(),
  });

  router.get('/api/news', validate({ query: listQuery }), async (req, res) => {
    const q = req.valid.query;
    res.json({ success: true, ...(await news.list({ symbol: q.symbol, limit: q.limit, feedId: q.feed })) });
  });

  router.get('/api/news/summary', validate({ query: z.object({ symbol: z.string().trim().min(1).max(60) }) }), async (req, res) => {
    res.json({ success: true, summary: await news.summary(req.valid.query.symbol) });
  });

  router.get('/api/news/feeds', async (req, res) => {
    res.json({ success: true, feeds: await news.feeds(), job: news.status() });
  });

  router.post('/api/news/feeds', requireControl, validate({ body: schemas.patch }), async (req, res) => {
    const f = await news.createFeed(req.valid.body);
    await audit(req, 'create', 'news feed', f.id, null, { name: f.name, url: f.url });
    res.json({ success: true, feed: f });
  });

  router.put('/api/news/feeds/:id', requireControl, byId, validate({ body: schemas.patch }), async (req, res) => {
    const { before, after } = await news.updateFeed(req.valid.params.id, req.valid.body);
    await audit(req, 'update', 'news feed', after.id, { name: before.name, url: before.url, enabled: before.enabled }, { name: after.name, url: after.url, enabled: after.enabled });
    res.json({ success: true, feed: after });
  });

  router.delete('/api/news/feeds/:id', requireControl, byId, async (req, res) => {
    const f = await news.removeFeed(req.valid.params.id);
    await audit(req, 'delete', 'news feed', f.id, { name: f.name, url: f.url }, null);
    res.json({ success: true });
  });

  // One feed: waits for the result. All feeds: runs in the background.
  router.post('/api/news/refresh', requireControl, validate({ body: z.object({ feedId: z.coerce.number().int().positive().optional() }) }), async (req, res) => {
    const { feedId } = req.valid.body;
    if (feedId) return res.json({ success: true, ...(await news.refresh({ feedId })) });
    news.refresh().catch((e) => log.warn({ error: e.message }, 'news refresh failed'));
    res.json({ success: true, started: true });
  });

  router.get('/api/insights', validate({ query: z.object({ symbol: z.string().trim().min(1).max(60), tf: z.enum(TIMEFRAMES).optional() }) }), async (req, res) => {
    const { symbol } = req.valid.query;
    const tf = req.valid.query.tf || settings.values.defaultTimeframe || '1h';
    const data = await marketData.candles({ symbol, tf, limit: 300 }).catch(asUpstream);
    const [analysis, summary] = await Promise.all([Insights.analyze(data.candles, { timeframe: tf }), news.summary(symbol).catch(() => null)]);
    res.json({ success: true, symbol, timeframe: tf, source: data.source, ...analysis, news: summary });
  });

  return router;
};
