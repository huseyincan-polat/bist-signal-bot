"""Price structure: support/resistance, breakouts, gaps, and swing direction."""

from __future__ import annotations

from data.models import Candle


def calculate(candles: list[Candle], lookback: int = 20) -> dict[str, float | bool | str | None]:
    if len(candles) < 3:
        return {
            "support": None, "resistance": None, "breakout": False, "breakdown": False,
            "structure": "BELİRSİZ", "gap": None,
        }
    window = candles[-lookback:-1] if len(candles) > lookback else candles[:-1]
    support = min(item.low for item in window)
    resistance = max(item.high for item in window)
    current, previous = candles[-1], candles[-2]
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
        "breakout": current.close > resistance,
        "breakdown": current.close < support,
        "structure": structure,
        "gap": round(gap, 2) if gap is not None else None,
    }
