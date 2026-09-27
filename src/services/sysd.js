// The openclaw user's systemd manager (systemctl --user), which runs the managed bots
// (freqtrade-bot@<name>) and every backtest and strategy check as a transient unit with its
// own limits. No root and no sudo: trading-suite runs as the same user.
const { execFile } = require('child_process');

function createSysd({ config, log, execFileImpl = execFile }) {
  const runtimeDir = config.bots.runtimeDir;
  const env = { ...process.env, XDG_RUNTIME_DIR: runtimeDir, DBUS_SESSION_BUS_ADDRESS: `unix:path=${runtimeDir}/bus` };

  function exec(cmd, args, { timeoutMs = 20000, maxBuffer = 4 * 1024 * 1024 } = {}) {
    return new Promise((resolve) => {
      execFileImpl(cmd, args, { env, timeout: timeoutMs, maxBuffer }, (error, stdout, stderr) => {
        resolve({ code: error ? (typeof error.code === 'number' ? error.code : 1) : 0, stdout: String(stdout || ''), stderr: String(stderr || ''), killed: !!(error && error.killed) });
      });
    });
  }

  const systemctl = (...args) => exec('systemctl', ['--user', ...args]);
  // Freqtrade needs up to a minute to shut down (TimeoutStopSec=60 in the unit).
  const ACTION_TIMEOUT_MS = 90000;

  // Runs argv to completion in a transient unit; stdout and stderr come back.
  async function run({ unit, cwd, argv, memoryMax = '900M', runtimeMaxSec = 1800, setenv = {} }) {
    const args = ['--user', '--wait', '--pipe', '--quiet', '--collect', `--unit=${unit}`, `--working-directory=${cwd}`,
      '-p', `MemoryMax=${memoryMax}`, '-p', 'NoNewPrivileges=yes', '-p', `RuntimeMaxSec=${runtimeMaxSec}`, '-p', 'Nice=10'];
    for (const [k, v] of Object.entries(setenv)) args.push(`--setenv=${k}=${v}`);
    args.push('--', ...argv);
    const out = await exec('systemd-run', args, { timeoutMs: (runtimeMaxSec + 60) * 1000, maxBuffer: 32 * 1024 * 1024 });
    log.debug({ unit, code: out.code }, 'transient unit finished');
    return out;
  }

  async function unitState(unit) {
    const r = await systemctl('show', '--no-pager', '--timestamp=unix', '-p', 'ActiveState,SubState,UnitFileState,ActiveEnterTimestamp,NRestarts,MemoryCurrent', unit);
    const kv = Object.fromEntries(r.stdout.trim().split('\n').filter(Boolean).map((l) => [l.slice(0, l.indexOf('=')), l.slice(l.indexOf('=') + 1)]));
    const ts = Number(String(kv.ActiveEnterTimestamp || '').replace('@', ''));
    const mem = Number(kv.MemoryCurrent);
    return {
      active: kv.ActiveState === 'active',
      state: kv.ActiveState || 'unknown',
      subState: kv.SubState || '',
      enabled: kv.UnitFileState || '',
      since: ts > 0 ? new Date(ts * 1000).toISOString() : null,
      restarts: Number(kv.NRestarts) || 0,
      memoryMb: Number.isFinite(mem) && mem < 1e15 ? Math.round(mem / 1048576) : null,
    };
  }

  // Recent journal lines of a user unit (managed bots, backtests) or a system unit.
  async function journal(unit, { lines = 200, system = false } = {}) {
    const r = await exec('journalctl', [system ? `--unit=${unit}` : `--user-unit=${unit}`, '-n', String(lines), '--no-pager', '--quiet', '-o', 'short-iso', '--no-hostname'], { maxBuffer: 8 * 1024 * 1024 });
    return r.stdout.split('\n').filter(Boolean);
  }

  const action = async (verb, unit) => {
    const r = await exec('systemctl', ['--user', verb, unit], { timeoutMs: ACTION_TIMEOUT_MS });
    if (r.code !== 0) throw new Error(`systemctl --user ${verb} ${unit}: ${(r.stderr || r.stdout).trim().slice(0, 300) || `exit ${r.code}`}`);
  };

  return {
    run,
    unitState,
    journal,
    start: (u) => action('start', u),
    stop: (u) => action('stop', u),
    restart: (u) => action('restart', u),
    enable: (u) => action('enable', u),
    disable: (u) => action('disable', u),
    resetFailed: (u) => action('reset-failed', u),
    exec,
  };
}

// MemAvailable from /proc/meminfo, in MB (null where there is none).
function availableMemoryMb(readFile = require('fs').readFileSync) {
  try {
    const m = readFile('/proc/meminfo', 'utf8').match(/^MemAvailable:\s+(\d+) kB/m);
    return m ? Math.round(Number(m[1]) / 1024) : null;
  } catch (e) {
    return null;
  }
}

module.exports = { createSysd, availableMemoryMb };
