#!/usr/bin/env node
"use strict";

/**
 * BIST backtest: strateji versiyonlarını geçmiş veride karşılaştırır.
 *
 * Kullanım:
 *   npm run backtest                         # BIST 100, son 2 yıl, tüm versiyonlar
 *   npm run backtest -- --years 3
 *   npm run backtest -- --symbols THYAO,ASELS,BIMAS
 *   npm run backtest -- --variants C,D --csv sonuc.csv
 *   npm run backtest -- --refresh            # önbelleği yok sayıp veriyi yeniden indir
 *
 * Veri Yahoo Finance'ten çekilir ve .cache/ klasörüne kaydedilir.
 */

const fs = require("fs");
const path = require("path");
const YahooFinance = require("yahoo-finance2").default;
const { BIST_100, BENCHMARK } = require("../lib/symbols");
const { normalizeBars } = require("../lib/indicators");
const { getConfig } = require("../lib/config");
const {
  VARIANTS,
  buildMarketContexts,
  simulateSymbol,
  summarizeTrades,
} = require("../lib/backtest");

const CACHE_DIR = path.join(__dirname, "..", ".cache", "backtest");
const WARMUP_DAYS = 420; // göstergeler için test başlangıcından önce gereken geçmiş
const FETCH_DELAY_MS = 300;

const yahooFinance = new YahooFinance({ suppressNotices: ["yahooSurvey"] });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function parseArgs(argv) {
  const args = { years: 2, symbols: null, variants: Object.keys(VARIANTS), csv: null, refresh: false };
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (a === "--years") args.years = Number(argv[++i]);
    else if (a === "--symbols") args.symbols = argv[++i].split(",").map((s) => s.trim().toUpperCase());
    else if (a === "--variants") args.variants = argv[++i].split(",").map((s) => s.trim().toUpperCase());
    else if (a === "--csv") args.csv = argv[++i];
    else if (a === "--refresh") args.refresh = true;
    else if (a === "--help" || a === "-h") {
      console.log(fs.readFileSync(__filename, "utf8").split("*/")[0]);
      process.exit(0);
    }
  }
  return args;
}

async function loadBars(symbol, period1, refresh) {
  fs.mkdirSync(CACHE_DIR, { recursive: true });
  const file = path.join(CACHE_DIR, `${symbol}.json`);
  const today = new Date().toISOString().slice(0, 10);

  if (!refresh && fs.existsSync(file)) {
    const cached = JSON.parse(fs.readFileSync(file, "utf8"));
    if (cached.fetchedOn === today && cached.period1 <= period1.toISOString()) {
      return normalizeBars(cached.quotes);
    }
  }

  const result = await yahooFinance.chart(symbol, { period1, interval: "1d" });
  fs.writeFileSync(
    file,
    JSON.stringify({ fetchedOn: today, period1: period1.toISOString(), quotes: result.quotes }),
  );
  await sleep(FETCH_DELAY_MS);
  return normalizeBars(result.quotes);
}

const fmt = (n, d = 2) => (n == null || !Number.isFinite(n) ? "—" : n.toFixed(d));

function printTable(rows) {
  const headers = ["Versiyon", "İşlem", "Kazanma %", "Ort. %", "Medyan %", "Kâr faktörü", "Toplam %", "Max düşüş %", "Ort. gün", "Hedef/Stop/İzSt/Süre"];
  const data = rows.map((r) => [
    r.key,
    String(r.s.trades),
    fmt(r.s.winRate, 1),
    fmt(r.s.avgReturn),
    fmt(r.s.medianReturn),
    fmt(r.s.profitFactor),
    fmt(r.s.totalReturn, 1),
    fmt(r.s.maxDrawdown, 1),
    fmt(r.s.avgHold, 1),
    `${r.s.tp}/${r.s.sl}/${r.s.trail}/${r.s.time}`,
  ]);
  const widths = headers.map((h, i) => Math.max(h.length, ...data.map((d) => d[i].length)));
  const line = (cells) => cells.map((c, i) => c.padEnd(widths[i])).join(" | ");
  console.log(line(headers));
  console.log(widths.map((w) => "-".repeat(w)).join("-|-"));
  data.forEach((d) => console.log(line(d)));
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const fromDate = new Date(Date.now() - args.years * 365 * 24 * 60 * 60 * 1000);
  const period1 = new Date(fromDate.getTime() - WARMUP_DAYS * 24 * 60 * 60 * 1000);

  const universe = (args.symbols
    ? args.symbols.map((s) => (s.endsWith(".IS") ? s : `${s}.IS`))
    : BIST_100
  ).filter((s) => s !== "ALTINS1.IS");

  console.log(`Veri indiriliyor: ${universe.length} hisse + ${BENCHMARK} (${period1.toISOString().slice(0, 10)} → bugün)`);
  const benchBars = await loadBars(BENCHMARK, period1, args.refresh);

  const barsBySymbol = new Map();
  for (const symbol of universe) {
    try {
      const bars = await loadBars(symbol, period1, args.refresh);
      if (bars.length > 250) barsBySymbol.set(symbol, bars);
      else console.warn(`  ${symbol}: yetersiz veri (${bars.length} gün), atlandı`);
    } catch (err) {
      console.warn(`  ${symbol}: indirilemedi (${err.message})`);
    }
  }

  console.log(`\nTest dönemi: ${fromDate.toISOString().slice(0, 10)} → bugün, ${barsBySymbol.size} hisse`);
  const base = getConfig();
  console.log(`Maliyet: tek yön komisyon %${base.commissionPct} + kayma %${base.slippagePct}\n`);

  const results = [];
  const allTrades = [];
  for (const key of args.variants) {
    const variant = VARIANTS[key];
    if (!variant) {
      console.warn(`Bilinmeyen versiyon: ${key}`);
      continue;
    }
    const config = getConfig(variant.config);
    const contexts = buildMarketContexts(benchBars, config);
    const trades = [];
    for (const [symbol, bars] of barsBySymbol) {
      trades.push(
        ...simulateSymbol(symbol, bars, contexts, {
          config,
          fromDate,
          allowReversal: variant.allowReversal,
          maxHoldBars: variant.maxHoldBars,
          trailAtr: variant.trailAtr,
        }),
      );
    }
    trades.forEach((t) => allTrades.push({ variant: key, ...t }));
    results.push({ key, label: variant.label, s: summarizeTrades(trades) });
    if (variant.splitByMarket) {
      results.push({ key: `${key}-güçlü`, label: "  piyasa güçlüyken (XU100 > EMA50)", s: summarizeTrades(trades.filter((t) => t.marketUp)) });
      results.push({ key: `${key}-zayıf`, label: "  piyasa zayıfken (XU100 < EMA50)", s: summarizeTrades(trades.filter((t) => !t.marketUp)) });
    }
    if (variant.allowReversal) {
      results.push({ key: `${key}-FIRSAT`, label: "  yalnızca FIRSAT işlemleri", s: summarizeTrades(trades.filter((t) => t.type === "FIRSAT")) });
      results.push({ key: `${key}-DÖNÜŞ`, label: "  yalnızca DÖNÜŞ işlemleri", s: summarizeTrades(trades.filter((t) => t.type === "DÖNÜŞ")) });
    }
  }

  results.forEach((r) => console.log(`${r.key}: ${r.label}`));
  console.log("");
  printTable(results);

  const benchFrom = benchBars.find((b) => b.date >= fromDate);
  const benchLast = benchBars[benchBars.length - 1];
  if (benchFrom && benchLast) {
    console.log(`\nKarşılaştırma: XU100 aynı dönemde ${fmt(((benchLast.close / benchFrom.close) - 1) * 100, 1)}%`);
  }
  console.log("Not: 'Toplam %' işlem getirilerinin toplamıdır (her işleme eşit para), bileşik getiri değildir.");
  console.log("Not: Geçmiş performans gelecekteki sonuçların garantisi değildir.");

  if (args.csv) {
    const header = "variant,symbol,type,marketUp,signalDate,entryDate,exitDate,entry,exit,tp,sl,outcome,holdBars,returnPct";
    const lines = allTrades.map((t) =>
      [t.variant, t.symbol, t.type, t.marketUp ? 1 : 0, t.signalDate, t.entryDate, t.exitDate, t.entry.toFixed(4), t.exit.toFixed(4), t.tp, t.sl, t.outcome, t.holdBars, t.returnPct.toFixed(3)].join(","),
    );
    fs.writeFileSync(args.csv, `${header}\n${lines.join("\n")}\n`);
    console.log(`\nİşlem listesi kaydedildi: ${args.csv}`);
  }
}

main().catch((err) => {
  console.error("Backtest hatası:", err.message);
  process.exit(1);
});
