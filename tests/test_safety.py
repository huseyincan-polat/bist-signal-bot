import asyncio

import pytest

from data.models import DataState, Signal, SignalState, utcnow
from data.provider import DxFeedProvider, MockProvider
from notifications.telegram import TelegramNotifier
from tests.conftest import make_config


def test_mock_provider_is_never_realtime_or_signal_ready() -> None:
    async def consume_one_round() -> MockProvider:
        config = make_config()
        provider = MockProvider(config)
        await provider.connect()
        stream = provider.stream()
        await anext(stream)
        await stream.aclose()
        return provider

    provider = asyncio.run(consume_one_round())
    assert provider.health.data_state is DataState.MOCK
    assert not provider.health.ready_for_signals


def test_dxfeed_refuses_to_start_without_entitlement_configuration() -> None:
    provider = DxFeedProvider(make_config("dxfeed"))
    with pytest.raises(RuntimeError):
        asyncio.run(provider.connect())
    assert provider.health.data_state is DataState.UNAVAILABLE


def test_telegram_never_posts_when_realtime_gate_is_closed() -> None:
    signal = Signal(
        symbol="AAA", state=SignalState.STRONG_BUY, confidence=80, price=100, entry=100,
        stop=95, targets=(105, 110, 115), reasons=["test"], data_timestamp=utcnow(),
        generated_at=utcnow(), provider="test",
    )
    notifier = TelegramNotifier("must-not-be-used", "123", enabled=True)
    assert asyncio.run(notifier.send_signal(signal, real_time_ready=False)) is False
