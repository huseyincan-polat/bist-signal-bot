"use strict";

const TelegramBot = require("node-telegram-bot-api");

const CACHE_MS = 24 * 60 * 60 * 1000;

class TelegramNotifier {
  constructor(token, chatId) {
    this.chatId = chatId;
    this.enabled = Boolean(token && chatId);
    this.bot = this.enabled ? new TelegramBot(token, { polling: false }) : null;
    this.cache = new Map();
    this.activeFirsat = new Map();
    this.lastTestSent = false;
  }

  canNotify(symbol, eventType) {
    if (eventType === "stop" || eventType === "target") return true;
    const key = `${symbol}:${eventType}`;
    const last = this.cache.get(key);
    if (!last) return true;
    return Date.now() - last > CACHE_MS;
  }

  markNotified(symbol, eventType) {
    this.cache.set(`${symbol}:${eventType}`, Date.now());
  }

  formatFirsat(row) {
    const pct = (from, to) => {
      if (!from || !to) return "";
      const p = ((to - from) / from) * 100;
      return ` (${p >= 0 ? "+" : ""}${p.toFixed(1)}%)`;
    };
    return [
      "🔔 BIST FIRSAT — " + row.symbol,
      "━━━━━━━━━━━━━━━━━━",
      `Skor: ${row.score}/100`,
      `Fiyat: ${fmtPrice(row.price)} TL`,
      `Stop: ${fmtPrice(row.stop)} TL${pct(row.price, row.stop)}`,
      `Hedef: ${fmtPrice(row.target)} TL${pct(row.price, row.target)}`,
      `R/R: 1:${row.rr}`,
      "━━━━━━━━━━━━━━━━━━",
      "BIST Confluence Swing Radar",
    ].join("\n");
  }

  formatStopHit(row, price) {
    return [
      "🛑 STOP — " + row.symbol,
      `Giriş: ${fmtPrice(row.entry)} TL`,
      `Stop: ${fmtPrice(row.stop)} TL`,
      `Son: ${fmtPrice(price)} TL`,
      "BIST Confluence Swing Radar",
    ].join("\n");
  }

  formatTargetHit(row, price) {
    return [
      "🎯 HEDEF — " + row.symbol,
      `Giriş: ${fmtPrice(row.entry)} TL`,
      `Hedef: ${fmtPrice(row.target)} TL`,
      `Son: ${fmtPrice(price)} TL`,
      "BIST Confluence Swing Radar",
    ].join("\n");
  }

  async send(text) {
    if (!this.enabled) return false;
    try {
      await this.bot.sendMessage(this.chatId, text, { disable_web_page_preview: true });
      return true;
    } catch (err) {
      console.error("Telegram gönderim hatası:", err.message);
      return false;
    }
  }

  async processRows(rows) {
    if (!this.enabled) return { sent: 0, events: [] };
    const events = [];
    let sent = 0;

    for (const row of rows) {
      if (row.symbol === "XU100.IS") continue;

      const prev = this.activeFirsat.get(row.symbol);
      const price = row.price;

      if (prev && price != null) {
        if (prev.stop && price <= prev.stop && this.canNotify(row.symbol, "stop")) {
          const ok = await this.send(this.formatStopHit(prev, price));
          if (ok) {
            this.markNotified(row.symbol, "stop");
            events.push("stop:" + row.symbol);
            sent += 1;
          }
          this.activeFirsat.delete(row.symbol);
          continue;
        }
        if (prev.target && price >= prev.target && this.canNotify(row.symbol, "target")) {
          const ok = await this.send(this.formatTargetHit(prev, price));
          if (ok) {
            this.markNotified(row.symbol, "target");
            events.push("target:" + row.symbol);
            sent += 1;
          }
          this.activeFirsat.delete(row.symbol);
          continue;
        }
      }

      if (row.status === "FIRSAT") {
        const isNew = !prev || prev.status !== "FIRSAT";
        if (isNew && this.canNotify(row.symbol, "firsat")) {
          const ok = await this.send(this.formatFirsat(row));
          if (ok) {
            this.markNotified(row.symbol, "firsat");
            events.push("firsat:" + row.symbol);
            sent += 1;
          }
        }
        this.activeFirsat.set(row.symbol, {
          symbol: row.symbol,
          entry: row.price,
          stop: row.stop,
          target: row.target,
          status: row.status,
        });
      } else if (prev) {
        this.activeFirsat.delete(row.symbol);
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
