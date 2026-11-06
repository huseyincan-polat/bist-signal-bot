"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const journal = require("../lib/journal");
const { getConfig } = require("../lib/config");

const DAY = 24 * 60 * 60 * 1000;
const opts = { persist: false, config: getConfig({ maxHoldDays: 20 }) }; // 20 işlem günü ≈ 28 takvim günü

test("sinyal günlüğü: kayıt, hedef, stop ve süre dolumu", () => {
  journal.reset();
  const t0 = Date.parse("2026-11-02T08:00:00Z");
  const added = journal.recordSignals([
    { symbol: "AAA.IS", status: "FIRSAT", price: 100, tp: 110, sl: 96 },
    { symbol: "BBB.IS", status: "DÖNÜŞ", price: 50, tp: 55, sl: 48 },
    { symbol: "CCC.IS", status: "DÖNÜŞ", price: 20, tp: 22, sl: 19 },
    { symbol: "DDD.IS", status: "BEKLE", price: 10, tp: null, sl: null },
  ], t0, opts);
  assert.equal(added.length, 3);

  // Aynı hissede açık sinyal varken tekrar kaydedilmez
  assert.equal(journal.recordSignals([{ symbol: "AAA.IS", status: "FIRSAT", price: 101, tp: 111, sl: 97 }], t0 + 1000, opts).length, 0);

  const { closed } = journal.updateOpenSignals([
    { symbol: "AAA.IS", price: 111 },
    { symbol: "BBB.IS", price: 47.5 },
    { symbol: "CCC.IS", price: 20.5 },
  ], t0 + DAY, opts);
  assert.deepEqual(closed.map((s) => [s.symbol, s.status, s.returnPct]), [["AAA", "tp", 10], ["BBB", "sl", -4]]);

  const { closed: expired } = journal.updateOpenSignals([{ symbol: "CCC.IS", price: 20.5 }], t0 + 31 * DAY, opts);
  assert.deepEqual(expired.map((s) => [s.symbol, s.status, s.returnPct]), [["CCC", "expired", 2.5]]);

  const summary = journal.summarize(0);
  assert.equal(summary.total, 3);
  assert.equal(summary.closed, 3);
  assert.equal(summary.winRate, 66.7);
  assert.equal(summary.totalReturn, 8.5);
  const text = journal.formatReport("Test", summary);
  assert.match(text, /Kazanma oranı: %66\.7/);
  journal.reset();
});

test("açık sinyal sınırı dolunca yeni sinyaller işaretlenir ve günlüğe yazılmaz", () => {
  journal.reset();
  const t0 = Date.parse("2026-11-02T08:00:00Z");
  journal.recordSignals([
    { symbol: "AAA.IS", status: "FIRSAT", price: 100, tp: 110, sl: 96 },
    { symbol: "BBB.IS", status: "FIRSAT", price: 50, tp: 55, sl: 48 },
  ], t0, opts);

  const rows = [
    { symbol: "AAA.IS", status: "FIRSAT", price: 101, tp: 111, sl: 97, lots: 10 }, // zaten açık
    { symbol: "CCC.IS", status: "FIRSAT", price: 20, tp: 22, sl: 19, lots: 50 }, // 3. sinyal: sığar
    { symbol: "DDD.IS", status: "FIRSAT", price: 30, tp: 33, sl: 29, lots: 40 }, // 4.: sınır dolu
    { symbol: "EEE.IS", status: "BEKLE", price: 5 },
  ];
  journal.applyOpenSignalLimit(rows, 3);
  assert.equal(rows[0].limitReached, undefined);
  assert.equal(rows[1].limitReached, undefined);
  assert.equal(rows[2].limitReached, true);
  assert.equal(rows[2].lots, null);
  assert.equal(rows[2].openSignalCount, 3);

  const added = journal.recordSignals(rows.filter((r) => !r.limitReached), t0 + 1000, opts);
  assert.deepEqual(added.map((s) => s.symbol), ["CCC"]);

  journal.applyOpenSignalLimit(rows, 0); // 0 = sınırsız
  journal.reset();
});

test("takip eden stop: yükselir, asla inmez, bildirilir ve kapanışta 'trail' olur", () => {
  journal.reset();
  const t0 = Date.parse("2026-11-02T08:00:00Z");
  journal.recordSignals([{ symbol: "TRL.IS", status: "FIRSAT", price: 100, tp: null, sl: 95, trailAtr: 3 }], t0, opts);

  // ATR 2 → stop = en yüksek − 6. Fiyat 100: 94 < 95, stop değişmez
  let r = journal.updateOpenSignals([{ symbol: "TRL.IS", price: 100, atr: 2 }], t0 + DAY, opts);
  assert.deepEqual([r.closed.length, r.raised.length], [0, 0]);

  // Fiyat 110: stop 104'e çıkar (%9,5 artış → bildirilir)
  r = journal.updateOpenSignals([{ symbol: "TRL.IS", price: 110, atr: 2 }], t0 + 2 * DAY, opts);
  assert.deepEqual(r.raised.map((e) => [e.from, e.to]), [[95, 104]]);

  // Fiyat 108: en yüksek 110 kalır, stop 104'te kalır (inmez)
  r = journal.updateOpenSignals([{ symbol: "TRL.IS", price: 108, atr: 2 }], t0 + 3 * DAY, opts);
  assert.equal(r.raised.length, 0);
  assert.equal(journal.summarize(0).openList[0].stop, 104);

  // Fiyat 111: stop 105 (%1 artış → kaydedilir ama bildirilmez)
  r = journal.updateOpenSignals([{ symbol: "TRL.IS", price: 111, atr: 2 }], t0 + 4 * DAY, opts);
  assert.equal(r.raised.length, 0);
  assert.equal(journal.summarize(0).openList[0].stop, 105);

  // Fiyat 104,5: stopun altında → takip eden stop ile kâr ederek kapanır
  r = journal.updateOpenSignals([{ symbol: "TRL.IS", price: 104.5, atr: 2 }], t0 + 5 * DAY, opts);
  assert.deepEqual(r.closed.map((s) => [s.status, s.returnPct]), [["trail", 4.5]]);
  assert.match(journal.formatReport("T", journal.summarize(0)), /1 takip eden stop/);
  journal.reset();
});
