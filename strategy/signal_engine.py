"""Multi-timeframe signal engine; produces analysis only, never orders."""

from __future__ import annotations

from collections import defaultdict
from datetime import UTC, datetime, timedelta

from app.config import AppConfig
from data.models import Candle, MarketTick, Signal, SignalState
from indicators import momentum, patterns, price_action, trend, volatility, volume
from risk.stops import stop_price
from risk.targets import targets
from strategy.market_regime import classify_market_regime
from strategy.relative_strength import relative_strength, score as relative_score
from strategy.scoring import aggregate, classify, is_bullish, meaningful_transition


class SignalEngine:
    """Calculates and caches one fresh analytical signal per symbol."""

    def __init__(self, config: AppConfig, provider_name: str) -> None:
        self.config = config
        self.provider_name = provider_name
        self._candles: dict[str, dict[str, list[Candle]]] = defaultdict(dict)
        self.signals: dict[str, Signal] = {}
        self._last_alert_at: dict[str, datetime] = {}
        self._pending_previous: dict[str, SignalState | None] = {}
        self.index_symbol = config.index_symbol.split(":")[0]
        self.market_regime = "NEUTRAL"

    def seed_history(self, symbol: str, timeframe: str, candles: list[Candle]) -> None:
        self._candles[symbol][timeframe] = list(candles)[-600:]

    def _update_current_candle(self, tick: MarketTick) -> None:
        history = self._candles[tick.symbol].setdefault("1m", [])
        minute = tick.timestamp.replace(second=0, microsecond=0)
        if history and history[-1].timestamp == minute:
            previous = history[-1]
            history[-1] = Candle(
                symbol=tick.symbol, timeframe="1m", timestamp=minute, open=previous.open,
                high=max(previous.high, tick.price), low=min(previous.low, tick.price),
                close=tick.price, volume=previous.volume + (tick.tick_volume or 0),
            )
        else:
            history.append(Candle(tick.symbol, "1m", minute, tick.price, tick.price, tick.price, tick.price, tick.tick_volume or 0))
        self._candles[tick.symbol]["1m"] = history[-600:]

    def _update_daily_candle(self, tick: MarketTick) -> None:
        """Apply a live last price to the primed daily series incrementally."""
        history = self._candles[tick.symbol].get("daily")
        if not history:
            return
        current_day = tick.timestamp.date()
        previous = history[-1]
        if previous.timestamp.date() == current_day:
            history[-1] = Candle(
                symbol=tick.symbol,
                timeframe="daily",
                timestamp=previous.timestamp,
                open=previous.open,
                high=max(previous.high, tick.price),
                low=min(previous.low, tick.price),
                close=tick.price,
                volume=max(previous.volume, tick.total_volume or previous.volume),
            )
        else:
            history.append(
                Candle(
                    symbol=tick.symbol,
                    timeframe="daily",
                    timestamp=tick.timestamp.replace(hour=0, minute=0, second=0, microsecond=0),
                    open=previous.close,
                    high=tick.price,
                    low=tick.price,
                    close=tick.price,
                    volume=tick.total_volume or tick.tick_volume or 0,
                )
            )
        self._candles[tick.symbol]["daily"] = history[-600:]

    def _analysis_candles(self, symbol: str) -> list[Candle]:
        intraday = self._candles[symbol].get("1m", [])
        return intraday if len(intraday) >= 35 else self._candles[symbol].get("daily", intraday)

    def prime_from_history(self) -> int:
        """Create display-only initial analyses from delayed historical bars."""
        primed = 0
        for symbol in self.config.symbols:
            candles = self._candles[symbol].get("daily", [])
            if len(candles) < 35:
                continue
            latest = candles[-1]
            self.signals[symbol] = self._build_signal(
                MarketTick(
                    symbol=symbol,
                    price=latest.close,
                    timestamp=latest.timestamp,
                    total_volume=latest.volume,
                    source="yfinance delayed history",
                ),
                candles,
            )
            primed += 1
        return primed

    def _timeframe_candles(self, symbol: str, timeframe: str) -> list[Candle]:
        direct = self._candles[symbol].get(timeframe)
        if direct:
            return direct
        multiplier = {"5m": 5, "15m": 15, "1h": 60, "daily": 1440}.get(timeframe)
        source = self._candles[symbol].get("1m", [])
        if not multiplier or len(source) < multiplier:
            return source
        aggregated: list[Candle] = []
        for index in range(0, len(source), multiplier):
            group = source[index:index + multiplier]
            if len(group) < multiplier:
                continue
            aggregated.append(Candle(
                symbol=symbol, timeframe=timeframe, timestamp=group[0].timestamp,
                open=group[0].open, high=max(item.high for item in group),
                low=min(item.low for item in group), close=group[-1].close,
                volume=sum(item.volume for item in group),
            ))
        return aggregated

    @staticmethod
    def _trend_score(value: str | None) -> float:
        return {"YÜKSELİŞ": 100, "DÜŞÜŞ": 0}.get(value or "", 50)

    def on_tick(self, tick: MarketTick) -> Signal | None:
        """Incrementally update only the affected symbol then recalculate it."""
        self._update_current_candle(tick)
        self._update_daily_candle(tick)
        if tick.symbol == self.index_symbol:
            self.market_regime = classify_market_regime(self._timeframe_candles(tick.symbol, "daily"))
            return None
        if tick.symbol not in self.config.symbols:
            return None
        analysis_candles = self._analysis_candles(tick.symbol)
        if len(analysis_candles) < 35:
            return None
        previous = self.signals.get(tick.symbol)
        signal = self._build_signal(tick, analysis_candles)
        self._pending_previous[tick.symbol] = previous.state if previous else None
        self.signals[tick.symbol] = signal
        return signal

    def _build_signal(self, tick: MarketTick, candles: list[Candle]) -> Signal:
        trend_values = trend.calculate(candles)
        momentum_values = momentum.calculate(candles)
        volume_values = volume.calculate(candles)
        volatility_values = volatility.calculate(candles)
        structure = price_action.calculate(candles)
        candle_patterns = patterns.calculate(candles)
        index_candles = self._analysis_candles(self.index_symbol)
        rs = relative_strength(candles, index_candles)
        mtf_trends = [
            self._trend_score(trend.calculate(self._timeframe_candles(tick.symbol, timeframe)).get("trend"))
            for timeframe in ("15m", "1h", "daily")
        ]
        momentum_score = 50.0
        rsi = momentum_values["rsi_14"]
        if isinstance(rsi, float):
            momentum_score = 50 + (rsi - 50) * 1.2
        if (momentum_values["macd_histogram"] or 0) > 0:
            momentum_score += 10
        components = {
            "trend": self._trend_score(str(trend_values["trend"])),
            "momentum": momentum_score,
            "volume": 70 if volume_values["volume_spike"] and tick.price >= (volume_values["vwap"] or tick.price) else 45,
            "breakout": 100 if structure["breakout"] else 0 if structure["breakdown"] else 50,
            "volatility": 65 if (volatility_values["bb_width"] or 0) < 0.15 else 45,
            "multi_timeframe": sum(mtf_trends) / len(mtf_trends),
            "market_regime": {"BULLISH": 100, "BEARISH": 0}.get(self.market_regime, 50),
            "relative_strength": relative_score(rs),
        }
        score = aggregate(
            components,
            self.market_regime,
            int(self.config.scoring.get("bearish_regime_penalty", 12)),
        )
        state = classify(score, self.config.scoring.get("buckets"))
        bullish = is_bullish(state)
        stop = stop_price(
            tick.price, volatility_values["atr_14"], structure["support"], structure["resistance"], bullish
        )
        reasons = self._reasons(trend_values, momentum_values, volume_values, structure, candle_patterns, rs)
        metrics: dict[str, float | str | None] = {
            "rsi": momentum_values["rsi_14"],
            "macd": momentum_values["macd"],
            "adx": trend_values["adx"],
            "relative_volume": volume_values["relative_volume"],
            "trend": str(trend_values["trend"]),
            "15m": self._timeframe_label(tick.symbol, "15m"),
            "1h": self._timeframe_label(tick.symbol, "1h"),
            "daily": self._timeframe_label(tick.symbol, "daily"),
            "relative_strength": rs,
            "market_regime": self.market_regime,
            "data_quality": "LIVE" if tick.source == self.provider_name else "DELAYED_HISTORICAL",
        }
        return Signal(
            symbol=tick.symbol,
            state=state,
            confidence=score,
            price=round(tick.price, 2),
            entry=round(tick.price, 2),
            stop=stop,
            targets=targets(tick.price, stop, bullish),
            reasons=reasons,
            data_timestamp=tick.timestamp,
            generated_at=datetime.now(UTC),
            provider=self.provider_name,
            metrics=metrics,
        )

    def _timeframe_label(self, symbol: str, timeframe: str) -> str:
        return str(trend.calculate(self._timeframe_candles(symbol, timeframe)).get("trend", "NÖTR"))

    @staticmethod
    def _reasons(
        trend_values: dict[str, float | str | None],
        momentum_values: dict[str, float | None],
        volume_values: dict[str, float | bool | None],
        structure: dict[str, float | bool | str | None],
        candle_patterns: dict[str, bool],
        rs: float | None,
    ) -> list[str]:
        reasons = [f"Trend: {trend_values['trend']}"]
        if momentum_values["rsi_14"] is not None:
            reasons.append(f"RSI(14): {momentum_values['rsi_14']}")
        if volume_values["relative_volume"] is not None:
            reasons.append(f"Bağıl hacim: {volume_values['relative_volume']}x")
        if structure["breakout"]:
            reasons.append("Direnç kırılımı")
        elif structure["breakdown"]:
            reasons.append("Destek kırılımı")
        if candle_patterns["bullish_engulfing"]:
            reasons.append("Boğa yutan mum")
        if candle_patterns["bearish_engulfing"]:
            reasons.append("Ayı yutan mum")
        if rs is not None:
            reasons.append(f"BIST 100'e göre güç: {rs:+.2f}%")
        return reasons

    def should_notify(self, signal: Signal) -> bool:
        previous = self._pending_previous.pop(signal.symbol, None)
        last_alert = self._last_alert_at.get(signal.symbol)
        cooldown_elapsed = not last_alert or datetime.now(UTC) - last_alert >= timedelta(minutes=self.config.signal_cooldown_minutes)
        if cooldown_elapsed and meaningful_transition(previous, signal.state):
            self._last_alert_at[signal.symbol] = datetime.now(UTC)
            return True
        return False
