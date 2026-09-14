import asyncio
from dataclasses import replace
from datetime import UTC, datetime

from data.binance_futures import FALLBACK_USDT_PERPETUALS, BinanceFuturesProvider
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


def test_parse_kline_message() -> None:
    provider = BinanceFuturesProvider(replace(make_config("binance_futures")))
    parsed = provider._parse_kline(
        {
            "e": "kline",
            "s": "BTCUSDT",
            "k": {
                "t": 1_731_689_400_000,
                "i": "1m",
                "o": "65000",
                "h": "65100",
                "l": "64900",
                "c": "65050",
                "v": "12.3",
                "x": False,
            },
        },
        "1m",
    )
    assert parsed is not None
    candle, is_closed = parsed
    assert candle.symbol == "BTCUSDT"
    assert candle.timeframe == "1m"
    assert candle.close == 65050.0
    assert is_closed is False


def test_classify_subscription_and_kline_frames() -> None:
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
    assert provider._subscription_frame(("BTCUSDT", "ETHUSDT"), "@kline_1m", 1) == {
        "method": "SUBSCRIBE",
        "params": ["btcusdt@kline_1m", "ethusdt@kline_1m"],
        "id": 1,
    }
