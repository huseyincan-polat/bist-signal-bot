from datetime import UTC, datetime, timedelta

from data.kline_buffer import BUFFER_SIZE, MIN_BARS_FOR_SIGNALS, KlineBufferStore, SEED_BARS
from data.models import Candle, MarketTick


def _candle(symbol: str, minute: int, close: float, *, bullish: bool = True) -> Candle:
    start = datetime(2026, 1, 1, 0, 0, tzinfo=UTC) + timedelta(minutes=minute)
    open_price = close - (0.5 if bullish else -0.5)
    return Candle(
        symbol=symbol,
        timeframe="1m",
        timestamp=start,
        open=open_price,
        high=max(open_price, close) + 0.2,
        low=min(open_price, close) - 0.2,
        close=close,
        volume=100 + minute,
    )


def test_kline_buffer_rolls_at_fifty_bars() -> None:
    store = KlineBufferStore(maxlen=BUFFER_SIZE)
    for minute in range(60):
        store.upsert_kline(_candle("BTCUSDT", minute, 100 + minute), is_closed=True)
    candles = store.candles("BTCUSDT", "1m")
    assert len(candles) == BUFFER_SIZE
    assert candles[0].timestamp > datetime(2026, 1, 1, 0, 0, tzinfo=UTC)


def test_first_tick_seeds_five_bars_for_immediate_analysis() -> None:
    store = KlineBufferStore(maxlen=BUFFER_SIZE)
    now = datetime(2026, 1, 1, 0, 5, 30, tzinfo=UTC)
    store.upsert_from_tick(MarketTick("ETHUSDT", 200.0, now, source="test"))
    candles = store.candles("ETHUSDT", "1m")
    assert len(candles) == SEED_BARS
    assert all(candle.close == 200.0 for candle in candles)
    assert "ETHUSDT" in store.symbols_with_min_bars(MIN_BARS_FOR_SIGNALS)
    assert store.structure("ETHUSDT").atr_14 is not None


def test_tick_fallback_builds_one_minute_series() -> None:
    store = KlineBufferStore(maxlen=BUFFER_SIZE)
    now = datetime(2026, 1, 1, 0, 0, 30, tzinfo=UTC)
    for offset in range(40):
        store.upsert_from_tick(
            MarketTick("ETHUSDT", 200 + offset, now + timedelta(minutes=offset), source="test")
        )
    assert len(store.candles("ETHUSDT", "1m")) >= 40
    assert store.structure("ETHUSDT").atr_14 is not None


def test_synthetic_trends_track_period_opens_from_ticks() -> None:
    store = KlineBufferStore(maxlen=BUFFER_SIZE)
    open_time = datetime(2026, 1, 1, 10, 0, tzinfo=UTC)
    store.upsert_from_tick(MarketTick("BTCUSDT", 100.0, open_time, source="test"))
    trends = store.synthetic_trends("BTCUSDT", 105.0)
    assert trends.trend_15m == "UP"
    assert trends.trend_1h == "UP"
    assert trends.trend_4h == "UP"
    assert trends.trend_daily == "UP"
    trends_down = store.synthetic_trends("BTCUSDT", 95.0)
    assert trends_down.trend_15m == "DOWN"


def test_reset_symbol_clears_buffers_and_trends() -> None:
    store = KlineBufferStore(maxlen=BUFFER_SIZE)
    now = datetime(2026, 1, 1, 0, 0, tzinfo=UTC)
    store.upsert_from_tick(MarketTick("SOLUSDT", 10.0, now, source="test"))
    assert "SOLUSDT" in store.symbols_with_min_bars()
    store.reset_symbol("SOLUSDT")
    assert "SOLUSDT" not in store.symbols_with_min_bars()
    assert store.synthetic_trends("SOLUSDT", 10.0).trend_15m == "FLAT"
