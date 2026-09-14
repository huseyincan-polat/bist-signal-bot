"""Application entry point for the analysis-only BIST 100 signal bot."""

from __future__ import annotations

import asyncio
import logging
from contextlib import asynccontextmanager, suppress

import uvicorn

from app.config import AppConfig, load_config
from dashboard.app import DashboardState, create_dashboard
from data.historical import fetch_yfinance_history
from data.provider import DataProvider, create_provider
from notifications.telegram import TelegramNotifier
from strategy.signal_engine import SignalEngine

logger = logging.getLogger(__name__)


class SignalBotApplication:
    """Coordinates startup verification, calculation, dashboard, and notifications."""

    def __init__(self, config: AppConfig) -> None:
        self.config = config
        self.provider: DataProvider = create_provider(config)
        self.engine = SignalEngine(config, self.provider.name)
        self.notifier = TelegramNotifier(
            config.telegram_bot_token, config.telegram_chat_id, config.telegram_enabled
        )
        self.engine_started = False
        self._provider_ready = False
        self.history_primed = False
        self.primed_symbol_count = 0
        self._historical_task: asyncio.Task[None] | None = None
        self._task: asyncio.Task[None] | None = None
        self.api, self.dashboard = create_dashboard(
            config, self.engine, self.provider.health, lifespan=self._lifespan
        )

    @asynccontextmanager
    async def _lifespan(self, _api: object):
        try:
            self._task = asyncio.create_task(self._consume(), name="market-data-consumer")
            yield
        finally:
            if self._task:
                self._task.cancel()
                with suppress(asyncio.CancelledError):
                    await self._task

    def _seed_provider_history(self) -> None:
        """Load available candles without inventing remote historical endpoints."""
        symbols = list(self.config.symbols) + [self.config.index_symbol.split(":")[0]]
        for symbol in symbols:
            for timeframe in ("1m", "5m", "15m", "1h", "daily"):
                candles = self.provider.historical_candles(symbol, timeframe)
                if candles:
                    self.engine.seed_history(symbol, timeframe, candles)

    async def _prime_history(self) -> None:
        """Prime delayed daily bars before a successful live iTick group activates signals."""
        self._seed_provider_history()
        try:
            symbols = list(self.config.symbols) + [self.config.index_symbol.split(":")[0]]
            history = await asyncio.wait_for(
                asyncio.to_thread(fetch_yfinance_history, symbols),
                timeout=45,
            )
        except (asyncio.TimeoutError, Exception):
            logger.warning("Historical priming unavailable; waiting for provider history")
            return
        for symbol, candles in history.items():
            self.engine.seed_history(symbol, "daily", candles)
        self.primed_symbol_count = sum(
            1 for symbol in self.config.symbols if len(history.get(symbol, [])) >= 35
        )
        self.history_primed = self.primed_symbol_count > 0
        logger.info("Historical primer completed: symbols=%s", self.primed_symbol_count)

    async def _consume(self) -> None:
        self._historical_task = asyncio.create_task(
            self._prime_history(),
            name="historical-primer",
        )
        try:
            # Step 1: connection configuration/handshake begins before any engine work.
            await self.provider.connect()
            async for tick in self.provider.stream():
                health = self.provider.health
                self.dashboard.record_tick(tick)
                # Steps 2–4 are satisfied only by accepted, current ticks for every symbol.
                if self.history_primed and health.ready_for_signals and not self._provider_ready:
                    primed_signals = self.engine.prime_from_history()
                    self.engine_started = True
                    self._provider_ready = True
                    logger.info(
                        "Live group verified; analysis engine started with primed_signals=%s",
                        primed_signals,
                    )
                    await self.dashboard.broadcast_state()
                elif not health.ready_for_signals:
                    self._provider_ready = False
                # Mock, delayed, stale, partial, and disconnected data cannot run the engine.
                if not self.engine_started or not health.ready_for_signals:
                    if tick.symbol in self.config.symbols:
                        await self.dashboard.publish(tick.symbol)
                    continue
                signal = self.engine.on_tick(tick)
                if signal:
                    await self.dashboard.publish(signal.symbol)
                    if not health.symbol_is_stale(signal.symbol) and self.engine.should_notify(signal):
                        try:
                            await self.notifier.send_signal(signal, real_time_ready=health.ready_for_signals)
                        except Exception:
                            # Keep telemetry secret-safe: response/request may include credentials.
                            logger.warning("Telegram delivery failed; signal was not retried")
        except Exception:
            # Do not include transport errors: a misconfigured URL could contain a secret.
            logger.warning("Market-data startup verification failed")
        finally:
            if self._historical_task and not self._historical_task.done():
                self._historical_task.cancel()
                with suppress(asyncio.CancelledError):
                    await self._historical_task


def build_application(config_path: str = "config.yaml") -> SignalBotApplication:
    return SignalBotApplication(load_config(config_path))


def main() -> None:
    logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(name)s: %(message)s")
    application = build_application()
    uvicorn.run(application.api, host=application.config.dashboard_host, port=application.config.dashboard_port)


if __name__ == "__main__":
    main()
