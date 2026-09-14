"""Relative strength against BIST 100."""

from __future__ import annotations

from data.models import Candle


def relative_strength(symbol_candles: list[Candle], index_candles: list[Candle], lookback: int = 20) -> float | None:
    if len(symbol_candles) <= lookback or len(index_candles) <= lookback:
        return None
    stock_return = symbol_candles[-1].close / symbol_candles[-1 - lookback].close - 1
    index_return = index_candles[-1].close / index_candles[-1 - lookback].close - 1
    return round((stock_return - index_return) * 100, 2)


def score(value: float | None) -> float:
    if value is None:
        return 50
    return max(0, min(100, 50 + value * 8))
