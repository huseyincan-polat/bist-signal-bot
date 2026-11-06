"use strict";

const path = require("path");
const { DATA_DIR, readJson, writeJson } = require("./storage");
const { normalizeSymbol } = require("./targets");
const { getConfig } = require("./config");

/**
 * Sinyal günlüğü: her FIRSAT/DÖNÜŞ sinyali kaydedilir, sonra hedef/stop/süre dolumu takip edilir.
 * Böylece botun gerçek hayattaki performansı ölçülür.
 */

const JOURNAL_PATH = path.join(DATA_DIR, "signals.json");
const STOP_RAISE_NOTIFY_PCT = 2; // stop en az bu kadar yükselince bildir
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
    if (row.price == null || row.sl == null) continue;
    const symbol = normalizeSymbol(row.symbol);
    const hasOpen = data.signals.some((s) => s.symbol === symbol && s.status === "open");
    if (hasOpen) continue;

    const entry = {
      id: `${symbol}-${now}`,
      symbol,
      type: row.status,
      openedAt: new Date(now).toISOString(),
      entry: row.price,
      tp: row.tp ?? null,
      sl: row.sl,
      stop: row.sl,
      highest: row.price,
      trailAtr: row.trailAtr ?? null,
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
 * Açık sinyalleri güncel fiyatlarla kontrol eder: hedef, stop, takip eden stop ya da süre dolumu.
 * Takip eden stoplu sinyallerde stop, en yüksek fiyat − trailAtr × ATR seviyesine yükseltilir (asla indirilmez).
 * @returns {{closed: Array, raised: Array<{signal: object, from: number, to: number}>}}
 */
function updateOpenSignals(rows, now = Date.now(), { persist = true, config = getConfig() } = {}) {
  const data = load();
  const rowBySymbol = new Map(
    rows.filter((r) => r.price != null).map((r) => [normalizeSymbol(r.symbol), r]),
  );
  const maxHoldMs = config.maxHoldDays * (7 / 5) * DAY_MS; // işlem günü → takvim günü
  const closed = [];
  const raised = [];
  let changed = false;

  for (const signal of data.signals) {
    if (signal.status !== "open") continue;
    const row = rowBySymbol.get(signal.symbol);
    if (!row) continue;
    const price = row.price;
    const stop = signal.stop ?? signal.sl;

    let outcome = null;
    let exit = price;
    if (signal.tp != null && price >= signal.tp) {
      outcome = "tp";
      exit = signal.tp;
    } else if (price <= stop) {
      outcome = stop > signal.sl ? "trail" : "sl";
      exit = signal.trailAtr ? price : stop;
    } else if (now - Date.parse(signal.openedAt) > maxHoldMs) {
      outcome = "expired";
    }

    if (outcome) {
      signal.status = outcome;
      signal.closedAt = new Date(now).toISOString();
      signal.exit = exit;
      signal.returnPct = Math.round(((exit / signal.entry) - 1) * 10000) / 100;
      closed.push(signal);
      changed = true;
      continue;
    }

    if (signal.trailAtr && row.atr) {
      const highest = Math.max(signal.highest ?? signal.entry, price);
      if (highest !== signal.highest) {
        signal.highest = highest;
        changed = true;
      }
      const candidate = Math.round((highest - signal.trailAtr * row.atr) * 100) / 100;
      if (candidate > stop) {
        const lastNotified = signal.notifiedStop ?? signal.sl;
        signal.stop = candidate;
        changed = true;
        if (candidate >= lastNotified * (1 + STOP_RAISE_NOTIFY_PCT / 100)) {
          raised.push({ signal, from: lastNotified, to: candidate });
          signal.notifiedStop = candidate;
        }
      }
    }
  }

  if (changed && persist) save();
  return { closed, raised };
}

/**
 * Aynı anda açık sinyal sayısını sınırlar. Sınır doluyken gelen yeni sinyallere
 * `limitReached` işareti konur: panelde ve Telegram'da görünür ama günlüğe yazılmaz
 * ve lot önerilmez. Açık sinyali olan hisse sınırdan etkilenmez.
 */
function applyOpenSignalLimit(rows, maxOpenSignals) {
  if (!maxOpenSignals) return;
  const open = load().signals.filter((s) => s.status === "open");
  const openSymbols = new Set(open.map((s) => s.symbol));
  let openCount = open.length;

  for (const row of rows) {
    if (row.status !== "FIRSAT" && row.status !== "DÖNÜŞ") continue;
    const key = normalizeSymbol(row.symbol);
    if (openSymbols.has(key)) continue;
    if (openCount < maxOpenSignals) {
      openCount += 1;
      openSymbols.add(key);
    } else {
      row.limitReached = true;
      row.openSignalCount = openCount;
      row.lots = null;
      row.riskTl = null;
      row.positionTl = null;
    }
  }
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
    trail: closed.filter((s) => s.status === "trail").length,
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
  lines.push(`Kapanan: ${summary.closed} → 🎯 ${summary.tp} hedef · 📈 ${summary.trail} takip eden stop · 🛑 ${summary.sl} stop · ⌛ ${summary.expired} süre doldu`);
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
  recordSignals,
  updateOpenSignals,
  applyOpenSignalLimit,
  summarize,
  formatReport,
  getLastWeeklyReport,
  setLastWeeklyReport,
  reset,
};
