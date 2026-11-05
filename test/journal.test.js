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
