"""Momentum indicator calculations."""

from __future__ import annotations

from data.models import Candle
from indicators.trend import ema


def rsi(values: list[float], period: int = 14) -> float | None:
    if len(values) < 2:
        return None
    period = min(period, len(values) - 1)
    if period < 1:
        return None
    gains = [max(0, current - previous) for previous, current in zip(values, values[1:])]
    losses = [max(0, previous - current) for previous, current in zip(values, values[1:])]
    avg_gain, avg_loss = sum(gains[:period]) / period, sum(losses[:period]) / period
    for gain, loss in zip(gains[period:], losses[period:]):
        avg_gain = (avg_gain * (period - 1) + gain) / period
        avg_loss = (avg_loss * (period - 1) + loss) / period
    if avg_loss == 0:
        return 100.0 if avg_gain > 0 else 50.0
    return round(100 - 100 / (1 + avg_gain / avg_loss), 2)


def macd(
    values: list[float],
    fast_period: int = 12,
    slow_period: int = 26,
    signal_period: int = 9,
) -> tuple[float | None, float | None, float | None]:
    min_len = slow_period + signal_period
    if len(values) < max(3, min_len // 2):
        return None, None, None
    fast_period = min(fast_period, max(2, len(values) - 1))
    slow_period = min(slow_period, max(fast_period + 1, len(values)))
    signal_period = min(signal_period, max(2, len(values) - slow_period))
    fast, slow = ema(values, fast_period), ema(values, slow_period)
    if fast is None or slow is None:
        return None, None, None
    series = []
    for index in range(slow_period, len(values) + 1):
        value = (ema(values[:index], fast_period) or 0) - (ema(values[:index], slow_period) or 0)
        series.append(value)
    signal = ema(series, signal_period)
    histogram = fast - slow - signal if signal is not None else None
    return round(fast - slow, 4), round(signal, 4) if signal is not None else None, round(histogram, 4) if histogram is not None else None


def stochastic(candles: list[Candle], period: int = 14) -> float | None:
    period = min(period, len(candles))
    if period < 2:
        return None
    window = candles[-period:]
    high, low = max(item.high for item in window), min(item.low for item in window)
    return round(100 * (window[-1].close - low) / (high - low), 2) if high != low else 50.0


def williams_r(candles: list[Candle], period: int = 14) -> float | None:
    value = stochastic(candles, period)
    return round(value - 100, 2) if value is not None else None


def cci(candles: list[Candle], period: int = 20) -> float | None:
    period = min(period, len(candles))
    if period < 2:
        return None
    typical = [(item.high + item.low + item.close) / 3 for item in candles[-period:]]
    average = sum(typical) / period
    deviation = sum(abs(value - average) for value in typical) / period
    return round((typical[-1] - average) / (0.015 * deviation), 2) if deviation else 0.0


def calculate(candles: list[Candle]) -> dict[str, float | None]:
    closes = [item.close for item in candles]
    count = len(closes)
    rsi_period = min(14, max(3, count - 1))
    if count < 12:
        macd_params = (3, 6, 3)
    elif count < 20:
        macd_params = (5, 10, 4)
    else:
        macd_params = (12, 26, 9)
    macd_line, signal, histogram = macd(closes, *macd_params)
    roc_lookback = min(13, max(2, count - 1))
    return {
        "rsi_14": rsi(closes, rsi_period),
        "macd": macd_line,
        "macd_signal": signal,
        "macd_histogram": histogram,
        "stochastic": stochastic(candles, min(14, max(3, count))),
        "williams_r": williams_r(candles, min(14, max(3, count))),
        "cci": cci(candles, min(20, max(3, count))),
        "roc": round((closes[-1] / closes[-roc_lookback - 1] - 1) * 100, 2) if count > roc_lookback else None,
    }
