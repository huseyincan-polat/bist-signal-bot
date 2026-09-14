"""Historical-candle utilities and a deterministic local fallback."""

from __future__ import annotations

import math
import random
from datetime import UTC, datetime, timedelta
from typing import Any

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


def yfinance_ticker(symbol: str) -> str:
    """Map a Borsa Istanbul ticker to yfinance's documented `.IS` notation."""
    return f"{symbol}.IS"


def fetch_yfinance_history(
    symbols: list[str],
    *,
    period: str = "6mo",
    limit: int = 100,
) -> dict[str, list[Candle]]:
    """Batch-download delayed daily history for indicator priming only.

    yfinance data is deliberately never reported through ``ProviderHealth`` and
    therefore can never make dashboard data state REAL_TIME.
    """
    try:
        import yfinance as yf
    except ImportError as error:
        raise RuntimeError("yfinance must be installed for historical priming") from error

    ticker_map = {symbol: yfinance_ticker(symbol) for symbol in symbols}
    raw = yf.download(
        list(ticker_map.values()),
        period=period,
        interval="1d",
        auto_adjust=False,
        group_by="ticker",
        progress=False,
        threads=True,
    )
    result: dict[str, list[Candle]] = {}
    for symbol, ticker in ticker_map.items():
        frame = _ticker_frame(raw, ticker)
        candles = _frame_to_candles(symbol, frame)
        if candles:
            result[symbol] = candles[-limit:]
    return result


def _ticker_frame(raw: Any, ticker: str) -> Any:
    """Handle yfinance's grouped multi-ticker DataFrame without pandas APIs."""
    columns = getattr(raw, "columns", None)
    if columns is None:
        return None
    if getattr(columns, "nlevels", 1) > 1:
        try:
            return raw[ticker]
        except KeyError:
            return None
    return raw


def _frame_to_candles(symbol: str, frame: Any) -> list[Candle]:
    if frame is None or getattr(frame, "empty", True):
        return []
    candles: list[Candle] = []
    for timestamp, row in frame.iterrows():
        try:
            values = {str(key).lower(): row[key] for key in row.index}
            if any(not _is_number(values.get(key)) for key in ("open", "high", "low", "close", "volume")):
                continue
            timestamp = timestamp.to_pydatetime()
            if timestamp.tzinfo is None:
                timestamp = timestamp.replace(tzinfo=UTC)
            else:
                timestamp = timestamp.astimezone(UTC)
            candles.append(
                Candle(
                    symbol=symbol,
                    timeframe="daily",
                    timestamp=timestamp,
                    open=float(values["open"]),
                    high=float(values["high"]),
                    low=float(values["low"]),
                    close=float(values["close"]),
                    volume=float(values["volume"]),
                )
            )
        except (AttributeError, KeyError, TypeError, ValueError):
            continue
    return candles


def _is_number(value: object) -> bool:
    return isinstance(value, (int, float)) and not math.isnan(float(value))
