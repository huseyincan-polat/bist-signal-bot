from app.config import AppConfig


def make_config(provider_name: str = "mock") -> AppConfig:
    return AppConfig(
        provider_name=provider_name,
        symbols=("AAA",),
        index_symbol="BTCUSDT",
        stale_after_seconds=45,
        scoring={"buckets": {"strong_sell_max": 29, "sell_max": 44, "wait_max": 59, "buy_max": 74}},
        backtest={"commission_bps": 10, "slippage_bps": 5},
    )
