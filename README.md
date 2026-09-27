# Trading Suite

Web dashboard for the OpenClaw trading engines (Freqtrade, Web3 DEX bot): market charts per instrument, trade markers, engine status, kill switch, a strategy center (bots, strategy library, backtests, dry-run and live) and the settings behind them. Node.js 22+ with Express 5 and PostgreSQL (`trade_db`), vanilla JS front end with TradingView Lightweight Charts.

Served by `trading-suite.service` on `127.0.0.1:18795`, published by Caddy on the tailnet at `/trading-suite/`.

## Views

- **Markets**: watchlist, chart and side panel in one view. The watchlist panel switches between named lists (see below); the chart shows candles and volume from the instrument's data sources, overlays, and Freqtrade, Web3 and test-order markers. The side panel holds the order book (where a source has one), a simulated test order, the economist signal, news and a risk calculator.
- **Screener**: every active instrument with price, 24 h change and volume, provider and economist score. Click a row to chart it.
- **Portfolio**: what the accounts are worth, real and paper, with the history of the totals; accounts, assets across accounts, and EVM wallets (see [Portfolio and wallets](#portfolio-and-wallets)).
- **Strategies**: every bot with its mode (dry-run or live), state and strategy; managed Freqtrade bots; the strategy library with checks, an editor and backtests (see [Strategy center](#strategy-center)).
- **Freqtrade**: live bot configuration, performance, whitelist and open trades from the Freqtrade API, plus trade history from `trade_db`.
- **Web3 DEX** and **Logs**: the pairs the Web3 engine scans, with arbitrage and flash loans switched on or off per pair (see [Web3 pair switches](#web3-pair-switches)), Web3 executions, and the live Web3 supervisor log. CEX trading is the Freqtrade view.
- **Settings**:
  - General and risk settings, stored in `suite_settings`.
  - Data providers: add, edit, test or disable a provider.
  - Instruments: add a pair, pick its provider and provider symbol, and activate or deactivate it.
  - Integrations: status of the database, Freqtrade API, Web3 heartbeat, system dashboard, providers and the price refresh.
  - News feeds and Trading venues (see below).

### Watchlists, search and data sources

- **Watchlists**: any number of named lists (starter lists: Main, Crypto spot, Crypto futures, DEX pools, Stocks & ETFs). Each list has its own columns (price, 24 h change, volume, source, economist score, last update) and sort order (manual, symbol, price, change, volume); in manual order rows move by drag and drop or Alt+↑ / Alt+↓. Manage lists with the gear button: rename, reorder, default list, columns, sort, delete. An instrument can be on several lists; the Sources dialog shows and toggles them.
- **Search (Ctrl+K or `/`)**: one box for registered instruments, provider catalogues and commands (go to a view or settings pane). Provider search covers Binance spot and USD-M futures, OKX, Bybit and Yahoo Finance (stocks, ETFs, indices); "DEX pools" asks GeckoTerminal (a few searches a minute), as does a contract address. Results are merged by symbol, with a badge per provider that carries it (✓ already a source). **Add** registers the instrument with every offered source and puts it on the chosen list; a badge adds that source only. Futures use the ccxt form `BASE/QUOTE:SETTLE` (e.g. `BTC/USDT:USDT`), so they never mix with spot.
- **Several sources per instrument** (`instrument_listings`): the chart and prices use the first enabled source in priority order that answers, and the source note shows ⚠ when it had to fall back. The plug button next to the chart opens the Sources dialog: reorder, enable or disable, edit the provider symbol, test each source, find the same pair on other providers, add one by hand. The source menu beside it pins the chart to one source. The first source is mirrored into `instrument_registry.provider_id` for the scripts that still read it; registry rows those scripts add get their source row on the next price refresh.

- **Populating from the engines**: `tools/populate_instruments.js` registers what the trading engines are mapped to and gives every instrument its sources. The main bot's pair whitelist becomes CEX (or CEX_FUTURES) instruments with the exchange's provider and the Freqtrade Bot provider; the Web3 engine's core pools per network (`STATIC_CORE_POOLS` in web3-dex-bot, read through `tools/web3_markets.py`) become DEX instruments with one GeckoTerminal source per pool, and its token registry per network one DEX instrument per token on the most liquid WETH or stablecoin pool; every CEX, futures and TradFi instrument gets the sources of the other providers that carry it (Binance, OKX, Bybit, Yahoo); DEX rows get their network. New instruments land on the starter watchlists. A DEX row that occupies the symbol of a whitelisted exchange pair (`ETH/USDT` as a Uniswap pool) is renamed to its wrapped form (`WETH/USDT`). Run it as the service user in `/opt/trading-suite`: `node tools/populate_instruments.js --dry-run` prints the plan, without the flag it applies it (`--skip-tokens` leaves out the token registry, whose GeckoTerminal searches take about 6.5 s each; `--no-web3` the Web3 map). The run is recorded in `suite_audit_log`.

### Charts, indicators and alerts

- Charts use TradingView Lightweight Charts 5. **Indicators** (button or `I`): 21 studies in `public/indicators.js`: SMA, EMA, WMA, HMA, VWAP (daily reset), Bollinger Bands, Keltner, Donchian, Supertrend, Parabolic SAR, RSI, MACD, Stochastic, Stochastic RSI, CCI, Williams %R, ROC, ADX (+DI/−DI), ATR, OBV, MFI. They follow Pine's definitions (EMA seeded with an SMA, Wilder smoothing for RSI/ATR/ADX, population standard deviation), so values match TradingView. Overlays share the price pane; every oscillator gets its own resizable pane with its reference levels. Each indicator has its parameters, colours and a show/hide switch, and the legend shows the values under the cursor.
- **Layouts** (`chart_layouts`): the indicator set is saved on the server. The default layout applies to every chart; "Only for this symbol" keeps a separate one for the current symbol, and unticking it goes back to the default. Volume on/off is part of the layout.
- **Alerts** (bell button): price above/below, 24 h change above/below, or an indicator line above/below a level on a timeframe. Price and change alerts are checked after every price refresh, indicator alerts every 5 minutes on the last closed candle. One-off alerts switch off when they fire; repeating ones fire again after the condition was false once. Price alerts show as dotted lines on the chart. Fired alerts pop up as notifications and count on the bell until the alerts dialog is opened.

### News and insights

- **News** (`news_feeds`, `news_items`, migration 009): a job reads the enabled RSS / Atom feeds every 15 minutes (CoinDesk, Cointelegraph, Decrypt, The Block, Investing.com crypto, CNBC markets, and Yahoo Finance headlines once per active TradFi instrument), keeps 30 days, drops a headline already stored from another feed, and tags each article with the assets it names: tickers in capitals (`BTC`, `$AAPL`), common coin names (Bitcoin, Ether, Solana…) and the names of registered stocks. The side panel lists the articles for the chart's asset, or the latest general ones when none name it; the dot is a keyword tone (surge, rally… vs. plunge, hack…), not a model. Settings → News feeds adds, switches off, reads or deletes feeds (https only, no private addresses, 3 MB at most).
- **Insights** (side panel, `public/insights.js`, also `GET /api/insights?symbol=&tf=`): rules on the chart's last 300 candles name the regime (uptrend or downtrend when ADX ≥ 25 and the EMAs and directional indicators agree; squeeze when the Bollinger width is in the lowest fifth of 120 bars; range when ADX < 20; otherwise mixed) with the numbers behind it, list RSI, MACD, EMA distance, ADX, ATR, 20-bar change and volume, suggest indicators for that regime (Add puts them on the chart) and the strategy templates that fit it (Backtest copies the template into the library and opens a backtest on this pair and timeframe), and count the week's articles about the asset. It describes the recent past; it is not a forecast.

### Pine editor

The **Pine** button (or `P`) opens an editor under the chart. Scripts are stored in `pine_scripts` (migration 008, with four examples) and run in the browser on the chart's candles (`public/pine.js`), again on every refresh, symbol or timeframe change.

- **Language**: a Pine Script v5 subset: `indicator()` / `strategy()`, variables with `=`, `:=`, `+=`, `var`, tuples (`[a, b] = ...`), `if` / `else if` / `else`, `for`, single- and multi-line functions (`=>`), the ternary operator, history (`x[1]`), inputs (`input`, `input.int/float/bool/string/source`), `ta.*` (sma, ema, rma, wma, hma, stdev, rsi, macd, bb, atr, tr, highest, lowest, change, mom, roc, crossover, crossunder, cross, stoch, cci, mfi, vwap, supertrend, dmi, obv, cum, barssince, valuewhen, rising, falling), `math.*`, `nz` / `na` / `fixnan`, `color.*`, `plot` (line, histogram, circles, per-bar colours), `plotshape`, `plotchar`, `hline`. The `ta.*` functions are tested against the chart indicators (same definitions as TradingView). Errors name the line and mark it in the editor. `bgcolor`, `fill`, labels and lines are ignored with a warning.
- **Chart**: overlay scripts draw on the price pane, others get their own pane below the indicators; shapes and strategy trades are markers on the candles; the legend shows the plot values.
- **Strategy tester**: `strategy.entry`, `strategy.close`, `strategy.close_all` and `strategy.exit` (stop and limit prices) fill at the next bar's open, one position at a time (reversals close and reopen), with the script's initial capital, order size and commission. It shows net profit, win rate, profit factor, drawdown, buy and hold, the open trade and the trade list.
- **Inputs** are edited in the Inputs tab (kept per script in the browser).
- **To Freqtrade** converts a strategy into a Freqtrade strategy class: variables become dataframe columns computed with the same definitions (checked against the interpreter on real candles), inputs become hyperopt parameters, `strategy.entry` / `strategy.close` under `if` blocks become entry and exit signals (opposite entries also exit), and plots go into `plot_config`. Bar-by-bar state (`var`, `:=`, `for`) is refused with the line; `strategy.exit` is reported, since stoploss and ROI stay for the user to set. The class is saved to the strategy library (`origin` pine) and checked, ready to edit or backtest.

### Links and keyboard

- The address bar holds the view: `#markets/<pair>/<timeframe>` (pair URL-encoded, e.g. `#markets/BTC%2FUSDT/1h`), `#screener`, `#strategies/<bots|library|editor|backtests>`, `#freqtrade`, `#dex`, `#settings/<general|providers|instruments|integrations>`, `#logs`; the shell adds `#system` and `#frequi`. Back and Forward move between views and pairs.
- Ctrl+K or `/` opens search, `I` the indicators, `P` the Pine editor (Ctrl+Enter runs, Ctrl+S saves); arrow keys, Home and End move between tabs; modals keep focus inside and return it on close.
- Every panel shows how old its data is; the label turns amber when an update failed or the data is older than expected, and failed panels have a Retry button.
- Prices below 0.001 use subscript zeros (`0.0₅436` = 0.00000436); changes carry ▲ / ▼ as well as colour.
- The chart legend shows OHLCV for the bar under the cursor. With "Trades" on, open Freqtrade trades on the pair are drawn as entry, stop-loss and liquidation lines.

## Portfolio and wallets

The Portfolio tab (`#portfolio`, migration 011) values **accounts** in USD and keeps the totals over time.

- **Manual holdings**: positions entered by hand, registered instruments (stocks, ETFs, coins; Ctrl+K adds one) and cash, with an optional cost basis for P/L. An account is **real** or **paper**, so a paper portfolio can be tracked next to real money.
- **Alpaca paper**: a venue from Settings → Trading venues; equity, cash and positions from Alpaca's paper API (always paper).
- **Freqtrade bot**: the main bot or a managed one; its wallet from `/balance`, paper while it runs dry.
- **Wallet**: an EVM wallet below; the native coin, the stablecoins and the token of every DEX instrument with a contract on the wallet's networks, read with JSON-RPC (`eth_getBalance`, `balanceOf`, `decimals`, one batch per network) from public endpoints (publicnode, then the chain's own; `EVM_RPC_<NETWORK>` in the environment puts others first, https only).

Prices come from the instrument registry (the ticker refresh keeps `last_price` current): an instrument by its symbol and quote, a coin against a USD stablecoin, a token by its contract on the network; stablecoins count as 1 USD, wrapped and staked coins as their underlying. A position without a USD price stays listed and is marked. **Refresh values** values every enabled account; the job does it every hour (`PORTFOLIO_REFRESH_MINUTES`, 0 to switch off) and stores a snapshot of the totals (kept a year) for the chart. The page reads the stored values, so it never waits on an exchange or a chain.

**EVM wallets** (`wallets`): **New wallet** creates a key on the server from a 12-word BIP-39 recovery phrase (128 bits from the system CSPRNG; first account on `m/44'/60'/0'/0/0`); **Import** takes a private key or a recovery phrase (12 to 24 words, any derivation path); **Watch an address** stores only the address (EIP-55 checksum checked). Networks: Ethereum, Arbitrum, Base, Optimism, Polygon, BNB Chain. Keys use `@noble/curves` (secp256k1), `@noble/hashes` (keccak-256) and `@scure/bip39` / `@scure/bip32`, audited libraries without dependencies.

- Secrets never go into the database, a log line or an API answer: they are written to `~/.openclaw/credentials/wallets/<id>.env` (0600: `WALLET_PRIVATE_KEY`, and `WALLET_MNEMONIC`, `WALLET_DERIVATION_PATH` for a phrase). The API only says whether a key and a phrase are stored. The one exception is a new wallet: its create response (`Cache-Control: no-store`) carries the recovery phrase once, and the page shows it until "I have written the 12 words down" is ticked.
- If the key cannot be written, the wallet is not created. Deleting a wallet (typing its name) removes it and its portfolio account and moves the key file to `credentials/wallets/trash`.
- Wallets here do not sign or trade; the Web3 engine keeps its own key in its `.env`.

API (reads open on the tailnet, changes with `X-Trading-Control: 1`, audited): `GET /api/portfolio`, `POST /api/portfolio/refresh`, `POST|PUT|DELETE /api/portfolio/accounts[/:id]`, `GET|PUT /api/portfolio/accounts/:id/holdings`, `DELETE /api/portfolio/holdings/:id`, `GET|POST /api/wallets`, `PUT|DELETE /api/wallets/:id`.

## Web3 pair switches

The Web3 engine reports every token pair it scans, per network, with its pools and DEXes (`dex_pair_controls`, on each pool discovery, every 5 minutes), and reads two switches per pair each cycle:

- **Arbitrage**: off, the pair is not evaluated.
- **Flash loan**: off, an opportunity on the pair uses only the engine's own capital: the base capital tier only, no loan and no loan fee. The payload says `use_flashloan: false`.

New pairs start with both on (the behaviour before the switches). If the switches cannot be read, the engine evaluates nothing that cycle. The Web3 DEX tab lists the pairs with both switches and sets them per pair or for a whole network. The same over the API:

```bash
curl -s http://127.0.0.1:18795/api/dex/pairs                           # ?network=base
curl -s -X PUT -H 'X-Trading-Control: 1' -H 'Content-Type: application/json' \
     -d '{"flashloan_enabled": false}' http://127.0.0.1:18795/api/dex/pairs/12
curl -s -X PUT -H 'X-Trading-Control: 1' -H 'Content-Type: application/json' \
     -d '{"network": "base", "arbitrage_enabled": false}' http://127.0.0.1:18795/api/dex/pairs   # or "ids": [..] or "all": true
```

Every change records who made it (`updated_by`, `suite_audit_log`).

## Strategy center

The Strategies tab covers every trading engine in one place.

- **Bots** (`bots` table): the main Freqtrade bot (`freqtrade.service`), the Web3 DEX engine (read-only, from its `engine_status` heartbeat) and **managed bots**. Each card shows the mode (DRY-RUN or LIVE), the trading-loop state from the bot's API, the strategy, open trades and closed profit. **Start / Pause / Stop** act on the trading loop (Pause keeps managing open trades and blocks new entries; Stop leaves them unmanaged). **Details** has the strategy switch, controls, settings, the live-trading checks, the event history (`bot_events`) and the journal.
- **Switching strategy**: the suite writes `strategy` (and `strategy_path` for library strategies) into the bot's config, keeps the previous file in `~/.openclaw/bots/config-backups`, calls `/api/v1/reload_config` and waits until the bot reports the new strategy; otherwise the old config goes back. Open trades stay open and follow the new strategy's exit rules. Only checked strategies can be chosen, and a live bot keeps its strategy. For the main bot this needs the drop-in `systemd/freqtrade-strategy-from-config.conf` (no `--strategy` on the command line; see *Host setup*).
- **Managed bots** (New bot): a Freqtrade instance per bot, run by the openclaw user's systemd manager as `freqtrade-bot@<name>` (`systemd/freqtrade-bot@.service`: 450 MB memory limit, 60 % CPU, no new privileges). The suite writes `~/.openclaw/bots/instances/<name>/config.json` (own API port from 8090, own SQLite trade database, `strategy_path` = the library), and generates API credentials into `~/.openclaw/credentials/bots/<name>.env` (0600), which the unit loads. Every bot starts in dry-run. At most 3 managed bots (`MAX_MANAGED_BOTS`), and a bot is only started when at least 450 MB of memory is free (`BOT_MIN_FREE_MB`). Deleting a bot stops it and moves its folder and credentials to trash folders.
- **Strategy library** (`strategies`, `strategy_versions`): Freqtrade strategies written in the editor, uploaded as `.py`, copied from the templates in `strategy-templates/` (EMA cross, RSI mean reversion, MACD trend, Bollinger breakout) or from the main bot's folder. Files are written to `~/.openclaw/bots/strategies` together with `ts_guard.py`; every save is a version. Before bots may use a strategy it has to pass its **check** (`tools/strategy_check.py`, in a sandboxed transient unit): static rules (no subprocess, socket, ctypes, pickle, eval/exec, dangerous `os` calls, dunder tricks; network libraries and file writes are warnings), loading through Freqtrade's resolver, and a run of the populate functions on 500 sample candles with the signal counts.
- **Editor**: CodeMirror with Python highlighting, versions, Save (Ctrl+S) and Save & check, and a new-strategy dialog (blank example, template or copy).
- **Backtests** (`backtests`): strategy, pairs, timeframe, days, exchange, market, stake, max open trades and wallet. Runs are queued and run one at a time as transient user units with memory and time limits: `freqtrade download-data` (only missing candles, with extra history for indicator warm-up) into `~/.openclaw/bots/data/<exchange>`, `freqtrade backtesting`, then `tools/bt_result.py` stores the summary, per-pair and exit-reason tables, up to 1000 trades and the daily profit. The result view has the key figures (profit, drawdown, win rate, profit factor, Sharpe, Sortino, CAGR, market change) and an equity curve. `BACKTEST_WORKER` decides which process runs the queue (default: the one with background jobs).
- **Kill switch**: halting pauses every Freqtrade bot through its API (a managed bot that cannot be paused is stopped) and records a `kill_switch_pause` event; the halt guard re-pauses any bot that reports running while halted; resume starts only the bots the kill switch paused. Library strategies also call `ts_guard.entries_allowed()` in `confirm_trade_entry`, which reads `trading_control` and refuses entries while halted (fails closed); the check warns when a strategy does not.
- **Going live** (managed bots only; the main bot stays in dry-run): Details → Live trading lists the checks, and Go live stays disabled until every one passes: strategy checked; a finished backtest of the same strategy version with at least 10 trades and no loss; at least 7 days of dry-run with this strategy and 5 closed dry-run trades; exchange API keys set; a capital limit that covers stake × max open trades; trading not halted. Exchange keys are write-only: they go into the bot's credentials file as `FREQTRADE__EXCHANGE__KEY/SECRET/PASSWORD` and the API only answers whether they are set, with the key's last four characters. Confirming takes typing `LIVE <name>`; the bot then restarts with `dry_run: false`, `available_capital` = the capital limit and a separate `trades.live.sqlite`. Back to dry-run restarts it with its dry-run database. The limits are environment variables (`LIVE_MIN_DRY_RUN_DAYS`, `LIVE_MIN_BACKTEST_TRADES`, `LIVE_MIN_DRY_RUN_TRADES`).

### Trading venues

Settings → Trading venues (`trading_venues`, migration 010) lists the accounts the suite can trade through:

- **Crypto exchanges** through Freqtrade and ccxt: any exchange in Freqtrade's list (`tools/venue_tool.py exchanges`, shown under the form; the 15 the Freqtrade team supports are offered for bots and backtests), spot or futures, with keys marked read-only or for live trading.
- **Alpaca** (US stocks and ETFs), paper-trading API only.
- **DEX**: the Web3 engine, read-only: its heartbeat and the DEX pools tracked per network. Its chains, RPCs and wallet stay in the web3-dex-bot repository.

API keys are write-only: they go to `~/.openclaw/credentials/venues/<id>.env` (0600) and the API only answers whether they are set, with the last four characters. **Test** reads the markets and a ticker and, with keys, the balance (in a sandboxed unit; Alpaca: account and positions over its REST API). It never orders or withdraws. A managed bot on the same exchange and market can take a venue's keys under Details → Live trading; deleting a venue moves its keys file to `credentials/venues/trash`. The panel also has a short guide to adding instruments, data sources, venues, bots and news feeds.

### Host setup

The suite runs as openclaw and uses that user's systemd manager (lingering is on) through `XDG_RUNTIME_DIR=/run/user/1000`; no sudo.

```bash
# Unit template for managed bots
install -m 644 systemd/freqtrade-bot@.service ~openclaw/.config/systemd/user/   # as openclaw
systemctl --user daemon-reload                                                  # as openclaw, XDG_RUNTIME_DIR=/run/user/1000
# Main bot: strategy from config.json instead of --strategy (restart the bot once afterwards)
sudo install -m 644 systemd/freqtrade-strategy-from-config.conf /etc/systemd/system/freqtrade.service.d/strategy-from-config.conf
# Write access for the suite: ReadWritePaths in systemd/trading-suite-hardening.conf
sudo install -m 644 systemd/trading-suite-hardening.conf /etc/systemd/system/trading-suite.service.d/hardening.conf
sudo install -d -m 700 -o openclaw -g openclaw ~openclaw/.openclaw/credentials/bots ~openclaw/.openclaw/credentials/venues
sudo systemctl daemon-reload
```

Paths and limits come from the environment: `BOTS_DIR`, `BOT_CREDENTIALS_DIR`, `FREQTRADE_BIN`, `FREQTRADE_PYTHON`, `MAIN_STRATEGIES_DIR`, `BOT_PORT_BASE`, `BOT_MEMORY_MAX`, `BACKTEST_MEMORY_MAX` (see `src/config.js`).

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
- Changes to settings, providers, instruments, sources and watchlists are written to `suite_audit_log` with the caller's Tailscale login and device.
- Freqtrade API credentials come from `~/.openclaw/credentials/freqtrade.env`; managed bots' API credentials and exchange keys from `~/.openclaw/credentials/bots/<name>.env`, trading venues' keys from `~/.openclaw/credentials/venues/<id>.env` (all 0600, generated or written by the suite, never returned by the API).
- News feeds must be https and may not point at private or tailnet addresses; feed bodies are capped at 3 MB and parsed without DOCTYPE entities.
- Strategies, backtests and strategy checks run as transient user units with memory, task and time limits and `NoNewPrivileges`, never inside the web process. `trading-suite.service` itself may write only `~/.openclaw/bots`, `~/.openclaw/credentials/bots`, `~/.openclaw/credentials/venues` and the main bot's `config.json` in `/home` (`ReadWritePaths`).
- Bot and strategy changes go to `suite_audit_log` and, per bot, `bot_events`.

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
- `005_listings_watchlists.sql`: `instrument_listings` (several sources per instrument, copied from the old single provider), `watchlists` and `watchlist_items` with starter lists.
- `006_chart_layouts_alerts.sql`: `chart_layouts`, `alerts`, `alert_events`.
- `007_bots_strategies_backtests.sql`: `bots` (seeded with the main bot and the Web3 engine), `bot_events`, `strategies`, `strategy_versions`, `backtests`.
- `008_pine_scripts.sql`: `pine_scripts` with four examples.
- `009_news.sql`: `news_feeds` (seven feeds), `news_items`. The older `market_news_cache` table is no longer read.
- `010_trading_venues.sql`: `trading_venues`.
- `011_portfolio_wallets_dex_pairs.sql`: `wallets`, `portfolio_accounts`, `portfolio_holdings`, `portfolio_snapshots`, `dex_pair_controls`.

The pool opens at most 10 connections (`PG_POOL_MAX`), waits 5 s for one, and every statement has a server-side `statement_timeout` of 10 s (`PG_STATEMENT_TIMEOUT_MS`).

## Code layout

```
server.js                 entry point: context, app, jobs, graceful shutdown
src/config.js             environment -> config
src/context.js            builds the services (tests replace any of them)
src/app.js                Express app: middleware, static files, routes, error handler
src/http/                 security headers, request ids and logging, validation, control guard, errors
src/schemas.js            zod schemas for every request body and query
src/routes/               one file per area (health, settings, providers, market, instruments, charts, reports, integrations, control, strategies, bots, pine, news, venues)
src/services/             database and upstream access (providers, instruments, market data, reports, control, Freqtrade, identity, audit,
                          sysd = systemctl --user and transient units, strategies, backtests, bots)
src/jobs/                 ticker refresh, halt guard, interval runner (also: indicator alerts, backtest queue, news every 15 minutes)
tools/                    Python helpers run with Freqtrade's virtualenv: strategy_check.py, bt_result.py, ts_guard.py, venue_tool.py;
                          populate_instruments.js (+ web3_markets.py) fills the registry and sources from the engines
strategy-templates/       starter strategies for the library
systemd/                  unit template for managed bots, drop-ins for freqtrade.service and trading-suite.service
lib/providers.js          provider adapters
lib/resilience.js         rate limit and circuit breaker
db/migrate.js             migration runner
public/                   front end (indicators.js, pine.js and insights.js are shared with the server and the tests)
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
