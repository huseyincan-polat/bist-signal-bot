from datetime import UTC, datetime, timedelta

from data.models import DataState, MarketTick
from data.realtime import ConnectionMonitor, TickValidator


def test_validator_rejects_duplicate_out_of_order_and_stale_ticks() -> None:
    now = datetime.now(UTC)
    validator = TickValidator(stale_after_seconds=30)
    first = MarketTick("THYAO", 250, now)
    assert validator.validate(first, now).accepted
    assert validator.validate(first, now).reason == "yinelenen tick"
    assert not validator.validate(MarketTick("THYAO", 251, now - timedelta(seconds=1)), now).accepted
    assert validator.validate(MarketTick("THYAO", 252, now - timedelta(seconds=31)), now).reason == "STALE_DATA"


def test_connection_monitor_requires_all_symbols_and_current_realtime_ticks() -> None:
    now = datetime.now(UTC)
    monitor = ConnectionMonitor("vendor", {"AAA", "BBB"}, 10)
    monitor.mark_connected()
    monitor.record_tick(MarketTick("AAA", 10, now), real_time=True)
    assert not monitor.health.ready_for_signals
    monitor.record_tick(MarketTick("BBB", 10, now), real_time=True)
    assert monitor.health.ready_for_signals
    assert monitor.refresh_freshness(now + timedelta(seconds=11)).data_state is DataState.STALE_DATA
