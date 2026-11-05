"use strict";

/** Test verisi: kapanış dizisinden hafta içi günlük barlar üretir. */
function makeBars(closes, { start = "2024-01-01", volume = 1_000_000, range = 0.01 } = {}) {
  const bars = [];
  const date = new Date(`${start}T00:00:00Z`);
  for (let i = 0; i < closes.length; i += 1) {
    while (date.getUTCDay() === 0 || date.getUTCDay() === 6) date.setUTCDate(date.getUTCDate() + 1);
    const close = closes[i];
    const open = i ? closes[i - 1] : close;
    bars.push({
      date: new Date(date),
      open,
      high: Math.max(open, close) * (1 + range),
      low: Math.min(open, close) * (1 - range),
      close,
      volume,
    });
    date.setUTCDate(date.getUTCDate() + 1);
  }
  return bars;
}

/** Deterministik sözde rastgele sayı üreteci. */
function rng(seed = 42) {
  let s = seed >>> 0;
  return () => {
    s = (s * 1664525 + 1013904223) >>> 0;
    return s / 2 ** 32;
  };
}

function series(start, steps) {
  const out = [start];
  for (const pct of steps) out.push(out[out.length - 1] * (1 + pct));
  return out;
}

module.exports = { makeBars, rng, series };
