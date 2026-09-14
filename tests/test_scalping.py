from risk.scalping import scalping_risk_plan
from strategy.scalping import scalping_score
from strategy.scoring import classify
from data.models import SignalState


def test_scalping_risk_plan_uses_one_percent_stop_and_three_percent_target() -> None:
    plan = scalping_risk_plan(100.0, bullish=True)
    assert plan.valid
    assert plan.stop == 99.0
    assert plan.targets[0] == 103.0
    assert plan.reward_to_risk == 3.0


def test_scalping_score_biases_toward_long_on_high_rsi() -> None:
    score = scalping_score(rsi=75, macd_histogram=0.1, tick_momentum=0.1, volume_spike=True, volatility_wide=False)
    assert classify(score).value in ("LONG", "GÜÇLÜ LONG")


def test_scalping_score_biases_toward_short_on_low_rsi() -> None:
    score = scalping_score(rsi=25, macd_histogram=-0.1, tick_momentum=-0.1, volume_spike=True, volatility_wide=False)
    assert classify(score).value in ("SHORT", "GÜÇLÜ SHORT")


def test_loosened_bucket_boundaries() -> None:
    buckets = {"strong_sell_max": 32, "sell_max": 47, "wait_max": 52, "buy_max": 67}
    assert classify(32, buckets) is SignalState.STRONG_SELL
    assert classify(40, buckets) is SignalState.SELL
    assert classify(50, buckets) is SignalState.WAIT
    assert classify(55, buckets) is SignalState.BUY
    assert classify(70, buckets) is SignalState.STRONG_BUY
