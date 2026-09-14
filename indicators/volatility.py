"""Volatility indicators."""

from __future__ import annotations

import statistics

from data.models import Candle


def atr(candles: list[Candle], period: int = 14) -> float | None:
    if len(candles) <= period:
        return None
    ranges = [
        max(current.high - current.low, abs(current.high - previous.close), abs(current.low - previous.close))
        for previous, current in zip(candles, candles[1:])
    ]
    value = sum(ranges[:period]) / period
    for item in ranges[period:]:
        value = (value * (period - 1) + item) / period
    return round(value, 4)


def bollinger(values: list[float], period: int = 20, deviations: float = 2) -> tuple[float | None, float | None, float | None, float | None]:
    if len(values) < period:
        return None, None, None, None
    window = values[-period:]
    middle = statistics.fmean(window)
    deviation = statistics.pstdev(window)
    upper, lower = middle + deviations * deviation, middle - deviations * deviation
    width = (upper - lower) / middle if middle else None
    return round(upper, 4), round(middle, 4), round(lower, 4), round(width, 4) if width is not None else None


def calculate(candles: list[Candle]) -> dict[str, float | None]:
    upper, middle, lower, width = bollinger([item.close for item in candles])
    return {
        "atr_14": atr(candles),
        "bb_upper": upper,
        "bb_middle": middle,
        "bb_lower": lower,
        "bb_width": width,
    }
