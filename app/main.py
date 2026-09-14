"""Application entry point for the analysis-only BIST 100 signal bot."""

from __future__ import annotations

import asyncio
import logging
from contextlib import suppress

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
        self.api, self.dashboard = create_dashboard(config, self.engine, self.provider.health)
        self.engine_started = False
        self._task: asyncio.Task[None] | None = None
        self._configure_lifecycle()

    def _configure_lifecycle(self) -> None:
        @self.api.on_event("startup")
        async def start() -> None:
            self._seed_local_history()
            self._task = asyncio.create_task(self._consume(), name="market-data-consumer")

        @self.api.on_event("shutdown")
        async def stop() -> None:
            if self._task:
                self._task.cancel()
                with suppress(asyncio.CancelledError):
                    await self._task

    def _seed_local_history(self) -> None:
        """Load available candles without inventing remote historical endpoints."""
        symbols = list(self.config.symbols) + [self.config.index_symbol.split(":")[0]]
        for symbol in symbols:
            for timeframe in ("1m", "5m", "15m", "1h", "daily"):
                candles = self.provider.historical_candles(symbol, timeframe)
                if candles:
                    self.engine.seed_history(symbol, timeframe, candles)

    async def _consume(self) -> None:
        try:
            # Step 1: connection configuration/handshake begins before any engine work.
            await self.provider.connect()
            async for tick in self.provider.stream():
                health = self.provider.health
                self.dashboard.record_tick(tick)
                # Steps 2–4 are satisfied only by accepted, current ticks for every symbol.
                if not self.engine_started and health.ready_for_signals:
                    self.engine_started = True
                    logger.info("Real-time verification passed; starting analysis engine")
                # Mock, delayed, stale, partial, and disconnected data cannot run the engine.
                if not self.engine_started or not health.ready_for_signals:
                    if tick.symbol in self.config.symbols:
                        await self.dashboard.publish(tick.symbol)
                    continue
                signal = self.engine.on_tick(tick)
                if signal:
                    await self.dashboard.publish(signal.symbol)
                    if self.engine.should_notify(signal):
                        try:
                            await self.notifier.send_signal(signal, real_time_ready=health.ready_for_signals)
                        except Exception:
                            # Keep telemetry secret-safe: response/request may include credentials.
                            logger.warning("Telegram delivery failed; signal was not retried")
        except Exception:
            # Do not include transport errors: a misconfigured URL could contain a secret.
            logger.warning("Market-data startup verification failed")


def build_application(config_path: str = "config.yaml") -> SignalBotApplication:
    return SignalBotApplication(load_config(config_path))


def main() -> None:
    logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(name)s: %(message)s")
    application = build_application()
    uvicorn.run(application.api, host=application.config.dashboard_host, port=application.config.dashboard_port)


if __name__ == "__main__":
    main()
