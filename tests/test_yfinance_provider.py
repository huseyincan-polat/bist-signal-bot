import asyncio
import time
from dataclasses import replace
from datetime import UTC, datetime

from data.models import DataState, MarketTick
from data.yfinance_provider import YahooBatchProvider
from tests.conftest import make_config


def test_batch_provider_runs_blocking_fetch_in_worker_thread() -> None:
    def slow_batch(_symbols: list[str]) -> list[MarketTick]:
        time.sleep(0.08)
        return [MarketTick("AAA", 100, datetime.now(UTC), source="test")]

    async def consume() -> tuple[float, YahooBatchProvider]:
        provider = YahooBatchProvider(
            replace(make_config("batch_yfinance"), batch_poll_seconds=60),
            fetch_batch=slow_batch,
        )
        started = time.monotonic()
        task = asyncio.create_task(anext(provider.stream()))
        await asyncio.sleep(0.01)
        elapsed_before_result = time.monotonic() - started
        await task
        return elapsed_before_result, provider

    elapsed, provider = asyncio.run(consume())
    assert elapsed < 0.06
    assert provider.health.data_state is DataState.STALE_DATA
    assert not provider.health.ready_for_signals


def test_batch_provider_uses_one_universe_request_not_per_symbol_calls() -> None:
    calls: list[list[str]] = []

    def batch(symbols: list[str]) -> list[MarketTick]:
        calls.append(symbols)
        return [MarketTick("AAA", 100, datetime.now(UTC), source="test")]

    async def consume_once() -> None:
        provider = YahooBatchProvider(
            replace(make_config("batch_yfinance"), symbols=("AAA", "BBB"), batch_poll_seconds=60),
            fetch_batch=batch,
        )
        stream = provider.stream()
        await anext(stream)
        await stream.aclose()

    asyncio.run(consume_once())
    assert calls == [["AAA", "BBB"]]
