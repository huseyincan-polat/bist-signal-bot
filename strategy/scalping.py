"""Aggressive tick-driven scoring for short-history scalping."""

from __future__ import annotations


def tick_momentum_pct(prices: list[float]) -> float:
    """Recent tick acceleration as a signed percent move."""
    if len(prices) < 2:
        return 0.0
    return round((prices[-1] / prices[0] - 1) * 100, 4)


def scalping_score(
    rsi: float | None,
    macd_histogram: float | None,
    tick_momentum: float,
    volume_spike: bool,
    volatility_wide: bool,
) -> int:
    """Bias score away from the WAIT bucket using RSI extremes and tick flow."""
    score = 50.0
    rsi_value = rsi if rsi is not None else 50.0
    if rsi_value >= 72:
        score += 28
    elif rsi_value >= 60:
        score += 16
    elif rsi_value <= 28:
        score -= 28
    elif rsi_value <= 40:
        score -= 16

    if tick_momentum >= 0.08:
        score += 18
    elif tick_momentum >= 0.02:
        score += 8
    elif tick_momentum <= -0.08:
        score -= 18
    elif tick_momentum <= -0.02:
        score -= 8

    histogram = macd_histogram or 0.0
    if histogram > 0:
        score += 10
    elif histogram < 0:
        score -= 10

    if volume_spike:
        score += 6 if tick_momentum >= 0 else -6
    if volatility_wide:
        score += 4 if abs(tick_momentum) > 0.03 else 0

    return round(max(0, min(100, score)))
