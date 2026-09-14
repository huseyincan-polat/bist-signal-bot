"""Momentum indicator calculations."""

from __future__ import annotations

from data.models import Candle
from indicators.trend import ema


def rsi(values: list[float], period: int = 14) -> float | None:
    if len(values) <= period:
        return None
    gains = [max(0, current - previous) for previous, current in zip(values, values[1:])]
    losses = [max(0, previous - current) for previous, current in zip(values, values[1:])]
    avg_gain, avg_loss = sum(gains[:period]) / period, sum(losses[:period]) / period
    for gain, loss in zip(gains[period:], losses[period:]):
        avg_gain = (avg_gain * (period - 1) + gain) / period
        avg_loss = (avg_loss * (period - 1) + loss) / period
    if avg_loss == 0:
        return 100.0
    return round(100 - 100 / (1 + avg_gain / avg_loss), 2)


def macd(values: list[float]) -> tuple[float | None, float | None, float | None]:
    if len(values) < 35:
        return None, None, None
    fast, slow = ema(values, 12), ema(values, 26)
    if fast is None or slow is None:
        return None, None, None
    series = []
    for index in range(26, len(values) + 1):
        value = (ema(values[:index], 12) or 0) - (ema(values[:index], 26) or 0)
        series.append(value)
    signal = ema(series, 9)
    return round(fast - slow, 4), round(signal, 4) if signal is not None else None, round(fast - slow - signal, 4) if signal is not None else None


def stochastic(candles: list[Candle], period: int = 14) -> float | None:
    if len(candles) < period:
        return None
    window = candles[-period:]
    high, low = max(item.high for item in window), min(item.low for item in window)
    return round(100 * (window[-1].close - low) / (high - low), 2) if high != low else 50.0


def williams_r(candles: list[Candle], period: int = 14) -> float | None:
    value = stochastic(candles, period)
    return round(value - 100, 2) if value is not None else None


def cci(candles: list[Candle], period: int = 20) -> float | None:
    if len(candles) < period:
        return None
    typical = [(item.high + item.low + item.close) / 3 for item in candles[-period:]]
    average = sum(typical) / period
    deviation = sum(abs(value - average) for value in typical) / period
    return round((typical[-1] - average) / (0.015 * deviation), 2) if deviation else 0.0


def calculate(candles: list[Candle]) -> dict[str, float | None]:
    closes = [item.close for item in candles]
    macd_line, signal, histogram = macd(closes)
    return {
        "rsi_14": rsi(closes),
        "macd": macd_line,
        "macd_signal": signal,
        "macd_histogram": histogram,
        "stochastic": stochastic(candles),
        "williams_r": williams_r(candles),
        "cci": cci(candles),
        "roc": round((closes[-1] / closes[-13] - 1) * 100, 2) if len(closes) >= 14 else None,
    }
