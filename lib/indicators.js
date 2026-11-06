"use strict";

function emaSeries(values, period) {
  if (!values.length || values.length < period) return [];
  const k = 2 / (period + 1);
  const out = [];
  let prev = values.slice(0, period).reduce((a, b) => a + b, 0) / period;
  out.push(prev);
  for (let i = period; i < values.length; i += 1) {
    prev = values[i] * k + prev * (1 - k);
    out.push(prev);
  }
  return out;
}

function ema(values, period) {
  const series = emaSeries(values, period);
  return series.length ? series[series.length - 1] : null;
}

/**
 * Wilder RSI serisi (TradingView / Matriks ile aynı yöntem).
 * İlk değer `period` değişimin basit ortalamasıyla, sonrakiler Wilder yumuşatmasıyla hesaplanır.
 * Dönen dizinin ilk elemanı closes[period] kapanışına aittir.
 */
function rsiSeries(closes, period = 14) {
  if (!closes || closes.length < period + 1) return [];
  let gain = 0;
  let loss = 0;
  for (let i = 1; i <= period; i += 1) {
    const diff = closes[i] - closes[i - 1];
    if (diff >= 0) gain += diff;
    else loss -= diff;
  }
  let avgGain = gain / period;
  let avgLoss = loss / period;
  const out = [rsiFromAverages(avgGain, avgLoss)];

  for (let i = period + 1; i < closes.length; i += 1) {
    const diff = closes[i] - closes[i - 1];
    avgGain = (avgGain * (period - 1) + Math.max(diff, 0)) / period;
    avgLoss = (avgLoss * (period - 1) + Math.max(-diff, 0)) / period;
    out.push(rsiFromAverages(avgGain, avgLoss));
  }
  return out;
}

function rsiFromAverages(avgGain, avgLoss) {
  if (avgLoss === 0) return avgGain > 0 ? 100 : 50;
  return 100 - 100 / (1 + avgGain / avgLoss);
}

function rsi(closes, period = 14) {
  const series = rsiSeries(closes, period);
  return series.length ? series[series.length - 1] : null;
}

function dailyReturns(closes) {
  const out = [];
  for (let i = 1; i < closes.length; i += 1) {
    const prev = closes[i - 1];
    out.push(prev ? closes[i] / prev - 1 : 0);
  }
  return out;
}

/**
 * Hissenin endekse göre betası. Tarihleri eşleştirerek son `lookback` ortak günü kullanır.
 * @returns {number|null}
 */
function beta(stockBars, benchBars, lookback = 120) {
  if (!stockBars?.length || !benchBars?.length) return null;
  const benchByDay = new Map(benchBars.map((b) => [dayKey(b.date), b.close]));
  const pairs = [];
  for (const bar of stockBars) {
    const bench = benchByDay.get(dayKey(bar.date));
    if (bench != null && bar.close != null) pairs.push([bar.close, bench]);
  }
  const window = pairs.slice(-(lookback + 1));
  if (window.length < 30) return null;

  const rs = dailyReturns(window.map((p) => p[0]));
  const rb = dailyReturns(window.map((p) => p[1]));
  const meanS = rs.reduce((a, b) => a + b, 0) / rs.length;
  const meanB = rb.reduce((a, b) => a + b, 0) / rb.length;
  let cov = 0;
  let varB = 0;
  for (let i = 0; i < rs.length; i += 1) {
    cov += (rs[i] - meanS) * (rb[i] - meanB);
    varB += (rb[i] - meanB) ** 2;
  }
  if (varB === 0) return null;
  return cov / varB;
}

function dayKey(date) {
  const d = date instanceof Date ? date : new Date(date);
  return d.toISOString().slice(0, 10);
}

/** Son `period` günün ortalama TL işlem hacmi (kapanış × lot). */
function avgTurnover(bars, period = 20) {
  const window = (bars || []).slice(-period);
  if (window.length < Math.min(period, 5)) return null;
  const total = window.reduce((sum, b) => sum + (b.close || 0) * (b.volume || 0), 0);
  return total / window.length;
}

/** Son `lookback` gündeki en büyük mutlak günlük kapanış değişimi (%). */
function maxAbsDailyMovePct(bars, lookback = 120) {
  const window = (bars || []).slice(-(lookback + 1));
  let max = 0;
  for (let i = 1; i < window.length; i += 1) {
    const prev = window[i - 1].close;
    if (!prev) continue;
    max = Math.max(max, Math.abs(window[i].close / prev - 1) * 100);
  }
  return max;
}

function sma(values, period) {
  if (values.length < period) return null;
  const slice = values.slice(-period);
  return slice.reduce((a, b) => a + b, 0) / period;
}

function withinPct(price, level, pct) {
  if (!level || level <= 0) return false;
  return Math.abs(price - level) / level <= pct / 100;
}

function localSwingLows(bars, lookback = 60) {
  const window = bars.slice(-lookback);
  const lows = [];
  for (let i = 1; i < window.length - 1; i += 1) {
    if (window[i].low < window[i - 1].low && window[i].low < window[i + 1].low) {
      lows.push(window[i].low);
    }
  }
  return lows;
}

function clusterSupport(lows, tolerancePct = 2) {
  if (!lows.length) return null;
  const sorted = [...lows].sort((a, b) => a - b);
  let bestCluster = [sorted[0]];
  let cluster = [sorted[0]];
  for (let i = 1; i < sorted.length; i += 1) {
    const ref = cluster[0];
    if (Math.abs(sorted[i] - ref) / ref <= tolerancePct / 100) {
      cluster.push(sorted[i]);
    } else {
      if (cluster.length > bestCluster.length) bestCluster = cluster;
      cluster = [sorted[i]];
    }
  }
  if (cluster.length > bestCluster.length) bestCluster = cluster;
  return bestCluster.reduce((a, b) => a + b, 0) / bestCluster.length;
}

function fibSupportBand(bars, lookback = 90) {
  const window = bars.slice(-lookback);
  if (window.length < 10) return null;
  const high = Math.max(...window.map((b) => b.high));
  const low = Math.min(...window.map((b) => b.low));
  if (high <= low) return null;
  const range = high - low;
  return {
    fib50: low + range * 0.5,
    fib618: low + range * 0.618,
    swingHigh: high,
    swingLow: low,
  };
}

function priorSwingHigh(bars, lookback = 120) {
  const window = bars.slice(-lookback);
  if (window.length < 5) return null;
  let best = window[0].high;
  for (let i = 1; i < window.length - 3; i += 1) {
    const h = window[i].high;
    if (h > window[i - 1].high && h > window[i + 1].high && h > best) {
      best = h;
    }
  }
  return best;
}

function pctChange(current, reference) {
  if (current == null || reference == null || reference === 0) return null;
  return Math.round(((current / reference) - 1) * 10000) / 100;
}

/**
 * Günlük yüzde değişimi iki ondalığa yuvarlar. Yahoo (regularMarketChangePercent) ve ALTINS1
 * kazıyıcısı değeri zaten yüzde olarak verir (−0,0977 = %−0,0977). Eskiden |değer| < 1 olan
 * sayılar kesir sanılıp 100 ile çarpılıyordu; bu, %0,1'lik bir hareketi %10 gösteriyordu.
 */
function normalizeDailyChangePercent(value) {
  if (value == null || !Number.isFinite(Number(value))) return null;
  return Math.round(Number(value) * 100) / 100;
}

function toIstanbulYmd(date) {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: "Europe/Istanbul",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(date);
}

function getIstanbulDateParts(date) {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: "Europe/Istanbul",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    weekday: "short",
  }).formatToParts(date);
  const map = Object.fromEntries(
    parts.filter((p) => p.type !== "literal").map((p) => [p.type, p.value]),
  );
  const weekdays = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 };
  return {
    year: Number(map.year),
    month: Number(map.month),
    day: Number(map.day),
    weekday: weekdays[map.weekday] ?? 0,
  };
}

function ymdString(year, month, day) {
  return `${year}-${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
}

/** Monday of the current Istanbul week (holiday Mondays fall through to first session bar). */
function getWeekMondayYmd(date) {
  const { year, month, day, weekday } = getIstanbulDateParts(date);
  const daysSinceMonday = weekday === 0 ? 6 : weekday - 1;
  const anchor = new Date(Date.UTC(year, month - 1, day));
  anchor.setUTCDate(anchor.getUTCDate() - daysSinceMonday);
  return ymdString(anchor.getUTCFullYear(), anchor.getUTCMonth() + 1, anchor.getUTCDate());
}

function firstPeriodOpen(dailyBars, matches) {
  for (const bar of dailyBars) {
    if (matches(toIstanbulYmd(bar.date))) {
      return bar.open;
    }
  }
  return null;
}

/**
 * Daily % from Yahoo quote; WTD/MTD/YTD vs first trading session open in period.
 */
function computePeriodChangePercents(dailyBars, currentPrice, dailyChangePercent) {
  if (!dailyBars.length || currentPrice == null) {
    return {
      dailyChangePercent: normalizeDailyChangePercent(dailyChangePercent),
      weeklyChangePercent: null,
      monthlyChangePercent: null,
      yearlyChangePercent: null,
    };
  }

  const anchor = dailyBars[dailyBars.length - 1].date;
  const { year, month } = getIstanbulDateParts(anchor);
  const monthPrefix = `${year}-${String(month).padStart(2, "0")}`;
  const yearPrefix = `${year}`;
  const weekMondayYmd = getWeekMondayYmd(anchor);

  const weekOpen = firstPeriodOpen(dailyBars, (ymd) => ymd >= weekMondayYmd);
  const monthOpen = firstPeriodOpen(dailyBars, (ymd) => ymd.startsWith(monthPrefix));
  const yearOpen = firstPeriodOpen(dailyBars, (ymd) => ymd.startsWith(yearPrefix));

  return {
    dailyChangePercent: normalizeDailyChangePercent(dailyChangePercent),
    weeklyChangePercent: pctChange(currentPrice, weekOpen),
    monthlyChangePercent: pctChange(currentPrice, monthOpen),
    yearlyChangePercent: pctChange(currentPrice, yearOpen),
  };
}

function normalizeBars(quotes) {
  return (quotes || [])
    .filter((q) => q.close != null && q.high != null && q.low != null)
    .map((q) => ({
      date: q.date instanceof Date ? q.date : new Date(q.date),
      open: q.open,
      high: q.high,
      low: q.low,
      close: q.close,
      volume: q.volume || 0,
    }))
    .sort((a, b) => a.date - b.date);
}

module.exports = {
  ema,
  emaSeries,
  rsi,
  rsiSeries,
  beta,
  avgTurnover,
  maxAbsDailyMovePct,
  sma,
  withinPct,
  localSwingLows,
  clusterSupport,
  fibSupportBand,
  priorSwingHigh,
  normalizeBars,
  normalizeDailyChangePercent,
  computePeriodChangePercents,
};
