# CLAUDE.md

Orientation for Claude Code sessions working in `erensas/trading-suite`.

## What this repo is

The trading dashboard of the OpenClaw VPS (`agents-s-2vcpu-4gb-ams3`): Node.js 22+ with Express 5 and PostgreSQL (`trade_db`), a vanilla JS front end with TradingView Lightweight Charts, no build step. Markets, watchlists, charts with indicators and alerts, the strategy center (bots, strategy library, backtests, dry-run and live), the Pine editor, news and insights, trading venues and the kill switch. `README.md` describes every view, the API, the database and the code layout; read it first.

## Where it runs

- Service `trading-suite.service` on `127.0.0.1:18795`, published by Caddy on the tailnet at `/trading-suite/`. It embeds system-dashboard (`erensas/system-dashboard`) as its System view, and FreqUI.
- `/opt/trading-suite` is the live git checkout (branch `master`). Develop in a separate clone, push, then deploy with `scripts/deploy.sh trading-suite` from `erensas/openclaw-workspace`, so a rollback has a previous commit. The deploy runs `npm ci` when the lockfile changed, `npm test`, pending migrations after a `pg_dump` of `trade_db`, then restarts and checks health.
- The unit runs with the hardening drop-in `systemd/trading-suite-hardening.conf` (read-only `/home` except the listed `ReadWritePaths`); strategies, backtests and venue tests run as sandboxed transient user units, never inside the web process.
- EVM wallet keys live in `~/.openclaw/credentials/wallets/<id>.env` (0600), written by the suite and never returned by the API (a new wallet's recovery phrase only once, in its create response). That folder must exist (700, openclaw) and be in the drop-in's `ReadWritePaths`. The Web3 engine reads its per-pair switches from `dex_pair_controls` every cycle.
- Both trading engines (Freqtrade and the Web3 DEX bot) run in dry-run mode; nothing trades live. Going live is a decision for Eren.

## Working rules (from the workspace `AGENTS.md`)

- Everything stored is in English: code, comments, UI text, commits, docs. Chat with Eren in Turkish.
- Work on the VPS on `master`; no feature branches or pull requests. Commit messages start with `[BACKUP]`.
- Back up before a system change: `sudo /usr/local/bin/daily_openclaw_backup.sh`; dump `trade_db` before a migration (deploy.sh does both).
- No secrets in the repo. Exchange and venue keys live in `~/.openclaw/credentials/` (mode 600) and are written by the suite itself; the service connects to PostgreSQL over the Unix socket with peer auth.
- Present a plan to Eren before changing the service unit, its drop-ins, the kill switch or anything that could trade.
- Migrations are additive (`db/migrations/NNN_name.sql`); never edit an applied file, write a new one. A code rollback does not undo them.
- `public/tokens.css` is an identical copy of the file in system-dashboard; change both repos in one go (deploy.sh refuses to deploy a split copy).
- Front-end rules from the workspace `AGENTS.md`: event delegation (`closest()`), guard every null price or change with a placeholder, keep the `{ success, error, code, requestId }` response shape.

## Develop and test

```bash
npm ci
npm test                                                                    # unit and HTTP tests, no database needed
TEST_DATABASE_URL=postgres://suite:suite@localhost/trade_db_test npm test   # plus migrations and the API on PostgreSQL
PORT=18796 SUITE_JOBS=0 node server.js                                      # local run without the background jobs
node db/migrate.js status                                                   # migrations (also check, up, baseline <NNN>)
```

CI (`.github/workflows/ci.yml`) runs the same on every push with PostgreSQL 16 plus `npm audit`; keep it green. Dependabot opens dependency PRs weekly; a major front-end library bump needs a look at the UI on a dev port first.

## Related docs

`docs/SYSTEM.md`, `docs/REPOS.md`, `docs/OPERATIONS.md` and `docs/BACKLOG.md` in `erensas/openclaw-workspace`; the trading-suite section of the backlog lists the open points.
