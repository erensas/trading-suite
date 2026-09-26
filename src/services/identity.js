// Who is calling: Caddy passes the tailnet client address in X-Forwarded-For (it overwrites
// any value the client sent), and `tailscale whois` maps it to the Tailscale login and
// device. Cached for 5 minutes.
const { execFile } = require('child_process');

const TAILNET_IP = /^100\.(6[4-9]|[7-9]\d|1[01]\d|12[0-7])\.\d{1,3}\.\d{1,3}$/;
const CACHE_MS = 5 * 60 * 1000;

function clientIp(req) {
  return String(req.get('X-Forwarded-For') || req.ip || '').split(',')[0].trim().replace(/^::ffff:/, '');
}

function createIdentity({ execFileImpl = execFile } = {}) {
  const cache = new Map();

  function whois(ip) {
    const hit = cache.get(ip);
    if (hit && Date.now() - hit.at < CACHE_MS) return Promise.resolve(hit.who);
    return new Promise((resolve) => {
      execFileImpl('tailscale', ['whois', '--json', ip], { timeout: 3000 }, (error, stdout) => {
        let who = null;
        if (!error) {
          try {
            const d = JSON.parse(stdout);
            const login = d.UserProfile && d.UserProfile.LoginName;
            const node = d.Node && (d.Node.ComputedName || String(d.Node.Name || '').split('.')[0]);
            if (login) who = node ? `${login} (${node}, ${ip})` : `${login} (${ip})`;
          } catch (e) {}
        }
        cache.set(ip, { at: Date.now(), who });
        resolve(who);
      });
    });
  }

  async function resolveActor(req) {
    const ip = clientIp(req);
    const who = TAILNET_IP.test(ip) ? await whois(ip) : null;
    return who || `unknown (${ip || 'no address'})`;
  }

  // The string stored in changed_by / updated_by / actor columns.
  const actorLabel = (req) => `trading-suite UI: ${req.actor || `unknown (${clientIp(req)})`}`;

  return { resolveActor, actorLabel };
}

module.exports = { createIdentity, clientIp, TAILNET_IP };
