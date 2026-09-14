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


class RotationBoundary(Exception):
    """Intentional reconnect after a free-tier subscription rotation."""


class ITickRealTimeProvider(RealTimeProvider):
    """Rotates BIST 100 through small documented iTick WebSocket groups."""

    name = "iTick stock WebSocket"
    SUBSCRIPTION_TYPES = ("quote", "tick", "depth")

    def __init__(self, config: AppConfig) -> None:
        self.config = config
        self.symbols = tuple(config.itick_symbols)
        self.group_size = config.itick_group_size
        self.group_listen_seconds = config.itick_group_listen_seconds
        rotation_seconds = (
            ((len(self.symbols) + self.group_size - 1) // self.group_size)
            * self.group_listen_seconds
            + 10
        )
        self._monitor = ConnectionMonitor(
            self.name,
            set(self.symbols),
            config.stale_after_seconds,
            partial_coverage_allowed=True,
            rotation_stale_after_seconds=rotation_seconds,
        )
        self._validator = TickValidator(config.stale_after_seconds)
        self._depth: dict[str, dict[str, float]] = {}
        self.last_quotes: dict[str, MarketTick] = {}
        self._last_message_at: datetime | None = None
        self._first_live_tick_logged = False
        self.successful_live_groups = 0
        self.current_group_index = -1
        self._next_group_index = 0

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
            self._monitor.mark_error("iTick API key or active subscription list is not configured")
            raise RuntimeError("ITICK_API_KEY and iTick symbols are required")

    def rotation_groups(self) -> tuple[tuple[str, ...], ...]:
        """Partition the BIST 100 universe without ever subscribing all at once."""
        return tuple(
            self.symbols[index:index + self.group_size]
            for index in range(0, len(self.symbols), self.group_size)
        )

    def subscription_payload(self, symbols: tuple[str, ...]) -> dict[str, str]:
        """Published raw-WebSocket subscribe frame using comma-separated SYMBOL$TR."""
        return {
            "ac": "subscribe",
            "params": ",".join(self._wire_symbol(symbol) for symbol in symbols),
            "types": ",".join(self.SUBSCRIPTION_TYPES),
        }

    def unsubscribe_payload(self, symbols: tuple[str, ...]) -> dict[str, object]:
        """Published raw unsubscribe frame (the SDK serializes ``codes`` to ``params``)."""
        return {
            "ac": "unsubscribe",
            "params": ",".join(self._wire_symbol(symbol) for symbol in symbols),
            "types": ",".join(self.SUBSCRIPTION_TYPES),
        }

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
                    await self._wait_for_authentication(socket)
                    groups = self.rotation_groups()
                    while True:
                        index = self._next_group_index
                        symbols = groups[index]
                        self.current_group_index = index
                        async for tick in self._stream_group(socket, index, symbols):
                            consecutive_failures = 0
                            yield tick
                        self._next_group_index = (index + 1) % len(groups)
                        await self._unsubscribe_group(socket, index, symbols)
                        raise RotationBoundary
            except RotationBoundary:
                # iTick's free endpoint closes after unsubscribe. Keep the last
                # fresh state while immediately reconnecting to the next group.
                continue
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

    async def _wait_for_authentication(self, socket: Any) -> None:
        while True:
            message = await self._receive(socket, timeout=15)
            if self._authentication_failed(message):
                raise PermissionError("iTick authentication failed")
            if self._authentication_succeeded(message):
                logger.info("iTick authenticated")
                return

    async def _stream_group(
        self,
        socket: Any,
        group_index: int,
        symbols: tuple[str, ...],
    ) -> AsyncIterator[MarketTick]:
        await socket.send(json.dumps(self.subscription_payload(symbols)))
        logger.info(
            "iTick rotation group=%s/%s subscribe symbols=%s",
            group_index + 1,
            len(self.rotation_groups()),
            ",".join(self._wire_symbol(symbol) for symbol in symbols),
        )
        accepted = False
        saved_ticks = 0
        deadline = asyncio.get_running_loop().time() + self.group_listen_seconds
        while (remaining := deadline - asyncio.get_running_loop().time()) > 0:
            try:
                message = await self._receive(socket, timeout=remaining)
            except asyncio.TimeoutError:
                break
            if self._subscription_failed(message):
                logger.warning(
                    "iTick rotation group=%s rejected code=%s",
                    group_index + 1,
                    message.get("code"),
                )
                raise PermissionError("iTick rotation group subscription rejected")
            if self._subscription_succeeded(message):
                accepted = True
                logger.info("iTick rotation group=%s accepted", group_index + 1)
                continue
            tick = self.parse_message(message)
            if tick and self._validator.validate(tick).accepted:
                self._monitor.record_tick(tick, real_time=True)
                self.last_quotes[tick.symbol] = tick
                saved_ticks += 1
                if not self._first_live_tick_logged:
                    logger.info(
                        "iTick live tick received: symbol=%s price=%s timestamp=%s",
                        tick.symbol,
                        tick.price,
                        tick.timestamp.isoformat(),
                    )
                    self._first_live_tick_logged = True
                yield tick
        if not accepted:
            raise asyncio.TimeoutError("iTick group did not acknowledge subscription")
        self.successful_live_groups += 1
        logger.info(
            "iTick rotation group=%s/%s complete ticks_saved=%s",
            group_index + 1,
            len(self.rotation_groups()),
            saved_ticks,
        )

    async def _unsubscribe_group(
        self,
        socket: Any,
        group_index: int,
        symbols: tuple[str, ...],
    ) -> None:
        """Send the documented unsubscribe frame before advancing the rotation."""
        await socket.send(json.dumps(self.unsubscribe_payload(symbols)))
        logger.info("iTick rotation group=%s unsubscribe sent", group_index + 1)

    async def _receive(self, socket: Any, timeout: float) -> dict[str, Any]:
        raw_message = await asyncio.wait_for(socket.recv(), timeout=timeout)
        self._last_message_at = datetime.now(UTC)
        return self._decode(raw_message) or {}

    def _wire_symbol(self, symbol: str) -> str:
        return symbol if "$" in symbol else f"{symbol}${self.config.itick_region}"

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

    @staticmethod
    def _subscription_succeeded(message: dict[str, Any]) -> bool:
        return message.get("resAc") == "subscribe" and message.get("code") == 1

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
