import asyncio
from dataclasses import replace
from datetime import UTC, datetime

from data.binance_futures import FALLBACK_USDT_PERPETUALS, BinanceFuturesProvider
from data.models import MarketTick
from tests.conftest import make_config


def test_parse_combined_bookticker_message() -> None:
    provider = BinanceFuturesProvider(replace(make_config("binance_futures")))
    provider.symbols = ("BTCUSDT",)
    provider._previous_closes["BTCUSDT"] = 65_000
    tick = provider.parse_message(
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


def test_classify_subscription_result_frame() -> None:
    provider = BinanceFuturesProvider(replace(make_config("binance_futures")))
    assert provider.classify_frame({"result": None, "id": 1}) == "subscription_result"
    assert provider.classify_frame({"e": "bookTicker", "s": "BTCUSDT"}) == "bookTicker"


def test_binance_historical_priming_runs_away_from_event_loop() -> None:
    provider = BinanceFuturesProvider(replace(make_config("binance_futures")))
    provider.symbols = ("BTCUSDT",)

    def slow_history(_symbols: tuple[str, ...]) -> dict[str, list[object]]:
        import time

        time.sleep(0.05)
        return {}

    provider._fetch_history = slow_history  # type: ignore[method-assign]

    async def prime_without_blocking() -> float:
        started = asyncio.get_running_loop().time()
        task = asyncio.create_task(provider.prime_history())
        await asyncio.sleep(0.01)
        elapsed = asyncio.get_running_loop().time() - started
        await task
        return elapsed

    assert asyncio.run(prime_without_blocking()) < 0.04


def test_static_universe_starts_websocket_without_a_rest_universe_request() -> None:
    provider = BinanceFuturesProvider(replace(make_config("binance_futures")))
    asyncio.run(provider.connect())
    assert provider.symbols == FALLBACK_USDT_PERPETUALS
    assert len(provider.symbols) == 50
    assert provider.symbols[:5] == ("BTCUSDT", "ETHUSDT", "SOLUSDT", "XRPUSDT", "ADAUSDT")


def test_raw_websocket_subscription_uses_documented_binance_frame() -> None:
    provider = BinanceFuturesProvider(replace(make_config("binance_futures")))
    assert provider.subscription_frame(("BTCUSDT", "ETHUSDT"), request_id=1) == {
        "method": "SUBSCRIBE",
        "params": ["btcusdt@bookTicker", "ethusdt@bookTicker"],
        "id": 1,
    }
