"""Real-time tick validation and connection-health tracking."""

from __future__ import annotations

from datetime import UTC, datetime

from data.models import DataState, MarketTick, ProviderHealth, ValidationResult


class TickValidator:
    """Reject malformed, duplicated, out-of-order, and stale ticks."""

    def __init__(self, stale_after_seconds: int) -> None:
        self.stale_after_seconds = stale_after_seconds
        self._last_tick: dict[str, MarketTick] = {}

    def validate(self, tick: MarketTick, now: datetime | None = None) -> ValidationResult:
        now = now or datetime.now(UTC)
        if tick.timestamp.tzinfo is None:
            return ValidationResult(False, "timestamp timezone bilgisi yok")
        if tick.price <= 0:
            return ValidationResult(False, "geçersiz fiyat")
        if (now - tick.timestamp).total_seconds() > self.stale_after_seconds:
            return ValidationResult(False, "STALE_DATA")
        if (tick.timestamp - now).total_seconds() > 10:
            return ValidationResult(False, "gelecek zaman damgası")
        previous = self._last_tick.get(tick.symbol)
        if previous:
            if tick.timestamp < previous.timestamp:
                return ValidationResult(False, "sıra dışı tick")
            if tick.timestamp == previous.timestamp and tick.price == previous.price:
                return ValidationResult(False, "yinelenen tick")
        self._last_tick[tick.symbol] = tick
        return ValidationResult(True)


class ConnectionMonitor:
    def __init__(
        self,
        provider: str,
        symbols: set[str],
        stale_after_seconds: int,
        *,
        partial_coverage_allowed: bool = False,
        rotation_stale_after_seconds: int | None = None,
    ) -> None:
        self.health = ProviderHealth(
            provider=provider,
            expected_symbols=symbols,
            partial_coverage_allowed=partial_coverage_allowed,
            rotation_stale_after_seconds=rotation_stale_after_seconds,
        )
        self.stale_after_seconds = stale_after_seconds

    def mark_connected(self) -> None:
        self.health.connected = True
        self.health.last_error = None

    def mark_error(self, message: str) -> None:
        self.health.connected = False
        self.health.data_state = DataState.UNAVAILABLE
        self.health.last_error = message
        self.health.symbols_received.clear()

    def mark_transient_error(self, message: str, now: datetime | None = None) -> None:
        """Retain a recent verified stream state through one reconnect attempt."""
        now = now or datetime.now(UTC)
        self.health.connected = False
        self.health.last_error = message
        if (
            self.health.last_data_at is None
            or (now - self.health.last_data_at).total_seconds() > self.stale_after_seconds
        ):
            self.health.data_state = DataState.UNAVAILABLE
            self.health.symbols_received.clear()

    def record_tick(
        self,
        tick: MarketTick,
        real_time: bool,
        data_state: DataState | None = None,
    ) -> None:
        self.health.last_data_at = tick.timestamp
        self.health.last_data_by_symbol[tick.symbol] = tick.timestamp
        self.health.symbols_received.add(tick.symbol)
        self.health.data_state = data_state or (DataState.REAL_TIME if real_time else DataState.MOCK)

    def refresh_freshness(self, now: datetime | None = None) -> ProviderHealth:
        now = now or datetime.now(UTC)
        if self.health.last_data_at and (now - self.health.last_data_at).total_seconds() > self.stale_after_seconds:
            self.health.data_state = DataState.STALE_DATA
        return self.health
