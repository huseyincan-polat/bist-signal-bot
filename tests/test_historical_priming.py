from data.historical import synthetic_candles
from strategy.signal_engine import SignalEngine
from tests.conftest import make_config


def test_primed_futures_candles_produce_initial_signal_scores() -> None:
    config = make_config()
    engine = SignalEngine(config, "Binance USDⓈ-M Futures")
    engine.seed_history("AAA", "1m", synthetic_candles("AAA", "1m", 100))
    assert engine.prime_from_history() == 1
    assert engine.signals["AAA"].confidence >= 0
    assert engine.signals["AAA"].metrics["data_quality"] == "DELAYED_HISTORICAL"
