"""Non-blocking, one-request-at-a-time Yahoo batch scanner.

Yahoo/yfinance BIST bars are often delayed. This provider therefore never
claims REAL_TIME, even when its worker finishes quickly.
"""

from __future__ import annotations

import asyncio
import logging
from collections.abc import AsyncIterator, Callable

from app.config import AppConfig
from data.historical import fetch_yfinance_batch_quotes
from data.models import Candle, DataState, MarketTick, ProviderHealth
from data.provider import HistoricalProvider
from data.realtime import ConnectionMonitor, TickValidator

logger = logging.getLogger(__name__)


class YahooBatchProvider(HistoricalProvider):
    """Poll all configured BIST symbols in one yfinance worker-thread call."""

    name = "yfinance delayed batch"
    is_real_time = False
    allows_delayed_analysis = True

    def __init__(
        self,
        config: AppConfig,
        fetch_batch: Callable[[list[str]], list[MarketTick]] = fetch_yfinance_batch_quotes,
    ) -> None:
        self.config = config
        self.symbols = tuple(config.symbols)
        self.fetch_batch = fetch_batch
        self._monitor = ConnectionMonitor(self.name, set(self.symbols), config.stale_after_seconds)
        self._validator = TickValidator(config.stale_after_seconds)
        self.last_quotes: dict[str, MarketTick] = {}

    @property
    def health(self) -> ProviderHealth:
        return self._monitor.refresh_freshness()

    async def connect(self) -> None:
        self._monitor.mark_connected()

    async def stream(self) -> AsyncIterator[MarketTick]:
        await self.connect()
        while True:
            started = asyncio.get_running_loop().time()
            try:
                ticks = await asyncio.to_thread(self.fetch_batch, list(self.symbols))
                self._monitor.mark_connected()
                for tick in ticks:
                    if self._validator.validate(tick, enforce_freshness=False).accepted:
                        self.last_quotes[tick.symbol] = tick
                        self._monitor.record_tick(
                            tick,
                            real_time=False,
                            data_state=DataState.STALE_DATA,
                        )
                        yield tick
                logger.info("yfinance batch completed: quotes=%s", len(ticks))
            except (asyncio.TimeoutError, Exception):
                self._monitor.mark_transient_error("yfinance batch unavailable")
                logger.warning("yfinance batch unavailable")
            elapsed = asyncio.get_running_loop().time() - started
            await asyncio.sleep(max(0, self.config.batch_poll_seconds - elapsed))

    def historical_candles(self, symbol: str, timeframe: str) -> list[Candle]:
        return []
