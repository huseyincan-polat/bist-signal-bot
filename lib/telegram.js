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
    const lines = [
      `🔔 BIST FIRSAT — ${ticker}`,
      "━━━━━━━━━━━━━━━━━━",
      `Skor: ${row.score}/100`,
      `Fiyat: ${fmtPrice(row.price)} TL`,
    ];

    if (row.tp != null && row.tp !== "-") {
      lines.push(`🎯 Oto Hedef (TP): ${row.tp} TL`);
      lines.push(`🛑 Oto Stop (SL): ${row.sl} TL`);
    }

    lines.push("Özel hedefler için: /alarm HISSE TP SL");
    lines.push("━━━━━━━━━━━━━━━━━━");
    lines.push("BIST Confluence Swing Radar");

    return lines.join("\n");
  }

  formatAlertList(alerts) {
    if (!alerts.length) return "kayıtlı alarm yok";

    const lines = alerts.map((alert) => {
      const tag = alert.triggered ? " (vuruldu)" : "";
      return `${alert.symbol} ${alert.tp} / ${alert.sl}${tag}`;
    });

    if (lines.length === 1) {
      return `Aktif: ${lines[0]}`;
    }

    return `Aktif:\n${lines.join("\n")}`;
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

  isAuthorizedChat(chatId) {
    return String(chatId) === String(this.chatId);
  }

  registerAlarmHandler({ setAlert, listAlerts, removeAlert, normalizeSymbol }) {
    if (!this.enabled || this.alarmRegistered) return;
    this.alarmRegistered = true;

    this.bot.onText(/\/alarm(?:@\w+)?\s+(\S+)\s+(\S+)\s+(\S+)/i, async (msg, match) => {
      if (!this.isAuthorizedChat(msg.chat.id)) return;

      const symbol = normalizeSymbol(match[1]);
      const tp = Number(String(match[2]).replace(",", "."));
      const sl = Number(String(match[3]).replace(",", "."));

      if (!symbol || !Number.isFinite(tp) || !Number.isFinite(sl) || tp <= 0 || sl <= 0) {
        await this.send("Kullanım: /alarm THYAO 320 285", msg.chat.id);
        return;
      }

      setAlert(symbol, tp, sl);
      await this.send(`${symbol} kayıt: TP ${tp} / SL ${sl}`, msg.chat.id);
    });

    this.bot.onText(/\/(?:alarmlar|list)(?:@\w+)?$/i, async (msg) => {
      if (!this.isAuthorizedChat(msg.chat.id)) return;
      await this.send(this.formatAlertList(listAlerts()), msg.chat.id);
    });

    this.bot.onText(/\/(?:sil|remove)(?:@\w+)?\s+(\S+)/i, async (msg, match) => {
      if (!this.isAuthorizedChat(msg.chat.id)) return;

      const symbol = normalizeSymbol(match[1]);
      if (!symbol) {
        await this.send("Kullanım: /sil THYAO", msg.chat.id);
        return;
      }

      const removed = removeAlert(symbol);
      if (removed) {
        await this.send(`${symbol} alarmı silindi.`, msg.chat.id);
        return;
      }

      await this.send("bu hissede alarm yok", msg.chat.id);
    });

    console.log("Telegram alarm komutları kayıtlı (/alarm, /alarmlar, /list, /sil, /remove)");
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
