"""Telegram signal delivery with an explicit real-time safety gate."""

from __future__ import annotations

from datetime import datetime

import httpx

from data.models import Signal


DISCLAIMER = "Yatırım tavsiyesi değildir. Bu bildirim analiz amaçlıdır; emir iletmez."


class TelegramNotifier:
    def __init__(self, token: str | None, chat_id: str | None, enabled: bool) -> None:
        self.token = token
        self.chat_id = chat_id
        self.enabled = enabled

    @property
    def configured(self) -> bool:
        return bool(self.enabled and self.token and self.chat_id)

    async def send_signal(self, signal: Signal, real_time_ready: bool) -> bool:
        """Send only when the whole provider verification gate is green."""
        if not self.configured or not real_time_ready:
            return False
        message = self.format_signal(signal)
        # Do not log this URL: it contains the bot token.
        url = f"https://api.telegram.org/bot{self.token}/sendMessage"
        async with httpx.AsyncClient(timeout=10) as client:
            response = await client.post(url, json={"chat_id": self.chat_id, "text": message})
            response.raise_for_status()
        return True

    @staticmethod
    def format_signal(signal: Signal) -> str:
        targets = " / ".join(f"{value:,.4f} USDT" for value in signal.targets if value is not None)
        reasons = "\n".join(f"• {reason}" for reason in signal.reasons[:5])
        return (
            "📊 FUTURES SİNYALİ\n"
            f"Sözleşme: {signal.symbol}\n"
            f"Sinyal: {signal.state.value} ({signal.confidence}/100)\n"
            "Onay: Canlı veriyle Onaylandı\n"
            f"Fiyat / Giriş: {signal.price:,.4f} USDT\n"
            f"Stop: {signal.stop:,.4f} USDT\n"
            f"Hedef 1 / 2 / 3: {targets}\n"
            f"Teknik nedenler:\n{reasons}\n"
            f"Veri zamanı: {signal.data_timestamp.strftime('%d.%m.%Y %H:%M:%S UTC')}\n"
            f"Sinyal zamanı: {signal.generated_at.strftime('%d.%m.%Y %H:%M:%S UTC')}\n"
            f"Sağlayıcı: {signal.provider}\n"
            f"⚠️ {DISCLAIMER}"
        )
