"""MACD trend (trading-suite template).

Long when MACD crosses above its signal line below zero-ish levels in an uptrend (close
above EMA 200, ADX above 20); exit when MACD crosses back under the signal line.
"""
from datetime import datetime
from typing import Optional

import talib.abstract as ta
from freqtrade.strategy import IStrategy, IntParameter
from pandas import DataFrame

from ts_guard import entries_allowed


class MacdTrendStrategy(IStrategy):
    INTERFACE_VERSION = 3
    timeframe = "1h"
    can_short = False
    stoploss = -0.06
    minimal_roi = {"0": 0.10, "480": 0.05, "1440": 0.02}
    trailing_stop = True
    trailing_stop_positive = 0.015
    trailing_stop_positive_offset = 0.03
    trailing_only_offset_is_reached = True
    process_only_new_candles = True
    startup_candle_count = 210

    adx_min = IntParameter(15, 35, default=20, space="buy")

    def populate_indicators(self, dataframe: DataFrame, metadata: dict) -> DataFrame:
        macd = ta.MACD(dataframe, fastperiod=12, slowperiod=26, signalperiod=9)
        dataframe["macd"], dataframe["macdsignal"] = macd["macd"], macd["macdsignal"]
        dataframe["ema200"] = ta.EMA(dataframe, timeperiod=200)
        dataframe["adx"] = ta.ADX(dataframe, timeperiod=14)
        return dataframe

    def populate_entry_trend(self, dataframe: DataFrame, metadata: dict) -> DataFrame:
        cross_up = (dataframe["macd"] > dataframe["macdsignal"]) & (dataframe["macd"].shift(1) <= dataframe["macdsignal"].shift(1))
        dataframe.loc[cross_up & (dataframe["close"] > dataframe["ema200"]) & (dataframe["adx"] > self.adx_min.value) & (dataframe["volume"] > 0), ["enter_long", "enter_tag"]] = (1, "macd_cross_up")
        return dataframe

    def populate_exit_trend(self, dataframe: DataFrame, metadata: dict) -> DataFrame:
        cross_down = (dataframe["macd"] < dataframe["macdsignal"]) & (dataframe["macd"].shift(1) >= dataframe["macdsignal"].shift(1))
        dataframe.loc[cross_down, ["exit_long", "exit_tag"]] = (1, "macd_cross_down")
        return dataframe

    def confirm_trade_entry(self, pair: str, order_type: str, amount: float, rate: float, time_in_force: str,
                            current_time: datetime, entry_tag: Optional[str], side: str, **kwargs) -> bool:
        return entries_allowed(pair)
