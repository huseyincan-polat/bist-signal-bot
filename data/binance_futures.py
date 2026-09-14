"""Official Binance USDⓈ-M Futures market-data provider.

API documentation:
https://developers.binance.com/docs/derivatives/usds-margined-futures
"""

from __future__ import annotations

import asyncio
import json
import logging
from collections.abc import AsyncIterator
from concurrent.futures import ThreadPoolExecutor, as_completed
from datetime import UTC, datetime
from typing import Any

import httpx
import websockets

from app.config import AppConfig
from data.models import Candle, MarketTick, ProviderHealth
from data.provider import HistoricalProvider, RealTimeProvider
from data.realtime import ConnectionMonitor, TickValidator

logger = logging.getLogger(__name__)

FALLBACK_USDT_PERPETUALS = (
    "BTCUSDT", "ETHUSDT", "SOLUSDT", "XRPUSDT", "ADAUSDT", "BNBUSDT",
    "DOGEUSDT", "TRXUSDT", "LINKUSDT", "AVAXUSDT", "LTCUSDT", "BCHUSDT",
    "XLMUSDT", "DOTUSDT", "UNIUSDT", "AAVEUSDT", "NEARUSDT", "APTUSDT",
    "OPUSDT", "ARBUSDT", "FILUSDT", "ATOMUSDT", "ETCUSDT", "ICPUSDT",
    "INJUSDT", "SEIUSDT", "WIFUSDT", "FETUSDT", "TIAUSDT", "RENDERUSDT",
    "ONDOUSDT", "CRVUSDT", "PENDLEUSDT", "ENAUSDT", "WLDUSDT", "GALAUSDT",
    "1000PEPEUSDT", "1000SHIBUSDT", "TAOUSDT", "JUPUSDT", "LDOUSDT",
    "ALGOUSDT", "VETUSDT", "EOSUSDT", "KAVAUSDT", "AXSUSDT", "SANDUSDT",
    "MANAUSDT", "RUNEUSDT", "KSMUSDT",
)

# Official USDⓈ-M market stream suffix. bookTicker is used because aggTrade can be
# silent on some cloud egress paths while the documented SUBSCRIBE flow still acks.
STREAM_SUFFIX = "@bookTicker"


class BinanceFuturesProvider(RealTimeProvider, HistoricalProvider):
    """Top-quote-volume USDT perpetual futures with bookTicker streaming."""

    name = "Binance USDⓈ-M Futures"

    def __init__(self, config: AppConfig) -> None:
        self.config = config
        self.symbols: tuple[str, ...] = ()
        self._monitor = ConnectionMonitor(
            self.name,
            set(),
            config.stale_after_seconds,
            partial_coverage_allowed=True,
        )
        self._validator = TickValidator(config.stale_after_seconds)
        self._history: dict[tuple[str, str], list[Candle]] = {}
        self._previous_closes: dict[str, float] = {}
        self._first_tick_logged = False
        self._raw_frames_logged = 0
        self.first_frame_type: str | None = None

    @property
    def health(self) -> ProviderHealth:
        health = self._monitor.refresh_freshness()
        health.first_frame_type = self.first_frame_type
        return health

    async def connect(self) -> None:
        self.symbols = FALLBACK_USDT_PERPETUALS
        self._previous_closes = {}
        self._monitor.health.expected_symbols = set(self.symbols)
        self._monitor.mark_connected()
        logger.info("Binance Futures static universe loaded: symbols=%s", len(self.symbols))

    async def prime_history(self) -> dict[str, list[Candle]]:
        history = await asyncio.to_thread(self._fetch_history, self.symbols)
        for symbol, candles in history.items():
            self._history[(symbol, "1m")] = candles
        return history

    def _fetch_history(self, symbols: tuple[str, ...]) -> dict[str, list[Candle]]:
        def fetch_symbol(symbol: str) -> tuple[str, list[Candle]]:
            response = httpx.get(
                f"{self.config.binance_rest_url}/fapi/v1/klines",
                params={"symbol": symbol, "interval": "1m", "limit": self.config.binance_historical_limit},
                timeout=10,
            )
            response.raise_for_status()
            rows = response.json()
            candles = [
                Candle(
                    symbol=symbol,
                    timeframe="1m",
                    timestamp=datetime.fromtimestamp(float(row[0]) / 1000, UTC),
                    open=float(row[1]),
                    high=float(row[2]),
                    low=float(row[3]),
                    close=float(row[4]),
                    volume=float(row[5]),
                )
                for row in rows
            ]
            return symbol, candles

        if not symbols:
            return {}
        history: dict[str, list[Candle]] = {}
        try:
            symbol, candles = fetch_symbol(symbols[0])
            if candles:
                history[symbol] = candles
        except httpx.HTTPStatusError as error:
            if error.response.status_code in (418, 451):
                logger.warning("Binance klines unavailable: HTTP %s", error.response.status_code)
                return {}
            raise
        with ThreadPoolExecutor(max_workers=8) as executor:
            futures = [executor.submit(fetch_symbol, symbol) for symbol in symbols[1:]]
            for future in as_completed(futures):
                try:
                    symbol, candles = future.result()
                except (httpx.HTTPError, KeyError, TypeError, ValueError):
                    continue
                if candles:
                    history[symbol] = candles
        return history

    async def stream(self) -> AsyncIterator[MarketTick]:
        if not self.symbols:
            await self.connect()
        url = f"{self.config.binance_websocket_url.rstrip('/')}/ws"
        failures = 0
        btc_probe = False
        awaiting_first_tick = True
        while True:
            try:
                async with websockets.connect(
                    url,
                    ping_interval=20,
                    ping_timeout=20,
                    close_timeout=5,
                ) as socket:
                    self._monitor.mark_connected()
                    failures = 0
                    active_symbols = ("BTCUSDT",) if btc_probe else self.symbols
                    await socket.send(json.dumps(self.subscription_frame(active_symbols, request_id=1)))
                    logger.info(
                        "Binance Futures WebSocket connected: bookTicker streams=%s",
                        len(active_symbols),
                    )
                    while True:
                        recv_timeout = 30 if awaiting_first_tick else self.config.stale_after_seconds
                        raw_message = await asyncio.wait_for(socket.recv(), timeout=recv_timeout)
                        frame_type = self._log_raw_frame(raw_message)
                        tick = self.parse_message(raw_message)
                        if tick and self._validator.validate(tick).accepted:
                            awaiting_first_tick = False
                            self._monitor.record_tick(tick, real_time=True)
                            if not self._first_tick_logged:
                                logger.info(
                                    "Binance Futures live tick: symbol=%s price=%s frame=%s timestamp=%s",
                                    tick.symbol,
                                    tick.price,
                                    frame_type,
                                    tick.timestamp.isoformat(),
                                )
                                self._first_tick_logged = True
                            if btc_probe:
                                await self._subscribe_remaining_symbols(socket)
                                btc_probe = False
                            yield tick
            except (OSError, websockets.WebSocketException, asyncio.TimeoutError):
                message = "Binance Futures stream unavailable"
                if self._monitor.health.symbols_received:
                    self._monitor.mark_transient_error(message)
                else:
                    self._monitor.mark_error(message)
                if not btc_probe:
                    logger.warning("Binance 50-stream subscription was silent; probing BTCUSDT")
                    btc_probe = True
                failures += 1
                awaiting_first_tick = True
                await asyncio.sleep(min(self.config.reconnect_backoff_seconds * 2 ** (failures - 1), 60))

    def subscription_frame(self, symbols: tuple[str, ...], request_id: int) -> dict[str, object]:
        """Documented Binance raw WebSocket SUBSCRIBE frame."""
        return {
            "method": "SUBSCRIBE",
            "params": [f"{symbol.lower()}{STREAM_SUFFIX}" for symbol in symbols],
            "id": request_id,
        }

    async def _subscribe_remaining_symbols(self, socket: Any) -> None:
        remaining = tuple(symbol for symbol in self.symbols if symbol != "BTCUSDT")
        for request_id, start in enumerate(range(0, len(remaining), 25), start=2):
            batch = remaining[start:start + 25]
            await socket.send(json.dumps(self.subscription_frame(batch, request_id)))
        logger.info("Binance BTCUSDT probe succeeded; requested remaining streams in two batches")

    @staticmethod
    def classify_frame(payload: dict[str, Any]) -> str:
        if payload.get("e") == "bookTicker":
            return "bookTicker"
        if "error" in payload:
            return "error"
        if "result" in payload and "id" in payload:
            return "subscription_result"
        return str(payload.get("e") or "unknown")

    def _log_raw_frame(self, raw_message: str | bytes) -> str:
        """Log only the first public frames, truncated to prevent noisy terminals."""
        preview = raw_message.decode() if isinstance(raw_message, bytes) else raw_message
        frame_type = "unknown"
        try:
            payload = json.loads(preview)
            if isinstance(payload, dict):
                frame_type = self.classify_frame(payload)
        except json.JSONDecodeError:
            frame_type = "non_json"
        if self.first_frame_type is None:
            self.first_frame_type = frame_type
        if self._raw_frames_logged < 2:
            logger.info("Binance WebSocket raw frame [%s]: %s", frame_type, preview[:240])
            self._raw_frames_logged += 1
        return frame_type

    def parse_message(self, raw_message: str | bytes | dict[str, Any]) -> MarketTick | None:
        if isinstance(raw_message, (str, bytes)):
            try:
                payload = json.loads(raw_message)
            except (TypeError, json.JSONDecodeError):
                return None
        else:
            payload = raw_message
        data = payload.get("data", payload)
        if not isinstance(data, dict) or data.get("e") != "bookTicker":
            return None
        symbol = data.get("s")
        bid, ask = data.get("b"), data.get("a")
        timestamp = data.get("E") or data.get("T")
        if (
            not isinstance(symbol, str)
            or symbol not in self.symbols
            or bid is None
            or ask is None
            or not isinstance(timestamp, (int, float))
        ):
            return None
        try:
            bid_f, ask_f = float(bid), float(ask)
            if bid_f <= 0 or ask_f <= 0:
                return None
            return MarketTick(
                symbol=symbol,
                price=round((bid_f + ask_f) / 2, 8),
                timestamp=datetime.fromtimestamp(float(timestamp) / 1000, UTC),
                bid=bid_f,
                ask=ask_f,
                previous_close=self._previous_closes.get(symbol),
                source=self.name,
            )
        except (TypeError, ValueError, OSError):
            return None

    def historical_candles(self, symbol: str, timeframe: str) -> list[Candle]:
        return list(self._history.get((symbol, timeframe), []))
