"""Application entry point for the analysis-only Futures signal bot."""

from __future__ import annotations

import asyncio
import logging
from contextlib import asynccontextmanager, suppress
from dataclasses import replace

import uvicorn

from app.config import AppConfig, load_config
from dashboard.app import DashboardState, create_dashboard
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

    def _apply_universe(self) -> None:
        """Use the provider's freshly ranked universe across app surfaces."""
        symbols = self.provider.symbols
        if not symbols:
            return
        self.config = replace(
            self.config,
            symbols=symbols,
            index_symbol="BTCUSDT" if "BTCUSDT" in symbols else symbols[0],
        )
        self.engine.config = self.config
        self.engine.index_symbol = self.config.index_symbol
        self.dashboard.config = self.config

    async def _prime_history(self) -> None:
        """Prime Futures indicators from official REST klines in a worker thread."""
        fetch_history = getattr(self.provider, "prime_history", None)
        if fetch_history is None:
            return
        try:
            history = await asyncio.wait_for(fetch_history(), timeout=45)
        except (asyncio.TimeoutError, Exception):
            logger.warning("Futures historical priming unavailable")
            return
        for symbol, candles in history.items():
            self.engine.seed_history(symbol, "1m", candles)
        self.primed_symbol_count = sum(
            1 for symbol in self.config.symbols if len(history.get(symbol, [])) >= 35
        )
        self.history_primed = self.primed_symbol_count > 0
        logger.info("Futures historical primer completed: symbols=%s", self.primed_symbol_count)

    async def _consume(self) -> None:
        try:
            # Step 1: connection configuration/handshake begins before any engine work.
            await self.provider.connect()
            self._apply_universe()
            self._historical_task = asyncio.create_task(
                self._prime_history(),
                name="historical-primer",
            )
            async for tick in self.provider.stream():
                health = self.provider.health
                self.dashboard.record_tick(tick)
                # Steps 2–4 are satisfied only by accepted, current ticks for every symbol.
                analysis_data_ready = health.ready_for_signals
                if self.history_primed and analysis_data_ready and not self._provider_ready:
                    primed_signals = self.engine.prime_from_history()
                    self.engine_started = True
                    self._provider_ready = True
                    logger.info(
                        "Live group verified; analysis engine started with primed_signals=%s",
                        primed_signals,
                    )
                    await self.dashboard.broadcast_state()
                elif not analysis_data_ready:
                    self._provider_ready = False
                # Mock, delayed, stale, partial, and disconnected data cannot run the engine.
                if not self.engine_started or not analysis_data_ready:
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
