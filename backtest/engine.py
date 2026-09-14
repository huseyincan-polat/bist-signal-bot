"""Event-driven historical simulation using the production signal engine."""

from __future__ import annotations

from dataclasses import dataclass

from app.config import AppConfig
from backtest.metrics import BacktestMetrics, calculate
from data.models import Candle, MarketTick, SignalState
from strategy.signal_engine import SignalEngine


@dataclass(frozen=True)
class BacktestResult:
    metrics: BacktestMetrics
    equity_curve: list[float]


class BacktestEngine:
    """Long-only paper simulation; it never calls an order API."""

    def __init__(self, config: AppConfig) -> None:
        self.config = config
        self.commission_bps = float(config.backtest.get("commission_bps", 10))
        self.slippage_bps = float(config.backtest.get("slippage_bps", 5))

    def run(self, candles_by_symbol: dict[str, list[Candle]]) -> BacktestResult:
        index_symbol = self.config.index_symbol.split(":")[0]
        if index_symbol not in candles_by_symbol:
            raise ValueError("Benchmark futures candles are required")
        engine = SignalEngine(self.config, "backtest")
        length = min(len(values) for values in candles_by_symbol.values())
        warmup = min(200, max(35, length // 3))
        for symbol, candles in candles_by_symbol.items():
            engine.seed_history(symbol, "1m", candles[:warmup])
        positions: dict[str, float] = {}
        returns: list[float] = []
        equity = 100_000.0
        curve = [equity]
        symbols = [symbol for symbol in self.config.symbols if symbol in candles_by_symbol]
        costs = (self.commission_bps + self.slippage_bps) / 10_000
        for position in range(warmup, length):
            index_candle = candles_by_symbol[index_symbol][position]
            engine.on_tick(MarketTick(index_symbol, index_candle.close, index_candle.timestamp, source="backtest"))
            for symbol in symbols:
                candle = candles_by_symbol[symbol][position]
                signal = engine.on_tick(MarketTick(symbol, candle.close, candle.timestamp, tick_volume=candle.volume, source="backtest"))
                if not signal:
                    continue
                if signal.state in (SignalState.BUY, SignalState.STRONG_BUY) and symbol not in positions:
                    positions[symbol] = candle.close * (1 + costs)
                elif signal.state in (SignalState.SELL, SignalState.STRONG_SELL) and symbol in positions:
                    entry = positions.pop(symbol)
                    result = (candle.close * (1 - costs) / entry - 1) * 100
                    returns.append(result)
                    equity *= 1 + result / 100
                    curve.append(equity)
        final_position = length - 1
        for symbol, entry in positions.items():
            result = (candles_by_symbol[symbol][final_position].close * (1 - costs) / entry - 1) * 100
            returns.append(result)
            equity *= 1 + result / 100
            curve.append(equity)
        elapsed_days = max(1, (candles_by_symbol[index_symbol][-1].timestamp - candles_by_symbol[index_symbol][0].timestamp).days)
        return BacktestResult(calculate(returns, curve, elapsed_days / 365.25), curve)
