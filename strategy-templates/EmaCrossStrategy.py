"""EMA cross, trend-following (trading-suite template).

Long when the fast EMA crosses above the slow EMA while the close is above the trend EMA;
exit when the fast EMA crosses back below the slow one. Suits trending markets.
"""
from datetime import datetime
from typing import Optional

import talib.abstract as ta
from freqtrade.strategy import IStrategy, IntParameter
from pandas import DataFrame

from ts_guard import entries_allowed


class EmaCrossStrategy(IStrategy):
    INTERFACE_VERSION = 3
    timeframe = "15m"
    can_short = False
    stoploss = -0.05
    minimal_roi = {"0": 0.08, "240": 0.04, "720": 0.02}
    trailing_stop = True
    trailing_stop_positive = 0.01
    trailing_stop_positive_offset = 0.02
    trailing_only_offset_is_reached = True
    process_only_new_candles = True
    startup_candle_count = 210

    fast = IntParameter(5, 30, default=12, space="buy")
    slow = IntParameter(20, 80, default=26, space="buy")
    trend = IntParameter(100, 250, default=200, space="buy")

    def populate_indicators(self, dataframe: DataFrame, metadata: dict) -> DataFrame:
        for n in {self.fast.value, self.slow.value, self.trend.value}:
            dataframe[f"ema_{n}"] = ta.EMA(dataframe, timeperiod=n)
        return dataframe

    def populate_entry_trend(self, dataframe: DataFrame, metadata: dict) -> DataFrame:
        fast, slow, trend = dataframe[f"ema_{self.fast.value}"], dataframe[f"ema_{self.slow.value}"], dataframe[f"ema_{self.trend.value}"]
        cross_up = (fast > slow) & (fast.shift(1) <= slow.shift(1))
        dataframe.loc[cross_up & (dataframe["close"] > trend) & (dataframe["volume"] > 0), ["enter_long", "enter_tag"]] = (1, "ema_cross_up")
        return dataframe

    def populate_exit_trend(self, dataframe: DataFrame, metadata: dict) -> DataFrame:
        fast, slow = dataframe[f"ema_{self.fast.value}"], dataframe[f"ema_{self.slow.value}"]
        dataframe.loc[(fast < slow) & (fast.shift(1) >= slow.shift(1)), ["exit_long", "exit_tag"]] = (1, "ema_cross_down")
        return dataframe

    def confirm_trade_entry(self, pair: str, order_type: str, amount: float, rate: float, time_in_force: str,
                            current_time: datetime, entry_tag: Optional[str], side: str, **kwargs) -> bool:
        return entries_allowed(pair)
