import asyncio
from dataclasses import replace
from datetime import UTC, datetime

import httpx

from data.binance_futures import FALLBACK_USDT_PERPETUALS, BinanceFuturesProvider
from data.models import MarketTick
from tests.conftest import make_config


def test_parse_combined_aggtrade_message() -> None:
    provider = BinanceFuturesProvider(replace(make_config("binance_futures")))
    provider.symbols = ("BTCUSDT",)
    provider._previous_closes["BTCUSDT"] = 65_000
    tick = provider.parse_message(
        {
            "stream": "btcusdt@aggTrade",
            "data": {
                "e": "aggTrade",
                "s": "BTCUSDT",
                "p": "65010.50",
                "q": "0.012",
                "T": 1_731_689_407_000,
            },
        }
    )
    assert tick is not None
    assert tick.symbol == "BTCUSDT"
    assert tick.price == 65010.5
    assert tick.tick_volume == 0.012
    assert tick.previous_close == 65_000


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


def test_rest_418_uses_fallback_universe_so_websocket_can_start() -> None:
    provider = BinanceFuturesProvider(replace(make_config("binance_futures")))
    request = httpx.Request("GET", "https://fapi.binance.com/fapi/v1/ticker/24hr")
    response = httpx.Response(418, request=request)

    def blocked_universe() -> tuple[tuple[str, ...], dict[str, float]]:
        raise httpx.HTTPStatusError("blocked", request=request, response=response)

    provider._refresh_universe = blocked_universe  # type: ignore[method-assign]
    asyncio.run(provider.connect())
    assert provider.symbols == FALLBACK_USDT_PERPETUALS
    assert len(provider.symbols) == 50
    assert provider.health.last_error == "Binance REST universe HTTP 418; fallback universe active"
