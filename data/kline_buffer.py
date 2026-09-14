"""In-memory rolling kline buffers with incremental structure updates."""

from __future__ import annotations

from collections import defaultdict, deque
from dataclasses import dataclass
from datetime import UTC, datetime, timedelta

from data.models import Candle, MarketTick
from indicators import price_action, volatility
from indicators.order_blocks import detect_order_block


BUFFER_SIZE = 50
MIN_BARS_FOR_SIGNALS = 5
SEED_BARS = 5
SYNTHETIC_TREND_PERIODS = ("15m", "1h", "4h", "daily")


@dataclass
class StructureSnapshot:
    swing_low: float | None = None
    swing_high: float | None = None
    atr_14: float | None = None
    order_block_low: float | None = None
    order_block_high: float | None = None


@dataclass(frozen=True)
class SyntheticTrends:
    trend_15m: str = "FLAT"
    trend_1h: str = "FLAT"
    trend_4h: str = "FLAT"
    trend_daily: str = "FLAT"

    def all_up(self, *periods: str) -> bool:
        mapping = {
            "15m": self.trend_15m,
            "1h": self.trend_1h,
            "4h": self.trend_4h,
            "daily": self.trend_daily,
        }
        return all(mapping[period] == "UP" for period in periods)

    def all_down(self, *periods: str) -> bool:
        mapping = {
            "15m": self.trend_15m,
            "1h": self.trend_1h,
            "4h": self.trend_4h,
            "daily": self.trend_daily,
        }
        return all(mapping[period] == "DOWN" for period in periods)


def _bucket_start(timestamp: datetime, period: str) -> datetime:
    ts = timestamp.astimezone(UTC)
    if period == "15m":
        minute = (ts.minute // 15) * 15
        return ts.replace(minute=minute, second=0, microsecond=0)
    if period == "1h":
        return ts.replace(minute=0, second=0, microsecond=0)
    if period == "4h":
        hour = (ts.hour // 4) * 4
        return ts.replace(hour=hour, minute=0, second=0, microsecond=0)
    return ts.replace(hour=0, minute=0, second=0, microsecond=0)


class KlineBufferStore:
    """Rolling deques per symbol/timeframe; recomputes SMC metrics on each update."""

    def __init__(self, maxlen: int = BUFFER_SIZE) -> None:
        self._maxlen = maxlen
        self._buffers: dict[str, dict[str, deque[Candle]]] = defaultdict(
            lambda: {
                "1m": deque(maxlen=maxlen),
                "1h": deque(maxlen=maxlen),
            }
        )
        self._structure: dict[str, StructureSnapshot] = {}
        self._seeded: set[str] = set()
        self._period_bucket: dict[str, dict[str, datetime]] = defaultdict(dict)
        self._period_opens: dict[str, dict[str, float]] = defaultdict(dict)
        self.kline_frames_received = 0

    def candles(self, symbol: str, timeframe: str) -> list[Candle]:
        return list(self._buffers[symbol][timeframe])

    def structure(self, symbol: str) -> StructureSnapshot:
        return self._structure.get(symbol, StructureSnapshot())

    def symbols_with_min_bars(self, minimum: int = MIN_BARS_FOR_SIGNALS) -> set[str]:
        ready: set[str] = set()
        for symbol, frames in self._buffers.items():
            if len(frames["1m"]) >= minimum:
                ready.add(symbol)
        return ready

    def symbols_with_full_buffers(self, size: int = BUFFER_SIZE) -> set[str]:
        return {symbol for symbol, frames in self._buffers.items() if len(frames["1m"]) >= size}

    def reset_symbol(self, symbol: str) -> None:
        self._buffers.pop(symbol, None)
        self._structure.pop(symbol, None)
        self._seeded.discard(symbol)
        self._period_bucket.pop(symbol, None)
        self._period_opens.pop(symbol, None)

    def reset_symbols(self, symbols: list[str]) -> None:
        for symbol in symbols:
            self.reset_symbol(symbol)

    def synthetic_trends(self, symbol: str, price: float) -> SyntheticTrends:
        opens = self._period_opens.get(symbol, {})
        trends: dict[str, str] = {}
        for period in SYNTHETIC_TREND_PERIODS:
            open_price = opens.get(period)
            if open_price is None:
                trends[period] = "FLAT"
            elif price > open_price:
                trends[period] = "UP"
            elif price < open_price:
                trends[period] = "DOWN"
            else:
                trends[period] = "FLAT"
        return SyntheticTrends(
            trend_15m=trends["15m"],
            trend_1h=trends["1h"],
            trend_4h=trends["4h"],
            trend_daily=trends["daily"],
        )

    def _update_synthetic_trends(self, tick: MarketTick) -> SyntheticTrends:
        for period in SYNTHETIC_TREND_PERIODS:
            bucket = _bucket_start(tick.timestamp, period)
            if self._period_bucket[tick.symbol].get(period) != bucket:
                self._period_bucket[tick.symbol][period] = bucket
                self._period_opens[tick.symbol][period] = tick.price
        return self.synthetic_trends(tick.symbol, tick.price)

    def seed_from_tick(self, tick: MarketTick) -> StructureSnapshot | None:
        """Bootstrap five 1m bars from the first live mid so analysis can start immediately."""
        if tick.symbol in self._seeded:
            return None
        minute = tick.timestamp.replace(second=0, microsecond=0)
        price = tick.price
        buffer = self._buffers[tick.symbol]["1m"]
        for offset in range(SEED_BARS):
            timestamp = minute - timedelta(minutes=SEED_BARS - 1 - offset)
            buffer.append(
                Candle(
                    symbol=tick.symbol,
                    timeframe="1m",
                    timestamp=timestamp,
                    open=price,
                    high=price,
                    low=price,
                    close=price,
                    volume=0,
                )
            )
        hour = minute.replace(minute=0)
        hour_buffer = self._buffers[tick.symbol]["1h"]
        for offset in range(SEED_BARS):
            timestamp = hour - timedelta(hours=SEED_BARS - 1 - offset)
            hour_buffer.append(
                Candle(
                    symbol=tick.symbol,
                    timeframe="1h",
                    timestamp=timestamp,
                    open=price,
                    high=price,
                    low=price,
                    close=price,
                    volume=0,
                )
            )
        self._seeded.add(tick.symbol)
        return self._recompute_structure(tick.symbol)

    def upsert_kline(self, candle: Candle, is_closed: bool) -> StructureSnapshot | None:
        """Apply an official kline WS update, including open-bar revisions."""
        self.kline_frames_received += 1
        buffer = self._buffers[candle.symbol][candle.timeframe]
        if buffer and buffer[-1].timestamp == candle.timestamp:
            buffer[-1] = candle
        elif not buffer or candle.timestamp > buffer[-1].timestamp:
            buffer.append(candle)
        else:
            buffer[-1] = candle
        if is_closed or len(buffer) >= MIN_BARS_FOR_SIGNALS:
            return self._recompute_structure(candle.symbol)
        return None

    def upsert_from_tick(self, tick: MarketTick) -> StructureSnapshot | None:
        """Update the live 1m bar from bookTicker; seed first if needed."""
        self.seed_from_tick(tick)
        self._update_synthetic_trends(tick)
        minute = tick.timestamp.replace(second=0, microsecond=0)
        buffer = self._buffers[tick.symbol]["1m"]
        if buffer and buffer[-1].timestamp == minute:
            previous = buffer[-1]
            buffer[-1] = Candle(
                symbol=tick.symbol,
                timeframe="1m",
                timestamp=minute,
                open=previous.open,
                high=max(previous.high, tick.price),
                low=min(previous.low, tick.price),
                close=tick.price,
                volume=previous.volume + (tick.tick_volume or 0),
            )
        elif not buffer or buffer[-1].timestamp < minute:
            buffer.append(
                Candle(
                    symbol=tick.symbol,
                    timeframe="1m",
                    timestamp=minute,
                    open=tick.price,
                    high=tick.price,
                    low=tick.price,
                    close=tick.price,
                    volume=tick.tick_volume or 0,
                )
            )
        if len(buffer) >= MIN_BARS_FOR_SIGNALS:
            return self._recompute_structure(tick.symbol)
        return None

    def _recompute_structure(self, symbol: str) -> StructureSnapshot:
        candles_1m = list(self._buffers[symbol]["1m"])
        structure_values = price_action.calculate(candles_1m)
        volatility_values = volatility.calculate(candles_1m)
        order_block = detect_order_block(candles_1m)
        atr_14 = volatility_values.get("atr_14")
        if (atr_14 is None or atr_14 <= 0) and candles_1m:
            atr_14 = round(candles_1m[-1].close * 0.003, 4)
        snapshot = StructureSnapshot(
            swing_low=structure_values.get("swing_low"),
            swing_high=structure_values.get("swing_high"),
            atr_14=atr_14,
            order_block_low=order_block.get("order_block_low"),
            order_block_high=order_block.get("order_block_high"),
        )
        self._structure[symbol] = snapshot
        return snapshot
