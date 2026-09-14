"""Transparent, configurable 0–100 technical-signal scoring."""

from __future__ import annotations

from data.models import SignalState

WEIGHTS = {
    "trend": 0.20,
    "momentum": 0.15,
    "volume": 0.10,
    "breakout": 0.10,
    "volatility": 0.08,
    "multi_timeframe": 0.15,
    "market_regime": 0.12,
    "relative_strength": 0.10,
}


def classify(score: int, buckets: dict[str, int] | None = None) -> SignalState:
    limits = buckets or {
        "strong_sell_max": 29,
        "sell_max": 44,
        "wait_max": 59,
        "buy_max": 74,
    }
    if score <= int(limits["strong_sell_max"]):
        return SignalState.STRONG_SELL
    if score <= int(limits["sell_max"]):
        return SignalState.SELL
    if score <= int(limits["wait_max"]):
        return SignalState.WAIT
    if score <= int(limits["buy_max"]):
        return SignalState.BUY
    return SignalState.STRONG_BUY


def is_bullish(state: SignalState) -> bool:
    return state in (SignalState.BUY, SignalState.STRONG_BUY)


def aggregate(components: dict[str, float], regime: str, bearish_penalty: int = 12) -> int:
    score = sum(WEIGHTS[name] * max(0, min(100, components.get(name, 50))) for name in WEIGHTS)
    if regime == "BEARISH":
        score -= bearish_penalty
    elif regime == "BULLISH":
        score += 3
    return round(max(0, min(100, score)))


def meaningful_transition(previous: SignalState | None, current: SignalState) -> bool:
    """Only entry/exit-grade transitions and strong extremes are alerts."""
    if previous is None:
        return current in (SignalState.STRONG_BUY, SignalState.STRONG_SELL)
    if previous == current:
        return False
    key = {SignalState.STRONG_SELL: 0, SignalState.SELL: 1, SignalState.WAIT: 2, SignalState.BUY: 3, SignalState.STRONG_BUY: 4}
    return abs(key[current] - key[previous]) >= 1 and (
        previous == SignalState.WAIT
        or current == SignalState.WAIT
        or previous in (SignalState.STRONG_BUY, SignalState.STRONG_SELL)
        or current in (SignalState.STRONG_BUY, SignalState.STRONG_SELL)
    )
