from datetime import UTC, datetime

from data.historical import synthetic_candles
from data.models import MarketTick, SignalState
from strategy.scoring import classify, meaningful_transition
from strategy.signal_engine import SignalEngine
from tests.conftest import make_config


def test_score_bucket_boundaries() -> None:
    assert classify(29) is SignalState.STRONG_SELL
    assert classify(30) is SignalState.SELL
    assert classify(45) is SignalState.WAIT
    assert classify(60) is SignalState.BUY
    assert classify(75) is SignalState.STRONG_BUY


def test_signal_engine_calculates_multi_timeframe_signal() -> None:
    config = make_config()
    engine = SignalEngine(config, "test")
    for symbol in ("AAA", "XU100"):
        for timeframe in ("1m", "5m", "15m", "1h", "daily"):
            engine.seed_history(symbol, timeframe, synthetic_candles(symbol, timeframe))
    signal = engine.on_tick(MarketTick("AAA", 100, datetime.now(UTC), tick_volume=1_000))
    assert signal is not None
    assert 0 <= signal.confidence <= 100
    assert len(signal.targets) == 3
    assert signal.stop != signal.entry


def test_notification_rules_require_meaningful_state_change() -> None:
    assert meaningful_transition(SignalState.WAIT, SignalState.BUY)
    assert meaningful_transition(SignalState.BUY, SignalState.STRONG_BUY)
    assert not meaningful_transition(SignalState.BUY, SignalState.BUY)
