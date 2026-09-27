// The Express app: middleware, static files, API routes, error handling.
const path = require('path');
const express = require('express');
const { securityHeaders, requestContext } = require('./http/middleware');
const { errorHandler, notFoundHandler } = require('./http/errors');

const ROOT = path.join(__dirname, '..');

// Front-end libraries from package.json (pinned versions), served from node_modules.
const VENDOR = {
  '/vendor/fontawesome/css': '@fortawesome/fontawesome-free/css',
  '/vendor/fontawesome/webfonts': '@fortawesome/fontawesome-free/webfonts',
  '/vendor/lightweight-charts': 'lightweight-charts/dist',
  '/vendor/fonts/inter': '@fontsource-variable/inter',
  '/vendor/fonts/jetbrains-mono': '@fontsource-variable/jetbrains-mono',
};

function createApp(ctx) {
  const app = express();
  app.disable('x-powered-by');

  app.use(requestContext(ctx.log));
  app.use(securityHeaders);
  app.use(express.json({ limit: '64kb' }));
  app.use(express.static(path.join(ROOT, 'public')));
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

  app.use('/api', notFoundHandler);
  app.use(errorHandler());
  return app;
}

module.exports = { createApp, VENDOR };
