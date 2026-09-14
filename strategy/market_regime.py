"""Benchmark futures regime classification."""

from __future__ import annotations

from data.models import Candle
from indicators.trend import ema


def classify_market_regime(candles: list[Candle]) -> str:
    closes = [item.close for item in candles]
    if len(closes) < 50:
        return "NEUTRAL"
    fast, slow = ema(closes, 20), ema(closes, 50)
    if fast is None or slow is None:
        return "NEUTRAL"
    if closes[-1] > fast > slow:
        return "BULLISH"
    if closes[-1] < fast < slow:
        return "BEARISH"
    return "NEUTRAL"
