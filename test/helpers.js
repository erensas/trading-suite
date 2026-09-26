// Test helpers: a fake pg pool, a fake Freqtrade client, and an app on a random port.
const { createContext } = require('../src/context');
const { createApp } = require('../src/app');
const { loadConfig } = require('../src/config');
const { createLogger } = require('../src/logger');

// handlers: [[/regex on the SQL/, (params, sql) => rows | { rows } | throws]]. Every query
// is recorded in db.calls. An unmatched query throws, so a test sees what it did not expect.
function fakeDb(handlers = []) {
  const calls = [];
  const query = async (sql, params = []) => {
    calls.push({ sql, params });
    for (const [re, fn] of handlers) {
      if (re.test(sql)) {
        const out = await fn(params, sql);
        return Array.isArray(out) ? { rows: out, rowCount: out.length } : out || { rows: [], rowCount: 0 };
      }
    }
    throw new Error(`fakeDb: unexpected query: ${sql.replace(/\s+/g, ' ').trim().slice(0, 120)}`);
  };
  return {
    calls,
    query,
    connect: async () => ({ query, release() {} }),
    end: async () => {},
    totalCount: 0,
    idleCount: 0,
    waitingCount: 0,
  };
}

const pgError = (code, message = `pg error ${code}`) => Object.assign(new Error(message), { code });

function fakeFreqtrade(routes = {}) {
  const calls = [];
  return {
    calls,
    api: async (method, apiPath) => {
      calls.push(`${method} ${apiPath}`);
      const handler = routes[`${method} ${apiPath}`];
      if (!handler) throw Object.assign(new Error(`Freqtrade API unreachable: fake has no ${method} ${apiPath}`), { transient: true });
      return typeof handler === 'function' ? handler() : handler;
    },
  };
}

async function startApp(overrides = {}) {
  const env = { LOG_LEVEL: 'silent', SUITE_JOBS: '0', ...(overrides.env || {}) };
  delete overrides.env;
  const ctx = createContext({
    config: loadConfig(env),
    log: createLogger('silent'),
    db: fakeDb(),
    freqtrade: fakeFreqtrade(),
    identity: { resolveActor: async () => 'tester@example (test-node, 100.64.0.1)', actorLabel: (req) => `trading-suite UI: ${req.actor || 'unknown'}` },
    ...overrides,
  });
  const app = createApp(ctx);
  const server = await new Promise((resolve) => {
    const s = app.listen(0, '127.0.0.1', () => resolve(s));
  });
  const url = `http://127.0.0.1:${server.address().port}`;
  const request = async (method, path, { body, headers = {}, control = false } = {}) => {
    const h = { ...headers };
    if (body !== undefined) h['Content-Type'] = 'application/json';
    if (control) h['X-Trading-Control'] = '1';
    const res = await fetch(url + path, { method, headers: h, body: body === undefined ? undefined : typeof body === 'string' ? body : JSON.stringify(body) });
    const text = await res.text();
    let json = null;
    try {
      json = JSON.parse(text);
    } catch (e) {}
    return { status: res.status, headers: res.headers, json, text };
  };
  return {
    ctx,
    url,
    request,
    close: () => {
      ctx.tickerRefresh.stop();
      return new Promise((resolve) => server.close(resolve));
    },
  };
}

module.exports = { fakeDb, fakeFreqtrade, pgError, startApp };
