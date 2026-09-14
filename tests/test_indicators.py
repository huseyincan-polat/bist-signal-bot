from data.historical import synthetic_candles
from indicators import momentum, trend, volatility, volume


def test_indicator_suite_returns_core_values() -> None:
    candles = synthetic_candles("THYAO", "1m", 240)
    trend_values = trend.calculate(candles)
    momentum_values = momentum.calculate(candles)
    assert trend_values["ema_200"] is not None
    assert trend_values["adx"] is not None
    assert 0 <= (momentum_values["rsi_14"] or 0) <= 100
    assert momentum_values["macd"] is not None
    assert volatility.calculate(candles)["atr_14"] is not None
    assert volume.calculate(candles)["vwap"] is not None
