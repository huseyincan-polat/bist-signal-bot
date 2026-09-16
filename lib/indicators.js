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

function rsi(closes, period = 14) {
  if (closes.length < period + 1) return null;
  let gains = 0;
  let losses = 0;
  for (let i = closes.length - period; i < closes.length; i += 1) {
    const diff = closes[i] - closes[i - 1];
    if (diff >= 0) gains += diff;
    else losses -= diff;
  }
  const avgGain = gains / period;
  const avgLoss = losses / period;
  if (avgLoss === 0) return avgGain > 0 ? 100 : 50;
  const rs = avgGain / avgLoss;
  return 100 - 100 / (1 + rs);
}

function rsiSeries(closes, period = 14) {
  const out = [];
  for (let end = period + 1; end <= closes.length; end += 1) {
    out.push(rsi(closes.slice(0, end), period));
  }
  return out;
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

/** Normalize Yahoo/scrape daily % — handles rare fraction form (0.0124 → 1.24). */
function normalizeDailyChangePercent(value) {
  if (value == null || !Number.isFinite(Number(value))) return null;

  let n = Number(value);
  if (n !== 0 && Math.abs(n) < 1 && Math.abs(n * 100) <= 15) {
    n *= 100;
  }

  return Math.round(n * 100) / 100;
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
