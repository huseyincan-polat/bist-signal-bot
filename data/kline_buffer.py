"""In-memory rolling kline buffers with incremental structure updates."""

from __future__ import annotations

from collections import defaultdict, deque
from dataclasses import dataclass

from data.models import Candle, MarketTick
from indicators import price_action, volatility
from indicators.order_blocks import detect_order_block


BUFFER_SIZE = 50
MIN_BARS_FOR_SIGNALS = 35


@dataclass
class StructureSnapshot:
    swing_low: float | None = None
    swing_high: float | None = None
    atr_14: float | None = None
    order_block_low: float | None = None
    order_block_high: float | None = None


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
        if is_closed or len(buffer) >= 14:
            return self._recompute_structure(candle.symbol)
        return None

    def upsert_from_tick(self, tick: MarketTick) -> StructureSnapshot | None:
        """Fallback 1m synthesis from bookTicker when kline streams are quiet."""
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
        else:
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
        if len(buffer) >= 14:
            return self._recompute_structure(tick.symbol)
        return None

    def _recompute_structure(self, symbol: str) -> StructureSnapshot:
        candles_1m = list(self._buffers[symbol]["1m"])
        structure_values = price_action.calculate(candles_1m)
        volatility_values = volatility.calculate(candles_1m)
        order_block = detect_order_block(candles_1m)
        snapshot = StructureSnapshot(
            swing_low=structure_values.get("swing_low"),
            swing_high=structure_values.get("swing_high"),
            atr_14=volatility_values.get("atr_14"),
            order_block_low=order_block.get("order_block_low"),
            order_block_high=order_block.get("order_block_high"),
        )
        self._structure[symbol] = snapshot
        return snapshot
