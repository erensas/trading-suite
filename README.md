# Trading Suite

Web dashboard for the OpenClaw trading engines (Freqtrade, Web3 DEX bot): market charts per instrument, trade markers, engine status, kill switch, and the settings behind them. Node.js + Express + PostgreSQL (`trade_db`), vanilla JS front end with TradingView Lightweight Charts.

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

## Security

- Every state-changing call except the simulated test order needs the `X-Trading-Control: 1` header and a same-origin `Origin`. This covers the kill switch, settings, providers and instruments.
- The service connects to PostgreSQL over the Unix socket with peer authentication, so it needs no DB password.
- Front-end libraries (Font Awesome, Lightweight Charts, Inter and JetBrains Mono) are npm dependencies served from `node_modules` under `/vendor`; the page loads nothing from other hosts, and the Content-Security-Policy allows only `'self'` for scripts, styles and fonts.
- Changes to settings, providers and instruments are written to `suite_audit_log` with the caller's Tailscale login and device.
- Freqtrade API credentials come from `~/.openclaw/credentials/freqtrade.env`.

## Database

Apply the migrations in order with `psql -d trade_db -f db/migrations/<file>`:

- `001_trading_control.sql`: kill switch state, audit log, engine heartbeat.
- `002_mark_synthetic_trade_logs.sql`: flags synthetic Web3 rows.
- `003_market_providers.sql`: `market_providers`, provider columns on `instrument_registry`, `suite_settings`, default providers and routing.
- `004_suite_audit_log.sql`: audit log of UI changes.

## Run and deploy

```bash
npm ci
PORT=18796 node server.js   # local run
```

On the VPS, deploy with `scripts/deploy.sh trading-suite` from the `openclaw-workspace` repo (backup, pull, `node --check`, restart, health checks, automatic rollback).
