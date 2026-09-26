// Runtime configuration from the environment (systemd unit, or the shell for a local run).
const os = require('os');
const path = require('path');

const int = (value, fallback) => {
  const n = parseInt(value, 10);
  return Number.isFinite(n) ? n : fallback;
};

function loadConfig(env = process.env) {
  const home = env.HOME || os.homedir();
  return {
    port: int(env.PORT, 18795),
    host: env.HOST || '127.0.0.1',
    logLevel: env.LOG_LEVEL || 'info',
    db: {
      connectionString: env.DATABASE_URL || undefined,
      database: env.PG_MAIN_DB || 'trade_db',
      user: env.DB_USER || env.PGUSER || 'openclaw',
      host: env.DB_HOST || env.PGHOST || '/var/run/postgresql',
      password: env.DB_PASSWORD || env.PGPASSWORD || '',
      port: int(env.DB_PORT || env.PGPORT, 5432),
      max: int(env.PG_POOL_MAX, 10),
      statementTimeoutMs: int(env.PG_STATEMENT_TIMEOUT_MS, 10000),
    },
    freqtrade: {
      url: env.FREQTRADE_API_URL || 'http://127.0.0.1:8080',
      user: env.FREQTRADE_USER,
      pass: env.FREQTRADE_PASS,
      credentialsFile: path.join(home, '.openclaw', 'credentials', 'freqtrade.env'),
    },
    systemDashboardHealth: env.SYSTEM_DASHBOARD_HEALTH || 'http://127.0.0.1:18791/health',
    supervisorLogPath:
      env.SUPERVISOR_LOG_PATH || '/home/openclaw/.openclaw/worktrees/web3-dex-bot/web3-dex-bot/supervisor/supervisor.log',
    jobs: env.SUITE_JOBS !== '0',
  };
}

module.exports = { loadConfig };
