"""Historical-candle utilities and a deterministic local fallback."""

from __future__ import annotations

import math
import random
from datetime import UTC, datetime, timedelta

from data.models import Candle


def synthetic_candles(symbol: str, timeframe: str, count: int = 240) -> list[Candle]:
    """Generate repeatable local test data; it is intentionally never real-time."""
    seed = sum(ord(char) for char in f"{symbol}:{timeframe}")
    rng = random.Random(seed)
    interval = {"1m": 1, "5m": 5, "15m": 15, "1h": 60, "daily": 1440}[timeframe]
    end = datetime.now(UTC).replace(second=0, microsecond=0)
    base = 20 + (seed % 800) / 10
    candles: list[Candle] = []
    for index in range(count):
        trend = index * 0.012
        wave = math.sin(index / 11) * (base * 0.015)
        close = max(0.5, base + trend + wave + rng.uniform(-base * 0.012, base * 0.012))
        open_ = candles[-1].close if candles else close * (1 + rng.uniform(-0.01, 0.01))
        high = max(open_, close) * (1 + rng.uniform(0.001, 0.012))
        low = min(open_, close) * (1 - rng.uniform(0.001, 0.012))
        candles.append(
            Candle(
                symbol=symbol,
                timeframe=timeframe,
                timestamp=end - timedelta(minutes=interval * (count - index)),
                open=round(open_, 2),
                high=round(high, 2),
                low=round(low, 2),
                close=round(close, 2),
                volume=round(rng.uniform(60_000, 800_000), 2),
            )
        )
    return candles


def merge_candles(existing: list[Candle], backfill: list[Candle]) -> list[Candle]:
    """Merge a reconnect backfill by its timestamp without duplicate candles."""
    by_time = {candle.timestamp: candle for candle in existing}
    by_time.update({candle.timestamp: candle for candle in backfill})
    return sorted(by_time.values(), key=lambda candle: candle.timestamp)
