"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const {
  analyzeSymbol,
  evaluateSignal,
  computeMarketContext,
  computePositionSize,
  signalCache,
} = require("../lib/confluence");
const { getConfig } = require("../lib/config");
const { makeBars, series } = require("./helpers");

// Zayıf piyasa: endeks 200 gün yükselip son 60 günde düşüyor → XU100 < EMA50
function weakMarket() {
  const steps = [...Array(200).fill(0.002), ...Array(70).fill(-0.004)];
  return makeBars(series(10000, steps));
}

// Uzun süre hafif yükselen, son 10 günde ~%14 düşen ve son gün sert yukarı dönen hisse
function reversalStock() {
  const steps = [...Array(255).fill(0.001), ...Array(10).fill(-0.015), 0.03];
  return makeBars(series(100, steps));
}

const goodQuote = { trailingPE: 7.5, priceToBook: 1.2, epsTrailingTwelveMonths: 4 };
const config = getConfig({ maxBeta: 0, enableReversal: true });

test("zayıf piyasada kârlı ve ucuz hisse dönünce DÖNÜŞ sinyali verir", () => {
  const ctx = computeMarketContext(weakMarket(), config);
  assert.equal(ctx.xu100AboveEma50, false);
  const bars = reversalStock();
  const price = bars[bars.length - 1].close;
  const signal = evaluateSignal(price, bars, { ...goodQuote, regularMarketVolume: 2_000_000 }, ctx, { config });
  assert.equal(signal.status, "DÖNÜŞ");
  assert.ok(signal.sl < price && signal.tp > price);
  assert.match(signal.reason, /F\/K 7\.5/);
});

test("DÖNÜŞ: zarar eden ya da pahalı hisseye sinyal verilmez", () => {
  const ctx = computeMarketContext(weakMarket(), config);
  const bars = reversalStock();
  const price = bars[bars.length - 1].close;
  const losing = evaluateSignal(price, bars, { trailingPE: null, priceToBook: 0.8, epsTrailingTwelveMonths: -1 }, ctx, { config });
  assert.equal(losing.status, null);
  assert.equal(losing.reversal.rules.profitable, false);
  const expensive = evaluateSignal(price, bars, { trailingPE: 40, priceToBook: 6, epsTrailingTwelveMonths: 1 }, ctx, { config });
  assert.equal(expensive.status, null);
  assert.equal(expensive.reversal.rules.cheap, false);
  const noData = evaluateSignal(price, bars, null, ctx, { config });
  assert.equal(noData.status, null, "temel veri yoksa sinyal verilmez");
});

test("DÖNÜŞ: backtest modunda temel analiz şartı atlanır", () => {
  const ctx = computeMarketContext(weakMarket(), config);
  const bars = reversalStock();
  const signal = evaluateSignal(bars[bars.length - 1].close, bars, null, ctx, { config, skipFundamentals: true });
  assert.equal(signal.status, "DÖNÜŞ");
});

test("DÖNÜŞ: düşük likiditeli hisse elenir", () => {
  const ctx = computeMarketContext(weakMarket(), config);
  const steps = [...Array(255).fill(0.001), ...Array(10).fill(-0.015), 0.03];
  const bars = makeBars(series(100, steps), { volume: 1000 }); // ~100 bin TL/gün
  const signal = evaluateSignal(bars[bars.length - 1].close, bars, goodQuote, ctx, { config });
  assert.equal(signal.status, null);
  assert.equal(signal.filters.liquidityOk, false);
});

test("bedelsiz şüphesi (düzeltilmemiş %50 düşüş) sinyali engeller", () => {
  const ctx = computeMarketContext(weakMarket(), config);
  const closes = series(100, [...Array(255).fill(0.001), ...Array(10).fill(-0.015), 0.03]);
  closes[200] = closes[199] * 0.5;
  for (let i = 201; i < closes.length; i += 1) closes[i] *= 0.5;
  const bars = makeBars(closes, { volume: 5_000_000 });
  const signal = evaluateSignal(closes[closes.length - 1], bars, goodQuote, ctx, { config });
  assert.equal(signal.status, null);
  assert.equal(signal.filters.dataOk, false);
  assert.match(signal.reason, /veri şüpheli/);
});

test("güçlü piyasada DÖNÜŞ verilmez", () => {
  const strong = makeBars(series(10000, Array(270).fill(0.002)));
  const ctx = computeMarketContext(strong, config);
  assert.equal(ctx.xu100AboveEma50, true);
  const bars = reversalStock();
  const signal = evaluateSignal(bars[bars.length - 1].close, bars, goodQuote, ctx, { config });
  assert.notEqual(signal.status, "DÖNÜŞ");
});

test("lot hesabı sermayenin %1'ini riske eder ve sermayeyi aşmaz", () => {
  const cfg = getConfig({ capitalTl: 100_000, riskPct: 1 });
  assert.deepEqual(computePositionSize(100, 95, cfg), { lots: 200, riskTl: 1000, positionTl: 20000 });
  // Stop çok yakınsa lot sermaye ile sınırlanır
  assert.equal(computePositionSize(100, 99.9, cfg).lots, 1000);
  assert.equal(computePositionSize(100, 95, getConfig({ capitalTl: 0 })), null);
  assert.equal(computePositionSize(100, 101, cfg), null);
});

test("aynı sinyal 24 saat içinde bir kez bildirilir", () => {
  const ctx = computeMarketContext(weakMarket(), config);
  const bars = reversalStock();
  const input = { symbol: "TEST.IS", dailyBars: bars, quote: { ...goodQuote, regularMarketPrice: bars[bars.length - 1].close }, marketContext: ctx, config };
  delete signalCache["TEST.IS"];
  const first = analyzeSymbol(input);
  assert.equal(first.status, "DÖNÜŞ");
  assert.equal(first.signalNotify, true);
  require("../lib/confluence").markSignalNotified("TEST.IS");
  const second = analyzeSymbol(input);
  assert.equal(second.signalNotify, false);
  delete signalCache["TEST.IS"];
});

test("güçlü piyasada trend + hacimli kırılım FIRSAT verir", () => {
  const strongBench = makeBars(series(10000, Array(270).fill(0.001)));
  const ctx = computeMarketContext(strongBench, config);
  const steps = [];
  for (let i = 0; i < 135; i += 1) steps.push(0.008, -0.005);
  steps.push(0.015);
  const bars = makeBars(series(100, steps), { volume: 1_000_000 });
  bars[bars.length - 1].volume = 3_000_000;
  const price = bars[bars.length - 1].close;

  const signal = evaluateSignal(price, bars, null, ctx, { config });
  assert.equal(signal.status, "FIRSAT", JSON.stringify(signal.breakout.rules));

  // Gün içi sabah saatinde hacim oranı düşük beklenir; ortalamanın altındaki hacim de yeterli olur
  bars[bars.length - 1].volume = 500_000;
  assert.equal(evaluateSignal(price, bars, null, ctx, { config }).status, null);
  assert.equal(evaluateSignal(price, bars, null, ctx, { config, volumeFraction: 0.3 }).status, "FIRSAT");
});

test("REQUIRE_FUNDAMENTALS kapalıysa temel veri eksik hissede yalnızca teknik şartlar aranır", () => {
  const ctx = computeMarketContext(weakMarket(), config);
  const bars = reversalStock();
  const price = bars[bars.length - 1].close;
  const relaxed = getConfig({ maxBeta: 0, enableReversal: true, requireFundamentals: false });
  assert.equal(evaluateSignal(price, bars, {}, ctx, { config: relaxed }).status, "DÖNÜŞ");
  // Veri varsa yine uygulanır
  assert.equal(evaluateSignal(price, bars, { trailingPE: 50, priceToBook: 9, epsTrailingTwelveMonths: 1 }, ctx, { config: relaxed }).status, null);
});

test("DÖNÜŞ varsayılan olarak kapalıdır", () => {
  const ctx = computeMarketContext(weakMarket(), config);
  const bars = reversalStock();
  const off = getConfig({ maxBeta: 0 });
  assert.equal(off.enableReversal, false);
  const signal = evaluateSignal(bars[bars.length - 1].close, bars, goodQuote, ctx, { config: off });
  assert.equal(signal.status, null);
  assert.equal(signal.reversal, null);
});
