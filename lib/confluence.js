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
  normalizeBars,
  normalizeDailyChangePercent,
  computePeriodChangePercents,
} = require("./indicators");

const SUPPORT_MARGIN_PCT = 2;
const EMA_HOLD_PCT = 1.5;
const EMA50_BAND_PCT = 3;
const FIRSAT_HOLD_MS = 2 * 60 * 60 * 1000;
const FIRSAT_PRICE_BAND = 0.02;

/** @type {Record<string, {time:number, price:number, notified:boolean}>} */
const firsatCache = {};

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

function simpleAtr(bars, period = 14) {
  const window = (bars || []).slice(-period);
  if (window.length < 2) return null;

  const trs = [];
  for (let i = 1; i < window.length; i += 1) {
    const high = window[i].high;
    const low = window[i].low;
    const prevClose = window[i - 1].close;
    trs.push(Math.max(high - low, Math.abs(high - prevClose), Math.abs(low - prevClose)));
  }

  if (!trs.length) return null;
  return trs.reduce((sum, tr) => sum + tr, 0) / trs.length;
}

function checkRawFirsat(close, dailyBars, quote) {
  const closes = dailyBars.map((b) => b.close);
  const volumes = dailyBars.map((b) => b.volume || 0);

  const sma200 = sma(closes, 200);
  const ema50 = ema(closes, 50);
  const rsi14 = rsi(closes, 14);
  const volSma20 = sma(volumes, 20);
  const currentVol = quote?.regularMarketVolume ?? volumes[volumes.length - 1] ?? 0;

  const aboveSma200 = sma200 != null && close > sma200;
  const nearEma50 =
    ema50 != null && ema50 > 0 && Math.abs(close - ema50) / ema50 <= EMA50_BAND_PCT / 100;
  const rsiLow = rsi14 != null && rsi14 < 45;
  const volumeAbove = volSma20 != null && volSma20 > 0 && currentVol > volSma20;

  const rules = { aboveSma200, nearEma50, rsiLow, volumeAbove };
  const count = Object.values(rules).filter(Boolean).length;

  return {
    raw: count === 4,
    count,
    rules,
    sma200,
    ema50,
    rsi14,
    volSma20,
    currentVol,
  };
}

function isWithinHysteresis(symbol, price) {
  const entry = firsatCache[symbol];
  if (!entry || entry.price <= 0) return false;

  const age = Date.now() - entry.time;
  if (age > FIRSAT_HOLD_MS) return false;

  const move = Math.abs(price - entry.price) / entry.price;
  return move < FIRSAT_PRICE_BAND;
}

function resolveFirsatStatus(symbol, price, rawFirsat) {
  if (rawFirsat) {
    const existing = firsatCache[symbol];
    if (!existing || Date.now() - existing.time > FIRSAT_HOLD_MS) {
      firsatCache[symbol] = { time: Date.now(), price, notified: false };
    } else {
      firsatCache[symbol].time = Date.now();
      firsatCache[symbol].price = price;
    }

    return {
      status: "FIRSAT",
      firsatNotify: !firsatCache[symbol].notified,
    };
  }

  if (isWithinHysteresis(symbol, price)) {
    return { status: "FIRSAT", firsatNotify: false };
  }

  delete firsatCache[symbol];
  return { status: "BEKLE", firsatNotify: false };
}

function markFirsatNotified(symbol) {
  const entry = firsatCache[symbol];
  if (entry) entry.notified = true;
}

function calculateDynamicTargets(bars, currentPrice) {
  if (currentPrice == null || !Number.isFinite(currentPrice) || currentPrice <= 0) {
    return { tp: null, sl: null };
  }

  const atr = simpleAtr(bars, 14);
  if (atr == null || !Number.isFinite(atr) || atr <= 0) {
    return {
      tp: round(currentPrice * 1.1),
      sl: round(currentPrice * 0.95),
    };
  }

  const sl = currentPrice - 1.5 * atr;
  const risk = currentPrice - sl;

  if (!Number.isFinite(sl) || sl <= 0 || !Number.isFinite(risk) || risk <= 0) {
    return {
      tp: round(currentPrice * 1.1),
      sl: round(currentPrice * 0.95),
    };
  }

  return {
    tp: round(currentPrice + risk * 2.5),
    sl: round(sl),
  };
}

/**
 * @param {object} input
 * @param {string} input.symbol
 * @param {Array} input.dailyBars normalized OHLCV
 * @param {object} input.quote Yahoo quote shape
 */
function analyzeSymbol({ symbol, dailyBars, quote }) {
  if (!dailyBars.length) {
    if (quote?.regularMarketPrice != null) {
      return {
        symbol,
        price: round(quote.regularMarketPrice),
        score: 0,
        status: "BEKLE",
        action: "—",
        firsatNotify: false,
        breakdown: {},
        dailyChangePercent: normalizeDailyChangePercent(quote.regularMarketChangePercent),
        weeklyChangePercent: null,
        monthlyChangePercent: null,
        yearlyChangePercent: null,
        error: "Tarihsel veri yok — yalnızca canlı fiyat",
        dataSource: quote.sourceUrl || quote.source || null,
      };
    }
    return {
      symbol,
      price: null,
      score: 0,
      status: "BEKLE",
      action: "—",
      firsatNotify: false,
      breakdown: {},
      error: "Veri yok",
    };
  }

  const price = quote?.regularMarketPrice ?? dailyBars[dailyBars.length - 1].close;
  const closes = dailyBars.map((b) => b.close);
  const changes = computePeriodChangePercents(
    dailyBars,
    price,
    quote?.regularMarketChangePercent ?? null,
  );

  const support = scoreSupportZone(price, dailyBars);
  const emaHold = scoreEmaHold(price, closes);
  const volumeScore = scoreVolumeAtSupport(dailyBars);
  const rsiTurn = scoreRsiTurnUp(closes);
  const firsatRules = checkRawFirsat(price, dailyBars, quote);
  const firsatState = resolveFirsatStatus(symbol, price, firsatRules.raw);

  let score = support.points + emaHold.points + volumeScore.points + rsiTurn.points;
  if (firsatRules.count === 3) score += 10;

  const isFirsat = firsatState.status === "FIRSAT";
  const dynamicTargets = isFirsat ? calculateDynamicTargets(dailyBars, price) : { tp: null, sl: null };

  return {
    symbol,
    price: round(price),
    score,
    status: firsatState.status,
    action: isFirsat ? "FIRSAT" : "—",
    firsatNotify: firsatState.firsatNotify,
    tp: dynamicTargets.tp,
    sl: dynamicTargets.sl,
    breakdown: {
      support: support.points,
      emaHold: emaHold.points,
      volume: volumeScore.points,
      rsiTurn: rsiTurn.points,
      rulesMatched: firsatRules.count,
      rules: firsatRules.rules,
      hysteresis: isFirsat && !firsatRules.raw,
    },
    rsi: firsatRules.rsi14 != null ? round(firsatRules.rsi14, 1) : (rsiTurn.rsi != null ? round(rsiTurn.rsi, 1) : null),
    ema50: firsatRules.ema50 != null ? round(firsatRules.ema50) : (emaHold.ema50 ? round(emaHold.ema50) : null),
    sma200: firsatRules.sma200 != null ? round(firsatRules.sma200) : null,
    dailyChangePercent: changes.dailyChangePercent,
    weeklyChangePercent: changes.weeklyChangePercent,
    monthlyChangePercent: changes.monthlyChangePercent,
    yearlyChangePercent: changes.yearlyChangePercent,
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
  calculateDynamicTargets,
  markFirsatNotified,
  checkRawFirsat,
  firsatCache,
};
