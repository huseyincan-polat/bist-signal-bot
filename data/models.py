"""Timestamped market-domain models shared by providers and strategies."""

from __future__ import annotations

from dataclasses import asdict, dataclass, field
from datetime import UTC, datetime
from enum import Enum
from typing import Any


def utcnow() -> datetime:
    return datetime.now(UTC)


class DataState(str, Enum):
    REAL_TIME = "REAL_TIME"
    STALE_DATA = "STALE_DATA"
    UNAVAILABLE = "UNAVAILABLE"
    MOCK = "MOCK"


class SignalState(str, Enum):
    STRONG_SELL = "GÜÇLÜ SHORT"
    SELL = "SHORT"
    WAIT = "BEKLE"
    BUY = "LONG"
    STRONG_BUY = "GÜÇLÜ LONG"


@dataclass(frozen=True)
class MarketTick:
    symbol: str
    price: float
    timestamp: datetime
    bid: float | None = None
    ask: float | None = None
    tick_volume: float | None = None
    total_volume: float | None = None
    previous_close: float | None = None
    bid_depth: float | None = None
    ask_depth: float | None = None
    source: str = ""

    @property
    def spread(self) -> float | None:
        if self.bid is None or self.ask is None:
            return None
        return self.ask - self.bid


@dataclass(frozen=True)
class Candle:
    symbol: str
    timeframe: str
    timestamp: datetime
    open: float
    high: float
    low: float
    close: float
    volume: float


@dataclass
class ValidationResult:
    accepted: bool
    reason: str | None = None


@dataclass
class ProviderHealth:
    connected: bool = False
    data_state: DataState = DataState.UNAVAILABLE
    provider: str = "unknown"
    first_frame_type: str | None = None
    last_error: str | None = None
    last_data_at: datetime | None = None
    last_data_by_symbol: dict[str, datetime] = field(default_factory=dict)
    symbols_received: set[str] = field(default_factory=set)
    expected_symbols: set[str] = field(default_factory=set)
    partial_coverage_allowed: bool = False
    rotation_stale_after_seconds: int | None = None

    @property
    def missing_symbols(self) -> set[str]:
        return self.expected_symbols - self.symbols_received

    @property
    def ready_for_signals(self) -> bool:
        return (
            self.connected
            and self.data_state is DataState.REAL_TIME
            and (self.partial_coverage_allowed or not self.missing_symbols)
        )

    def symbol_is_stale(self, symbol: str, now: datetime | None = None) -> bool:
        last_data = self.last_data_by_symbol.get(symbol)
        if last_data is None:
            return True
        if self.rotation_stale_after_seconds is None:
            return False
        return ((now or utcnow()) - last_data).total_seconds() > self.rotation_stale_after_seconds


@dataclass
class Signal:
    symbol: str
    state: SignalState
    confidence: int
    price: float
    entry: float
    stop: float | None
    targets: tuple[float | None, float | None, float | None]
    reasons: list[str]
    data_timestamp: datetime
    generated_at: datetime
    provider: str
    metrics: dict[str, float | str | None] = field(default_factory=dict)

    def to_dict(self) -> dict[str, Any]:
        body = asdict(self)
        body["state"] = self.state.value
        body["data_timestamp"] = self.data_timestamp.isoformat()
        body["generated_at"] = self.generated_at.isoformat()
        return body
