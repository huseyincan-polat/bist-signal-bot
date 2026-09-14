"""Risk/reward target calculation for analytical signals."""

from __future__ import annotations


def targets(entry: float, stop: float, bullish: bool) -> tuple[float, float, float]:
    risk = abs(entry - stop)
    direction = 1 if bullish else -1
    return tuple(round(entry + direction * risk * multiple, 2) for multiple in (1, 2, 3))  # type: ignore[return-value]
