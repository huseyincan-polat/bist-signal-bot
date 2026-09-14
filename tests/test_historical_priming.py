from data.historical import synthetic_candles, yfinance_ticker
from strategy.signal_engine import SignalEngine
from tests.conftest import make_config


def test_yfinance_uses_borsa_istanbul_symbol_suffix() -> None:
    assert yfinance_ticker("THYAO") == "THYAO.IS"


def test_primed_daily_history_produces_display_signal_scores() -> None:
    config = make_config()
    engine = SignalEngine(config, "yfinance delayed batch")
    engine.seed_history("AAA", "daily", synthetic_candles("AAA", "daily", 100))
    assert engine.prime_from_history() == 1
    assert engine.signals["AAA"].confidence >= 0
    assert engine.signals["AAA"].metrics["data_quality"] == "DELAYED_HISTORICAL"
