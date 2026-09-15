"use strict";

const { normalizeSymbol, load, markTriggered } = require("./targets");

function resolveAction(price, alert) {
  if (!alert || (alert.tp == null && alert.sl == null)) {
    return "No Alert";
  }
  if (price == null) return "Watch";
  if (alert.tp != null && price >= alert.tp) return "Take Profit";
  if (alert.sl != null && price <= alert.sl) return "Stop Loss";
  return "Watch";
}

function enrichRow(row, targets) {
  const key = normalizeSymbol(row.symbol);
  const alert = targets[key] || null;
  const tp = alert?.tp ?? null;
  const sl = alert?.sl ?? null;
  const action = alert?.triggered
    ? resolveAction(row.price, alert)
    : resolveAction(row.price, alert);

  return {
    ...row,
    tp: tp ?? "-",
    sl: sl ?? "-",
    action,
    alertTriggered: Boolean(alert?.triggered),
  };
}

function formatPrice(price) {
  return Number(price).toLocaleString("tr-TR", {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  });
}

/**
 * Check custom TP/SL targets each scan loop; returns Telegram messages to send.
 */
function collectTriggerEvents(rows) {
  const targets = load();
  const events = [];

  for (const row of rows) {
    const key = normalizeSymbol(row.symbol);
    const alert = targets[key];
    if (!alert || alert.triggered || row.price == null) continue;

    if (alert.tp != null && row.price >= alert.tp) {
      events.push({
        key,
        type: "tp",
        message: `🎯 HEDEF VURULDU: ${key} ${formatPrice(row.price)} TL`,
      });
      markTriggered(key);
      continue;
    }

    if (alert.sl != null && row.price <= alert.sl) {
      events.push({
        key,
        type: "sl",
        message: `🛑 STOP VURULDU: ${key} ${formatPrice(row.price)} TL`,
      });
      markTriggered(key);
    }
  }

  return events;
}

module.exports = {
  enrichRow,
  collectTriggerEvents,
  resolveAction,
};
