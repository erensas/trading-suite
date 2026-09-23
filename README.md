# 📈 Unified Trading Suite

A high-performance, real-time, database-centric trading suite and analytics dashboard built with Node.js, Express, PostgreSQL, SQLite, and TradingView Lightweight Charts.

## 🚀 Features

- **Interactive Charting & Overlays**: Real-time candlestick charts with on-chain & CEX trade markers directly fetched from PostgreSQL (`trade_logs`) and Freqtrade SQLite DB.
- **Database Market Screener**: Dynamic instrument directory covering DEX pools, CEX futures, and TradFi stocks/ETFs.
- **Binance L2 Depth & Order Book**: Real-time order book depth ladder and market trade stream.
- **IBKR TradFi Option Chain Matrix**: Options matrix with implied volatility and Greeks (Delta, Gamma, Theta, Vega).
- **Dynamic Setting Mutations**: Live controls for Profit Guard threshold, Max Slippage, and Execution Mode (`DRY-RUN` / `LIVE`).
- **Interactive Service Control Bridge**: Control systemd microservices (`web3-dex-bot`, `freqtrade`, `system-dashboard`, `trading-suite`) from the web UI.
- **Risk Sentinel Circuit Breaker**: Automated drawdown circuit breaker protecting trading capital.
- **Real-Time Log Stream**: Server-Sent Events (SSE) log console streaming live supervisor logs.

## 🛠 Tech Stack

- **Backend**: Node.js, Express, `pg` (PostgreSQL), `node:sqlite` (SQLite3).
- **Frontend**: HTML5, Vanilla JS (ES6+), TradingView Lightweight Charts v4.1.1, FontAwesome 6.
- **Service Management**: Systemd (`trading-suite.service`), Caddy Reverse Proxy (`:18795` -> `/trading-suite/`).

## ⚡ Quick Start

```bash
# Install dependencies
npm install

# Start development server
npm start
```

## 📜 Systemd Service Setup

```ini
[Unit]
Description=Unified Trading Suite Web Dashboard & Analytics Engine
After=network.target postgresql.service

[Service]
Type=simple
User=openclaw
WorkingDirectory=/opt/trading-suite
ExecStart=/usr/bin/node /opt/trading-suite/server.js
Restart=always
RestartSec=3s
Environment=NODE_ENV=production
Environment=PORT=18795
Environment=HOST=127.0.0.1

[Install]
WantedBy=multi-user.target
```
