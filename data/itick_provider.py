"""iTick Turkish-stock WebSocket adapter using its published protocol.

Documentation:
https://docs.itick.org/en/websocket/stocks
https://blog.itick.org/en/stock-api/turkey-stock-api-bist-real-time-depth-historical-data-technical
"""

from __future__ import annotations

import asyncio
from contextlib import suppress
import inspect
import json
import logging
import time
from collections.abc import AsyncIterator
from datetime import UTC, datetime
from typing import Any

import websockets

from app.config import AppConfig
from data.models import Candle, MarketTick, ProviderHealth
from data.provider import RealTimeProvider
from data.realtime import ConnectionMonitor, TickValidator

logger = logging.getLogger(__name__)


class ITickRealTimeProvider(RealTimeProvider):
    """Streams the configured BIST 30 watchlist from iTick's stock channel."""

    name = "iTick stock WebSocket"

    def __init__(self, config: AppConfig) -> None:
        self.config = config
        self.symbols = tuple(config.itick_symbols)
        self._monitor = ConnectionMonitor(self.name, set(self.symbols), config.stale_after_seconds)
        self._validator = TickValidator(config.stale_after_seconds)
        self._depth: dict[str, dict[str, float]] = {}
        self._last_message_at: datetime | None = None
        self._first_live_tick_logged = False

    @property
    def health(self) -> ProviderHealth:
        return self._monitor.refresh_freshness()

    def health_check(self) -> dict[str, bool | str | None]:
        """Report socket status plus separately measured message freshness."""
        health = self.health
        message_fresh = bool(
            self._last_message_at
            and (datetime.now(UTC) - self._last_message_at).total_seconds()
            <= self.config.stale_after_seconds
        )
        return {
            "connected": health.connected,
            "last_message_fresh": message_fresh,
            "data_state": health.data_state.value,
            "last_message_at": self._last_message_at.isoformat() if self._last_message_at else None,
        }

    async def connect(self) -> None:
        if not self.config.is_itick_configured:
            self._monitor.mark_error("iTick API key or BIST 30 subscription list is not configured")
            raise RuntimeError("ITICK_API_KEY and iTick BIST 30 symbols are required")

    def subscription_payload(self) -> dict[str, str]:
        """Published iTick payload: comma-separated SYMBOL$TR and quote/tick/depth."""
        codes = ",".join(f"{symbol}${self.config.itick_region}" for symbol in self.symbols)
        return {"ac": "subscribe", "params": codes, "types": "quote,tick,depth"}

    async def stream(self) -> AsyncIterator[MarketTick]:
        await self.connect()
        consecutive_failures = 0
        while True:
            heartbeat: asyncio.Task[None] | None = None
            try:
                async with self._socket() as socket:
                    self._monitor.mark_connected()
                    logger.info("iTick WebSocket connected; waiting for authentication")
                    heartbeat = asyncio.create_task(self._heartbeat(socket), name="itick-heartbeat")
                    async for raw_message in socket:
                        self._last_message_at = datetime.now(UTC)
                        message = self._decode(raw_message)
                        if not message:
                            continue
                        if self._authentication_failed(message):
                            raise PermissionError("iTick authentication failed")
                        if self._authentication_succeeded(message):
                            await socket.send(json.dumps(self.subscription_payload()))
                            logger.info("iTick authenticated; BIST 30 subscription requested")
                            continue
                        if self._subscription_failed(message):
                            raise PermissionError("iTick BIST 30 subscription was rejected")
                        tick = self.parse_message(message)
                        if tick and self._validator.validate(tick).accepted:
                            self._monitor.record_tick(tick, real_time=True)
                            consecutive_failures = 0
                            if not self._first_live_tick_logged:
                                logger.info("iTick live tick received for %s", tick.symbol)
                                self._first_live_tick_logged = True
                            yield tick
                raise ConnectionError("iTick stream closed")
            except (OSError, websockets.WebSocketException, asyncio.TimeoutError, PermissionError, ConnectionError) as error:
                self._monitor.mark_error("iTick stream unavailable")
                consecutive_failures += 1
                delay = min(self.config.reconnect_backoff_seconds * 2 ** (consecutive_failures - 1), 60)
                # Class/code are safe diagnostic evidence; exception text may contain secrets.
                logger.warning(
                    "iTick stream unavailable (%s, code=%s); reconnecting in %ss",
                    type(error).__name__,
                    getattr(error, "code", None),
                    delay,
                )
                await asyncio.sleep(delay)
            finally:
                if heartbeat:
                    heartbeat.cancel()
                    with suppress(asyncio.CancelledError):
                        await heartbeat

    def _socket(self) -> Any:
        """Use the documented `token` WebSocket header without exposing it in logs."""
        headers = {"token": self.config.itick_api_key or ""}
        parameter = (
            "additional_headers"
            if "additional_headers" in inspect.signature(websockets.connect).parameters
            else "extra_headers"
        )
        return websockets.connect(
            self.config.itick_websocket_url,
            **{parameter: headers},
            ping_interval=None,
            close_timeout=5,
        )

    async def _heartbeat(self, socket: Any) -> None:
        while True:
            await asyncio.sleep(30)
            # iTick specifies a client {"ac":"ping","params":"<milliseconds>"} message.
            await socket.send(json.dumps({"ac": "ping", "params": str(int(time.time() * 1000))}))

    @staticmethod
    def _decode(raw_message: str | bytes) -> dict[str, Any] | None:
        try:
            parsed = json.loads(raw_message)
        except (TypeError, json.JSONDecodeError):
            return None
        return parsed if isinstance(parsed, dict) else None

    @staticmethod
    def _authentication_succeeded(message: dict[str, Any]) -> bool:
        return message.get("resAc") == "auth" and message.get("code") == 1

    @staticmethod
    def _authentication_failed(message: dict[str, Any]) -> bool:
        return message.get("resAc") == "auth" and message.get("code") != 1

    @staticmethod
    def _subscription_failed(message: dict[str, Any]) -> bool:
        return message.get("resAc") == "subscribe" and message.get("code") != 1

    def parse_message(self, message: dict[str, Any]) -> MarketTick | None:
        """Map documented quote/tick/depth JSON (`data.s`, `ld`, `t`, `v`) to MarketTick."""
        data = message.get("data")
        if not isinstance(data, dict):
            return None
        symbol = str(data.get("s", "")).split(".")[0].split("$")[0]
        if symbol not in self.symbols:
            return None
        if data.get("type") == "depth":
            self._record_depth(symbol, data)
            return None
        if data.get("type") not in ("quote", "tick"):
            return None
        if not isinstance(data.get("ld"), (int, float)) or not isinstance(data.get("t"), (int, float)):
            return None
        depth = self._depth.get(symbol, {})
        is_trade = data["type"] == "tick"
        return MarketTick(
            symbol=symbol,
            price=float(data["ld"]),
            timestamp=datetime.fromtimestamp(float(data["t"]) / 1000, UTC),
            bid=depth.get("bid"),
            ask=depth.get("ask"),
            tick_volume=float(data["v"]) if is_trade and isinstance(data.get("v"), (int, float)) else None,
            total_volume=float(data["v"]) if not is_trade and isinstance(data.get("v"), (int, float)) else None,
            bid_depth=depth.get("bid_depth"),
            ask_depth=depth.get("ask_depth"),
            source=self.name,
        )

    def _record_depth(self, symbol: str, data: dict[str, Any]) -> None:
        bids = data.get("b")
        asks = data.get("a")
        bid = bids[0] if isinstance(bids, list) and bids and isinstance(bids[0], dict) else {}
        ask = asks[0] if isinstance(asks, list) and asks and isinstance(asks[0], dict) else {}
        book: dict[str, float] = {}
        if isinstance(bid.get("p"), (int, float)):
            book["bid"] = float(bid["p"])
        if isinstance(ask.get("p"), (int, float)):
            book["ask"] = float(ask["p"])
        if isinstance(bids, list):
            book["bid_depth"] = sum(
                float(item["v"])
                for item in bids
                if isinstance(item, dict) and isinstance(item.get("v"), (int, float))
            )
        if isinstance(asks, list):
            book["ask_depth"] = sum(
                float(item["v"])
                for item in asks
                if isinstance(item, dict) and isinstance(item.get("v"), (int, float))
            )
        self._depth[symbol] = book

    def historical_candles(self, symbol: str, timeframe: str) -> list[Candle]:
        # This adapter deliberately avoids undocumented REST backfills.
        return []
