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

function closeAtOffset(closes, offset) {
  const index = closes.length - 1 - offset;
  if (index < 0 || index >= closes.length) return null;
  return closes[index];
}

/** Daily / ~7d / ~30d / ~365d percent change vs prior closes. */
function computeChangePercents(dailyBars) {
  if (!dailyBars.length) {
    return {
      dailyChangePercent: null,
      weeklyChangePercent: null,
      monthlyChangePercent: null,
      yearlyChangePercent: null,
    };
  }
  const closes = dailyBars.map((b) => b.close);
  const last = closes[closes.length - 1];
  return {
    dailyChangePercent: pctChange(last, closeAtOffset(closes, 1)),
    weeklyChangePercent: pctChange(last, closeAtOffset(closes, 7)),
    monthlyChangePercent: pctChange(last, closeAtOffset(closes, 30)),
    yearlyChangePercent: pctChange(last, closeAtOffset(closes, 365)),
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
  computeChangePercents,
};
