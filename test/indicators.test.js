"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const { rsiSeries, rsi, beta, avgTurnover, maxAbsDailyMovePct } = require("../lib/indicators");
const { expectedVolumeFraction } = require("../lib/market-hours");
const { makeBars, rng, series } = require("./helpers");

test("RSI Wilder yöntemiyle hesaplanır (StockCharts örneği)", () => {
  const closes = [44.34, 44.09, 44.15, 43.61, 44.33, 44.83, 45.10, 45.42, 45.84, 46.08, 45.89, 46.03, 45.61, 46.28, 46.28, 46.00, 46.03, 46.41];
  const values = rsiSeries(closes, 14);
  const expected = [70.53, 66.32, 66.55, 69.41];
  assert.equal(values.length, expected.length);
  values.forEach((v, i) => assert.ok(Math.abs(v - expected[i]) < 0.15, `RSI[${i}] ${v} ≠ ${expected[i]}`));
  assert.equal(rsi(closes, 14), values[values.length - 1]);
});

test("RSI uç durumlar", () => {
  assert.equal(rsi([1, 2], 14), null);
  assert.equal(rsi(Array.from({ length: 20 }, (_, i) => 10 + i), 14), 100);
  assert.equal(rsi(Array(20).fill(10), 14), 50);
});

test("beta: endeksin iki katı hareket eden hisse ≈ 2", () => {
  const rand = rng(1);
  const benchSteps = Array.from({ length: 150 }, () => (rand() - 0.5) * 0.04);
  const bench = makeBars(series(1000, benchSteps));
  const stock = makeBars(series(50, benchSteps.map((r) => r * 2)));
  const b = beta(stock, bench, 120);
  assert.ok(Math.abs(b - 2) < 0.01, `beta ${b}`);
});

test("beta: ortak gün yetersizse null", () => {
  assert.equal(beta(makeBars([1, 2, 3]), makeBars([1, 2, 3]), 120), null);
});

test("ortalama TL hacim ve en büyük günlük hareket", () => {
  const bars = makeBars([100, 100, 100, 100, 100], { volume: 1000 });
  assert.equal(avgTurnover(bars, 20), 100_000);
  const jumpy = makeBars([100, 101, 50, 51]);
  assert.ok(Math.abs(maxAbsDailyMovePct(jumpy) - 50.495) < 0.01);
});

test("gün içi beklenen hacim oranı", () => {
  // 2026-11-04 Çarşamba. İstanbul = UTC+3
  assert.equal(expectedVolumeFraction(new Date("2026-11-04T06:30:00Z")), 0.05); // 09:30
  const noon = expectedVolumeFraction(new Date("2026-11-04T10:00:00Z")); // 13:00
  assert.ok(Math.abs(noon - (3 / 8) * 0.85) < 1e-9);
  assert.equal(expectedVolumeFraction(new Date("2026-11-04T15:05:00Z")), 1); // 18:05
});
