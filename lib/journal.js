"use strict";

const path = require("path");
const { DATA_DIR, readJson, writeJson } = require("./storage");
const { normalizeSymbol } = require("./targets");

/**
 * Sinyal günlüğü: her FIRSAT/DÖNÜŞ sinyali kaydedilir, sonra hedef/stop/süre dolumu takip edilir.
 * Böylece botun gerçek hayattaki performansı ölçülür.
 */

const JOURNAL_PATH = path.join(DATA_DIR, "signals.json");
const MAX_HOLD_DAYS = 30;
const DAY_MS = 24 * 60 * 60 * 1000;

let memory = null;

function load() {
  if (!memory) {
    memory = readJson(JOURNAL_PATH, { signals: [], lastWeeklyReport: null });
    if (!Array.isArray(memory.signals)) memory.signals = [];
  }
  return memory;
}

function save() {
  writeJson(JOURNAL_PATH, memory);
}

/** Testlerde kullanılmak üzere hafızayı sıfırlar (dosyaya dokunmaz). */
function reset(data = { signals: [], lastWeeklyReport: null }) {
  memory = data;
}

/**
 * Yeni sinyalleri kaydeder. Aynı hissede açık bir sinyal varsa tekrar kaydetmez.
 * @returns {Array} eklenen kayıtlar
 */
function recordSignals(rows, now = Date.now(), { persist = true } = {}) {
  const data = load();
  const added = [];
  for (const row of rows) {
    if (row.status !== "FIRSAT" && row.status !== "DÖNÜŞ") continue;
    if (row.price == null || row.tp == null || row.sl == null) continue;
    const symbol = normalizeSymbol(row.symbol);
    const hasOpen = data.signals.some((s) => s.symbol === symbol && s.status === "open");
    if (hasOpen) continue;

    const entry = {
      id: `${symbol}-${now}`,
      symbol,
      type: row.status,
      openedAt: new Date(now).toISOString(),
      entry: row.price,
      tp: row.tp,
      sl: row.sl,
      status: "open",
      closedAt: null,
      exit: null,
      returnPct: null,
    };
    data.signals.push(entry);
    added.push(entry);
  }
  if (added.length && persist) save();
  return added;
}

/**
 * Açık sinyalleri güncel fiyatlarla kontrol eder: hedef, stop ya da 30 gün dolumu.
 * @returns {Array} kapanan kayıtlar
 */
function updateOpenSignals(rows, now = Date.now(), { persist = true } = {}) {
  const data = load();
  const priceBySymbol = new Map(
    rows.filter((r) => r.price != null).map((r) => [normalizeSymbol(r.symbol), r.price]),
  );
  const closed = [];

  for (const signal of data.signals) {
    if (signal.status !== "open") continue;
    const price = priceBySymbol.get(signal.symbol);
    if (price == null) continue;

    let outcome = null;
    let exit = price;
    if (price >= signal.tp) {
      outcome = "tp";
      exit = signal.tp;
    } else if (price <= signal.sl) {
      outcome = "sl";
      exit = signal.sl;
    } else if (now - Date.parse(signal.openedAt) > MAX_HOLD_DAYS * DAY_MS) {
      outcome = "expired";
    }

    if (outcome) {
      signal.status = outcome;
      signal.closedAt = new Date(now).toISOString();
      signal.exit = exit;
      signal.returnPct = Math.round(((exit / signal.entry) - 1) * 10000) / 100;
      closed.push(signal);
    }
  }

  if (closed.length && persist) save();
  return closed;
}

function summarize(sinceMs = 0) {
  const data = load();
  const inRange = data.signals.filter((s) => Date.parse(s.openedAt) >= sinceMs);
  const closed = inRange.filter((s) => s.status !== "open");
  const wins = closed.filter((s) => s.returnPct > 0);
  const totalReturn = closed.reduce((sum, s) => sum + (s.returnPct || 0), 0);

  return {
    total: inRange.length,
    open: inRange.length - closed.length,
    closed: closed.length,
    tp: closed.filter((s) => s.status === "tp").length,
    sl: closed.filter((s) => s.status === "sl").length,
    expired: closed.filter((s) => s.status === "expired").length,
    winRate: closed.length ? Math.round((wins.length / closed.length) * 1000) / 10 : null,
    avgReturn: closed.length ? Math.round((totalReturn / closed.length) * 100) / 100 : null,
    totalReturn: Math.round(totalReturn * 100) / 100,
    byType: {
      FIRSAT: inRange.filter((s) => s.type === "FIRSAT").length,
      DÖNÜŞ: inRange.filter((s) => s.type === "DÖNÜŞ").length,
    },
    openList: inRange.filter((s) => s.status === "open"),
  };
}

function formatReport(title, summary) {
  const lines = [`📊 ${title}`, "━━━━━━━━━━━━━━━━━━"];
  if (!summary.total) {
    lines.push("Bu dönemde sinyal yok.");
    return lines.join("\n");
  }
  lines.push(`Sinyal: ${summary.total} (FIRSAT ${summary.byType.FIRSAT} · DÖNÜŞ ${summary.byType.DÖNÜŞ})`);
  lines.push(`Kapanan: ${summary.closed} → 🎯 ${summary.tp} hedef · 🛑 ${summary.sl} stop · ⌛ ${summary.expired} süre doldu`);
  if (summary.winRate != null) {
    lines.push(`Kazanma oranı: %${summary.winRate}`);
    lines.push(`Ortalama: ${signed(summary.avgReturn)}% · Toplam: ${signed(summary.totalReturn)}%`);
  }
  if (summary.openList.length) {
    lines.push(`Açık: ${summary.openList.map((s) => `${s.symbol} (${s.type})`).join(", ")}`);
  }
  lines.push("Komisyon dahil değildir.");
  return lines.join("\n");
}

function signed(n) {
  if (n == null) return "—";
  return n > 0 ? `+${n}` : String(n);
}

function getLastWeeklyReport() {
  return load().lastWeeklyReport;
}

function setLastWeeklyReport(key) {
  load().lastWeeklyReport = key;
  save();
}

module.exports = {
  JOURNAL_PATH,
  MAX_HOLD_DAYS,
  recordSignals,
  updateOpenSignals,
  summarize,
  formatReport,
  getLastWeeklyReport,
  setLastWeeklyReport,
  reset,
};
