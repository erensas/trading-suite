"""Bollinger breakout (trading-suite template).

Long when the close breaks above the upper Bollinger band on above-average volume after a
squeeze (band width in its lowest 20% of the last 100 bars); exit when the close falls back
under the middle band. Suits volatility expansions.
"""
from datetime import datetime
from typing import Optional

import talib.abstract as ta
from freqtrade.strategy import IStrategy
from pandas import DataFrame

from ts_guard import entries_allowed


class BollingerBreakoutStrategy(IStrategy):
    INTERFACE_VERSION = 3
    timeframe = "15m"
    can_short = False
    stoploss = -0.05
    minimal_roi = {"0": 0.12, "360": 0.05, "1440": 0.02}
    trailing_stop = True
    trailing_stop_positive = 0.02
    trailing_stop_positive_offset = 0.04
    trailing_only_offset_is_reached = True
    process_only_new_candles = True
    startup_candle_count = 120

    def populate_indicators(self, dataframe: DataFrame, metadata: dict) -> DataFrame:
        bb = ta.BBANDS(dataframe, timeperiod=20, nbdevup=2.0, nbdevdn=2.0)
        dataframe["bb_lower"], dataframe["bb_mid"], dataframe["bb_upper"] = bb["lowerband"], bb["middleband"], bb["upperband"]
        dataframe["bb_width"] = (dataframe["bb_upper"] - dataframe["bb_lower"]) / dataframe["bb_mid"]
        dataframe["width_rank"] = dataframe["bb_width"].rolling(100).rank(pct=True)
        dataframe["vol_mean"] = dataframe["volume"].rolling(20).mean()
        return dataframe

    def populate_entry_trend(self, dataframe: DataFrame, metadata: dict) -> DataFrame:
        squeezed = dataframe["width_rank"].shift(1).rolling(10).min() < 0.2
        dataframe.loc[squeezed & (dataframe["close"] > dataframe["bb_upper"]) & (dataframe["volume"] > 1.5 * dataframe["vol_mean"]), ["enter_long", "enter_tag"]] = (1, "bb_breakout")
        return dataframe

    def populate_exit_trend(self, dataframe: DataFrame, metadata: dict) -> DataFrame:
        dataframe.loc[dataframe["close"] < dataframe["bb_mid"], ["exit_long", "exit_tag"]] = (1, "bb_back_to_mid")
        return dataframe

    def confirm_trade_entry(self, pair: str, order_type: str, amount: float, rate: float, time_in_force: str,
                            current_time: datetime, entry_tag: Optional[str], side: str, **kwargs) -> bool:
        return entries_allowed(pair)
