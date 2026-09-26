// Authenticated client for the Freqtrade REST API (JWT from /token/login, kept 10 minutes).
// Credentials: FREQTRADE_USER / FREQTRADE_PASS from the environment, or
// ~/.openclaw/credentials/freqtrade.env.
const fs = require('fs');
const { ProviderError } = require('../../lib/providers');

function readCredentials({ user, pass, credentialsFile }) {
  if (user && pass) return { user, pass };
  try {
    for (const line of fs.readFileSync(credentialsFile, 'utf8').split('\n')) {
      const match = line.match(/^(FREQTRADE_USER|FREQTRADE_PASS)=(.*)$/);
      if (!match) continue;
      const value = match[2].trim().replace(/^['"]|['"]$/g, '');
      if (match[1] === 'FREQTRADE_USER' && !user) user = value;
      if (match[1] === 'FREQTRADE_PASS' && !pass) pass = value;
    }
  } catch (e) {}
  return { user, pass };
}

function createFreqtradeClient(cfg, { fetchImpl = fetch } = {}) {
  let token = null;
  let tokenExpiry = 0;

  async function request(url, init) {
    let res;
    try {
      res = await fetchImpl(url, { ...init, signal: AbortSignal.timeout(5000) });
    } catch (e) {
      throw new ProviderError(`Freqtrade API unreachable: ${e.name === 'TimeoutError' ? 'timeout' : e.message}`, { transient: true, code: 'freqtrade_unreachable' });
    }
    return res;
  }

  async function login() {
    const { user, pass } = readCredentials(cfg);
    if (!user || !pass) throw new ProviderError('Freqtrade API credentials not configured', { code: 'freqtrade_not_configured' });
    const res = await request(`${cfg.url}/api/v1/token/login`, {
      method: 'POST',
      headers: { Authorization: 'Basic ' + Buffer.from(`${user}:${pass}`).toString('base64') },
    });
    if (!res.ok) throw new ProviderError(`Freqtrade login failed: HTTP ${res.status}`, { transient: res.status >= 500 });
    token = (await res.json()).access_token;
    tokenExpiry = Date.now() + 10 * 60 * 1000;
  }

  async function api(method, apiPath) {
    if (!token || Date.now() > tokenExpiry) await login();
    const res = await request(`${cfg.url}/api/v1${apiPath}`, { method, headers: { Authorization: `Bearer ${token}` } });
    if (res.status === 401) token = null;
    if (!res.ok) {
      const err = new ProviderError(`Freqtrade ${method} ${apiPath}: HTTP ${res.status}`, { transient: res.status >= 500 });
      err.upstreamStatus = res.status;
      throw err;
    }
    return res.json();
  }

  return { api };
}

module.exports = { createFreqtradeClient, readCredentials };
