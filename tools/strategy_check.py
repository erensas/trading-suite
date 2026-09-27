"""Checks a Freqtrade strategy before trading-suite uses it.

1. Static rules on the source (no process, shell, raw socket or dynamic-code calls; file
   writes and network libraries are reported).
2. Load through Freqtrade's StrategyResolver, as a bot would.
3. populate_indicators / populate_entry_trend / populate_exit_trend on synthetic candles,
   counting the signals.

Runs with the Freqtrade virtualenv's python, in a sandboxed user unit started by
trading-suite (NoNewPrivileges, memory limit, time limit). Prints one JSON object:
  {"ok": bool, "message": str, "errors": [...], "warnings": [...], "class": str,
   "timeframe": str, "can_short": bool, "stoploss": float, "minimal_roi": {...},
   "signals": {"enter_long": n, ...}}

Usage: strategy_check.py <strategy_dir> <StrategyName> [--static-only]
"""
import ast
import json
import sys
from pathlib import Path

FORBIDDEN_MODULES = {
    "subprocess", "socket", "ctypes", "shutil", "multiprocessing", "pty", "telnetlib", "ftplib",
    "smtplib", "paramiko", "pexpect", "importlib", "code", "codeop", "pickle", "marshal",
}
NETWORK_MODULES = {"requests", "urllib", "urllib3", "httpx", "aiohttp", "websocket", "websockets", "http"}
FORBIDDEN_CALLS = {"eval", "exec", "compile", "__import__", "breakpoint", "globals", "vars"}
FORBIDDEN_OS = {
    "system", "popen", "remove", "unlink", "rmdir", "removedirs", "rename", "replace", "chmod", "chown",
    "kill", "fork", "forkpty", "setuid", "setgid", "putenv", "unsetenv",
    "execl", "execle", "execlp", "execlpe", "execv", "execve", "execvp", "execvpe",
    "spawnl", "spawnle", "spawnlp", "spawnlpe", "spawnv", "spawnve", "spawnvp", "spawnvpe", "startfile",
}


def static_check(source, class_name):
    errors, warnings = [], []
    try:
        tree = ast.parse(source)
    except SyntaxError as e:
        return [f"syntax error on line {e.lineno}: {e.msg}"], warnings
    classes = [n.name for n in tree.body if isinstance(n, ast.ClassDef)]
    if class_name not in classes:
        errors.append(f"no class named {class_name} at the top level (found: {', '.join(classes) or 'none'})")
    for node in ast.walk(tree):
        if isinstance(node, (ast.Import, ast.ImportFrom)):
            names = [a.name for a in node.names] if isinstance(node, ast.Import) else [node.module or ""]
            for name in names:
                root = name.split(".")[0]
                if root in FORBIDDEN_MODULES:
                    errors.append(f"line {node.lineno}: importing {name} is not allowed")
                elif root in NETWORK_MODULES:
                    warnings.append(f"line {node.lineno}: imports {name} (network access from a strategy)")
                if isinstance(node, ast.ImportFrom) and root == "os":
                    for a in node.names:
                        if a.name in FORBIDDEN_OS or a.name == "*":
                            errors.append(f"line {node.lineno}: importing os.{a.name} is not allowed")
        elif isinstance(node, ast.Call):
            f = node.func
            if isinstance(f, ast.Name) and f.id in FORBIDDEN_CALLS:
                errors.append(f"line {node.lineno}: {f.id}() is not allowed")
            if isinstance(f, ast.Attribute) and isinstance(f.value, ast.Name) and f.value.id == "os" and f.attr in FORBIDDEN_OS:
                errors.append(f"line {node.lineno}: os.{f.attr}() is not allowed")
            if isinstance(f, ast.Name) and f.id == "open":
                mode = node.args[1] if len(node.args) > 1 else next((k.value for k in node.keywords if k.arg == "mode"), None)
                if isinstance(mode, ast.Constant) and isinstance(mode.value, str) and any(c in mode.value for c in "wax+"):
                    warnings.append(f"line {node.lineno}: writes a file")
        elif isinstance(node, ast.Attribute) and node.attr.startswith("__") and node.attr not in ("__init__", "__name__", "__class__"):
            if node.attr in ("__globals__", "__builtins__", "__subclasses__", "__code__", "__bases__", "__mro__"):
                errors.append(f"line {node.lineno}: access to {node.attr} is not allowed")
    # The kill switch: bots are paused through their API, and a library strategy should also
    # refuse entries itself while trading is halted.
    calls_guard = any(isinstance(n, ast.Call) and getattr(n.func, "id", getattr(n.func, "attr", None)) == "entries_allowed" for n in ast.walk(tree))
    if not calls_guard:
        warnings.append("does not call ts_guard.entries_allowed() in confirm_trade_entry; while trading is halted only pausing the bot stops new entries")
    return errors, warnings


def synthetic_candles(n=500, seed=7):
    import numpy as np
    import pandas as pd

    rng = np.random.default_rng(seed)
    # A trend, a range and a sell-off, so most strategies produce some signals.
    drift = np.concatenate([np.full(n // 3, 0.0012), np.full(n // 3, 0.0), np.full(n - 2 * (n // 3), -0.0015)])
    close = 100 * np.cumprod(1 + drift + rng.normal(0, 0.006, n))
    return pd.DataFrame({
        "date": pd.date_range("2026-01-01", periods=n, freq="15min", tz="UTC"),
        "open": close * (1 + rng.normal(0, 0.001, n)),
        "high": close * (1 + abs(rng.normal(0.002, 0.002, n))),
        "low": close * (1 - abs(rng.normal(0.002, 0.002, n))),
        "close": close,
        "volume": rng.uniform(100, 1000, n),
    })


def run(strategy_dir, class_name, static_only=False):
    out = {"ok": False, "message": "", "errors": [], "warnings": [], "class": class_name}
    path = f"{strategy_dir}/{class_name}.py"
    try:
        with open(path, encoding="utf-8") as f:
            source = f.read()
    except OSError as e:
        out["errors"].append(f"cannot read {path}: {e.strerror}")
        out["message"] = out["errors"][0]
        return out
    errors, warnings = static_check(source, class_name)
    out["errors"] += errors
    out["warnings"] += warnings
    if errors or static_only:
        out["ok"] = not errors
        out["message"] = errors[0] if errors else "static rules passed"
        return out

    from freqtrade.resolvers import StrategyResolver

    config = {
        "strategy": class_name,
        "strategy_path": strategy_dir,
        "user_data_dir": Path(strategy_dir),
        "stake_currency": "USDT",
        "stake_amount": 100,
        "dry_run": True,
        "trading_mode": "spot",
        "margin_mode": "",
        "exchange": {"name": "binance", "pair_whitelist": ["BTC/USDT"], "pair_blacklist": []},
        "pairlists": [{"method": "StaticPairList"}],
        "entry_pricing": {"price_side": "same"},
        "exit_pricing": {"price_side": "same"},
        "max_open_trades": 3,
    }
    strategy = StrategyResolver.load_strategy(config)
    out.update({
        "timeframe": strategy.timeframe,
        "can_short": bool(getattr(strategy, "can_short", False)),
        "stoploss": strategy.stoploss,
        "minimal_roi": {str(k): v for k, v in (strategy.minimal_roi or {}).items()},
        "interface_version": getattr(strategy, "INTERFACE_VERSION", None),
        "startup_candle_count": getattr(strategy, "startup_candle_count", 0),
    })
    df = synthetic_candles()
    meta = {"pair": "BTC/USDT"}
    df = strategy.populate_indicators(df, meta)
    df = strategy.populate_entry_trend(df, meta)
    df = strategy.populate_exit_trend(df, meta)
    signals = {}
    for col in ("enter_long", "exit_long", "enter_short", "exit_short"):
        if col in df.columns:
            signals[col] = int(df[col].fillna(0).astype(bool).sum())
    out["signals"] = signals
    if "enter_long" not in df.columns and "enter_short" not in df.columns:
        out["errors"].append("populate_entry_trend sets neither enter_long nor enter_short")
    if not signals.get("enter_long") and not signals.get("enter_short"):
        out["warnings"].append("no entry signal on the 500 sample candles")
    out["ok"] = not out["errors"]
    out["message"] = out["errors"][0] if out["errors"] else f"loads and runs; entries on sample data: {signals.get('enter_long', 0)} long, {signals.get('enter_short', 0)} short"
    return out


if __name__ == "__main__":
    if len(sys.argv) < 3:
        print(json.dumps({"ok": False, "message": "usage: strategy_check.py <dir> <StrategyName> [--static-only]"}))
        sys.exit(2)
    try:
        result = run(sys.argv[1], sys.argv[2], "--static-only" in sys.argv)
    except Exception as e:  # any crash is a failed check, reported as such
        result = {"ok": False, "message": f"{type(e).__name__}: {e}", "errors": [f"{type(e).__name__}: {e}"], "warnings": [], "class": sys.argv[2]}
    print("STRATEGY_CHECK " + json.dumps(result, default=str))
    sys.exit(0 if result["ok"] else 1)
