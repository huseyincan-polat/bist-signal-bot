"""Minimal documented dxLink WebSocket client.

Protocol source: https://github.com/dxFeed/dxLink/blob/main/dxlink-specification/asyncapi.yml
The provider endpoint is supplied by dxFeed in the customer's welcome letter.
"""

from __future__ import annotations

import asyncio
import json
from collections.abc import AsyncIterator
from datetime import UTC, datetime
from typing import Any

import websockets


class DxLinkClient:
    """Streams FULL-format Quote, Trade, and Candle events over dxLink."""

    def __init__(
        self,
        url: str,
        token: str | None,
        symbols: list[str],
        candle_from_times: dict[str, int] | None = None,
    ) -> None:
        self.url = url
        self.token = token
        self.symbols = symbols
        self.candle_from_times = candle_from_times if candle_from_times is not None else {}
        self._channel_open = False

    @staticmethod
    def _message(type_: str, channel: int, **values: Any) -> str:
        return json.dumps({"type": type_, "channel": channel, **values})

    async def events(self, reconnect_delay: int = 3) -> AsyncIterator[dict[str, Any]]:
        while True:
            try:
                async for event in self._connect_once():
                    yield event
            except (OSError, websockets.WebSocketException, asyncio.TimeoutError) as error:
                yield {"eventType": "connection_error", "message": str(error)}
                await asyncio.sleep(reconnect_delay)

    async def _connect_once(self) -> AsyncIterator[dict[str, Any]]:
        self._channel_open = False
        async with websockets.connect(self.url, ping_interval=None, close_timeout=5) as socket:
            await socket.send(
                self._message(
                    "SETUP",
                    0,
                    keepaliveTimeout=60,
                    acceptKeepaliveTimeout=60,
                    version="0.1-python/1.0.0",
                )
            )
            authorized = self.token is None
            while True:
                raw = await asyncio.wait_for(socket.recv(), timeout=70)
                message = json.loads(raw)
                kind = message.get("type")

                if kind == "KEEPALIVE":
                    continue
                if kind == "SETUP":
                    if self.token:
                        await socket.send(self._message("AUTH", 0, token=self.token))
                    else:
                        await self._request_feed(socket)
                    continue
                if kind == "AUTH_STATE":
                    if message.get("state") != "AUTHORIZED":
                        raise ConnectionError("dxFeed authorization failed")
                    authorized = True
                    await self._request_feed(socket)
                    continue
                if kind == "ERROR":
                    raise ConnectionError(message.get("message", "dxLink protocol error"))
                if kind == "CHANNEL_OPENED" and message.get("channel") == 1 and authorized:
                    await self._subscribe(socket)
                    continue
                if kind == "FEED_DATA":
                    for event in message.get("data", []):
                        if isinstance(event, dict):
                            yield event

    async def _request_feed(self, socket: websockets.ClientConnection) -> None:
        if not self._channel_open:
            self._channel_open = True
            await socket.send(self._message("CHANNEL_REQUEST", 1, service="FEED", parameters={"contract": "AUTO"}))

    async def _subscribe(self, socket: websockets.ClientConnection) -> None:
        fields = {
            "Quote": ["eventType", "eventSymbol", "time", "bidPrice", "askPrice", "bidSize", "askSize"],
            "Trade": ["eventType", "eventSymbol", "time", "price", "size", "dayVolume"],
            "Candle": ["eventType", "eventSymbol", "time", "open", "high", "low", "close", "volume"],
        }
        await socket.send(self._message("FEED_SETUP", 1, acceptDataFormat="FULL", acceptEventFields=fields))
        quotes_and_trades = [
            {"type": event_type, "symbol": symbol}
            for symbol in self.symbols
            for event_type in ("Quote", "Trade")
        ]
        candles = [
            {
                "type": "Candle",
                "symbol": f"{symbol}{{=m}}",
                # On reconnect this resumes just before the last cached candle.
                "fromTime": self.candle_from_times.get(
                    symbol, int((datetime.now(UTC).timestamp() - 86400 * 5) * 1000)
                ),
            }
            for symbol in self.symbols
        ]
        await socket.send(self._message("FEED_SUBSCRIPTION", 1, add=quotes_and_trades + candles))
