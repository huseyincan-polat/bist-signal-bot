from risk.targets import structure_risk_plan


def test_rejects_stop_deeper_than_four_percent() -> None:
    plan = structure_risk_plan(
        entry=100,
        atr=1,
        swing_low=90,
        swing_high=110,
        bullish=True,
    )
    assert not plan.valid
    assert plan.stop is None
    assert "azami %4" in (plan.reason or "")


def test_rejects_structure_target_below_three_to_one_reward_ratio() -> None:
    plan = structure_risk_plan(
        entry=100,
        atr=1,
        swing_low=99,
        swing_high=101,
        bullish=True,
    )
    assert not plan.valid
    assert plan.reward_to_risk == 2.0
    assert "3 katını" in (plan.reason or "")


def test_uses_non_symmetric_pivot_and_atr_risk_levels() -> None:
    plan = structure_risk_plan(
        entry=100,
        atr=1,
        swing_low=99.2,
        swing_high=104,
        bullish=True,
    )
    assert plan.valid
    assert plan.stop == 98.5
    assert plan.targets == (104, 105, 106)
    assert plan.targets[0] is not None
    assert 100 - plan.stop != plan.targets[0] - 100
