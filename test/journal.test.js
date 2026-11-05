"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const journal = require("../lib/journal");

const DAY = 24 * 60 * 60 * 1000;
const opts = { persist: false };

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

  const closed = journal.updateOpenSignals([
    { symbol: "AAA.IS", price: 111 },
    { symbol: "BBB.IS", price: 47.5 },
    { symbol: "CCC.IS", price: 20.5 },
  ], t0 + DAY, opts);
  assert.deepEqual(closed.map((s) => [s.symbol, s.status, s.returnPct]), [["AAA", "tp", 10], ["BBB", "sl", -4]]);

  const expired = journal.updateOpenSignals([{ symbol: "CCC.IS", price: 20.5 }], t0 + 31 * DAY, opts);
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
