"""Kill switch for strategies in the trading-suite library.

Copied into the library directory next to the strategies. A strategy calls
entries_allowed() in confirm_trade_entry, so no new position opens while trading is halted
from the suite (trade_db.trading_control). Fails closed: if the state cannot be read,
entries are refused. Bots are also paused through their API when the kill switch is used;
this is the second line.
"""
import logging
import os
import time

logger = logging.getLogger(__name__)

TRADE_DB_URL = os.environ.get("TS_TRADE_DB_URL", "postgresql+psycopg2://openclaw@/trade_db?host=/var/run/postgresql")
_CACHE_SECONDS = 5.0
_engine = None
_cache = (0.0, (True, "not checked yet"))


def trading_halted():
    """(halted, reason), cached for a few seconds."""
    global _engine, _cache
    now = time.monotonic()
    if now - _cache[0] < _CACHE_SECONDS:
        return _cache[1]
    try:
        from sqlalchemy import create_engine, text

        if _engine is None:
            _engine = create_engine(TRADE_DB_URL, pool_pre_ping=True, pool_size=1, max_overflow=0, connect_args={"connect_timeout": 3})
        with _engine.connect() as conn:
            row = conn.execute(text("SELECT halted, COALESCE(reason, '') FROM trading_control WHERE id = 1")).fetchone()
        result = (True, "trading_control row missing") if row is None else (bool(row[0]), row[1])
    except Exception as e:  # unreadable state counts as halted
        logger.warning("Kill switch state unreadable, treating as halted: %s", e)
        result = (True, f"kill switch state unreadable: {type(e).__name__}")
    _cache = (now, result)
    return result


def entries_allowed(pair=""):
    halted, reason = trading_halted()
    if halted:
        logger.warning("[KILL SWITCH] entry for %s refused: trading halted (%s)", pair, reason or "no reason given")
    return not halted
