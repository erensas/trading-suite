// The Express app: middleware, static files, API routes, error handling.
const fs = require('fs');
const path = require('path');
const express = require('express');
const compression = require('compression');
const { securityHeaders, requestContext } = require('./http/middleware');
const { errorHandler, notFoundHandler } = require('./http/errors');

const ROOT = path.join(__dirname, '..');
const LARGE_BODIES = /^\/api\/(strategies|pine)\//;

// Front-end libraries from package.json (pinned versions), served from node_modules.
const VENDOR = {
  '/vendor/fontawesome/css': '@fortawesome/fontawesome-free/css',
  '/vendor/fontawesome/webfonts': '@fortawesome/fontawesome-free/webfonts',
  '/vendor/lightweight-charts': 'lightweight-charts/dist',
  '/vendor/codemirror/lib': 'codemirror/lib',
  '/vendor/codemirror/mode': 'codemirror/mode',
  '/vendor/codemirror/addon': 'codemirror/addon',
  '/vendor/fonts/inter': '@fontsource-variable/inter',
  '/vendor/fonts/jetbrains-mono': '@fontsource-variable/jetbrains-mono',
};

// Browsers keep /vendor files for 7 days, so every reference in index.html carries the
// package version (?v=5.2.1): after an upgrade the new file has a new URL.
const packageOf = (dir) => (dir.startsWith('@') ? dir.split('/').slice(0, 2).join('/') : dir.split('/')[0]);
function versionedIndex() {
  const html = fs.readFileSync(path.join(ROOT, 'public', 'index.html'), 'utf8');
  return html.replace(/(src|href)="(vendor\/[^"?]+)"/g, (m, attr, ref) => {
    const hit = Object.entries(VENDOR).find(([route]) => `/${ref}`.startsWith(`${route}/`));
    if (!hit) return m;
    const { version } = JSON.parse(fs.readFileSync(path.join(ROOT, 'node_modules', packageOf(hit[1]), 'package.json'), 'utf8'));
    return `${attr}="${ref}?v=${version}"`;
  });
}

function createApp(ctx) {
  const indexHtml = versionedIndex();
  const app = express();
  app.disable('x-powered-by');

  app.use(requestContext(ctx.log));
  app.use(securityHeaders);
  // gzip for pages, scripts and JSON (the log stream is sent as it comes).
  app.use(compression({ filter: (req, res) => !req.path.endsWith('/logs/stream') && compression.filter(req, res) }));
  // Strategy sources may be up to 200 KB; everything else stays small.
  const smallJson = express.json({ limit: '64kb' });
  const largeJson = express.json({ limit: '256kb' });
  app.use((req, res, next) => (LARGE_BODIES.test(req.path) ? largeJson : smallJson)(req, res, next));
  // The page itself is always checked with the server (ETag), never taken from cache as is.
  app.get(['/', '/index.html'], (req, res) => {
    res.set('Cache-Control', 'no-cache').type('html').send(indexHtml);
  });
  app.use(express.static(path.join(ROOT, 'public'), { setHeaders: (res) => res.set('Cache-Control', 'no-cache') }));
  for (const [route, dir] of Object.entries(VENDOR)) {
    app.use(route, express.static(path.join(ROOT, 'node_modules', dir), { maxAge: '7d', index: false }));
  }

  app.use(require('./routes/health')(ctx));
  app.use(require('./routes/settings')(ctx));
  app.use(require('./routes/providers')(ctx));
  app.use(require('./routes/market')(ctx));
  app.use(require('./routes/instruments')(ctx));
  app.use(require('./routes/charts')(ctx));
  app.use(require('./routes/reports')(ctx));
  app.use(require('./routes/integrations')(ctx));
  app.use(require('./routes/control')(ctx));
  app.use(require('./routes/strategies')(ctx));
  app.use(require('./routes/bots')(ctx));
  app.use(require('./routes/pine')(ctx));
  app.use(require('./routes/news')(ctx));
  app.use(require('./routes/venues')(ctx));

  app.use('/api', notFoundHandler);
  app.use(errorHandler());
  return app;
}

module.exports = { createApp, VENDOR, versionedIndex };
