"""Signal risk levels only. This project deliberately contains no order API."""

from __future__ import annotations

from dataclasses import dataclass


@dataclass(frozen=True)
class StructuralStop:
    stop: float | None
    risk: float | None
    valid: bool
    reason: str | None = None


def structural_stop(
    entry: float,
    atr: float | None,
    swing_low: float | None,
    swing_high: float | None,
    bullish: bool,
    max_stop_loss_pct: float = 0.03,
) -> StructuralStop:
    """Use the deeper of a confirmed swing and an ATR stop; never use percent bands."""
    pivot = swing_low if bullish else swing_high
    if atr is None or atr <= 0 or pivot is None:
        return StructuralStop(None, None, False, "ATR veya teyitli swing pivotu yok")
    atr_stop = entry - 1.5 * atr if bullish else entry + 1.5 * atr
    technical_stop = min(pivot, atr_stop) if bullish else max(pivot, atr_stop)
    risk = abs(entry - technical_stop)
    if risk <= 0:
        return StructuralStop(None, None, False, "Teknik stop giriş yönünün dışında")
    if risk / entry > max_stop_loss_pct:
        return StructuralStop(None, risk, False, "Teknik stop azami %3 zarar sınırını aşıyor")
    return StructuralStop(round(technical_stop, 2), round(risk, 4), True)
