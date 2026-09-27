"""Reads the result of one Freqtrade backtest run and prints a compact JSON summary.

Freqtrade writes <prefix>-<time>.zip (with a .json inside) into the export directory and
names the latest in .last_result.json. trading-suite stores this summary in
trade_db.backtests.

Usage: bt_result.py <run_dir> [max_trades]
"""
import json
import sys
import zipfile
from pathlib import Path

SUMMARY_KEYS = [
    "total_trades", "trade_count_long", "trade_count_short", "wins", "draws", "losses", "winrate",
    "profit_total", "profit_total_abs", "profit_mean", "profit_median", "profit_factor", "expectancy", "expectancy_ratio",
    "cagr", "sharpe", "sortino", "calmar", "sqn", "max_drawdown_account", "max_drawdown_abs", "max_relative_drawdown",
    "drawdown_start", "drawdown_end", "starting_balance", "final_balance", "stake_amount", "stake_currency",
    "max_open_trades", "timeframe", "timerange", "backtest_start", "backtest_end", "backtest_days", "market_change",
    "holding_avg", "winner_holding_avg", "loser_holding_avg", "max_consecutive_wins", "max_consecutive_losses",
    "best_pair", "worst_pair", "backtest_best_day", "backtest_worst_day", "winning_days", "losing_days", "draw_days",
    "stoploss", "minimal_roi", "trailing_stop", "trading_mode", "pairlist", "rejected_signals",
]
TRADE_KEYS = ["pair", "open_date", "close_date", "open_rate", "close_rate", "profit_ratio", "profit_abs", "exit_reason", "enter_tag", "is_short", "trade_duration", "stake_amount"]


def load(run_dir):
    run = Path(run_dir)
    latest = json.loads((run / ".last_result.json").read_text())["latest_backtest"]
    with zipfile.ZipFile(run / latest) as z:
        name = next(n for n in z.namelist() if n.endswith(".json") and not n.endswith("_config.json"))
        return json.loads(z.read(name))


def summarize(data, max_trades=1000):
    strategy, s = next(iter(data["strategy"].items()))
    summary = {k: s.get(k) for k in SUMMARY_KEYS if k in s}
    summary["strategy"] = strategy
    for key in ("best_pair", "worst_pair"):
        if isinstance(summary.get(key), dict):
            summary[key] = {"key": summary[key].get("key"), "profit_total_pct": summary[key].get("profit_total_pct")}
    per_pair = [
        {k: r.get(k) for k in ("key", "trades", "profit_mean_pct", "profit_total_abs", "profit_total_pct", "winrate", "wins", "losses", "duration_avg", "max_drawdown_account")}
        for r in s.get("results_per_pair", [])
    ]
    exits = [{k: r.get(k) for k in ("key", "trades", "profit_total_abs", "winrate")} for r in s.get("exit_reason_summary", [])]
    trades = [{k: t.get(k) for k in TRADE_KEYS} for t in s.get("trades", [])[:max_trades]]
    return {"summary": summary, "per_pair": per_pair, "exit_reasons": exits, "trades": trades, "trade_count": len(s.get("trades", [])), "daily": s.get("daily_profit", [])}


if __name__ == "__main__":
    try:
        out = summarize(load(sys.argv[1]), int(sys.argv[2]) if len(sys.argv) > 2 else 1000)
        print("BT_RESULT " + json.dumps(out, default=str))
    except Exception as e:
        print("BT_RESULT " + json.dumps({"error": f"{type(e).__name__}: {e}"}))
        sys.exit(1)
