"use strict";

const TelegramBot = require("node-telegram-bot-api");
const { markSignalNotified } = require("./confluence");
const { formatSignalHistory } = require("./signal-history");

class TelegramNotifier {
  constructor(token, chatId) {
    this.chatId = chatId;
    this.enabled = Boolean(token && chatId);
    this.bot = this.enabled
      ? new TelegramBot(token, { polling: true })
      : null;
    this.lastTestSent = false;
    this.alarmRegistered = false;
    this.reportRegistered = false;
  }

  formatSignal(row) {
    const ticker = String(row.symbol).replace(/\.IS$/i, "");
    const isReversal = row.status === "DÖNÜŞ";
    const lines = [
      isReversal ? `🔄 BIST DÖNÜŞ — ${ticker}` : `🔔 BIST FIRSAT — ${ticker}`,
      "━━━━━━━━━━━━━━━━━━",
      isReversal
        ? "Zayıf piyasada düşmüş, kârlı ve ucuz hisse yukarı dönüyor"
        : "Güçlü piyasada trend + hacimli kırılım",
      `Fiyat: ${fmtPrice(row.price)} TL`,
    ];

    if (row.statusReason) lines.push(`Detay: ${row.statusReason}`);

    if (row.tp != null && row.tp !== "-") {
      lines.push(`🎯 Oto Hedef (TP): ${row.tp} TL`);
      lines.push(`🛑 Oto Stop (SL): ${row.sl} TL`);
    }

    if (row.lots != null) {
      lines.push(
        `📐 Lot: ${row.lots} (pozisyon ≈ ${fmtPrice(row.positionTl)} TL, risk ≈ ${fmtPrice(row.riskTl)} TL)`,
      );
    }

    if (row.limitReached) {
      lines.push(
        `⚠️ Açık sinyal sınırı dolu (${row.openSignalCount}). Yeni pozisyon önerilmez, sadece bilgi.`,
      );
    }

    const historyLine = formatSignalHistory(row.history, row.historyYears);
    if (historyLine) lines.push(historyLine);

    const extras = [];
    if (row.beta != null) extras.push(`Beta ${row.beta}`);
    if (row.rsi != null) extras.push(`RSI ${row.rsi}`);
    if (extras.length) lines.push(extras.join(" · "));

    lines.push("Özel hedefler için: /alarm HISSE TP SL");
    lines.push("━━━━━━━━━━━━━━━━━━");
    lines.push("Yatırım tavsiyesi değildir. Karar ve risk sana aittir.");

    return lines.join("\n");
  }

  formatClosedSignal(signal) {
    const icon = signal.status === "tp" ? "🎯" : signal.status === "sl" ? "🛑" : "⌛";
    const label = signal.status === "tp" ? "hedefe ulaştı" : signal.status === "sl" ? "stop oldu" : "30 günde sonuçlanmadı";
    const pct = signal.returnPct > 0 ? `+${signal.returnPct}` : `${signal.returnPct}`;
    return `${icon} ${signal.symbol} (${signal.type}) ${label}: ${fmtPrice(signal.entry)} → ${fmtPrice(signal.exit)} TL (${pct}%)`;
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

  registerReportHandler(buildReport) {
    if (!this.enabled || this.reportRegistered) return;
    this.reportRegistered = true;

    this.bot.onText(/\/(?:rapor|report)(?:@\w+)?$/i, async (msg) => {
      if (!this.isAuthorizedChat(msg.chat.id)) return;
      await this.send(buildReport(), msg.chat.id);
    });
  }

  async processRows(rows) {
    if (!this.enabled) return { sent: 0, events: [] };
    const events = [];
    let sent = 0;

    for (const row of rows) {
      if (row.symbol === "XU100.IS") continue;

      if (row.signalNotify) {
        const ok = await this.send(this.formatSignal(row));
        if (ok) {
          markSignalNotified(row.symbol);
          events.push(`${row.status}:${row.symbol}`);
          sent += 1;
        }
      }

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
