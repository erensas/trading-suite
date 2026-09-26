const crypto = require('crypto');
const { badRequest, forbidden } = require('./errors');

// Security headers. Every script, style and font is served by this app (npm packages under
// /vendor, no CDNs); inline styles stay allowed, inline scripts do not. The shell embeds the
// system dashboard (same origin) and FreqUI (same host, Caddy ports 8181 / 8443), so
// frame-src names that host.
const CSP_BASE = [
  "default-src 'self'",
  "script-src 'self'",
  "style-src 'self' 'unsafe-inline'",
  "font-src 'self' data:",
  "img-src 'self' data:",
  "connect-src 'self'",
  "object-src 'none'",
  "base-uri 'self'",
  "form-action 'self'",
  "frame-ancestors 'self'",
].join('; ');

function securityHeaders(req, res, next) {
  const host = /^[a-z0-9.-]+$/i.test(req.hostname || '') ? req.hostname : null;
  const frameSrc = host ? `frame-src 'self' http://${host}:8181 https://${host}:8443` : "frame-src 'self'";
  res.set({
    'Content-Security-Policy': `${CSP_BASE}; ${frameSrc}`,
    'X-Content-Type-Options': 'nosniff',
    'X-Frame-Options': 'SAMEORIGIN',
    'Referrer-Policy': 'same-origin',
  });
  next();
}

// Request id (taken from X-Request-Id when the caller sent a sane one) and one log line per
// API request. Successful reads are logged at debug level, because the UI polls; writes,
// failures and requests slower than 2 s at info or above.
const REQUEST_ID = /^[A-Za-z0-9._-]{1,64}$/;
const SLOW_MS = 2000;

function requestContext(log) {
  return (req, res, next) => {
    const incoming = req.get('X-Request-Id');
    req.id = incoming && REQUEST_ID.test(incoming) ? incoming : crypto.randomUUID();
    req.log = log.child({ reqId: req.id });
    res.set('X-Request-Id', req.id);
    if (!req.path.startsWith('/api/')) return next();
    const started = process.hrtime.bigint();
    res.on('finish', () => {
      const ms = Math.round(Number(process.hrtime.bigint() - started) / 1e6);
      const entry = { method: req.method, path: req.path, status: res.statusCode, ms };
      if (req.actor) entry.actor = req.actor;
      if (res.locals.error) Object.assign(entry, { code: res.locals.code, error: res.locals.error });
      if (res.statusCode >= 500) req.log.error(entry, 'request');
      else if (res.statusCode >= 400) req.log.warn(entry, 'request');
      else if (req.method !== 'GET' || ms > SLOW_MS) req.log.info(entry, 'request');
      else req.log.debug(entry, 'request');
    });
    next();
  };
}

// Validates req.params / req.query / req.body with zod schemas and puts the parsed values
// in req.valid (Express 5 makes req.query read-only, so the originals stay untouched).
function validate(schemas) {
  return (req, res, next) => {
    req.valid = req.valid || {};
    for (const part of ['params', 'query', 'body']) {
      const schema = schemas[part];
      if (!schema) continue;
      const result = schema.safeParse(req[part] === undefined ? {} : req[part]);
      if (!result.success) {
        const issues = result.error.issues.map((i) => ({ path: i.path.join('.'), message: i.message }));
        const first = issues[0];
        return next(badRequest(first.path ? `${first.path}: ${first.message}` : first.message, issues));
      }
      req.valid[part] = result.data;
    }
    next();
  };
}

// State-changing calls from the UI. A cross-site page can send neither the custom header
// nor a matching Origin (CSRF guard). The caller is identified from the tailnet address.
function requireControl(identity) {
  return async (req, res, next) => {
    if (req.get('X-Trading-Control') !== '1') return next(forbidden('Missing X-Trading-Control header'));
    const origin = req.get('Origin');
    if (origin) {
      let originHost = null;
      try {
        originHost = new URL(origin).host;
      } catch (e) {}
      if (originHost !== req.get('Host')) return next(forbidden('Cross-origin control request rejected'));
    }
    req.actor = await identity.resolveActor(req);
    req.log.info({ method: req.method, path: req.path, actor: req.actor }, 'control request');
    next();
  };
}

module.exports = { securityHeaders, requestContext, validate, requireControl, CSP_BASE };
