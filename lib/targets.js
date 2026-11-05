"use strict";

const fs = require("fs");
const path = require("path");

const { DATA_DIR, readJson, writeJson } = require("./storage");

const TARGETS_PATH = path.join(DATA_DIR, "targets.json");

let memory = {};

function normalizeSymbol(symbol) {
  return String(symbol || "")
    .trim()
    .replace(/\.IS$/i, "")
    .toUpperCase();
}

function load() {
  if (fs.existsSync(TARGETS_PATH)) {
    memory = readJson(TARGETS_PATH, memory);
  } else {
    memory = {};
    save(memory);
  }
  return { ...memory };
}

function save(data) {
  memory = data;
  writeJson(TARGETS_PATH, memory);
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
