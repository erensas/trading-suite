"""Trading venue checks for trading-suite (Settings -> Trading venues).

Runs with Freqtrade's virtualenv in a sandboxed user unit started by trading-suite.

  venue_tool.py exchanges
      Freqtrade's exchange list (name, ccxt id, supported by the Freqtrade team, trade modes).
  venue_tool.py test <ccxt id> <env file or -> <spot|futures>
      Public check (markets, a ticker) and, when the env file has VENUE_KEY / VENUE_SECRET
      (/ VENUE_PASSWORD), a private check (balance). Nothing is ordered or withdrawn.

Prints one line: VENUE {json}. Key values never appear in the output.
"""
import json
import sys
import time


def emit(obj):
    print("VENUE " + json.dumps(obj, default=str))


def read_env(path):
    out = {}
    if not path or path == "-":
        return out
    try:
        with open(path, encoding="utf-8") as f:
            for line in f:
                line = line.strip()
                if "=" in line and not line.startswith("#"):
                    k, v = line.split("=", 1)
                    out[k.strip()] = v.strip().strip("'\"")
    except OSError:
        pass
    return out


def exchanges():
    from freqtrade.exchange import list_available_exchanges

    rows = []
    for e in list_available_exchanges(False):
        if not e.get("valid"):
            continue
        modes = sorted({m["trading_mode"] for m in e.get("trade_modes", [])})
        rows.append({"id": e["classname"], "name": e["name"], "supported": bool(e.get("supported")), "dex": bool(e.get("dex")), "modes": modes, "comment": e.get("comment") or ""})
    emit({"exchanges": rows})


def test(exchange_id, env_path, trading_mode):
    import ccxt

    env = read_env(env_path)
    secrets = [v for k, v in env.items() if k in ("VENUE_KEY", "VENUE_SECRET", "VENUE_PASSWORD") and v]

    def redact(text):
        text = str(text)
        for s in secrets:
            text = text.replace(s, "***")
        return text[:300]

    if not hasattr(ccxt, exchange_id):
        return emit({"ok": False, "message": f"unknown exchange {exchange_id}"})
    opts = {"enableRateLimit": True, "timeout": 15000}
    if trading_mode == "futures":
        opts["options"] = {"defaultType": "swap"}
    if env.get("VENUE_KEY") and env.get("VENUE_SECRET"):
        opts.update(apiKey=env["VENUE_KEY"], secret=env["VENUE_SECRET"])
        if env.get("VENUE_PASSWORD"):
            opts["password"] = env["VENUE_PASSWORD"]
    ex = getattr(ccxt, exchange_id)(opts)
    out = {"ok": False, "exchange": exchange_id, "trading_mode": trading_mode}
    try:
        t0 = time.time()
        markets = ex.load_markets()
        pub = {"markets": len(markets), "ms": int((time.time() - t0) * 1000)}
        for sym in ("BTC/USDT:USDT", "BTC/USDT", "BTC/USD", "ETH/USDT") if trading_mode == "futures" else ("BTC/USDT", "BTC/USD", "BTC/EUR", "ETH/USDT"):
            if sym in markets:
                pub["ticker"] = {"symbol": sym, "last": ex.fetch_ticker(sym).get("last")}
                break
        out["public"] = pub
        out["ok"] = True
    except Exception as e:  # any failure is reported, not raised
        out["public"] = {"error": f"{type(e).__name__}: {redact(e)}"}
        return emit({**out, "message": out["public"]["error"]})
    if "apiKey" in opts:
        try:
            bal = ex.fetch_balance()
            totals = {k: v for k, v in (bal.get("total") or {}).items() if v}
            top = sorted(totals.items(), key=lambda kv: -float(kv[1] or 0))[:6]
            out["private"] = {"ok": True, "assets": len(totals), "top": [{"asset": k, "total": v} for k, v in top]}
        except Exception as e:
            out["private"] = {"ok": False, "error": f"{type(e).__name__}: {redact(e)}"}
            out["ok"] = False
    out["message"] = (
        f"{pub['markets']} markets in {pub['ms']} ms"
        + (f"; {pub['ticker']['symbol']} {pub['ticker']['last']}" if "ticker" in pub else "")
        + ("" if "private" not in out else ("; keys work, balance read" if out["private"]["ok"] else f"; keys failed: {out['private']['error']}"))
        + ("" if "apiKey" in opts else "; no keys set (public check only)")
    )
    emit(out)


if __name__ == "__main__":
    try:
        if len(sys.argv) >= 2 and sys.argv[1] == "exchanges":
            exchanges()
        elif len(sys.argv) >= 5 and sys.argv[1] == "test":
            test(sys.argv[2], sys.argv[3], sys.argv[4])
        else:
            emit({"ok": False, "message": "usage: venue_tool.py exchanges | test <id> <env> <spot|futures>"})
    except Exception as e:
        emit({"ok": False, "message": f"{type(e).__name__}: {str(e)[:300]}"})
