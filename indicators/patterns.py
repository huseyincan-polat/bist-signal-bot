"""Conservative recognition of common Japanese candlestick patterns."""

from __future__ import annotations

from data.models import Candle


def _body(candle: Candle) -> float:
    return abs(candle.close - candle.open)


def calculate(candles: list[Candle]) -> dict[str, bool]:
    if len(candles) < 3:
        return {name: False for name in ("doji", "hammer", "shooting_star", "bullish_engulfing", "bearish_engulfing", "morning_star", "evening_star")}
    first, previous, current = candles[-3:]
    body = _body(current)
    span = max(current.high - current.low, 0.0001)
    doji = body / span <= 0.1
    lower_shadow = min(current.open, current.close) - current.low
    upper_shadow = current.high - max(current.open, current.close)
    bullish_engulfing = previous.close < previous.open and current.close > current.open and current.close >= previous.open and current.open <= previous.close
    bearish_engulfing = previous.close > previous.open and current.close < current.open and current.open >= previous.close and current.close <= previous.open
    return {
        "doji": doji,
        "hammer": lower_shadow >= body * 2 and upper_shadow <= body and current.close >= current.open,
        "shooting_star": upper_shadow >= body * 2 and lower_shadow <= body and current.close <= current.open,
        "bullish_engulfing": bullish_engulfing,
        "bearish_engulfing": bearish_engulfing,
        "morning_star": first.close < first.open and _body(previous) < _body(first) * 0.5 and current.close > current.open,
        "evening_star": first.close > first.open and _body(previous) < _body(first) * 0.5 and current.close < current.open,
    }
