"use strict";

const TelegramBot = require("node-telegram-bot-api");

const CACHE_MS = 24 * 60 * 60 * 1000;

class TelegramNotifier {
  constructor(token, chatId) {
    this.chatId = chatId;
    this.enabled = Boolean(token && chatId);
    this.bot = this.enabled
      ? new TelegramBot(token, { polling: true })
      : null;
    this.cache = new Map();
    this.lastFirsatStatus = new Map();
    this.lastTestSent = false;
    this.alarmRegistered = false;
  }

  canNotifyFirsat(symbol) {
    const last = this.cache.get(`firsat:${symbol}`);
    if (!last) return true;
    return Date.now() - last > CACHE_MS;
  }

  markFirsatNotified(symbol) {
    this.cache.set(`firsat:${symbol}`, Date.now());
  }

  formatFirsat(row) {
    const ticker = String(row.symbol).replace(/\.IS$/i, "");
    return [
      `🔔 BIST FIRSAT — ${ticker}`,
      "━━━━━━━━━━━━━━━━━━",
      `Skor: ${row.score}/100`,
      `Fiyat: ${fmtPrice(row.price)} TL`,
      "/alarm HISSE TP SL ile özel hedef/stop ekleyin",
      "━━━━━━━━━━━━━━━━━━",
      "BIST Confluence Swing Radar",
    ].join("\n");
  }

  async send(text, chatId = this.chatId) {
    if (!this.enabled) return false;
    try {
      await this.bot.sendMessage(chatId, text, { disable_web_page_preview: true });
      return true;
    } catch (err) {
      console.error("Telegram gönderim hatası:", err.message);
      return false;
    }
  }

  registerAlarmHandler({ setAlert, normalizeSymbol }) {
    if (!this.enabled || this.alarmRegistered) return;
    this.alarmRegistered = true;

    this.bot.onText(/\/alarm(?:@\w+)?\s+(\S+)\s+(\S+)\s+(\S+)/i, async (msg, match) => {
      if (String(msg.chat.id) !== String(this.chatId)) return;

      const symbol = normalizeSymbol(match[1]);
      const tp = Number(String(match[2]).replace(",", "."));
      const sl = Number(String(match[3]).replace(",", "."));

      if (!symbol || !Number.isFinite(tp) || !Number.isFinite(sl) || tp <= 0 || sl <= 0) {
        await this.send(
          "Kullanım: /alarm THYAO 320 285",
          msg.chat.id,
        );
        return;
      }

      setAlert(symbol, tp, sl);
      await this.send(
        `✅ ${symbol} için Hedef: ${tp}, Stop: ${sl} sisteme kaydedildi.`,
        msg.chat.id,
      );
    });

    console.log("Telegram /alarm komutu kayıtlı");
  }

  async processRows(rows) {
    if (!this.enabled) return { sent: 0, events: [] };
    const events = [];
    let sent = 0;

    for (const row of rows) {
      if (row.symbol === "XU100.IS") continue;
      const prevStatus = this.lastFirsatStatus.get(row.symbol);
      const isFirsat = row.status === "FIRSAT";

      if (isFirsat && prevStatus !== "FIRSAT" && this.canNotifyFirsat(row.symbol)) {
        const ok = await this.send(this.formatFirsat(row));
        if (ok) {
          this.markFirsatNotified(row.symbol);
          events.push(`firsat:${row.symbol}`);
          sent += 1;
        }
      }

      this.lastFirsatStatus.set(row.symbol, row.status);
    }

    return { sent, events };
  }

  async sendTest() {
    if (!this.enabled) return false;
    const ok = await this.send("✅ BIST Confluence Swing Radar — Telegram bağlantısı aktif.");
    this.lastTestSent = ok;
    return ok;
  }
}

function fmtPrice(n) {
  if (n == null) return "—";
  return Number(n).toLocaleString("tr-TR", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

module.exports = { TelegramNotifier };
