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
const EMA_SLOPE_LOOKBACK = 5;
const RS_WINDOW_DAYS = 10;
const RESISTANCE_LOOKBACK = 20;
const FIRSAT_NOTIFY_COOLDOWN_MS = 24 * 60 * 60 * 1000;
const MIN_RR = 2;

/** @type {Record<string, {time:number, price:number, notified:boolean}>} */
const firsatCache = {};

function scoreSupportZone(price, dailyBars) {
  const lows = localSwingLows(dailyBars, 60);
  const cluster = clusterSupport(lows, SUPPORT_MARGIN_PCT);
  const fib = fibSupportBand(dailyBars, 90);
  let hit = false;

  if (cluster && withinPct(price, cluster, SUPPORT_MARGIN_PCT)) hit = true;
  if (fib) {
    const inFibBand =
      (price >= fib.fib50 * (1 - SUPPORT_MARGIN_PCT / 100) &&
        price <= fib.fib618 * (1 + SUPPORT_MARGIN_PCT / 100)) ||
      withinPct(price, fib.fib50, SUPPORT_MARGIN_PCT) ||
      withinPct(price, fib.fib618, SUPPORT_MARGIN_PCT);
    if (inFibBand) hit = true;
  }
  return { points: hit ? 25 : 0 };
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

function returnOverWindow(bars, days) {
  if (!bars || bars.length < days + 1) return null;
  const end = bars[bars.length - 1].close;
  const start = bars[bars.length - 1 - days].close;
  if (end == null || start == null || start === 0) return null;
  return ((end / start) - 1) * 100;
}

function emaSlopeUp(closes, period, lookback = EMA_SLOPE_LOOKBACK) {
  if (closes.length < period + lookback + 1) return false;
  const now = ema(closes, period);
  const then = ema(closes.slice(0, -lookback), period);
  return now != null && then != null && now > then;
}

function higherHighHigherLow(bars, lookback = 20) {
  const window = bars.slice(-lookback);
  if (window.length < 10) return false;
  const mid = Math.floor(window.length / 2);
  const first = window.slice(0, mid);
  const second = window.slice(mid);
  const firstLow = Math.min(...first.map((b) => b.low));
  const secondLow = Math.min(...second.map((b) => b.low));
  const firstHigh = Math.max(...first.map((b) => b.high));
  const secondHigh = Math.max(...second.map((b) => b.high));
  return secondLow > firstLow && secondHigh > firstHigh;
}

function recentResistanceHigh(bars, lookback = RESISTANCE_LOOKBACK) {
  const prior = bars.slice(-lookback - 1, -1);
  if (!prior.length) return null;
  return Math.max(...prior.map((b) => b.high));
}

function lastSwingLow(bars, lookback = 30) {
  const window = bars.slice(-lookback);
  if (window.length < 5) return null;
  const lows = localSwingLows(window, lookback);
  if (lows.length) return Math.min(...lows);
  return Math.min(...window.map((b) => b.low));
}

function computeMarketContext(xu100DailyBars) {
  if (!xu100DailyBars?.length) {
    return { xu100AboveEma50: false, xu100Return10d: null };
  }

  const closes = xu100DailyBars.map((b) => b.close);
  const lastClose = closes[closes.length - 1];
  const ema50 = ema(closes, 50);

  return {
    xu100AboveEma50: ema50 != null && lastClose > ema50,
    xu100Return10d: returnOverWindow(xu100DailyBars, RS_WINDOW_DAYS),
  };
}

function checkBreakoutFirsat(close, dailyBars, quote, marketContext) {
  const empty = {
    raw: false,
    riskOk: false,
    rules: {},
    rsi14: null,
    ema20: null,
    ema50: null,
    rr: null,
  };

  if (!marketContext?.xu100AboveEma50 || dailyBars.length < 60) {
    return { ...empty, rules: { marketOk: false } };
  }

  const closes = dailyBars.map((b) => b.close);
  const volumes = dailyBars.map((b) => b.volume || 0);
  const today = dailyBars[dailyBars.length - 1];
  const prev = dailyBars[dailyBars.length - 2];

  const ema20 = ema(closes, 20);
  const ema50 = ema(closes, 50);
  const rsi14 = rsi(closes, 14);
  const rsiPrev = closes.length >= 16 ? rsi(closes.slice(0, -1), 14) : null;
  const volSma20 = sma(volumes, 20);
  const currentVol = quote?.regularMarketVolume ?? volumes[volumes.length - 1] ?? 0;

  const stockRet10 = returnOverWindow(dailyBars, RS_WINDOW_DAYS);
  const benchRet10 = marketContext.xu100Return10d;
  const relativeStrength =
    stockRet10 != null && benchRet10 != null && stockRet10 > benchRet10;

  const trendStructure =
    close > ema20 &&
    close > ema50 &&
    emaSlopeUp(closes, 20) &&
    emaSlopeUp(closes, 50) &&
    higherHighHigherLow(dailyBars);

  const resistance = recentResistanceHigh(dailyBars);
  const atResistance = resistance != null && close >= resistance * 0.998;
  const breaksPriorHigh = prev != null && close >= prev.high;
  const volumeConviction = volSma20 != null && volSma20 > 0 && currentVol > volSma20;
  const rsiMomentum =
    rsi14 != null &&
    rsi14 >= 50 &&
    rsi14 <= 70 &&
    (rsiPrev == null || rsi14 >= rsiPrev || rsi14 >= 50);

  const trigger = (atResistance || breaksPriorHigh) && volumeConviction && rsiMomentum;

  const rules = {
    marketOk: true,
    relativeStrength,
    trendStructure,
    trigger,
    atResistance,
    breaksPriorHigh,
    volumeConviction,
    rsiMomentum,
    stockRet10,
    benchRet10,
  };

  const raw = relativeStrength && trendStructure && trigger;

  return {
    raw,
    riskOk: false,
    rules,
    rsi14,
    ema20,
    ema50,
    rr: null,
  };
}

function evaluateRiskReward(dailyBars, currentPrice) {
  const targets = calculateDynamicTargets(dailyBars, currentPrice);
  const { tp, sl } = targets;

  if (tp == null || sl == null || currentPrice == null) {
    return { ok: false, rr: null, tp, sl };
  }

  const risk = currentPrice - sl;
  const reward = tp - currentPrice;
  if (!Number.isFinite(risk) || !Number.isFinite(reward) || risk <= 0 || reward <= 0) {
    return { ok: false, rr: null, tp, sl };
  }

  const rr = reward / risk;
  return { ok: rr >= MIN_RR, rr, tp, sl };
}

function resolveFirsatStatus(symbol, price, rawFirsat, riskOk) {
  const qualifies = rawFirsat && riskOk;

  if (!qualifies) {
    delete firsatCache[symbol];
    return { status: "BEKLE", firsatNotify: false };
  }

  const entry = firsatCache[symbol];
  const notifiedRecently =
    entry?.notified && Date.now() - entry.time < FIRSAT_NOTIFY_COOLDOWN_MS;

  if (!entry) {
    firsatCache[symbol] = { time: Date.now(), price, notified: false };
  } else {
    entry.time = Date.now();
    entry.price = price;
  }

  return {
    status: "FIRSAT",
    firsatNotify: !notifiedRecently,
  };
}

function markFirsatNotified(symbol) {
  const entry = firsatCache[symbol];
  if (entry) {
    entry.notified = true;
    entry.time = Date.now();
  } else {
    firsatCache[symbol] = { time: Date.now(), price: 0, notified: true };
  }
}

function calculateDynamicTargets(bars, currentPrice) {
  if (currentPrice == null || !Number.isFinite(currentPrice) || currentPrice <= 0) {
    return { tp: null, sl: null };
  }

  const closes = (bars || []).map((b) => b.close);
  const atr = simpleAtr(bars, 14);
  const ema20 = closes.length >= 20 ? ema(closes, 20) : null;
  const swingLow = lastSwingLow(bars || []);

  const atrSl = atr != null && atr > 0 ? currentPrice - 1.5 * atr : null;
  const structuralCandidates = [];
  if (swingLow != null && swingLow > 0) structuralCandidates.push(swingLow * 0.995);
  if (ema20 != null && ema20 > 0) structuralCandidates.push(ema20 * 0.995);
  if (atrSl != null) structuralCandidates.push(atrSl);

  const validSl = structuralCandidates.filter(
    (v) => Number.isFinite(v) && v > 0 && v < currentPrice,
  );
  let sl = validSl.length ? Math.min(...validSl) : null;

  if (sl == null || !Number.isFinite(sl) || sl <= 0 || sl >= currentPrice) {
    if (atrSl != null && atrSl > 0 && atrSl < currentPrice) sl = atrSl;
    else {
      return {
        tp: round(currentPrice * 1.1),
        sl: round(currentPrice * 0.95),
      };
    }
  }

  const risk = currentPrice - sl;
  if (!Number.isFinite(risk) || risk <= 0) {
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
 * @param {object} input.marketContext from computeMarketContext
 */
function analyzeSymbol({ symbol, dailyBars, quote, marketContext }) {
  const ctx = marketContext || { xu100AboveEma50: false, xu100Return10d: null };

  if (!dailyBars.length) {
    if (quote?.regularMarketPrice != null) {
      return {
        symbol,
        price: round(quote.regularMarketPrice),
        score: 0,
        status: "BEKLE",
        action: "—",
        firsatNotify: false,
        breakdown: { marketOk: ctx.xu100AboveEma50 },
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

  const breakout = checkBreakoutFirsat(price, dailyBars, quote, ctx);
  const risk = evaluateRiskReward(dailyBars, price);
  const firsatState = resolveFirsatStatus(symbol, price, breakout.raw, risk.ok);

  let score = support.points + emaHold.points + volumeScore.points + rsiTurn.points;
  if (breakout.raw && !risk.ok) score += 5;

  const isFirsat = firsatState.status === "FIRSAT";
  const targets = isFirsat ? { tp: risk.tp, sl: risk.sl } : { tp: null, sl: null };

  return {
    symbol,
    price: round(price),
    score,
    status: firsatState.status,
    action: isFirsat ? "FIRSAT" : "—",
    firsatNotify: firsatState.firsatNotify,
    tp: targets.tp,
    sl: targets.sl,
    breakdown: {
      support: support.points,
      emaHold: emaHold.points,
      volume: volumeScore.points,
      rsiTurn: rsiTurn.points,
      marketOk: ctx.xu100AboveEma50,
      rules: breakout.rules,
      riskOk: risk.ok,
      rr: risk.rr != null ? round(risk.rr, 2) : null,
    },
    rsi: breakout.rsi14 != null ? round(breakout.rsi14, 1) : (rsiTurn.rsi != null ? round(rsiTurn.rsi, 1) : null),
    ema50: breakout.ema50 != null ? round(breakout.ema50) : (emaHold.ema50 ? round(emaHold.ema50) : null),
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
  computeMarketContext,
  checkBreakoutFirsat,
  firsatCache,
};
