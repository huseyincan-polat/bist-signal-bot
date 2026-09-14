import asyncio
from dataclasses import replace
from datetime import UTC, datetime, timedelta

from data.binance_futures import (
    BOOK_TICKER_SUFFIX,
    FALLBACK_USDT_PERPETUALS,
    SYMBOL_STALE_SECONDS,
    BinanceFuturesProvider,
)
from data.models import MarketTick
from tests.conftest import make_config


def test_parse_combined_bookticker_message() -> None:
    provider = BinanceFuturesProvider(replace(make_config("binance_futures")))
    provider.symbols = ("BTCUSDT",)
    provider._previous_closes["BTCUSDT"] = 65_000
    tick = provider._parse_bookticker(
        {
            "stream": "btcusdt@bookTicker",
            "data": {
                "e": "bookTicker",
                "s": "BTCUSDT",
                "b": "65010.00",
                "a": "65011.00",
                "E": 1_731_689_407_000,
            },
        }
    )
    assert tick is not None
    assert tick.symbol == "BTCUSDT"
    assert tick.price == 65010.5
    assert tick.bid == 65010.0
    assert tick.ask == 65011.0
    assert tick.previous_close == 65_000


def test_classify_subscription_and_bookticker_frames() -> None:
    provider = BinanceFuturesProvider(replace(make_config("binance_futures")))
    assert provider.classify_frame({"result": None, "id": 1}) == "subscription_result"
    assert provider.classify_frame({"e": "bookTicker", "s": "BTCUSDT"}) == "bookTicker"
    assert provider.classify_frame({"e": "kline", "k": {"i": "1m"}}) == "kline_1m"


def test_static_universe_starts_websocket_without_a_rest_universe_request() -> None:
    provider = BinanceFuturesProvider(replace(make_config("binance_futures")))
    asyncio.run(provider.connect())
    assert provider.symbols == FALLBACK_USDT_PERPETUALS
    assert len(provider.symbols) == 50
    assert provider.symbols[:5] == ("BTCUSDT", "ETHUSDT", "SOLUSDT", "XRPUSDT", "ADAUSDT")


def test_raw_websocket_subscription_uses_documented_binance_frame() -> None:
    provider = BinanceFuturesProvider(replace(make_config("binance_futures")))
    assert provider._subscription_frame(("BTCUSDT", "ETHUSDT"), BOOK_TICKER_SUFFIX, 1) == {
        "method": "SUBSCRIBE",
        "params": ["btcusdt@bookTicker", "ethusdt@bookTicker"],
        "id": 1,
    }


def test_stale_symbol_resets_buffers() -> None:
    provider = BinanceFuturesProvider(replace(make_config("binance_futures")))
    asyncio.run(provider.connect())
    now = datetime.now(UTC)
    provider._last_tick_at["BTCUSDT"] = now - timedelta(seconds=SYMBOL_STALE_SECONDS + 1)
    provider.klines.upsert_from_tick(MarketTick("BTCUSDT", 100.0, now, source="test"))
    assert "BTCUSDT" in provider.klines.symbols_with_min_bars()
    provider.klines.reset_symbol("BTCUSDT")
    assert "BTCUSDT" not in provider.klines.symbols_with_min_bars()


def test_rotation_stale_threshold_is_configured() -> None:
    provider = BinanceFuturesProvider(replace(make_config("binance_futures")))
    assert provider.health.rotation_stale_after_seconds == SYMBOL_STALE_SECONDS
