"""Official Binance USDⓈ-M Futures market-data provider.

API documentation:
https://developers.binance.com/docs/derivatives/usds-margined-futures
"""

from __future__ import annotations

import asyncio
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


class BinanceFuturesProvider(RealTimeProvider, HistoricalProvider):
    """Top-quote-volume USDT perpetual futures with aggTrade streaming."""

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

    @property
    def health(self) -> ProviderHealth:
        return self._monitor.refresh_freshness()

    async def connect(self) -> None:
        try:
            symbols, previous_closes = await asyncio.to_thread(self._refresh_universe)
        except httpx.HTTPStatusError as error:
            self._monitor.mark_error(f"Binance Futures universe HTTP {error.response.status_code}")
            logger.warning("Binance Futures universe request failed: HTTP %s", error.response.status_code)
            raise
        if not symbols:
            self._monitor.mark_error("Binance Futures universe is unavailable")
            raise RuntimeError("No Binance USDT perpetual symbols available")
        self.symbols = symbols
        self._previous_closes = previous_closes
        self._monitor.health.expected_symbols = set(symbols)
        self._monitor.mark_connected()
        logger.info("Binance Futures universe refreshed: symbols=%s", len(symbols))

    def _refresh_universe(self) -> tuple[tuple[str, ...], dict[str, float]]:
        with httpx.Client(base_url=self.config.binance_rest_url, timeout=10) as client:
            exchange_response = client.get("/fapi/v1/exchangeInfo")
            ticker_response = client.get("/fapi/v1/ticker/24hr")
        exchange_response.raise_for_status()
        ticker_response.raise_for_status()
        exchange_info = exchange_response.json()
        tickers = ticker_response.json()
        if not isinstance(exchange_info, dict) or not isinstance(tickers, list):
            raise RuntimeError("Binance Futures returned an invalid market-data response")
        perpetuals = {
            item["symbol"]
            for item in exchange_info.get("symbols", [])
            if item.get("status") == "TRADING"
            and item.get("contractType") == "PERPETUAL"
            and item.get("quoteAsset") == "USDT"
        }
        ranked = sorted(
            (item for item in tickers if item.get("symbol") in perpetuals),
            key=lambda item: float(item.get("quoteVolume", 0) or 0),
            reverse=True,
        )[: self.config.binance_universe_size]
        return (
            tuple(item["symbol"] for item in ranked),
            {
                item["symbol"]: float(item["prevClosePrice"])
                for item in ranked
                if item.get("prevClosePrice") not in (None, "")
            },
        )

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

        history: dict[str, list[Candle]] = {}
        with ThreadPoolExecutor(max_workers=8) as executor:
            futures = [executor.submit(fetch_symbol, symbol) for symbol in symbols]
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
        streams = "/".join(f"{symbol.lower()}@aggTrade" for symbol in self.symbols)
        url = f"{self.config.binance_websocket_url}/stream?streams={streams}"
        failures = 0
        while True:
            try:
                async with websockets.connect(url, ping_interval=20, close_timeout=5) as socket:
                    self._monitor.mark_connected()
                    failures = 0
                    logger.info("Binance Futures WebSocket connected: aggTrade streams=%s", len(self.symbols))
                    async for raw_message in socket:
                        tick = self.parse_message(raw_message)
                        if tick and self._validator.validate(tick).accepted:
                            self._monitor.record_tick(tick, real_time=True)
                            if not self._first_tick_logged:
                                logger.info(
                                    "Binance Futures live tick: symbol=%s price=%s timestamp=%s",
                                    tick.symbol,
                                    tick.price,
                                    tick.timestamp.isoformat(),
                                )
                                self._first_tick_logged = True
                            yield tick
            except (OSError, websockets.WebSocketException, asyncio.TimeoutError):
                self._monitor.mark_error("Binance Futures stream unavailable")
                failures += 1
                await asyncio.sleep(min(self.config.reconnect_backoff_seconds * 2 ** (failures - 1), 60))

    def parse_message(self, raw_message: str | bytes | dict[str, Any]) -> MarketTick | None:
        if isinstance(raw_message, (str, bytes)):
            import json

            try:
                payload = json.loads(raw_message)
            except (TypeError, json.JSONDecodeError):
                return None
        else:
            payload = raw_message
        data = payload.get("data", payload)
        if not isinstance(data, dict) or data.get("e") != "aggTrade":
            return None
        symbol, price, timestamp = data.get("s"), data.get("p"), data.get("T")
        if (
            not isinstance(symbol, str)
            or symbol not in self.symbols
            or price is None
            or not isinstance(timestamp, (int, float))
        ):
            return None
        try:
            return MarketTick(
                symbol=symbol,
                price=float(price),
                timestamp=datetime.fromtimestamp(float(timestamp) / 1000, UTC),
                tick_volume=float(data["q"]) if data.get("q") is not None else None,
                previous_close=self._previous_closes.get(symbol),
                source=self.name,
            )
        except (TypeError, ValueError, OSError):
            return None

    def historical_candles(self, symbol: str, timeframe: str) -> list[Candle]:
        return list(self._history.get((symbol, timeframe), []))
