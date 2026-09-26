# Trading Suite

Web dashboard for the OpenClaw trading engines (Freqtrade, Web3 DEX bot): market charts per instrument, trade markers, engine status, kill switch, and the settings behind them. Node.js 22+ with Express 5 and PostgreSQL (`trade_db`), vanilla JS front end with TradingView Lightweight Charts.

Served by `trading-suite.service` on `127.0.0.1:18795`, published by Caddy on the tailnet at `/trading-suite/`.

## Views

- **Markets**: pair list, chart and side panel in one view. A searchable pair picker sits above the chart (press `/`), and the list can be hidden. The chart shows candles and volume from the instrument's data provider, SMA/EMA overlays, and Freqtrade, Web3 and test-order markers. The side panel holds the order book (where the provider has one), a simulated test order, the economist signal, news and a risk calculator.
- **Screener**: every active instrument with price, 24 h change and volume, provider and economist score. Click a row to chart it.
- **Freqtrade**: live bot configuration, performance, whitelist and open trades from the Freqtrade API, plus trade history from `trade_db`.
- **Web3 DEX** and **Logs**: Web3 executions and the live Web3 supervisor log. CEX trading is the Freqtrade view.
- **Settings**:
  - General and risk settings, stored in `suite_settings`.
  - Data providers: add, edit, test or disable a provider.
  - Instruments: add a pair, pick its provider and provider symbol, and activate or deactivate it.
  - Integrations: status of the database, Freqtrade API, Web3 heartbeat, system dashboard, providers and the price refresh.

### Links and keyboard

- The address bar holds the view: `#markets/<pair>/<timeframe>` (pair URL-encoded, e.g. `#markets/BTC%2FUSDT/1h`), `#screener`, `#freqtrade`, `#dex`, `#settings/<general|providers|instruments|integrations>`, `#logs`; the shell adds `#system` and `#frequi`. Back and Forward move between views and pairs.
- `/` opens the pair picker; arrow keys, Home and End move between tabs; modals keep focus inside and return it on close.
- Every panel shows how old its data is; the label turns amber when an update failed or the data is older than expected, and failed panels have a Retry button.
- Prices below 0.001 use subscript zeros (`0.0₅436` = 0.00000436); changes carry ▲ / ▼ as well as colour.
- The chart legend shows OHLCV for the bar under the cursor. With "Trades" on, open Freqtrade trades on the pair are drawn as entry, stop-loss and liquidation lines.

## Data providers

Instruments are routed to a row in `market_providers`; the row's `kind` picks an adapter in `lib/providers.js`:

| Kind | Candles | Ticker | Order book | Instrument symbol |
|---|---|---|---|---|
| `binance` | yes | yes | yes | `BTCUSDT` (also any Binance-compatible API via `base_url`) |
| `binance_futures` | yes | yes | yes | `BTCUSDT` |
| `okx` | yes | yes | yes | `BTC-USDT`, or `-SWAP` with `instType: SWAP` |
| `bybit` | yes | yes | yes | `BTCUSDT`, `category` spot / linear / inverse |
| `geckoterminal` | yes | yes | no | pool found from the contract address, or pinned as `network:pool_address` |
| `yahoo` | yes | yes | no | `SPY`, `AAPL`, `^GSPC` |
| `freqtrade` | yes (whitelisted pairs) | no | no | `BTC/USDT` |
| `rest_template` | yes | optional | no | configured by URL template |

`rest_template` adds a provider without code: a URL template with `{symbol} {base} {quote} {contract} {network} {interval} {limit}`, a path to the candle array and a field mapping. Example (Gate.io):

```json
{
  "candles_url": "/api/v4/spot/candlesticks?currency_pair={symbol}&interval={interval}&limit={limit}",
  "rows_path": "",
  "fields": { "time": 0, "open": 5, "high": 3, "low": 4, "close": 2, "volume": 6 },
  "time_unit": "s",
  "symbol_format": "{base}_{quote}"
}
```

Provider base URLs must be public `https` hosts, and template URLs must stay on the base URL. API keys are never stored in the database: `credential_env` names a variable whose value lives in `~/.openclaw/credentials/market-providers.env`, and a template can use it as `{credential}` in `headers`.

A background job refreshes `last_price`, `change_24h_pct` and `volume_24h_usd` of active instruments on the configured interval (GeckoTerminal at most every 5 minutes, one call every 6.5 s, and a one-minute pause after a 429). When a provider fails, the chart keeps the last good candles and marks them stale.

Every provider call goes through `lib/resilience.js`:

- **Request budget** per provider: 300/min for Binance, OKX and Bybit, 60/min for Yahoo and REST templates (override with `rate_limit_per_min` in the provider's config). A call waits up to 5 s for its turn, then gets a 429. GeckoTerminal keeps its own spacing; Freqtrade is local and has none.
- **Circuit breaker** per provider: after 5 failures in a row (network error, timeout, HTTP 5xx or 429) the provider is paused for 30 s, then one trial call decides; each failed trial doubles the pause, up to 5 minutes. An unknown symbol or other 4xx does not count. Settings → Integrations shows a paused provider and when it is retried.

## Security

- Every state-changing call except the simulated test order needs the `X-Trading-Control: 1` header and a same-origin `Origin`. This covers the kill switch, settings, providers and instruments.
- The service connects to PostgreSQL over the Unix socket with peer authentication, so it needs no DB password.
- Front-end libraries (Font Awesome, Lightweight Charts, Inter and JetBrains Mono) are npm dependencies served from `node_modules` under `/vendor`; the page loads nothing from other hosts, and the Content-Security-Policy allows only `'self'` for scripts, styles and fonts.
- Changes to settings, providers and instruments are written to `suite_audit_log` with the caller's Tailscale login and device.
- Freqtrade API credentials come from `~/.openclaw/credentials/freqtrade.env`.

## Database

Migrations live in `db/migrations/NNN_name.sql` and are applied by `db/migrate.js`, which records them in `schema_migrations` (version, file, checksum, when, by whom):

```bash
npm run migrate:status          # node db/migrate.js status
node db/migrate.js check        # exit 3 when something is pending
npm run migrate                 # node db/migrate.js up
node db/migrate.js baseline 004 # record 001..004 as applied without running them
```

Each file runs in one transaction with its `schema_migrations` row, and an advisory lock keeps two runners apart. Files may keep their own `BEGIN;` / `COMMIT;` lines (the runner drops them). A file that changes after it was applied is reported by `status`, never re-run; write a new migration instead. `deploy.sh` applies pending migrations after a `pg_dump` of `trade_db`; a code rollback does not undo them, so keep migrations additive.

- `001_trading_control.sql`: kill switch state, audit log, engine heartbeat.
- `002_mark_synthetic_trade_logs.sql`: flags synthetic Web3 rows.
- `003_market_providers.sql`: `market_providers`, provider columns on `instrument_registry`, `suite_settings`, default providers and routing.
- `004_suite_audit_log.sql`: audit log of UI changes.

The pool opens at most 10 connections (`PG_POOL_MAX`), waits 5 s for one, and every statement has a server-side `statement_timeout` of 10 s (`PG_STATEMENT_TIMEOUT_MS`).

## Code layout

```
server.js                 entry point: context, app, jobs, graceful shutdown
src/config.js             environment -> config
src/context.js            builds the services (tests replace any of them)
src/app.js                Express app: middleware, static files, routes, error handler
src/http/                 security headers, request ids and logging, validation, control guard, errors
src/schemas.js            zod schemas for every request body and query
src/routes/               one file per area (health, settings, providers, market, reports, integrations, control)
src/services/             database and upstream access (providers, instruments, market data, reports, control, Freqtrade, identity, audit)
src/jobs/                 ticker refresh, halt guard
lib/providers.js          provider adapters
lib/resilience.js         rate limit and circuit breaker
db/migrate.js             migration runner
public/                   front end
test/                     node:test suites (unit, http, db)
```

Responses keep one shape: `{ "success": true, ... }`, or `{ "success": false, "error": "...", "code": "bad_request", "requestId": "..." }` with a 4xx/5xx status (`details` lists every validation issue). Every response carries `X-Request-Id`; send your own to follow a call through the logs.

## Logs

JSON lines on stdout (pino), collected by journald. Successful reads are logged at debug level; writes, 4xx/5xx and requests slower than 2 s at info or above, with the request id and, for control calls, the caller. `LOG_LEVEL` sets the level (default `info`).

```bash
journalctl -u trading-suite -o cat | jq -c 'select(.level >= 40)'          # warnings and errors
journalctl -u trading-suite -o cat | jq -c 'select(.reqId == "<id>")'      # one request
```

## Tests

```bash
npm test                                                                    # unit and HTTP tests (no database needed)
TEST_DATABASE_URL=postgres://suite:suite@localhost/trade_db_test npm test   # plus migrations and the API on PostgreSQL
```

The database tests drop and recreate the `public` schema, so they refuse a database whose name does not contain `test`; they load `test/fixtures/external-tables.sql` (the tables other components own) and then the migrations. GitHub Actions runs everything on each push with PostgreSQL 16, plus `npm audit`; Dependabot proposes dependency updates weekly.

## Run and deploy

```bash
npm ci
PORT=18796 SUITE_JOBS=0 node server.js   # local run; SUITE_JOBS=0 skips the ticker refresh and halt guard
```

On the VPS, deploy with `scripts/deploy.sh trading-suite` from the `openclaw-workspace` repo: backup, pull, `npm ci` when the lockfile changed, `npm test`, pending migrations (after a `pg_dump`), restart, health checks, and automatic rollback of code and dependencies.
