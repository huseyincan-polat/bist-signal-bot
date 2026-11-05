"use strict";

const {
  ema,
  rsiSeries,
  sma,
  withinPct,
  localSwingLows,
  clusterSupport,
  fibSupportBand,
  normalizeBars,
  normalizeDailyChangePercent,
  computePeriodChangePercents,
  beta,
  avgTurnover,
  maxAbsDailyMovePct,
} = require("./indicators");
const { getConfig } = require("./config");

const SUPPORT_MARGIN_PCT = 2;
const EMA_HOLD_PCT = 1.5;
const EMA_SLOPE_LOOKBACK = 5;
const RESISTANCE_LOOKBACK = 20;
const SIGNAL_NOTIFY_COOLDOWN_MS = 24 * 60 * 60 * 1000;
const REVERSAL_DROP_WINDOW = 10;
const BETA_LOOKBACK = 120;

/** @type {Record<string, {status:string, time:number, price:number, notified:boolean}>} */
const signalCache = {};

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

function computeMarketContext(xu100DailyBars, config = getConfig()) {
  if (!xu100DailyBars?.length) {
    return { xu100AboveEma50: false, benchReturn: null, benchBars: [] };
  }

  const closes = xu100DailyBars.map((b) => b.close);
  const lastClose = closes[closes.length - 1];
  const ema50 = ema(closes, 50);

  return {
    xu100AboveEma50: ema50 != null && lastClose > ema50,
    benchReturn: returnOverWindow(xu100DailyBars, config.rsWindowDays),
    benchBars: xu100DailyBars,
  };
}

/**
 * FIRSAT ve DÖNÜŞ için ortak güvenlik filtreleri: likidite, beta ve veri tutarlılığı.
 */
function computeFilters(dailyBars, benchBars, config) {
  const turnover = avgTurnover(dailyBars, 20);
  const stockBeta = beta(dailyBars, benchBars, BETA_LOOKBACK);
  const maxMove = maxAbsDailyMovePct(dailyBars, BETA_LOOKBACK);

  const liquidityOk = !config.minTurnoverTl || (turnover != null && turnover >= config.minTurnoverTl);
  const betaOk = !config.maxBeta || stockBeta == null || stockBeta <= config.maxBeta;
  const dataOk = maxMove <= config.maxDailyJumpPct;

  return {
    turnover,
    beta: stockBeta,
    maxMove,
    liquidityOk,
    betaOk,
    dataOk,
    ok: liquidityOk && betaOk && dataOk,
  };
}

function computeStrengthMetrics(close, dailyBars, quote, marketContext, config, volumeFraction = 1) {
  const closes = dailyBars.map((b) => b.close);
  const volumes = dailyBars.map((b) => b.volume || 0);
  const prev = dailyBars[dailyBars.length - 2];

  const ema20 = ema(closes, 20);
  const ema50 = ema(closes, 50);
  const series = rsiSeries(closes, 14);
  const rsi14 = series.length ? series[series.length - 1] : null;
  const rsiPrev = series.length > 1 ? series[series.length - 2] : null;
  // Bugünkü (yarım kalmış olabilecek) bar hariç önceki 20 günün ortalaması
  const volSma20 = sma(volumes.slice(0, -1), 20);
  const currentVol = quote?.regularMarketVolume ?? volumes[volumes.length - 1] ?? 0;

  const stockReturn = returnOverWindow(dailyBars, config.rsWindowDays);
  const benchReturn = marketContext?.benchReturn ?? null;
  const relativeStrength =
    stockReturn != null && benchReturn != null && stockReturn > benchReturn;

  const lightweightTrend = ema20 != null && close > ema20;

  const trendStructure =
    lightweightTrend &&
    close > ema50 &&
    emaSlopeUp(closes, 20) &&
    emaSlopeUp(closes, 50) &&
    higherHighHigherLow(dailyBars);

  const resistance = recentResistanceHigh(dailyBars);
  const atResistance = resistance != null && close >= resistance * 0.998;
  const breaksPriorHigh = prev != null && close >= prev.high;
  const volumeConviction =
    volSma20 != null && volSma20 > 0 && currentVol > volSma20 * volumeFraction;
  const rsiMomentum = !config.requireRsiMomentum || (rsi14 != null && rsi14 >= 50 && rsi14 <= 70);

  const trigger = (atResistance || breaksPriorHigh) && volumeConviction && rsiMomentum;

  return {
    ema20,
    ema50,
    rsi14,
    rsiPrev,
    stockReturn,
    benchReturn,
    relativeStrength,
    lightweightTrend,
    trendStructure,
    trigger,
    atResistance,
    breaksPriorHigh,
    volumeConviction,
    rsiMomentum,
  };
}

function checkBreakoutFirsat(close, dailyBars, quote, marketContext, options = {}) {
  const config = options.config || getConfig();
  const filters = options.filters || computeFilters(dailyBars, marketContext?.benchBars, config);
  const empty = {
    raw: false,
    rules: {},
    rsi14: null,
    ema20: null,
    ema50: null,
  };

  const marketOk = Boolean(marketContext?.xu100AboveEma50);
  if (!marketOk || dailyBars.length < 60) {
    return { ...empty, rules: { marketOk } };
  }

  const metrics = computeStrengthMetrics(
    close,
    dailyBars,
    quote,
    marketContext,
    config,
    options.volumeFraction ?? 1,
  );

  const rules = {
    marketOk: true,
    relativeStrength: metrics.relativeStrength,
    trendStructure: metrics.trendStructure,
    trigger: metrics.trigger,
    atResistance: metrics.atResistance,
    breaksPriorHigh: metrics.breaksPriorHigh,
    volumeConviction: metrics.volumeConviction,
    rsiMomentum: metrics.rsiMomentum,
    stockReturn: metrics.stockReturn,
    benchReturn: metrics.benchReturn,
    liquidityOk: filters.liquidityOk,
    betaOk: filters.betaOk,
    dataOk: filters.dataOk,
  };

  const raw =
    metrics.relativeStrength && metrics.trendStructure && metrics.trigger && filters.ok;

  return {
    raw,
    rules,
    rsi14: metrics.rsi14,
    ema20: metrics.ema20,
    ema50: metrics.ema50,
  };
}

/**
 * DÖNÜŞ: Piyasa zayıfken (XU100 < EMA50) sert düşmüş ama kârlı ve ucuz bir hissenin yukarı dönmesi.
 * Borsa İstanbul'da kısa vadeli dönüşlerin piyasa durumuna bağlı olduğu ve kârlı/ucuz
 * hisselerde daha güçlü olduğu yönündeki bulgulara dayanır.
 */
function checkReversalDonus(close, dailyBars, quote, marketContext, options = {}) {
  const config = options.config || getConfig();
  const filters = options.filters || computeFilters(dailyBars, marketContext?.benchBars, config);
  const result = { ok: false, rules: {}, reason: null };

  if (marketContext?.xu100AboveEma50 || dailyBars.length < 60) return result;

  const closes = dailyBars.map((b) => b.close);
  const prev = dailyBars[dailyBars.length - 2];
  const series = rsiSeries(closes, 14);
  const rsiNow = series[series.length - 1];
  const rsiPrev = series[series.length - 2];
  const recentRsiMin = Math.min(...series.slice(-5));

  const drop = returnOverWindow(dailyBars, REVERSAL_DROP_WINDOW);
  const oversold =
    (drop != null && drop <= -config.reversalDropPct) || recentRsiMin <= config.reversalRsiMax;

  const turningUp =
    prev != null &&
    (close > prev.high ||
      (rsiNow > rsiPrev && rsiPrev <= config.reversalRsiMax + 5 && close > prev.close));

  const fundamentals = readFundamentals(quote);
  let profitable = true;
  let cheap = true;
  const hasFundamentals =
    fundamentals.pe != null || fundamentals.pb != null || fundamentals.eps != null;
  if (!options.skipFundamentals && (hasFundamentals || config.requireFundamentals)) {
    profitable = fundamentals.eps != null ? fundamentals.eps > 0 : fundamentals.pe != null && fundamentals.pe > 0;
    cheap =
      (fundamentals.pe != null && fundamentals.pe > 0 && fundamentals.pe <= config.maxPe) ||
      (fundamentals.pb != null && fundamentals.pb > 0 && fundamentals.pb <= config.maxPb);
  }

  result.rules = {
    oversold,
    turningUp,
    profitable,
    cheap,
    drop,
    liquidityOk: filters.liquidityOk,
    betaOk: filters.betaOk,
    dataOk: filters.dataOk,
  };
  result.ok = oversold && turningUp && profitable && cheap && filters.ok;
  if (result.ok) {
    const parts = [];
    if (drop != null) parts.push(`10g ${drop.toFixed(1)}%`);
    if (fundamentals.pe != null) parts.push(`F/K ${fundamentals.pe.toFixed(1)}`);
    if (fundamentals.pb != null) parts.push(`PD/DD ${fundamentals.pb.toFixed(2)}`);
    result.reason = parts.join(" · ") || "zayıf piyasada dönüş";
  }
  return result;
}

function readFundamentals(quote) {
  const pick = (v) => (v != null && Number.isFinite(Number(v)) ? Number(v) : null);
  return {
    pe: pick(quote?.trailingPE),
    pb: pick(quote?.priceToBook),
    eps: pick(quote?.epsTrailingTwelveMonths),
  };
}

/**
 * İşlem başına sermayenin `riskPct` yüzdesini riske edecek lot sayısı.
 * @returns {{lots:number, riskTl:number, positionTl:number}|null}
 */
function computePositionSize(price, sl, config = getConfig()) {
  if (!config.capitalTl || !price || !sl || sl >= price) return null;
  const riskBudget = (config.capitalTl * config.riskPct) / 100;
  const perShareRisk = price - sl;
  let lots = Math.floor(riskBudget / perShareRisk);
  lots = Math.min(lots, Math.floor(config.capitalTl / price));
  if (lots <= 0) return null;
  return {
    lots,
    riskTl: round(lots * perShareRisk),
    positionTl: round(lots * price),
  };
}

function evaluateRiskReward(dailyBars, currentPrice, config = getConfig()) {
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
  return { ok: rr >= config.minRr, rr, tp, sl };
}

/**
 * Sinyal durumunu takip eder ve Telegram'a bildirim gidip gitmeyeceğine karar verir.
 * Aynı hisse için aynı sinyal 24 saat içinde tekrar bildirilmez.
 */
function resolveSignal(symbol, status, price) {
  if (!status) {
    delete signalCache[symbol];
    return { notify: false };
  }

  const entry = signalCache[symbol];
  if (!entry || entry.status !== status) {
    signalCache[symbol] = { status, time: Date.now(), price, notified: false };
    return { notify: true };
  }

  const notifiedRecently =
    entry.notified && Date.now() - entry.time < SIGNAL_NOTIFY_COOLDOWN_MS;
  if (!entry.notified) {
    entry.time = Date.now();
    entry.price = price;
  }
  return { notify: !notifiedRecently };
}

function markSignalNotified(symbol) {
  const entry = signalCache[symbol];
  if (entry) {
    entry.notified = true;
    entry.time = Date.now();
  } else {
    signalCache[symbol] = { status: null, time: Date.now(), price: 0, notified: true };
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
 * Saf sinyal değerlendirmesi: canlı bot ve backtest aynı fonksiyonu kullanır.
 * @returns {{status:"FIRSAT"|"DÖNÜŞ"|null, tp:number|null, sl:number|null, reason:string|null,
 *   breakout:object, reversal:object|null, risk:object, filters:object}}
 */
function evaluateSignal(price, dailyBars, quote, marketContext, options = {}) {
  const config = options.config || getConfig();
  const filters = computeFilters(dailyBars, marketContext?.benchBars, config);
  const opts = { ...options, config, filters };

  const breakout = checkBreakoutFirsat(price, dailyBars, quote, marketContext, opts);
  const risk = evaluateRiskReward(dailyBars, price, config);
  let reversal = null;

  let status = null;
  let reason = null;
  if (marketContext?.xu100AboveEma50) {
    if (breakout.raw && risk.ok) status = "FIRSAT";
  } else {
    reversal = checkReversalDonus(price, dailyBars, quote, marketContext, opts);
    if (reversal.ok && risk.ok) {
      status = "DÖNÜŞ";
      reason = reversal.reason;
    }
  }

  if (!status && !filters.dataOk) {
    reason = "veri şüpheli (bedelsiz/bölünme?)";
  }

  return {
    status,
    tp: status ? risk.tp : null,
    sl: status ? risk.sl : null,
    reason,
    breakout,
    reversal,
    risk,
    filters,
  };
}

/**
 * @param {object} input
 * @param {string} input.symbol
 * @param {Array} input.dailyBars normalized OHLCV
 * @param {object} input.quote Yahoo quote shape
 * @param {object} input.marketContext from computeMarketContext
 * @param {number} [input.volumeFraction] gün içinde beklenen hacim oranı (0–1)
 * @param {object} [input.config] strateji ayarları
 */
function analyzeSymbol({ symbol, dailyBars, quote, marketContext, volumeFraction = 1, config }) {
  const ctx = marketContext || { xu100AboveEma50: false, benchReturn: null, benchBars: [] };
  const cfg = config || getConfig();

  if (!dailyBars.length) {
    resolveSignal(symbol, null, null);
    if (quote?.regularMarketPrice != null) {
      return {
        symbol,
        price: round(quote.regularMarketPrice),
        score: 0,
        status: "BEKLE",
        action: "—",
        signalNotify: false,
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
      signalNotify: false,
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

  // Sıralama puanı (sinyali belirlemez; destek/EMA/hacim/RSI dönüşü yakınlığını özetler)
  const support = scoreSupportZone(price, dailyBars);
  const emaHold = scoreEmaHold(price, closes);
  const volumeScore = scoreVolumeAtSupport(dailyBars);
  const rsiTurn = scoreRsiTurnUp(closes);
  const score = support.points + emaHold.points + volumeScore.points + rsiTurn.points;

  const signal = evaluateSignal(price, dailyBars, quote, ctx, { config: cfg, volumeFraction });
  const { notify } = resolveSignal(symbol, signal.status, price);
  const position = signal.status ? computePositionSize(price, signal.sl, cfg) : null;
  const fundamentals = readFundamentals(quote);

  return {
    symbol,
    price: round(price),
    score,
    status: signal.status || "BEKLE",
    action: signal.status || "—",
    statusReason: signal.reason,
    signalNotify: Boolean(signal.status) && notify,
    tp: signal.tp,
    sl: signal.sl,
    lots: position?.lots ?? null,
    riskTl: position?.riskTl ?? null,
    positionTl: position?.positionTl ?? null,
    beta: signal.filters.beta != null ? round(signal.filters.beta, 2) : null,
    turnoverTl: signal.filters.turnover != null ? Math.round(signal.filters.turnover) : null,
    pe: fundamentals.pe != null ? round(fundamentals.pe, 1) : null,
    pb: fundamentals.pb != null ? round(fundamentals.pb, 2) : null,
    breakdown: {
      support: support.points,
      emaHold: emaHold.points,
      volume: volumeScore.points,
      rsiTurn: rsiTurn.points,
      marketOk: ctx.xu100AboveEma50,
      rules: signal.breakout.rules,
      reversal: signal.reversal?.rules ?? null,
      filters: {
        liquidityOk: signal.filters.liquidityOk,
        betaOk: signal.filters.betaOk,
        dataOk: signal.filters.dataOk,
      },
      riskOk: signal.risk.ok,
      rr: signal.risk.rr != null ? round(signal.risk.rr, 2) : null,
    },
    rsi: signal.breakout.rsi14 != null
      ? round(signal.breakout.rsi14, 1)
      : (rsiTurn.rsi != null ? round(rsiTurn.rsi, 1) : null),
    ema50: signal.breakout.ema50 != null
      ? round(signal.breakout.ema50)
      : (emaHold.ema50 ? round(emaHold.ema50) : null),
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
  evaluateSignal,
  normalizeBars,
  calculateDynamicTargets,
  computePositionSize,
  computeFilters,
  markSignalNotified,
  computeMarketContext,
  checkBreakoutFirsat,
  checkReversalDonus,
  signalCache,
};
