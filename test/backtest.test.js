"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const { simulateSymbol, summarizeTrades, buildMarketContexts, VARIANTS } = require("../lib/backtest");
const { getConfig } = require("../lib/config");
const { makeBars, series, rng } = require("./helpers");

test("işlem özeti: kazanma oranı, kâr faktörü ve max düşüş", () => {
  const trades = [
    { returnPct: 10, holdBars: 5, outcome: "tp", exitDate: "2025-01-01" },
    { returnPct: -4, holdBars: 3, outcome: "sl", exitDate: "2025-01-02" },
    { returnPct: -4, holdBars: 3, outcome: "sl", exitDate: "2025-01-03" },
    { returnPct: 2, holdBars: 30, outcome: "time", exitDate: "2025-01-04" },
    { returnPct: 99, holdBars: 1, outcome: "open", exitDate: "2025-01-05" },
  ];
  const s = summarizeTrades(trades);
  assert.equal(s.trades, 4);
  assert.equal(s.winRate, 50);
  assert.equal(s.profitFactor, 12 / 8);
  assert.equal(s.totalReturn, 4);
  assert.equal(s.maxDrawdown, -8);
  assert.equal(s.medianReturn, -1);
  assert.deepEqual([s.tp, s.sl, s.time], [1, 2, 1]);
});

test("simülasyon: ertesi gün açılıştan girer, maliyeti düşer ve sonuç üretir", () => {
  const rand = rng(7);
  const benchSteps = Array.from({ length: 700 }, () => 0.0008 + (rand() - 0.5) * 0.02);
  const bench = makeBars(series(10000, benchSteps));
  const stockSteps = benchSteps.map((r) => r * 1.1 + 0.0004 + (rand() - 0.5) * 0.02);
  const stock = makeBars(series(100, stockSteps), { volume: 2_000_000 });

  let total = 0;
  for (const key of Object.keys(VARIANTS)) {
    const variant = VARIANTS[key];
    const config = getConfig(variant.config);
    const contexts = buildMarketContexts(bench, config);
    const trades = simulateSymbol("TEST.IS", stock, contexts, { config, allowReversal: variant.allowReversal });
    total += trades.length;
    for (const t of trades) {
      assert.ok(t.entryDate > t.signalDate, "giriş sinyalden sonraki gün");
      assert.ok(t.holdBars >= 1 && t.holdBars <= 30);
      assert.ok(t.exitDate >= t.entryDate);
      if (t.outcome === "sl") assert.ok(t.returnPct < 0, "stopta zarar");
    }
    // İşlemler çakışmaz: hisse başına tek pozisyon
    for (let i = 1; i < trades.length; i += 1) {
      assert.ok(trades[i].signalDate > trades[i - 1].exitDate);
    }
  }
  assert.ok(total > 0, "en az bir işlem üretilmeli");
});
