"""Signal risk levels only. This project deliberately contains no order API."""

from __future__ import annotations

def stop_price(
    price: float,
    atr: float | None,
    support: float | None,
    resistance: float | None,
    bullish: bool,
) -> float:
    """Combine an ATR stop with the latest swing support/resistance."""
    distance = max((atr or price * 0.02) * 1.5, price * 0.008)
    atr_stop = price - distance if bullish else price + distance
    swing = support if bullish else resistance
    if swing is None:
        return round(atr_stop, 2)
    return round(min(atr_stop, swing) if bullish else max(atr_stop, swing), 2)
