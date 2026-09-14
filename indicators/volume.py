"""Volume, relative-volume, OBV, and intraday VWAP indicators."""

from __future__ import annotations

from data.models import Candle
from indicators.trend import sma


def calculate(candles: list[Candle]) -> dict[str, float | bool | None]:
    if not candles:
        return {"volume": None, "volume_sma_20": None, "relative_volume": None, "obv": None, "vwap": None, "volume_spike": False}
    volumes = [item.volume for item in candles]
    average = sma(volumes, min(20, max(3, len(volumes))))
    relative = volumes[-1] / average if average else None
    obv = 0.0
    for previous, current in zip(candles, candles[1:]):
        if current.close > previous.close:
            obv += current.volume
        elif current.close < previous.close:
            obv -= current.volume
    cumulative_volume = sum(item.volume for item in candles)
    vwap = (
        sum(((item.high + item.low + item.close) / 3) * item.volume for item in candles) / cumulative_volume
        if cumulative_volume
        else None
    )
    return {
        "volume": volumes[-1],
        "volume_sma_20": average,
        "relative_volume": round(relative, 2) if relative is not None else None,
        "obv": round(obv, 2),
        "vwap": round(vwap, 3) if vwap is not None else None,
        "volume_spike": bool(relative and relative >= 1.8),
    }
