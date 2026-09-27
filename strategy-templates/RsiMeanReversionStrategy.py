"""RSI mean reversion (trading-suite template).

Buy an oversold dip (RSI below the threshold and the close under the lower Bollinger band)
and sell into the rebound (RSI overbought or the close back above the middle band). Suits
ranging markets; the tight stop limits damage when a range breaks down.
"""
from datetime import datetime
from typing import Optional

import talib.abstract as ta
from freqtrade.strategy import IStrategy, IntParameter
from pandas import DataFrame

from ts_guard import entries_allowed


class RsiMeanReversionStrategy(IStrategy):
    INTERFACE_VERSION = 3
    timeframe = "15m"
    can_short = False
    stoploss = -0.04
    minimal_roi = {"0": 0.04, "120": 0.02, "360": 0.01}
    process_only_new_candles = True
    startup_candle_count = 40

    rsi_buy = IntParameter(15, 40, default=30, space="buy")
    rsi_sell = IntParameter(60, 85, default=70, space="sell")

    def populate_indicators(self, dataframe: DataFrame, metadata: dict) -> DataFrame:
        dataframe["rsi"] = ta.RSI(dataframe, timeperiod=14)
        bb = ta.BBANDS(dataframe, timeperiod=20, nbdevup=2.0, nbdevdn=2.0)
        dataframe["bb_lower"], dataframe["bb_mid"], dataframe["bb_upper"] = bb["lowerband"], bb["middleband"], bb["upperband"]
        return dataframe

    def populate_entry_trend(self, dataframe: DataFrame, metadata: dict) -> DataFrame:
        dataframe.loc[
            (dataframe["rsi"] < self.rsi_buy.value) & (dataframe["close"] < dataframe["bb_lower"]) & (dataframe["volume"] > 0),
            ["enter_long", "enter_tag"],
        ] = (1, "rsi_oversold")
        return dataframe

    def populate_exit_trend(self, dataframe: DataFrame, metadata: dict) -> DataFrame:
        dataframe.loc[(dataframe["rsi"] > self.rsi_sell.value) | (dataframe["close"] > dataframe["bb_mid"]), ["exit_long", "exit_tag"]] = (1, "rsi_rebound")
        return dataframe

    def confirm_trade_entry(self, pair: str, order_type: str, amount: float, rate: float, time_in_force: str,
                            current_time: datetime, entry_tag: Optional[str], side: str, **kwargs) -> bool:
        return entries_allowed(pair)
