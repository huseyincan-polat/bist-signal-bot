"use strict";

const {
  ema,
  rsi,
  rsiSeries,
  sma,
  withinPct,
  localSwingLows,
  clusterSupport,
  fibSupportBand,
  priorSwingHigh,
  normalizeBars,
} = require("./indicators");

const SUPPORT_MARGIN_PCT = 2;
const EMA_HOLD_PCT = 1.5;
const STOP_BUFFER_PCT = 2.5;
const MIN_SCORE_FIRSAT = 75;
const MIN_RR = 2;

function scoreSupportZone(price, dailyBars) {
  const lows = localSwingLows(dailyBars, 60);
  const cluster = clusterSupport(lows, SUPPORT_MARGIN_PCT);
  const fib = fibSupportBand(dailyBars, 90);
  let hit = false;
  let supportLevel = cluster;

  if (cluster && withinPct(price, cluster, SUPPORT_MARGIN_PCT)) {
    hit = true;
  }
  if (fib) {
    const inFibBand =
      (price >= fib.fib50 * (1 - SUPPORT_MARGIN_PCT / 100) &&
        price <= fib.fib618 * (1 + SUPPORT_MARGIN_PCT / 100)) ||
      withinPct(price, fib.fib50, SUPPORT_MARGIN_PCT) ||
      withinPct(price, fib.fib618, SUPPORT_MARGIN_PCT);
    if (inFibBand) {
      hit = true;
      supportLevel = supportLevel || (fib.fib50 + fib.fib618) / 2;
    }
  }
  return { points: hit ? 25 : 0, supportLevel, fib };
}

function scoreEmaHold(price, closes) {
  const ema50 = ema(closes, 50);
  const ema200 = ema(closes, 200);
  const near50 = ema50 && withinPct(price, ema50, EMA_HOLD_PCT) && price >= ema50 * (1 - EMA_HOLD_PCT / 100);
  const near200 = ema200 && withinPct(price, ema200, EMA_HOLD_PCT) && price >= ema200 * (1 - EMA_HOLD_PCT / 100);
  return { points: near50 || near200 ? 20 : 0, ema50, ema200 };
}

function scoreVolumeAtSupport(dailyBars) {
  const volumes = dailyBars.map((b) => b.volume);
  const volSma = sma(volumes, 20);
  const lastVol = volumes[volumes.length - 1] || 0;
  if (!volSma) return { points: 0, volSma: null, lastVol };
  return { points: lastVol >= volSma ? 20 : 0, volSma, lastVol };
}

function scoreRsiTurnUp(closes) {
  if (closes.length < 20) return { points: 0, rsi: null, prevRsi: null };
  const series = rsiSeries(closes, 14);
  if (series.length < 2) return { points: 0, rsi: null, prevRsi: null };
  const current = series[series.length - 1];
  const previous = series[series.length - 2];
  const turningUp = current > previous;
  const fromZone = (previous >= 30 && previous <= 40) || (current >= 30 && current <= 40);
  return {
    points: turningUp && fromZone ? 15 : 0,
    rsi: current,
    prevRsi: previous,
  };
}

function scoreMarketRegime(xu100Daily) {
  const closes = xu100Daily.map((b) => b.close);
  const ema50 = ema(closes, 50);
  const last = closes[closes.length - 1];
  if (!ema50 || !last) return { points: 0, xu100AboveEma50: false };
  return { points: last > ema50 ? 20 : 0, xu100AboveEma50: last > ema50 };
}

function computeRiskReward(price, supportLevel, target) {
  if (!supportLevel || !target || price <= supportLevel) return { stop: null, target: null, rr: 0 };
  const stop = supportLevel * (1 - STOP_BUFFER_PCT / 100);
  const risk = price - stop;
  const reward = target - price;
  if (risk <= 0 || reward <= 0) return { stop, target, rr: 0 };
  return { stop, target, rr: reward / risk };
}

/**
 * @param {object} input
 * @param {string} input.symbol
 * @param {Array} input.dailyBars normalized OHLCV
 * @param {Array} input.weeklyBars normalized OHLCV
 * @param {object} input.marketRegime from scoreMarketRegime
 */
function analyzeSymbol({ symbol, dailyBars, weeklyBars, marketRegime }) {
  if (!dailyBars.length) {
    return {
      symbol,
      price: null,
      score: 0,
      status: "BEKLE",
      stop: null,
      target: null,
      rr: 0,
      breakdown: {},
      error: "Veri yok",
    };
  }

  const price = dailyBars[dailyBars.length - 1].close;
  const closes = dailyBars.map((b) => b.close);

  const support = scoreSupportZone(price, dailyBars);
  const emaHold = scoreEmaHold(price, closes);
  const volume = scoreVolumeAtSupport(dailyBars);
  const rsiTurn = scoreRsiTurnUp(closes);
  const regimePts = marketRegime?.points ?? 0;

  const score =
    support.points + emaHold.points + volume.points + rsiTurn.points + regimePts;

  const weeklyHigh = weeklyBars.length
    ? priorSwingHigh(weeklyBars, weeklyBars.length)
    : null;
  const dailyHigh = priorSwingHigh(dailyBars, 120);
  const target = weeklyHigh || dailyHigh || null;
  const supportLevel = support.supportLevel || support.fib?.fib618 || support.fib?.fib50;
  const { stop, rr } = computeRiskReward(price, supportLevel, target);

  let status = "BEKLE";
  if (score >= MIN_SCORE_FIRSAT && rr >= MIN_RR && stop && target) {
    status = "FIRSAT";
  }

  return {
    symbol,
    price: round(price),
    score,
    status,
    stop: stop ? round(stop) : null,
    target: target ? round(target) : null,
    rr: round(rr, 2),
    breakdown: {
      support: support.points,
      emaHold: emaHold.points,
      volume: volume.points,
      rsiTurn: rsiTurn.points,
      marketRegime: regimePts,
    },
    rsi: rsiTurn.rsi != null ? round(rsiTurn.rsi, 1) : null,
    ema50: emaHold.ema50 ? round(emaHold.ema50) : null,
    supportLevel: supportLevel ? round(supportLevel) : null,
    xu100AboveEma50: marketRegime?.xu100AboveEma50 ?? false,
  };
}

function round(value, digits = 2) {
  if (value == null || Number.isNaN(value)) return null;
  const factor = 10 ** digits;
  return Math.round(value * factor) / factor;
}

module.exports = {
  analyzeSymbol,
  normalizeBars,
  scoreMarketRegime,
  MIN_SCORE_FIRSAT,
};
