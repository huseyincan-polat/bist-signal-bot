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


def test_kline_frame_counter_increments() -> None:
    store = KlineBufferStore()
    store.upsert_kline(_candle("SOLUSDT", 0, 10), is_closed=False)
    store.upsert_kline(_candle("SOLUSDT", 0, 10.5), is_closed=True)
    assert store.kline_frames_received == 2
