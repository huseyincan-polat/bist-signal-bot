from datetime import UTC, datetime

from app.config import AppConfig, load_config
from data.itick_provider import ITickRealTimeProvider


def make_itick_provider() -> ITickRealTimeProvider:
    config = AppConfig(
        provider_name="itick",
        symbols=("THYAO", "EREGL", "KCHOL"),
        index_symbol="XU100:TR",
        itick_api_key="test-key",
        itick_symbols=("THYAO", "EREGL", "KCHOL"),
        itick_region="TR",
    )
    return ITickRealTimeProvider(config)


def test_itick_subscription_uses_documented_turkish_symbol_format() -> None:
    provider = make_itick_provider()
    assert provider.subscription_payload(provider.rotation_groups()[0]) == {
        "ac": "subscribe",
        "params": "THYAO$TR,EREGL$TR,KCHOL$TR",
        "types": "quote,tick,depth",
    }


def test_itick_uses_the_full_bist100_universe_from_config() -> None:
    config = load_config("config.yaml")
    assert config.itick_symbols == config.symbols
    assert len(config.itick_symbols) == 100


def test_itick_rotation_groups_limit_subscription_size_to_three() -> None:
    provider = ITickRealTimeProvider(
        AppConfig(
            provider_name="itick",
            symbols=tuple(f"SYM{index}" for index in range(7)),
            index_symbol="XU100:TR",
            itick_api_key="test-key",
            itick_symbols=tuple(f"SYM{index}" for index in range(7)),
            itick_group_size=3,
        )
    )
    assert provider.rotation_groups() == (
        ("SYM0", "SYM1", "SYM2"),
        ("SYM3", "SYM4", "SYM5"),
        ("SYM6",),
    )
    assert provider.unsubscribe_payload(("SYM0", "SYM1", "SYM2")) == {
        "ac": "unsubscribe",
        "params": "SYM0$TR,SYM1$TR,SYM2$TR",
        "types": "quote,tick,depth",
    }


def test_itick_keeps_each_group_quote_in_memory() -> None:
    provider = make_itick_provider()
    tick = provider.parse_message(
        {"code": 1, "data": {"s": "THYAO", "r": "TR", "ld": 250, "v": 10, "t": 1_731_689_407_000, "type": "tick"}}
    )
    assert tick is not None
    provider.last_quotes[tick.symbol] = tick
    assert provider.last_quotes["THYAO"].price == 250


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
