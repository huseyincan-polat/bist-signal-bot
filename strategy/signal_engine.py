"""Multi-timeframe signal engine; produces analysis only, never orders."""

from __future__ import annotations

from collections import defaultdict, deque
from datetime import UTC, datetime, timedelta

from app.config import AppConfig
from data.kline_buffer import KlineBufferStore, MIN_BARS_FOR_SIGNALS, SyntheticTrends
from data.models import Candle, MarketTick, Signal, SignalState
from indicators import momentum, patterns, price_action, trend, volatility, volume
from risk.scalping import scalping_risk_plan
from strategy.market_regime import classify_market_regime
from strategy.relative_strength import relative_strength, score as relative_score
from strategy.scalping import scalping_score, tick_momentum_pct
from strategy.scoring import classify, is_bullish, meaningful_transition


class SignalEngine:
    """Calculates and caches one fresh analytical signal per symbol."""

    def __init__(self, config: AppConfig, provider_name: str) -> None:
        self.config = config
        self.provider_name = provider_name
        self._candles: dict[str, dict[str, list[Candle]]] = defaultdict(dict)
        self._previous_closes: dict[str, float] = {}
        self._tick_prices: dict[str, deque[float]] = defaultdict(lambda: deque(maxlen=24))
        self.signals: dict[str, Signal] = {}
        self._last_alert_at: dict[str, datetime] = {}
        self._pending_previous: dict[str, SignalState | None] = {}
        self.index_symbol = config.index_symbol.split(":")[0]
        self.market_regime = "NEUTRAL"
        self._kline_store: KlineBufferStore | None = None

    def bind_kline_store(self, store: KlineBufferStore) -> None:
        self._kline_store = store

    def reset_symbol(self, symbol: str) -> None:
        self.signals.pop(symbol, None)
        self._pending_previous.pop(symbol, None)
        self._tick_prices.pop(symbol, None)
        self._candles.pop(symbol, None)

    def seed_history(self, symbol: str, timeframe: str, candles: list[Candle]) -> None:
        history = list(candles)[-600:]
        self._candles[symbol][timeframe] = history
        if timeframe == "daily" and len(history) >= 2:
            self._previous_closes[symbol] = history[-2].close

    def previous_close(self, symbol: str) -> float | None:
        return self._previous_closes.get(symbol)

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
        if self._kline_store:
            ws_candles = self._kline_store.candles(symbol, "1m")
            if len(ws_candles) >= MIN_BARS_FOR_SIGNALS:
                return ws_candles
        intraday = self._candles[symbol].get("1m", [])
        return intraday if len(intraday) >= MIN_BARS_FOR_SIGNALS else self._candles[symbol].get("daily", intraday)

    def prime_from_history(self) -> int:
        """Create initial analyses from primed provider candles."""
        primed = 0
        for symbol in self.config.symbols:
            candles = self._analysis_candles(symbol)
            if len(candles) < MIN_BARS_FOR_SIGNALS:
                continue
            latest = candles[-1]
            self._tick_prices[symbol].append(latest.close)
            self.signals[symbol] = self._build_signal(
                MarketTick(
                    symbol=symbol,
                    price=latest.close,
                    timestamp=latest.timestamp,
                    total_volume=latest.volume,
                    source="historical primer",
                ),
                candles,
            )
            primed += 1
        return primed

    def _record_tick_price(self, tick: MarketTick) -> float:
        prices = self._tick_prices[tick.symbol]
        prices.append(tick.price)
        return tick_momentum_pct(list(prices))

    def on_tick(self, tick: MarketTick, symbol_data_age: float | None = None) -> Signal | None:
        """Incrementally update only the affected symbol then recalculate it."""
        if tick.previous_close is not None and tick.previous_close > 0:
            self._previous_closes[tick.symbol] = tick.previous_close
        self._update_current_candle(tick)
        self._update_daily_candle(tick)
        if tick.symbol == self.index_symbol:
            self.market_regime = classify_market_regime(self._analysis_candles(tick.symbol))
            return None
        if tick.symbol not in self.config.symbols:
            return None
        analysis_candles = self._analysis_candles(tick.symbol)
        if len(analysis_candles) < MIN_BARS_FOR_SIGNALS:
            return None
        previous = self.signals.get(tick.symbol)
        trends = (
            self._kline_store.synthetic_trends(tick.symbol, tick.price)
            if self._kline_store
            else SyntheticTrends()
        )
        signal = self._build_signal(tick, analysis_candles, symbol_data_age, trends)
        self._pending_previous[tick.symbol] = previous.state if previous else None
        self.signals[tick.symbol] = signal
        return signal

    def _build_signal(
        self,
        tick: MarketTick,
        candles: list[Candle],
        symbol_data_age: float | None = None,
        trends: SyntheticTrends | None = None,
    ) -> Signal:
        tick_accel = self._record_tick_price(tick)
        trend_values = trend.calculate(candles)
        momentum_values = momentum.calculate(candles)
        volume_values = volume.calculate(candles)
        volatility_values = volatility.calculate(candles)
        structure = price_action.calculate(candles)
        if self._kline_store:
            snapshot = self._kline_store.structure(tick.symbol)
            if snapshot.swing_low is not None:
                structure["swing_low"] = snapshot.swing_low
            if snapshot.swing_high is not None:
                structure["swing_high"] = snapshot.swing_high
            if snapshot.atr_14 is not None:
                volatility_values = {**volatility_values, "atr_14": snapshot.atr_14}
        candle_patterns = patterns.calculate(candles)
        index_candles = self._analysis_candles(self.index_symbol)
        rs = relative_strength(candles, index_candles)
        score = scalping_score(
            momentum_values["rsi_14"],
            momentum_values["macd_histogram"],
            tick_accel,
            bool(volume_values["volume_spike"]),
            (volatility_values["bb_width"] or 0) > 0.12,
        )
        state = classify(score, self.config.scoring.get("buckets"))
        state = self._apply_freshness_gates(
            state,
            momentum_values["rsi_14"],
            trends or SyntheticTrends(),
            symbol_data_age,
        )
        risk_plan = None
        if state is not SignalState.WAIT:
            bullish = is_bullish(state)
            risk_plan = scalping_risk_plan(tick.price, bullish)
        reasons = self._reasons(trend_values, momentum_values, volume_values, structure, candle_patterns, rs, tick_accel)
        metrics: dict[str, float | str | None] = {
            "rsi": momentum_values["rsi_14"],
            "macd": momentum_values["macd"],
            "adx": trend_values["adx"],
            "atr": volatility_values["atr_14"],
            "relative_volume": volume_values["relative_volume"],
            "trend": str(trend_values["trend"]),
            "tick_momentum": tick_accel,
            "relative_strength": rs,
            "market_regime": self.market_regime,
            "data_quality": "LIVE" if tick.source == self.provider_name else "DELAYED_HISTORICAL",
            "reward_to_risk": risk_plan.reward_to_risk if risk_plan else None,
            "trend_15m": trends.trend_15m if trends else None,
            "trend_1h": trends.trend_1h if trends else None,
            "trend_4h": trends.trend_4h if trends else None,
            "trend_daily": trends.trend_daily if trends else None,
            "symbol_data_age": symbol_data_age,
        }
        return Signal(
            symbol=tick.symbol,
            state=state,
            confidence=score,
            price=round(tick.price, 2),
            entry=round(tick.price, 2),
            stop=risk_plan.stop if risk_plan and risk_plan.valid else None,
            targets=risk_plan.targets if risk_plan and risk_plan.valid else (None, None, None),
            reasons=reasons,
            data_timestamp=tick.timestamp,
            generated_at=datetime.now(UTC),
            provider=self.provider_name,
            metrics=metrics,
        )

    @staticmethod
    def _apply_freshness_gates(
        state: SignalState,
        rsi: float | None,
        trends: SyntheticTrends,
        symbol_data_age: float | None,
    ) -> SignalState:
        if symbol_data_age is not None and symbol_data_age > 5:
            return SignalState.WAIT
        if state is SignalState.STRONG_BUY:
            if symbol_data_age is None or symbol_data_age >= 3:
                return SignalState.BUY
            if rsi is None or rsi <= 50 or rsi >= 95:
                return SignalState.BUY
            if not trends.all_up("15m", "1h", "daily"):
                return SignalState.BUY
        if state is SignalState.STRONG_SELL:
            if symbol_data_age is None or symbol_data_age >= 3:
                return SignalState.SELL
            if rsi is None or rsi <= 5 or rsi >= 50:
                return SignalState.SELL
            if not trends.all_down("15m", "1h", "daily"):
                return SignalState.SELL
        return state

    @staticmethod
    def _reasons(
        trend_values: dict[str, float | str | None],
        momentum_values: dict[str, float | None],
        volume_values: dict[str, float | bool | None],
        structure: dict[str, float | bool | str | None],
        candle_patterns: dict[str, bool],
        rs: float | None,
        tick_accel: float,
    ) -> list[str]:
        reasons = [f"Tick ivme: {tick_accel:+.3f}%", f"Trend: {trend_values['trend']}"]
        if momentum_values["rsi_14"] is not None:
            reasons.append(f"RSI: {momentum_values['rsi_14']}")
        if momentum_values["macd_histogram"] is not None:
            reasons.append(f"MACD hist: {momentum_values['macd_histogram']}")
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
            reasons.append(f"Benchmark'a göre güç: {rs:+.2f}%")
        return reasons

    def should_notify(self, signal: Signal) -> bool:
        previous = self._pending_previous.pop(signal.symbol, None)
        if signal.state is SignalState.WAIT:
            return False
        last_alert = self._last_alert_at.get(signal.symbol)
        cooldown_elapsed = not last_alert or datetime.now(UTC) - last_alert >= timedelta(minutes=self.config.signal_cooldown_minutes)
        if cooldown_elapsed and meaningful_transition(previous, signal.state):
            self._last_alert_at[signal.symbol] = datetime.now(UTC)
            return True
        return False
