"use strict";

const fs = require("fs");
const path = require("path");

const TARGETS_PATH = path.join(__dirname, "..", "targets.json");

let memory = {};

function normalizeSymbol(symbol) {
  return String(symbol || "")
    .trim()
    .replace(/\.IS$/i, "")
    .toUpperCase();
}

function load() {
  try {
    if (fs.existsSync(TARGETS_PATH)) {
      const raw = fs.readFileSync(TARGETS_PATH, "utf8");
      memory = raw.trim() ? JSON.parse(raw) : {};
    } else {
      memory = {};
      save(memory);
    }
  } catch {
    memory = {};
  }
  return { ...memory };
}

function save(data) {
  memory = data;
  fs.writeFileSync(TARGETS_PATH, `${JSON.stringify(memory, null, 2)}\n`);
}

function get(symbol) {
  const key = normalizeSymbol(symbol);
  return memory[key] ? { ...memory[key] } : null;
}

function setAlert(symbol, tp, sl) {
  const key = normalizeSymbol(symbol);
  const data = load();
  data[key] = {
    tp: Number(tp),
    sl: Number(sl),
    triggered: false,
  };
  save(data);
  return { key, ...data[key] };
}

function markTriggered(symbol) {
  const key = normalizeSymbol(symbol);
  const data = load();
  if (!data[key]) return false;
  data[key].triggered = true;
  save(data);
  return true;
}

function listAlerts() {
  const data = load();
  return Object.entries(data)
    .map(([symbol, alert]) => ({
      symbol,
      tp: alert.tp,
      sl: alert.sl,
      triggered: Boolean(alert.triggered),
    }))
    .sort((a, b) => a.symbol.localeCompare(b.symbol, "tr"));
}

function removeAlert(symbol) {
  const key = normalizeSymbol(symbol);
  const data = load();
  if (!data[key]) return false;
  delete data[key];
  save(data);
  return true;
}

function init() {
  load();
}

module.exports = {
  TARGETS_PATH,
  normalizeSymbol,
  load,
  save,
  get,
  setAlert,
  markTriggered,
  listAlerts,
  removeAlert,
  init,
};
