"""Simple order-block style zones from completed 1m structure."""

from __future__ import annotations

from data.models import Candle


def detect_order_block(candles: list[Candle], lookback: int = 12) -> dict[str, float | None]:
    """Identify the last opposing candle before a displacement move."""
    if len(candles) < 4:
        return {"order_block_low": None, "order_block_high": None}
    window = candles[-lookback:]
    order_block_low: float | None = None
    order_block_high: float | None = None
    for index in range(1, len(window) - 1):
        previous, current, nxt = window[index - 1], window[index], window[index + 1]
        bearish = current.close < current.open
        bullish = current.close > current.open
        bullish_displacement = nxt.close > current.high and nxt.close > previous.high
        bearish_displacement = nxt.close < current.low and nxt.close < previous.low
        if bearish and bullish_displacement:
            order_block_low = current.low
            order_block_high = current.high
        if bullish and bearish_displacement:
            order_block_low = current.low
            order_block_high = current.high
    return {"order_block_low": order_block_low, "order_block_high": order_block_high}
