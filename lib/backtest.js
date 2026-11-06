"use strict";

const { evaluateSignal, computeMarketContext } = require("./confluence");
const { getConfig } = require("./config");

/**
 * Backtest motoru. Canlı botla aynı evaluateSignal fonksiyonunu günlük kapanışlarda çalıştırır.
 *
 * Varsayımlar (bilerek temkinli):
 * - Sinyal günün kapanışında oluşur, işleme ERTESİ GÜNÜN AÇILIŞINDA girilir.
 * - Açılış stopun altındaysa açılıştan çıkılır (gap riski).
 * - Aynı gün hem stop hem hedef görülürse önce STOP olduğu varsayılır.
 * - En fazla `maxHoldBars` işlem günü tutulur, sonra kapanıştan çıkılır.
 * - Her işlemde giriş ve çıkışta komisyon + kayma düşülür.
 * - Hisse başına aynı anda tek pozisyon.
 * - Geçmiş F/K ve PD/DD verisi olmadığı için DÖNÜŞ'ün temel analiz şartı backtest'te uygulanmaz.
 */

const LIVE_HISTORY_BARS = 280; // canlı bot ~400 takvim günü çeker ≈ 280 işlem günü
const BENCH_HISTORY_BARS = 280;

function dayKey(date) {
  return (date instanceof Date ? date : new Date(date)).toISOString().slice(0, 10);
}

/**
 * Her işlem günü için piyasa bağlamını önceden hesaplar (XU100 > EMA50, göreceli getiri).
 * @returns {Map<string, object>}
 */
function buildMarketContexts(benchBars, config) {
  const out = new Map();
  for (let i = 0; i < benchBars.length; i += 1) {
    const window = benchBars.slice(Math.max(0, i + 1 - BENCH_HISTORY_BARS), i + 1);
    out.set(dayKey(benchBars[i].date), computeMarketContext(window, config));
  }
  return out;
}

/**
 * @param {Array} bars hissenin günlük barları (eskiden yeniye)
 * @param {Map<string, object>} contexts buildMarketContexts çıktısı
 * @param {object} options
 * @returns {Array} işlemler
 */
function simulateSymbol(symbol, bars, contexts, options = {}) {
  const config = options.config || getConfig();
  const maxHoldBars = options.maxHoldBars ?? 30;
  const startIndex = options.startIndex ?? 220;
  const fromDate = options.fromDate ? Date.parse(options.fromDate) : null;
  const allowReversal = options.allowReversal !== false;
  const costPct = (config.commissionPct + config.slippagePct) / 100;
  // Takip eden stop: en yüksek seviyenin trailAtr × ATR altı. null = sabit hedef
  const trailAtr = options.trailAtr ?? null;

  const trades = [];
  let i = startIndex;

  while (i < bars.length - 1) {
    const bar = bars[i];
    if (fromDate != null && bar.date.getTime() < fromDate) {
      i += 1;
      continue;
    }

    const ctx = contexts.get(dayKey(bar.date));
    if (!ctx) {
      i += 1;
      continue;
    }

    const window = bars.slice(Math.max(0, i + 1 - LIVE_HISTORY_BARS), i + 1);
    const signal = evaluateSignal(bar.close, window, null, ctx, {
      config,
      skipFundamentals: true,
      volumeFraction: 1,
    });

    const tradable = signal.status === "FIRSAT" || (signal.status === "DÖNÜŞ" && allowReversal);
    if (!tradable) {
      i += 1;
      continue;
    }

    const entryBar = bars[i + 1];
    const entryPrice = entryBar.open * (1 + costPct);
    const sl = signal.sl;
    const tp = trailAtr ? Infinity : signal.tp;

    // Ertesi gün açılış zaten stopun altındaysa ya da hedefin üstündeyse işleme girme
    if (entryBar.open <= sl || entryBar.open >= tp) {
      i += 1;
      continue;
    }

    let exitPrice = null;
    let exitIndex = null;
    let outcome = null;
    let stop = sl;
    let highest = entryBar.open;

    for (let j = i + 1; j < bars.length && j <= i + maxHoldBars; j += 1) {
      const b = bars[j];
      if (trailAtr && j > i + 1) {
        // Dünkü bara kadar olan bilgiyle stopu yukarı çek (asla aşağı indirme)
        highest = Math.max(highest, bars[j - 1].high);
        const atr = averageTrueRange(bars, j - 1, 14);
        if (atr != null) stop = Math.max(stop, highest - trailAtr * atr);
      }
      if (j > i + 1 && b.open <= stop) {
        exitPrice = b.open;
        outcome = stop > sl ? "trail" : "sl";
      } else if (b.low <= stop) {
        exitPrice = stop;
        outcome = stop > sl ? "trail" : "sl";
      } else if (b.high >= tp) {
        exitPrice = j > i + 1 && b.open >= tp ? b.open : tp;
        outcome = "tp";
      }
      if (outcome) {
        exitIndex = j;
        break;
      }
    }

    if (!outcome) {
      exitIndex = Math.min(i + maxHoldBars, bars.length - 1);
      exitPrice = bars[exitIndex].close;
      outcome = exitIndex === bars.length - 1 && exitIndex < i + maxHoldBars ? "open" : "time";
    }

    const netExit = exitPrice * (1 - costPct);
    trades.push({
      symbol,
      type: signal.status,
      marketUp: Boolean(ctx.xu100AboveEma50),
      signalDate: dayKey(bar.date),
      entryDate: dayKey(entryBar.date),
      exitDate: dayKey(bars[exitIndex].date),
      entry: entryPrice,
      exit: netExit,
      tp,
      sl,
      outcome,
      holdBars: exitIndex - i,
      returnPct: ((netExit / entryPrice) - 1) * 100,
    });

    i = exitIndex + 1;
  }

  return trades;
}

/** index'teki bar dahil son `period` barın ortalama gerçek aralığı. */
function averageTrueRange(bars, index, period = 14) {
  if (index < period) return null;
  let sum = 0;
  for (let k = index - period + 1; k <= index; k += 1) {
    const prevClose = bars[k - 1].close;
    sum += Math.max(bars[k].high - bars[k].low, Math.abs(bars[k].high - prevClose), Math.abs(bars[k].low - prevClose));
  }
  return sum / period;
}

function summarizeTrades(trades) {
  const closed = trades.filter((t) => t.outcome !== "open");
  if (!closed.length) {
    return {
      trades: 0,
      winRate: null,
      avgReturn: null,
      medianReturn: null,
      profitFactor: null,
      totalReturn: 0,
      maxDrawdown: 0,
      avgHold: null,
      tp: 0,
      sl: 0,
      trail: 0,
      time: 0,
    };
  }

  const returns = closed.map((t) => t.returnPct);
  const wins = returns.filter((r) => r > 0);
  const losses = returns.filter((r) => r <= 0);
  const grossWin = wins.reduce((a, b) => a + b, 0);
  const grossLoss = Math.abs(losses.reduce((a, b) => a + b, 0));
  const sorted = [...returns].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  const median = sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;

  // Eşit ağırlıklı işlemlerin çıkış tarihine göre kümülatif toplamı üzerinden en büyük düşüş
  const byExit = [...closed].sort((a, b) => a.exitDate.localeCompare(b.exitDate));
  let equity = 0;
  let peak = 0;
  let maxDrawdown = 0;
  for (const t of byExit) {
    equity += t.returnPct;
    peak = Math.max(peak, equity);
    maxDrawdown = Math.min(maxDrawdown, equity - peak);
  }

  return {
    trades: closed.length,
    winRate: (wins.length / closed.length) * 100,
    avgReturn: returns.reduce((a, b) => a + b, 0) / closed.length,
    medianReturn: median,
    profitFactor: grossLoss > 0 ? grossWin / grossLoss : null,
    totalReturn: returns.reduce((a, b) => a + b, 0),
    maxDrawdown,
    avgHold: closed.reduce((a, t) => a + t.holdBars, 0) / closed.length,
    tp: closed.filter((t) => t.outcome === "tp").length,
    sl: closed.filter((t) => t.outcome === "sl").length,
    trail: closed.filter((t) => t.outcome === "trail").length,
    time: closed.filter((t) => t.outcome === "time").length,
  };
}

/** Karşılaştırılan strateji versiyonları. */
const VARIANTS = {
  A: {
    label: "Eski kurallar (10g güç, RSI 50–70, filtre yok)",
    allowReversal: false,
    config: { rsWindowDays: 10, requireRsiMomentum: true, maxBeta: 0, minTurnoverTl: 0, maxDailyJumpPct: 1000 },
  },
  B: {
    label: "63g güç, RSI şartı yok, filtre yok",
    allowReversal: false,
    config: { rsWindowDays: 63, requireRsiMomentum: false, maxBeta: 0, minTurnoverTl: 0, maxDailyJumpPct: 1000 },
  },
  C: {
    label: "63g güç, RSI şartı, beta+likidite+veri filtresi",
    allowReversal: false,
    config: { requireRsiMomentum: true },
  },
  D: {
    label: "C + DÖNÜŞ modu (F/K filtresi hariç)",
    allowReversal: true,
    config: { enableReversal: true },
  },
  E: {
    label: "C, RSI şartı yok, sabit hedef 2,5R, 30 gün (63g, beta+likidite+veri filtresi)",
    allowReversal: false,
    config: { requireRsiMomentum: false },
  },

  // Satış kuralı denemeleri (giriş kuralları E ile aynı)
  E15: {
    label: "E, hedef 1,5R",
    allowReversal: false,
    config: { requireRsiMomentum: false, tpR: 1.5 },
  },
  E2: {
    label: "E, hedef 2R",
    allowReversal: false,
    config: { requireRsiMomentum: false, tpR: 2 },
  },
  E60: {
    label: "E, hedef 2,5R, en fazla 60 gün",
    allowReversal: false,
    config: { requireRsiMomentum: false },
    maxHoldBars: 60,
  },
  ETR: {
    label: "Varsayılan: E, hedef yok, takip eden stop (en yüksek − 3×ATR), en fazla 60 gün",
    allowReversal: false,
    config: { requireRsiMomentum: false },
    trailAtr: 3,
    maxHoldBars: 60,
  },

  // Zayıf piyasada güçlü hisseler
  F: {
    label: "E, piyasa filtresi yok (zayıf piyasada da FIRSAT)",
    allowReversal: false,
    config: { requireRsiMomentum: false, requireMarketUptrend: false },
    splitByMarket: true,
  },
  FTR: {
    label: "F + takip eden stop (piyasa filtresi yok, en yüksek − 3×ATR, en fazla 60 gün)",
    allowReversal: false,
    config: { requireRsiMomentum: false, requireMarketUptrend: false },
    trailAtr: 3,
    maxHoldBars: 60,
    splitByMarket: true,
  },
};

module.exports = {
  VARIANTS,
  buildMarketContexts,
  simulateSymbol,
  summarizeTrades,
  dayKey,
};
