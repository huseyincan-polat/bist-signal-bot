"""Trend indicators with reusable incremental EMA support."""

from __future__ import annotations

from data.models import Candle


def sma(values: list[float], period: int) -> float | None:
    period = min(period, len(values))
    return sum(values[-period:]) / period if period >= 1 else None


def ema(values: list[float], period: int, previous: float | None = None) -> float | None:
    if not values:
        return None
    period = min(period, len(values))
    if previous is None and len(values) < period:
        return None
    seed = previous if previous is not None else sum(values[:period]) / period
    start = 0 if previous is not None else period
    multiplier = 2 / (period + 1)
    for value in values[start:]:
        seed = (value - seed) * multiplier + seed
    return seed


def adx(candles: list[Candle], period: int = 14) -> tuple[float | None, float | None, float | None]:
    period = min(period, max(2, len(candles) // 2))
    if len(candles) < period + 1:
        return None, None, None
    tr_values: list[float] = []
    plus_dm: list[float] = []
    minus_dm: list[float] = []
    for previous, current in zip(candles, candles[1:]):
        up = current.high - previous.high
        down = previous.low - current.low
        plus_dm.append(up if up > down and up > 0 else 0)
        minus_dm.append(down if down > up and down > 0 else 0)
        tr_values.append(max(current.high - current.low, abs(current.high - previous.close), abs(current.low - previous.close)))
    atr = sum(tr_values[:period])
    plus = sum(plus_dm[:period])
    minus = sum(minus_dm[:period])
    dxs: list[float] = []
    for index in range(period, len(tr_values)):
        atr = atr - (atr / period) + tr_values[index]
        plus = plus - (plus / period) + plus_dm[index]
        minus = minus - (minus / period) + minus_dm[index]
        plus_di = 100 * plus / atr if atr else 0
        minus_di = 100 * minus / atr if atr else 0
        denominator = plus_di + minus_di
        dxs.append(100 * abs(plus_di - minus_di) / denominator if denominator else 0)
    if not dxs:
        return None, None, None
    adx_value = sum(dxs[: min(period, len(dxs))]) / min(period, len(dxs))
    for value in dxs[min(period, len(dxs)):]:
        adx_value = (adx_value * (period - 1) + value) / period
    return round(adx_value, 2), round(plus_di, 2), round(minus_di, 2)


def calculate(candles: list[Candle]) -> dict[str, float | str | None]:
    closes = [item.close for item in candles]
    count = len(closes)
    adx_period = 3 if count < 12 else min(14, max(3, count // 2))
    ema_periods = (3, 5, 8) if count < 12 else (9, 20, 50, 100, 200)
    sma_periods = (3, 5) if count < 12 else (20, 50, 200)
    result: dict[str, float | str | None] = {}
    for period in ema_periods:
        result[f"ema_{period}"] = ema(closes, period)
    for period in sma_periods:
        result[f"sma_{period}"] = sma(closes, period)
    adx_value, plus_di, minus_di = adx(candles, adx_period)
    result.update(adx=adx_value, plus_di=plus_di, minus_di=minus_di)
    current = closes[-1] if closes else None
    fast = result.get("ema_3") or result.get("ema_9") or result.get("ema_20")
    slow = result.get("ema_5") or result.get("ema_20") or result.get("ema_50")
    adx_floor = 8 if count < 12 else 20
    if current is None or fast is None or slow is None:
        result["trend"] = "NÖTR"
    elif current > fast > slow and (adx_value or 0) >= adx_floor:
        result["trend"] = "YÜKSELİŞ"
    elif current < fast < slow and (adx_value or 0) >= adx_floor:
        result["trend"] = "DÜŞÜŞ"
    else:
        result["trend"] = "NÖTR"
    return result
