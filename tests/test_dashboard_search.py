from dataclasses import replace

from dashboard.app import DASHBOARD_HTML, DashboardState
from data.historical import synthetic_candles
from data.realtime import ConnectionMonitor
from strategy.signal_engine import SignalEngine
from tests.conftest import make_config


def test_dashboard_includes_symbol_and_display_name_search() -> None:
    assert 'id="search"' in DASHBOARD_HTML
    assert "r.symbol} ${r.name}" in DASHBOARD_HTML


def test_primed_symbol_waiting_for_live_tick_is_not_labelled_stale() -> None:
    config = replace(
        make_config(),
        symbols=("ALTINS1",),
        symbol_names={"ALTINS1": "Darphane Altın Sertifikası"},
    )
    engine = SignalEngine(config, "iTick stock WebSocket")
    engine.seed_history("ALTINS1", "daily", synthetic_candles("ALTINS1", "daily", 100))
    engine.prime_from_history()
    health = ConnectionMonitor("iTick stock WebSocket", {"ALTINS1"}, 45, partial_coverage_allowed=True).health
    row = DashboardState(config, engine, health)._row("ALTINS1", None)
    assert row["name"] == "Darphane Altın Sertifikası"
    assert row["row_data_state"] == "PRIMED"
    assert row["data_age"] is None
