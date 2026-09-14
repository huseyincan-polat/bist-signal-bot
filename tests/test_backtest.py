from backtest.engine import BacktestEngine
from data.historical import synthetic_candles
from tests.conftest import make_config


def test_backtest_reports_requested_metrics() -> None:
    config = make_config()
    result = BacktestEngine(config).run(
        {
            "AAA": synthetic_candles("AAA", "1m", 260),
            "BTCUSDT": synthetic_candles("BTCUSDT", "1m", 260),
        }
    )
    metrics = result.metrics.to_dict()
    assert {"total_trades", "win_rate", "profit_factor", "total_return", "max_drawdown", "sharpe", "avg_win", "avg_loss", "expectancy", "cagr"} <= metrics.keys()
    assert result.equity_curve[0] == 100_000
