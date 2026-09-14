"""Configuration loading with environment-only credentials."""

from __future__ import annotations

import os
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any

import yaml
from dotenv import load_dotenv


@dataclass(frozen=True)
class AppConfig:
    provider_name: str
    symbols: tuple[str, ...]
    index_symbol: str
    symbol_names: dict[str, str] = field(default_factory=dict)
    stale_after_seconds: int = 45
    startup_warmup_seconds: int = 8
    reconnect_backoff_seconds: int = 3
    signal_cooldown_minutes: int = 20
    dashboard_host: str = "0.0.0.0"
    dashboard_port: int = 8347
    telegram_enabled: bool = False
    telegram_bot_token: str | None = None
    telegram_chat_id: str | None = None
    binance_rest_url: str = "https://fapi.binance.com"
    binance_websocket_url: str = "wss://fstream.binance.com"
    binance_historical_limit: int = 100
    scoring: dict[str, Any] = field(default_factory=dict)
    backtest: dict[str, Any] = field(default_factory=dict)

def _read_env(name: str, default: str | None = None) -> str | None:
    value = os.getenv(name, default)
    return value.strip() if value else None


def _read_port(default: int) -> int:
    value = _read_env("PORT", str(default))
    if value is None or not value.isdigit():
        return default
    return int(value)


def load_config(path: str | Path = "config.yaml") -> AppConfig:
    """Load non-secret YAML settings and resolve secrets from `.env` only."""
    load_dotenv()
    with Path(path).open(encoding="utf-8") as handle:
        raw = yaml.safe_load(handle) or {}

    runtime = raw.get("runtime", {})
    dashboard = raw.get("dashboard", {})
    telegram = raw.get("telegram", {})
    binance = raw.get("binance_futures", {})
    provider_name = (_read_env("DATA_PROVIDER", raw.get("data_provider", "mock")) or "mock").lower()
    return AppConfig(
        provider_name=provider_name,
        symbols=tuple(raw.get("universe", {}).get("symbols", [])),
        index_symbol=raw.get("universe", {}).get("benchmark_symbol", "BTCUSDT"),
        symbol_names=raw.get("universe", {}).get("symbol_names", {}),
        stale_after_seconds=int(runtime.get("stale_after_seconds", 45)),
        startup_warmup_seconds=int(runtime.get("startup_warmup_seconds", 8)),
        reconnect_backoff_seconds=int(runtime.get("reconnect_backoff_seconds", 3)),
        signal_cooldown_minutes=int(runtime.get("signal_cooldown_minutes", 20)),
        dashboard_host=dashboard.get("host", "0.0.0.0"),
        dashboard_port=_read_port(int(dashboard.get("port", 8347))),
        telegram_enabled=bool(telegram.get("enabled", False)),
        telegram_bot_token=_read_env("TELEGRAM_BOT_TOKEN"),
        telegram_chat_id=_read_env("TELEGRAM_CHAT_ID"),
        binance_rest_url=binance.get("rest_url", "https://fapi.binance.com"),
        binance_websocket_url=binance.get("websocket_url", "wss://fstream.binance.com"),
        binance_historical_limit=int(binance.get("historical_limit", 100)),
        scoring=raw.get("scoring", {}),
        backtest=raw.get("backtest", {}),
    )
