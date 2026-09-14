"""Application entry point for the analysis-only Futures signal bot."""

from __future__ import annotations

import asyncio
import logging
from contextlib import asynccontextmanager, suppress

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
        from dataclasses import replace

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

    def _analysis_ready(self) -> bool:
        analysis_ready = getattr(self.provider, "analysis_ready", False)
        return bool(analysis_ready)

    async def _consume(self) -> None:
        try:
            await self.provider.connect()
            self._apply_universe()
            bind_store = getattr(self.provider, "klines", None)
            if bind_store is not None:
                self.engine.bind_kline_store(bind_store)
            async for tick in self.provider.stream():
                health = self.provider.health
                self.dashboard.record_tick(tick)
                self._apply_universe()
                analysis_data_ready = health.ready_for_signals and self._analysis_ready()
                if analysis_data_ready and not self._provider_ready:
                    self.engine_started = True
                    self._provider_ready = True
                    primed = self.engine.prime_from_history()
                    logger.info(
                        "Analysis engine started: primed=%s symbols=%s kline_frames=%s",
                        primed,
                        len(bind_store.symbols_with_min_bars()) if bind_store else 0,
                        getattr(health, "kline_frames_received", 0),
                    )
                    await self.dashboard.broadcast_state()
                elif not analysis_data_ready:
                    self._provider_ready = False
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
                            logger.warning("Telegram delivery failed; signal was not retried")
        except Exception:
            logger.warning("Market-data startup verification failed")


def build_application(config_path: str = "config.yaml") -> SignalBotApplication:
    return SignalBotApplication(load_config(config_path))


def main() -> None:
    logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(name)s: %(message)s")
    application = build_application()
    uvicorn.run(application.api, host=application.config.dashboard_host, port=application.config.dashboard_port)


if __name__ == "__main__":
    main()
