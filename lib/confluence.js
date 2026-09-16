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
  computePeriodChangePercents,
} = require("./indicators");

const SUPPORT_MARGIN_PCT = 2;
const EMA_HOLD_PCT = 1.5;
const SWEEP_MARGIN_PCT = 2;
const VOLUME_SPIKE_MULT = 1.5;

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

/** Minimum low over the prior 10 completed daily sessions (excludes current bar). */
function priorTenSessionLow(dailyBars) {
  if (dailyBars.length < 11) return null;
  const prior = dailyBars.slice(-11, -1);
  return Math.min(...prior.map((b) => b.low));
}

/**
 * Liquidity sweep: price within 2% above 10-session low, or wicked below and recovered.
 */
function checkLiquiditySweep(price, dailyBars) {
  if (price == null || dailyBars.length < 11) {
    return { hit: false, low10: null };
  }

  const low10 = priorTenSessionLow(dailyBars);
  if (!low10 || low10 <= 0) return { hit: false, low10: null };

  const today = dailyBars[dailyBars.length - 1];
  const withinBand = price >= low10 && price <= low10 * (1 + SWEEP_MARGIN_PCT / 100);
  const sweepRecovery = today.low < low10 && price >= low10;

  return { hit: withinBand || sweepRecovery, low10 };
}

/**
 * Volume spike: regularMarketVolume >= 1.5× 10-day average (quote or bar SMA).
 */
function checkVolumeSpike(quote, dailyBars) {
  const currentVol = quote?.regularMarketVolume ?? null;
  let avgVol = quote?.averageDailyVolume10Day ?? null;

  if ((!avgVol || avgVol <= 0) && dailyBars.length >= 11) {
    const priorVolumes = dailyBars.slice(-11, -1).map((b) => b.volume || 0);
    avgVol = sma(priorVolumes, 10);
  }

  if (currentVol == null || avgVol == null || avgVol <= 0) {
    return { hit: false, currentVol, avgVol };
  }

  return {
    hit: currentVol >= VOLUME_SPIKE_MULT * avgVol,
    currentVol,
    avgVol,
  };
}

function isFirsat(price, dailyBars, quote) {
  const sweep = checkLiquiditySweep(price, dailyBars);
  const volume = checkVolumeSpike(quote, dailyBars);
  return sweep.hit && volume.hit;
}

function calculateDynamicTargets(bars, currentPrice) {
  if (currentPrice == null || !Number.isFinite(currentPrice) || currentPrice <= 0) {
    return { tp: null, sl: null };
  }

  const window = (bars || []).slice(-14);
  if (!window.length) {
    return {
      tp: round(currentPrice * 1.1),
      sl: round(currentPrice * 0.95),
    };
  }

  const lowestLow = Math.min(...window.map((b) => b.low));
  const sl = lowestLow * 0.985;
  const risk = currentPrice - sl;

  if (!Number.isFinite(lowestLow) || lowestLow <= 0 || !Number.isFinite(sl) || sl <= 0 || risk <= 0) {
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
        breakdown: {},
        dailyChangePercent: quote.regularMarketChangePercent ?? null,
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

  const score = support.points + emaHold.points + volumeScore.points + rsiTurn.points;

  const sweep = checkLiquiditySweep(price, dailyBars);
  const volumeSpike = checkVolumeSpike(quote, dailyBars);
  const firsat = sweep.hit && volumeSpike.hit;
  const status = firsat ? "FIRSAT" : "BEKLE";
  const action = firsat ? "FIRSAT" : "—";
  const dynamicTargets = firsat ? calculateDynamicTargets(dailyBars, price) : { tp: null, sl: null };

  return {
    symbol,
    price: round(price),
    score,
    status,
    action,
    tp: dynamicTargets.tp,
    sl: dynamicTargets.sl,
    breakdown: {
      support: support.points,
      emaHold: emaHold.points,
      volume: volumeScore.points,
      rsiTurn: rsiTurn.points,
      liquiditySweep: sweep.hit,
      volumeSpike: volumeSpike.hit,
    },
    rsi: rsiTurn.rsi != null ? round(rsiTurn.rsi, 1) : null,
    ema50: emaHold.ema50 ? round(emaHold.ema50) : null,
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
  checkLiquiditySweep,
  checkVolumeSpike,
  isFirsat,
  calculateDynamicTargets,
};
