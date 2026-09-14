"""Provider contracts and the local mock implementation.

No provider in this project contains order-routing functionality.
"""

from __future__ import annotations

import asyncio
import hashlib
import random
from abc import ABC, abstractmethod
from collections.abc import AsyncIterator
from datetime import UTC, datetime

from app.config import AppConfig
from data.historical import synthetic_candles
from data.models import Candle, MarketTick, ProviderHealth
from data.realtime import ConnectionMonitor, TickValidator


class DataProvider(ABC):
    """Code-independent source of timestamped market data."""

    name: str
    is_real_time: bool = False
    allows_delayed_analysis: bool = False
    symbols: tuple[str, ...] = ()

    @abstractmethod
    async def connect(self) -> None: ...

    @abstractmethod
    async def stream(self) -> AsyncIterator[MarketTick]: ...

    @abstractmethod
    def historical_candles(self, symbol: str, timeframe: str) -> list[Candle]: ...

    @property
    @abstractmethod
    def health(self) -> ProviderHealth: ...

    def health_check(self) -> dict[str, bool | str | None]:
        health = self.health
        return {
            "connected": health.connected,
            "last_message_fresh": health.data_state.value == "REAL_TIME",
            "data_state": health.data_state.value,
            "last_message_at": health.last_data_at.isoformat() if health.last_data_at else None,
        }


class RealTimeProvider(DataProvider):
    """Marker base for a documented real-time vendor source."""

    is_real_time = True


class HistoricalProvider(DataProvider):
    """Marker base for providers able to return historical candles."""


class MockProvider(HistoricalProvider):
    """Local fixture feed only; never qualifies as real-time."""

    name = "mock (local test data)"
    is_real_time = False

    def __init__(self, config: AppConfig) -> None:
        self.config = config
        self.symbols = config.symbols or ("BTCUSDT", "ETHUSDT")
        self._monitor = ConnectionMonitor(self.name, set(self.symbols), config.stale_after_seconds)
        self._validator = TickValidator(config.stale_after_seconds)
        self._prices = {symbol: self._seed_price(symbol) for symbol in self.symbols}
        self._rng = random.Random(100)

    @staticmethod
    def _seed_price(symbol: str) -> float:
        return 20 + (int(hashlib.sha256(symbol.encode()).hexdigest()[:6], 16) % 7000) / 100

    @property
    def health(self) -> ProviderHealth:
        return self._monitor.refresh_freshness()

    async def connect(self) -> None:
        self._monitor.mark_connected()

    async def stream(self) -> AsyncIterator[MarketTick]:
        while True:
            for symbol, previous in self._prices.items():
                price = max(0.1, previous * (1 + self._rng.uniform(-0.002, 0.002)))
                self._prices[symbol] = price
                tick = MarketTick(
                    symbol=symbol,
                    price=round(price, 2),
                    bid=round(price - 0.01, 2),
                    ask=round(price + 0.01, 2),
                    tick_volume=self._rng.randint(100, 20_000),
                    total_volume=self._rng.randint(100_000, 5_000_000),
                    timestamp=datetime.now(UTC),
                    source=self.name,
                )
                if self._validator.validate(tick).accepted:
                    self._monitor.record_tick(tick, real_time=False)
                    yield tick
            await asyncio.sleep(0.4)

    def historical_candles(self, symbol: str, timeframe: str) -> list[Candle]:
        return synthetic_candles(symbol, timeframe)


def create_provider(config: AppConfig) -> DataProvider:
    if config.provider_name == "binance_futures":
        from data.binance_futures import BinanceFuturesProvider

        return BinanceFuturesProvider(config)
    if config.provider_name == "mock":
        return MockProvider(config)
    raise ValueError(f"Unsupported data provider: {config.provider_name}")
