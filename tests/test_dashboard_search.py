from dataclasses import replace

from dashboard.app import DASHBOARD_HTML, DashboardState
from data.historical import synthetic_candles
from data.models import DataState, MarketTick
from data.realtime import ConnectionMonitor
from strategy.signal_engine import SignalEngine
from tests.conftest import make_config


def test_dashboard_defaults_to_full_ham_liste_view() -> None:
    assert 'data-filter="TUMU"' in DASHBOARD_HTML
    assert "filter='TUMU'" in DASHBOARD_HTML
    assert "ham liste için Tümü sekmesine geçin" in DASHBOARD_HTML
    assert 'data-filter="ACTIVE">LONG / SHORT' in DASHBOARD_HTML


def test_dashboard_searches_contract_symbols() -> None:
    assert 'id="search"' in DASHBOARD_HTML
    assert "r.symbol} ${r.name}" in DASHBOARD_HTML


def test_dashboard_calculates_previous_close_price_change() -> None:
    config = replace(make_config(), symbols=("BTCUSDT",))
    engine = SignalEngine(config, "Binance USDⓈ-M Futures")
    health = ConnectionMonitor("Binance USDⓈ-M Futures", {"BTCUSDT"}, 45).health
    dashboard = DashboardState(config, engine, health)
    dashboard.record_tick(
        MarketTick(
            symbol="BTCUSDT",
            price=73_100,
            previous_close=72_020,
            timestamp=synthetic_candles("BTCUSDT", "daily", 1)[0].timestamp,
        )
    )
    row = dashboard._row("BTCUSDT", None)
    assert row["price_change"] == 1080
    assert row["price_change_pct"] == 1.5


def test_non_realtime_provider_rows_are_never_labelled_live() -> None:
    config = replace(make_config(), symbols=("BTCUSDT",))
    engine = SignalEngine(config, "delayed provider")
    monitor = ConnectionMonitor("delayed provider", {"BTCUSDT"}, 45)
    monitor.mark_connected()
    tick = MarketTick("BTCUSDT", 100, synthetic_candles("BTCUSDT", "daily", 1)[0].timestamp)
    monitor.record_tick(tick, real_time=False, data_state=DataState.STALE_DATA)
    dashboard = DashboardState(config, engine, monitor.health)
    dashboard.record_tick(tick)
    assert dashboard._row("BTCUSDT", None)["row_data_state"] == "STALE_DATA"
