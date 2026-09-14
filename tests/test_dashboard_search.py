from dataclasses import replace

from dashboard.app import DASHBOARD_HTML, DashboardState
from data.historical import synthetic_candles
from data.models import MarketTick
from data.realtime import ConnectionMonitor
from strategy.signal_engine import SignalEngine
from tests.conftest import make_config


def test_dashboard_includes_symbol_and_display_name_search() -> None:
    assert 'id="search"' in DASHBOARD_HTML
    assert "r.symbol} ${r.name}" in DASHBOARD_HTML
    assert "priceCell(r)" in DASHBOARD_HTML
    assert "filter='ACTIVE'" in DASHBOARD_HTML
    assert "['AL','GÜÇLÜ AL','SAT','GÜÇLÜ SAT']" in DASHBOARD_HTML


def test_primed_symbol_waiting_for_live_tick_is_not_labelled_stale() -> None:
    config = replace(
        make_config(),
        symbols=("ALTINS1",),
        symbol_names={"ALTINS1": "Darphane Altın Sertifikası"},
    )
    engine = SignalEngine(config, "yfinance delayed batch")
    engine.seed_history("ALTINS1", "daily", synthetic_candles("ALTINS1", "daily", 100))
    engine.prime_from_history()
    health = ConnectionMonitor("yfinance delayed batch", {"ALTINS1"}, 45, partial_coverage_allowed=True).health
    row = DashboardState(config, engine, health)._row("ALTINS1", None)
    assert row["name"] == "Darphane Altın Sertifikası"
    assert row["row_data_state"] == "PRIMED"
    assert row["data_age"] is None


def test_dashboard_calculates_cached_previous_close_price_change() -> None:
    config = replace(make_config(), symbols=("THYAO",))
    engine = SignalEngine(config, "yfinance delayed batch")
    health = ConnectionMonitor("yfinance delayed batch", {"THYAO"}, 45).health
    dashboard = DashboardState(config, engine, health)
    dashboard.record_tick(
        MarketTick(
            symbol="THYAO",
            price=73.10,
            previous_close=72.02,
            timestamp=synthetic_candles("THYAO", "daily", 1)[0].timestamp,
        )
    )
    row = dashboard._row("THYAO", None)
    assert row["price_change"] == 1.08
    assert row["price_change_pct"] == 1.5
