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
    stale_after_seconds: int = 45
    startup_warmup_seconds: int = 8
    reconnect_backoff_seconds: int = 3
    signal_cooldown_minutes: int = 20
    dashboard_host: str = "127.0.0.1"
    dashboard_port: int = 8347
    telegram_enabled: bool = False
    telegram_bot_token: str | None = None
    telegram_chat_id: str | None = None
    dxfeed_websocket_url: str | None = None
    dxfeed_token: str | None = None
    scoring: dict[str, Any] = field(default_factory=dict)
    backtest: dict[str, Any] = field(default_factory=dict)

    @property
    def is_dxfeed_configured(self) -> bool:
        return bool(self.dxfeed_websocket_url and self.dxfeed_token)


def _read_env(name: str, default: str | None = None) -> str | None:
    value = os.getenv(name, default)
    return value.strip() if value else None


def load_config(path: str | Path = "config.yaml") -> AppConfig:
    """Load non-secret YAML settings and resolve secrets from `.env` only."""
    load_dotenv()
    with Path(path).open(encoding="utf-8") as handle:
        raw = yaml.safe_load(handle) or {}

    runtime = raw.get("runtime", {})
    dashboard = raw.get("dashboard", {})
    telegram = raw.get("telegram", {})
    dxfeed = raw.get("dxfeed", {})
    provider_name = (_read_env("DATA_PROVIDER", raw.get("data_provider", "mock")) or "mock").lower()
    return AppConfig(
        provider_name=provider_name,
        symbols=tuple(raw.get("bist100", {}).get("symbols", [])),
        index_symbol=dxfeed.get("index_symbol", "XU100:TR"),
        stale_after_seconds=int(runtime.get("stale_after_seconds", 45)),
        startup_warmup_seconds=int(runtime.get("startup_warmup_seconds", 8)),
        reconnect_backoff_seconds=int(runtime.get("reconnect_backoff_seconds", 3)),
        signal_cooldown_minutes=int(runtime.get("signal_cooldown_minutes", 20)),
        dashboard_host=dashboard.get("host", "127.0.0.1"),
        dashboard_port=int(dashboard.get("port", 8347)),
        telegram_enabled=bool(telegram.get("enabled", False)),
        telegram_bot_token=_read_env("TELEGRAM_BOT_TOKEN"),
        telegram_chat_id=_read_env("TELEGRAM_CHAT_ID"),
        dxfeed_websocket_url=_read_env(dxfeed.get("websocket_url_env", "DXFEED_WS_URL")),
        dxfeed_token=_read_env(dxfeed.get("token_env", "DXFEED_TOKEN")),
        scoring=raw.get("scoring", {}),
        backtest=raw.get("backtest", {}),
    )
