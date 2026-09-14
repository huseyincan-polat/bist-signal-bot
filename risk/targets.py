"""Risk/reward target calculation for analytical signals."""

from __future__ import annotations

from dataclasses import dataclass

from risk.stops import structural_stop


@dataclass(frozen=True)
class RiskPlan:
    stop: float | None
    targets: tuple[float | None, float | None, float | None]
    reward_to_risk: float | None
    valid: bool
    reason: str | None = None


def structure_risk_plan(
    entry: float,
    atr: float | None,
    swing_low: float | None,
    swing_high: float | None,
    bullish: bool,
) -> RiskPlan:
    """Create non-symmetric targets from the opposite pivot plus ATR expansion."""
    stop_result = structural_stop(entry, atr, swing_low, swing_high, bullish)
    if not stop_result.valid or stop_result.stop is None or stop_result.risk is None:
        return RiskPlan(None, (None, None, None), None, False, stop_result.reason)
    if bullish:
        if swing_high is None:
            return RiskPlan(None, (None, None, None), None, False, "Teyitli swing high yok")
        target_1 = max(swing_high, entry + atr)
        target_2 = max(swing_high + atr, entry + 2 * atr)
        target_3 = max(swing_high + 2 * atr, entry + 3 * atr)
        reward = target_3 - entry
    else:
        if swing_low is None:
            return RiskPlan(None, (None, None, None), None, False, "Teyitli swing low yok")
        target_1 = min(swing_low, entry - atr)
        target_2 = min(swing_low - atr, entry - 2 * atr)
        target_3 = min(swing_low - 2 * atr, entry - 3 * atr)
        reward = entry - target_3
    reward_to_risk = reward / stop_result.risk
    if reward_to_risk < 3:
        return RiskPlan(
            None,
            (None, None, None),
            round(reward_to_risk, 2),
            False,
            "Yapısal hedef azami zararın 3 katını karşılamıyor",
        )
    return RiskPlan(
        stop_result.stop,
        (round(target_1, 2), round(target_2, 2), round(target_3, 2)),
        round(reward_to_risk, 2),
        True,
    )
