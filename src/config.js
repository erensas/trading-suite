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
    // EVM wallets created or imported in the Portfolio tab: <id>.env (0600) per wallet.
    walletCredentialsDir: env.WALLET_CREDENTIALS_DIR || path.join(home, '.openclaw', 'credentials', 'wallets'),
    // Portfolio valuation (all accounts, and a snapshot of the totals) by the background job.
    portfolioRefreshMinutes: int(env.PORTFOLIO_REFRESH_MINUTES, 60),
    // Strategy center: managed Freqtrade bots, the strategy library, backtests.
    bots: {
      dir: env.BOTS_DIR || path.join(home, '.openclaw', 'bots'),
      credentialsDir: env.BOT_CREDENTIALS_DIR || path.join(home, '.openclaw', 'credentials', 'bots'),
      venueCredentialsDir: env.VENUE_CREDENTIALS_DIR || path.join(home, '.openclaw', 'credentials', 'venues'),
      freqtradeBin: env.FREQTRADE_BIN || '/home/openclaw/.openclaw/worktrees/d89946a92f485818/freqtrade/.venv/bin/freqtrade',
      python: env.FREQTRADE_PYTHON || '/home/openclaw/.openclaw/worktrees/d89946a92f485818/freqtrade/.venv/bin/python3',
      mainStrategiesDir: env.MAIN_STRATEGIES_DIR || '/home/openclaw/.openclaw/workspace/freqtrade/user_data/strategies',
      runtimeDir: env.XDG_RUNTIME_DIR || `/run/user/${typeof process.getuid === 'function' ? process.getuid() : 1000}`,
      // Runs queued backtests (default: where the background jobs run).
      worker: env.BACKTEST_WORKER ? env.BACKTEST_WORKER !== '0' : env.SUITE_JOBS !== '0',
      maxManaged: int(env.MAX_MANAGED_BOTS, 3),
      portBase: int(env.BOT_PORT_BASE, 8090),
      minFreeMemoryMb: int(env.BOT_MIN_FREE_MB, 450),
      botMemoryMax: env.BOT_MEMORY_MAX || '450M',
      backtestMemoryMax: env.BACKTEST_MEMORY_MAX || '900M',
      // Before a bot may trade live (phase E).
      liveMinDryRunDays: int(env.LIVE_MIN_DRY_RUN_DAYS, 7),
      liveMinBacktestTrades: int(env.LIVE_MIN_BACKTEST_TRADES, 10),
      liveMinDryRunTrades: int(env.LIVE_MIN_DRY_RUN_TRADES, 5),
    },
  };
}

module.exports = { loadConfig };
