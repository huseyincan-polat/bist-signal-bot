import asyncio

import pytest

from data.models import DataState, Signal, SignalState, utcnow
from data.provider import MockProvider, create_provider
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


def test_unknown_provider_is_rejected() -> None:
    with pytest.raises(ValueError):
        create_provider(make_config("unsupported"))


def test_telegram_never_posts_when_realtime_gate_is_closed() -> None:
    signal = Signal(
        symbol="AAA", state=SignalState.STRONG_BUY, confidence=80, price=100, entry=100,
        stop=95, targets=(105, 110, 115), reasons=["test"], data_timestamp=utcnow(),
        generated_at=utcnow(), provider="test",
    )
    notifier = TelegramNotifier("must-not-be-used", "123", enabled=True)
    assert asyncio.run(notifier.send_signal(signal, real_time_ready=False)) is False
