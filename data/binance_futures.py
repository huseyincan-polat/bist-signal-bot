"""Official Binance USDⓈ-M Futures market-data provider.

API documentation:
https://developers.binance.com/docs/derivatives/usds-margined-futures
"""

from __future__ import annotations

import asyncio
import json
import logging
from collections.abc import AsyncIterator
from datetime import UTC, datetime
from typing import Any

import websockets

from app.config import AppConfig
from data.kline_buffer import BUFFER_SIZE, KlineBufferStore
from data.models import Candle, MarketTick, ProviderHealth
from data.provider import RealTimeProvider
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

BOOK_TICKER_SUFFIX = "@bookTicker"
SYMBOL_SILENCE_SECONDS = 20
KLINE_SUBSCRIBE_BATCH = 20


class BinanceFuturesProvider(RealTimeProvider):
    """USDT perpetual futures via bookTicker prices and kline WS indicator buffers."""

    name = "Binance USDⓈ-M Futures"

    def __init__(self, config: AppConfig) -> None:
        self.config = config
        self.symbols: tuple[str, ...] = ()
        self.klines = KlineBufferStore(maxlen=BUFFER_SIZE)
        self._monitor = ConnectionMonitor(
            self.name,
            set(),
            config.stale_after_seconds,
            partial_coverage_allowed=True,
        )
        self._validator = TickValidator(config.stale_after_seconds)
        self._previous_closes: dict[str, float] = {}
        self._first_tick_logged = False
        self._raw_frames_logged = 0
        self.first_frame_type: str | None = None
        self._last_tick_at: dict[str, datetime] = {}
        self._kline_probe_complete = False

    @property
    def health(self) -> ProviderHealth:
        health = self._monitor.refresh_freshness()
        health.first_frame_type = self.first_frame_type
        health.kline_frames_received = self.klines.kline_frames_received
        health.symbols_with_buffers = len(self.klines.symbols_with_full_buffers(BUFFER_SIZE))
        health.symbols_analysis_ready = len(self.klines.symbols_with_min_bars())
        return health

    @property
    def analysis_ready(self) -> bool:
        return bool(self.klines.symbols_with_min_bars())

    async def connect(self) -> None:
        self.symbols = FALLBACK_USDT_PERPETUALS
        self._previous_closes = {}
        self._monitor.health.expected_symbols = set(self.symbols)
        self._monitor.mark_connected()
        logger.info("Binance Futures static universe loaded: symbols=%s", len(self.symbols))

    async def stream(self) -> AsyncIterator[MarketTick]:
        if not self.symbols:
            await self.connect()
        queue: asyncio.Queue[MarketTick] = asyncio.Queue()
        stop = asyncio.Event()
        workers = [
            asyncio.create_task(self._run_bookticker_feed(queue, stop), name="bookticker-feed"),
            asyncio.create_task(self._run_kline_feed("1m", stop), name="kline-1m-feed"),
            asyncio.create_task(self._run_kline_feed("1h", stop), name="kline-1h-feed"),
            asyncio.create_task(self._prune_silent_symbols(stop), name="silent-symbol-pruner"),
        ]
        try:
            while not stop.is_set():
                tick = await queue.get()
                yield tick
        finally:
            stop.set()
            for worker in workers:
                worker.cancel()
            await asyncio.gather(*workers, return_exceptions=True)

    async def _run_bookticker_feed(self, queue: asyncio.Queue[MarketTick], stop: asyncio.Event) -> None:
        url = f"{self.config.binance_websocket_url.rstrip('/')}/ws"
        failures = 0
        btc_probe = False
        awaiting_first_tick = True
        while not stop.is_set():
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
                    await socket.send(json.dumps(self._subscription_frame(active_symbols, BOOK_TICKER_SUFFIX, 1)))
                    logger.info("Binance bookTicker connected: streams=%s", len(active_symbols))
                    while not stop.is_set():
                        recv_timeout = 30 if awaiting_first_tick else self.config.stale_after_seconds
                        raw_message = await asyncio.wait_for(socket.recv(), timeout=recv_timeout)
                        self._log_raw_frame(raw_message)
                        tick = self._parse_bookticker(raw_message)
                        if tick and self._validator.validate(tick).accepted:
                            awaiting_first_tick = False
                            now = datetime.now(UTC)
                            self._last_tick_at[tick.symbol] = now
                            self._monitor.record_tick(tick, real_time=True)
                            self.klines.upsert_from_tick(tick)
                            if not self._first_tick_logged:
                                logger.info(
                                    "Binance Futures live tick: symbol=%s price=%s",
                                    tick.symbol,
                                    tick.price,
                                )
                                self._first_tick_logged = True
                            if btc_probe:
                                await self._subscribe_batches(
                                    socket,
                                    tuple(symbol for symbol in self.symbols if symbol != "BTCUSDT"),
                                    BOOK_TICKER_SUFFIX,
                                    start_id=2,
                                )
                                btc_probe = False
                            await queue.put(tick)
            except (OSError, websockets.WebSocketException, asyncio.TimeoutError):
                message = "Binance Futures stream unavailable"
                if self._monitor.health.symbols_received:
                    self._monitor.mark_transient_error(message)
                else:
                    self._monitor.mark_error(message)
                if not btc_probe:
                    logger.warning("Binance bookTicker batch was silent; probing BTCUSDT")
                    btc_probe = True
                failures += 1
                awaiting_first_tick = True
                await asyncio.sleep(min(self.config.reconnect_backoff_seconds * 2 ** (failures - 1), 60))

    async def _run_kline_feed(self, interval: str, stop: asyncio.Event) -> None:
        """Dedicated connection per interval to avoid stream limits on one socket."""
        url = f"{self.config.binance_websocket_url.rstrip('/')}/ws"
        suffix = f"@kline_{interval}"
        failures = 0
        btc_probe = False
        while not stop.is_set():
            try:
                async with websockets.connect(
                    url,
                    ping_interval=20,
                    ping_timeout=20,
                    close_timeout=5,
                ) as socket:
                    failures = 0
                    active_symbols = ("BTCUSDT",) if btc_probe else self.symbols
                    await self._subscribe_batches(socket, active_symbols, suffix, start_id=1)
                    logger.info("Binance kline_%s connected: symbols=%s", interval, len(active_symbols))
                    while not stop.is_set():
                        raw_message = await asyncio.wait_for(socket.recv(), timeout=30)
                        self._log_raw_frame(raw_message)
                        parsed = self._parse_kline(raw_message, interval)
                        if parsed:
                            candle, is_closed = parsed
                            if candle.symbol in self.symbols:
                                self.klines.upsert_kline(candle, is_closed)
                                if interval == "1m" and not self._kline_probe_complete:
                                    self._kline_probe_complete = True
                                    logger.info("Binance kline_%s frames flowing for %s", interval, candle.symbol)
                                if btc_probe:
                                    remaining = tuple(symbol for symbol in self.symbols if symbol != "BTCUSDT")
                                    await self._subscribe_batches(socket, remaining, suffix, start_id=2)
                                    btc_probe = False
            except (OSError, websockets.WebSocketException, asyncio.TimeoutError):
                failures += 1
                if interval == "1m" and not btc_probe and not self._kline_probe_complete:
                    logger.warning("Binance kline_%s batch silent; probing BTCUSDT", interval)
                    btc_probe = True
                await asyncio.sleep(min(self.config.reconnect_backoff_seconds * 2 ** (failures - 1), 60))

    async def _prune_silent_symbols(self, stop: asyncio.Event) -> None:
        while not stop.is_set():
            await asyncio.sleep(5)
            now = datetime.now(UTC)
            silent = [
                symbol
                for symbol in self.symbols
                if symbol in self._last_tick_at
                and (now - self._last_tick_at[symbol]).total_seconds() > SYMBOL_SILENCE_SECONDS
            ]
            if not silent:
                continue
            remaining = tuple(symbol for symbol in self.symbols if symbol not in silent)
            if len(remaining) == len(self.symbols) or len(remaining) < max(10, len(self.symbols) // 2):
                continue
            logger.warning("Dropping silent symbols after %ss: %s", SYMBOL_SILENCE_SECONDS, silent)
            self.symbols = remaining
            self._monitor.health.expected_symbols = set(self.symbols)

    @staticmethod
    def _subscription_frame(symbols: tuple[str, ...], suffix: str, request_id: int) -> dict[str, object]:
        return {
            "method": "SUBSCRIBE",
            "params": [f"{symbol.lower()}{suffix}" for symbol in symbols],
            "id": request_id,
        }

    async def _subscribe_batches(
        self,
        socket: Any,
        symbols: tuple[str, ...],
        suffix: str,
        *,
        start_id: int,
    ) -> None:
        request_id = start_id
        for start in range(0, len(symbols), KLINE_SUBSCRIBE_BATCH):
            batch = symbols[start:start + KLINE_SUBSCRIBE_BATCH]
            await socket.send(json.dumps(self._subscription_frame(batch, suffix, request_id)))
            request_id += 1

    @staticmethod
    def classify_frame(payload: dict[str, Any]) -> str:
        if payload.get("e") == "bookTicker":
            return "bookTicker"
        if payload.get("e") == "kline":
            interval = payload.get("k", {}).get("i")
            return f"kline_{interval}" if interval else "kline"
        if "error" in payload:
            return "error"
        if "result" in payload and "id" in payload:
            return "subscription_result"
        return str(payload.get("e") or "unknown")

    def _log_raw_frame(self, raw_message: str | bytes) -> str:
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
        if self._raw_frames_logged < 3:
            logger.info("Binance WebSocket raw frame [%s]: %s", frame_type, preview[:240])
            self._raw_frames_logged += 1
        return frame_type

    def _parse_bookticker(self, raw_message: str | bytes | dict[str, Any]) -> MarketTick | None:
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

    @staticmethod
    def _parse_kline(raw_message: str | bytes | dict[str, Any], interval: str) -> tuple[Candle, bool] | None:
        if isinstance(raw_message, (str, bytes)):
            try:
                payload = json.loads(raw_message)
            except (TypeError, json.JSONDecodeError):
                return None
        else:
            payload = raw_message
        data = payload.get("data", payload)
        if not isinstance(data, dict) or data.get("e") != "kline":
            return None
        kline = data.get("k")
        if not isinstance(kline, dict) or kline.get("i") != interval:
            return None
        try:
            candle = Candle(
                symbol=str(data["s"]),
                timeframe=interval,
                timestamp=datetime.fromtimestamp(float(kline["t"]) / 1000, UTC),
                open=float(kline["o"]),
                high=float(kline["h"]),
                low=float(kline["l"]),
                close=float(kline["c"]),
                volume=float(kline["v"]),
            )
            return candle, bool(kline.get("x"))
        except (KeyError, TypeError, ValueError):
            return None

    def historical_candles(self, symbol: str, timeframe: str) -> list[Candle]:
        return self.klines.candles(symbol, timeframe)
