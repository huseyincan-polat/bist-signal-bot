"""Provider adapters. No order-routing capability exists in this module."""

from __future__ import annotations

import asyncio
import hashlib
import random
from abc import ABC, abstractmethod
from collections import defaultdict
from collections.abc import AsyncIterator
from datetime import UTC, datetime

from app.config import AppConfig
from data.historical import synthetic_candles
from data.models import Candle, MarketTick, ProviderHealth
from data.realtime import ConnectionMonitor, TickValidator
from data.websocket import DxLinkClient


class DataProvider(ABC):
    """Code-independent source of timestamped market data."""

    name: str
    is_real_time: bool = False
    allows_delayed_analysis: bool = False

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
        """Return a provider-agnostic live-data readiness snapshot."""
        health = self.health
        return {
            "connected": health.connected,
            "last_message_fresh": health.data_state.value == "REAL_TIME",
            "data_state": health.data_state.value,
            "last_message_at": health.last_data_at.isoformat() if health.last_data_at else None,
        }


class RealTimeProvider(DataProvider):
    """Marker base for an entitled vendor-backed real-time source."""

    is_real_time = True


class HistoricalProvider(DataProvider):
    """Marker base for providers able to return historical candles."""


class MockProvider(HistoricalProvider):
    """Deterministic local data only; cannot ever authorize signal delivery."""

    name = "mock (local test data)"
    is_real_time = False

    def __init__(self, config: AppConfig) -> None:
        self.config = config
        self.index_symbol = config.index_symbol.split(":")[0]
        expected = set(config.symbols) | {self.index_symbol}
        self._monitor = ConnectionMonitor(self.name, expected, config.stale_after_seconds)
        self._validator = TickValidator(config.stale_after_seconds)
        self._prices = {symbol: self._seed_price(symbol) for symbol in expected}
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
                timestamp = datetime.now(UTC)
                tick = MarketTick(
                    symbol=symbol,
                    price=round(price, 2),
                    bid=round(price - 0.01, 2),
                    ask=round(price + 0.01, 2),
                    tick_volume=self._rng.randint(100, 20_000),
                    total_volume=self._rng.randint(100_000, 5_000_000),
                    timestamp=timestamp,
                    source=self.name,
                )
                if self._validator.validate(tick).accepted:
                    self._monitor.record_tick(tick, real_time=False)
                    yield tick
            await asyncio.sleep(0.4)

    def historical_candles(self, symbol: str, timeframe: str) -> list[Candle]:
        return synthetic_candles(symbol, timeframe)


class DxFeedProvider(RealTimeProvider, HistoricalProvider):
    """dxFeed dxLink adapter, using a customer-provided documented endpoint."""

    name = "dxFeed dxLink"

    def __init__(self, config: AppConfig) -> None:
        self.config = config
        self.symbols = [self._dx_symbol(symbol) for symbol in config.symbols]
        self.index_symbol = config.index_symbol
        expected = set(config.symbols) | {self.index_symbol.split(":")[0]}
        self._monitor = ConnectionMonitor(self.name, expected, config.stale_after_seconds)
        self._validator = TickValidator(config.stale_after_seconds)
        self._quotes: dict[str, dict[str, float]] = {}
        self._history: dict[tuple[str, str], list[Candle]] = defaultdict(list)
        self._candle_from_times: dict[str, int] = {}

    @staticmethod
    def _dx_symbol(symbol: str) -> str:
        return symbol if ":" in symbol else f"{symbol}:TR"

    @staticmethod
    def _local_symbol(symbol: str) -> str:
        return symbol.split(":")[0].split("{")[0]

    @property
    def health(self) -> ProviderHealth:
        return self._monitor.refresh_freshness()

    async def connect(self) -> None:
        if not self.config.is_dxfeed_configured:
            self._monitor.mark_error("dxFeed endpoint or token is not configured")
            raise RuntimeError("DXFEED_WS_URL and DXFEED_TOKEN are required for dxFeed")
        # The actual connection is opened by stream() so startup can verify received data.
        self._monitor.mark_connected()

    async def stream(self) -> AsyncIterator[MarketTick]:
        await self.connect()
        dx_symbols = self.symbols + [self.index_symbol]
        client = DxLinkClient(
            self.config.dxfeed_websocket_url or "",
            self.config.dxfeed_token,
            dx_symbols,
            self._candle_from_times,
        )
        async for event in client.events(self.config.reconnect_backoff_seconds):
            if event.get("eventType") == "connection_error":
                self._monitor.mark_error("dxFeed stream disconnected")
                continue
            self._monitor.mark_connected()
            tick = self._parse_event(event)
            if tick and self._validator.validate(tick).accepted:
                self._monitor.record_tick(tick, real_time=True)
                yield tick

    def _parse_event(self, event: dict[str, object]) -> MarketTick | None:
        event_type = str(event.get("eventType", ""))
        raw_symbol = str(event.get("eventSymbol", ""))
        symbol = self._local_symbol(raw_symbol)
        timestamp_ms = event.get("time") or event.get("eventTime")
        if not symbol or not isinstance(timestamp_ms, (int, float)):
            return None
        timestamp = datetime.fromtimestamp(float(timestamp_ms) / 1000, UTC)
        if event_type == "Quote":
            bid, ask = event.get("bidPrice"), event.get("askPrice")
            if isinstance(bid, (int, float)) and isinstance(ask, (int, float)):
                self._quotes[symbol] = {"bid": float(bid), "ask": float(ask)}
            return None
        if event_type == "Candle":
            required = ("open", "high", "low", "close", "volume")
            if not all(isinstance(event.get(key), (int, float)) for key in required):
                return None
            candle = Candle(
                symbol=symbol,
                timeframe="1m",
                timestamp=timestamp,
                open=float(event["open"]),
                high=float(event["high"]),
                low=float(event["low"]),
                close=float(event["close"]),
                volume=float(event["volume"]),
            )
            self._history[(symbol, "1m")].append(candle)
            self._history[(symbol, "1m")] = self._history[(symbol, "1m")][-600:]
            self._candle_from_times[self._dx_symbol(symbol)] = int(timestamp.timestamp() * 1000) - 60_000
            return None
        if event_type != "Trade" or not isinstance(event.get("price"), (int, float)):
            return None
        quote = self._quotes.get(symbol, {})
        return MarketTick(
            symbol=symbol,
            price=float(event["price"]),
            timestamp=timestamp,
            bid=quote.get("bid"),
            ask=quote.get("ask"),
            tick_volume=float(event["size"]) if isinstance(event.get("size"), (int, float)) else None,
            total_volume=float(event["dayVolume"]) if isinstance(event.get("dayVolume"), (int, float)) else None,
            source=self.name,
        )

    def historical_candles(self, symbol: str, timeframe: str) -> list[Candle]:
        # dxLink Candle events populate this cache; no undocumented HTTP endpoint is used.
        return list(self._history.get((symbol, timeframe), []))


def create_provider(config: AppConfig) -> DataProvider:
    if config.provider_name == "batch_yfinance":
        from data.yfinance_provider import YahooBatchProvider

        return YahooBatchProvider(config)
    if config.provider_name == "dxfeed":
        return DxFeedProvider(config)
    if config.provider_name == "mock":
        return MockProvider(config)
    raise ValueError(f"Unsupported data provider: {config.provider_name}")
