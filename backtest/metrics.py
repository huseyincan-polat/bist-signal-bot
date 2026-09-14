"""Backtest performance metrics."""

from __future__ import annotations

import math
import statistics
from dataclasses import asdict, dataclass


@dataclass(frozen=True)
class BacktestMetrics:
    total_trades: int
    win_rate: float
    profit_factor: float
    total_return: float
    max_drawdown: float
    sharpe: float
    avg_win: float
    avg_loss: float
    expectancy: float
    cagr: float

    def to_dict(self) -> dict[str, float | int]:
        return asdict(self)


def calculate(trade_returns: list[float], equity_curve: list[float], years: float) -> BacktestMetrics:
    wins = [value for value in trade_returns if value > 0]
    losses = [value for value in trade_returns if value < 0]
    total_return = (equity_curve[-1] / equity_curve[0] - 1) * 100 if len(equity_curve) > 1 else 0
    peak, maximum_drawdown = equity_curve[0] if equity_curve else 1, 0.0
    for equity in equity_curve:
        peak = max(peak, equity)
        maximum_drawdown = min(maximum_drawdown, (equity / peak - 1) * 100)
    average = statistics.fmean(trade_returns) if trade_returns else 0
    standard_deviation = statistics.stdev(trade_returns) if len(trade_returns) > 1 else 0
    sharpe = average / standard_deviation * math.sqrt(252) if standard_deviation else 0
    cagr = ((equity_curve[-1] / equity_curve[0]) ** (1 / years) - 1) * 100 if years > 0 and len(equity_curve) > 1 else 0
    return BacktestMetrics(
        total_trades=len(trade_returns),
        win_rate=round(100 * len(wins) / len(trade_returns), 2) if trade_returns else 0,
        profit_factor=round(sum(wins) / abs(sum(losses)), 3) if losses else float("inf") if wins else 0,
        total_return=round(total_return, 2),
        max_drawdown=round(maximum_drawdown, 2),
        sharpe=round(sharpe, 3),
        avg_win=round(statistics.fmean(wins), 2) if wins else 0,
        avg_loss=round(statistics.fmean(losses), 2) if losses else 0,
        expectancy=round(average, 2),
        cagr=round(cagr, 2),
    )
