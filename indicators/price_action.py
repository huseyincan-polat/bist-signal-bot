"""Price structure: support/resistance, breakouts, gaps, and swing direction."""

from __future__ import annotations

from data.models import Candle


def swing_pivots(candles: list[Candle], strength: int = 2) -> tuple[list[float], list[float]]:
    """Return confirmed local swing lows and highs from completed candles."""
    lows: list[float] = []
    highs: list[float] = []
    for index in range(strength, len(candles) - strength):
        window = candles[index - strength:index + strength + 1]
        candle = candles[index]
        if candle.low == min(item.low for item in window):
            lows.append(candle.low)
        if candle.high == max(item.high for item in window):
            highs.append(candle.high)
    return lows, highs


def calculate(candles: list[Candle], lookback: int = 20) -> dict[str, float | bool | str | None]:
    if len(candles) < 3:
        return {
            "support": None, "resistance": None, "breakout": False, "breakdown": False,
            "structure": "BELİRSİZ", "gap": None,
        }
    window = candles[-lookback:-1] if len(candles) > lookback else candles[:-1]
    current, previous = candles[-1], candles[-2]
    pivot_lows, pivot_highs = swing_pivots(window)
    supports = [value for value in pivot_lows if value < current.close]
    resistances = [value for value in pivot_highs if value > current.close]
    support = max(supports) if supports else min(item.low for item in window)
    resistance = min(resistances) if resistances else max(item.high for item in window)
    if current.high > previous.high and current.low > previous.low:
        structure = "HH/HL"
    elif current.high < previous.high and current.low < previous.low:
        structure = "LH/LL"
    else:
        structure = "KARMA"
    gap = (current.open / previous.close - 1) * 100 if previous.close else None
    return {
        "support": round(support, 3),
        "resistance": round(resistance, 3),
        "swing_low": round(support, 3),
        "swing_high": round(resistance, 3),
        "breakout": current.close > resistance,
        "breakdown": current.close < support,
        "structure": structure,
        "gap": round(gap, 2) if gap is not None else None,
    }
