import asyncio
import json
from datetime import UTC, datetime

from app.config import AppConfig, load_config
from data.itick_provider import ITickRealTimeProvider


def make_itick_provider() -> ITickRealTimeProvider:
    config = AppConfig(
        provider_name="itick",
        symbols=("THYAO",),
        index_symbol="XU100:TR",
        itick_api_key="test-key",
        itick_symbols=("THYAO",),
        itick_region="TR",
    )
    return ITickRealTimeProvider(config)


def test_itick_subscription_uses_documented_turkish_symbol_format() -> None:
    provider = make_itick_provider()
    assert provider.subscription_payload() == {
        "ac": "subscribe",
        "params": "THYAO$TR",
        "types": "quote,tick,depth",
    }


def test_itick_uses_the_temporary_one_symbol_diagnostic_pool() -> None:
    config = load_config("config.yaml")
    assert config.itick_symbols == ("THYAO",)
    assert set(config.itick_symbols) < set(config.symbols)


def test_itick_tries_ticker_formats_in_requested_order() -> None:
    assert make_itick_provider().subscription_candidates() == (
        "THYAO$TR",
        "THYAO",
        "THYAO.IS",
        "THYAO.E",
    )


def test_itick_sends_next_ticker_format_after_rejection() -> None:
    class RecordingSocket:
        def __init__(self) -> None:
            self.messages: list[dict[str, str]] = []

        async def send(self, message: str) -> None:
            self.messages.append(json.loads(message))

    async def subscribe_twice() -> RecordingSocket:
        provider = make_itick_provider()
        socket = RecordingSocket()
        candidates = iter(provider.subscription_candidates())
        assert await provider._subscribe_next(socket, candidates) == "THYAO$TR"
        assert await provider._subscribe_next(socket, candidates) == "THYAO"
        return socket

    socket = asyncio.run(subscribe_twice())
    assert [message["params"] for message in socket.messages] == ["THYAO$TR", "THYAO"]


def test_itick_parse_maps_published_depth_and_tick_fields() -> None:
    provider = make_itick_provider()
    assert provider.parse_message(
        {
            "code": 1,
            "data": {
                "s": "THYAO",
                "r": "TR",
                "type": "depth",
                "b": [{"po": 1, "p": 250.1, "v": 100}],
                "a": [{"po": 1, "p": 250.2, "v": 200}],
            },
        }
    ) is None
    tick = provider.parse_message(
        {"code": 1, "data": {"s": "THYAO", "r": "TR", "ld": 250.15, "v": 42, "t": 1_731_689_407_000, "type": "tick"}}
    )
    assert tick is not None
    assert tick.symbol == "THYAO"
    assert tick.price == 250.15
    assert tick.bid == 250.1 and tick.ask == 250.2
    assert tick.bid_depth == 100 and tick.ask_depth == 200
    assert tick.tick_volume == 42 and tick.total_volume is None


def test_itick_health_check_requires_fresh_live_tick() -> None:
    provider = make_itick_provider()
    assert provider.health_check()["connected"] is False
    provider._monitor.mark_connected()
    provider._last_message_at = datetime.now(UTC)
    quote = provider.parse_message(
        {"code": 1, "data": {"s": "THYAO", "r": "TR", "ld": 100, "v": 1000, "t": int(datetime.now(UTC).timestamp() * 1000), "type": "quote"}}
    )
    assert quote is not None
    provider._monitor.record_tick(quote, real_time=True)
    health = provider.health_check()
    assert health["connected"] is True
    assert health["last_message_fresh"] is True
    assert health["data_state"] == "REAL_TIME"
