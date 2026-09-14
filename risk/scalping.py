"""Fixed-percent scalping risk plan (1% stop / 3% target, 1:3 R:R)."""

from __future__ import annotations

from dataclasses import dataclass


@dataclass(frozen=True)
class RiskPlan:
    stop: float | None
    targets: tuple[float | None, float | None, float | None]
    reward_to_risk: float | None
    valid: bool
    reason: str | None = None


def scalping_risk_plan(
    entry: float,
    bullish: bool,
    stop_pct: float = 0.01,
    target_pct: float = 0.03,
) -> RiskPlan:
    """Percent-based stop and target for fast futures scalping signals."""
    if entry <= 0:
        return RiskPlan(None, (None, None, None), None, False, "Geçersiz giriş fiyatı")
    if bullish:
        stop = round(entry * (1 - stop_pct), 8)
        targets = (
            round(entry * (1 + target_pct), 8),
            round(entry * (1 + target_pct * 1.5), 8),
            round(entry * (1 + target_pct * 2), 8),
        )
    else:
        stop = round(entry * (1 + stop_pct), 8)
        targets = (
            round(entry * (1 - target_pct), 8),
            round(entry * (1 - target_pct * 1.5), 8),
            round(entry * (1 - target_pct * 2), 8),
        )
    risk = abs(entry - stop)
    reward = abs(targets[0] - entry)
    reward_to_risk = round(reward / risk, 2) if risk else None
    return RiskPlan(stop, targets, reward_to_risk, True)
