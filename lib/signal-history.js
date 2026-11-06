"use strict";

const { buildMarketContexts, simulateSymbol, summarizeTrades } = require("./backtest");

/**
 * "Zaman makinesi": yeni bir sinyal geldiğinde, aynı kuralların bu hissede geçmişte
 * kaç kez sinyal verdiğini ve sonuçlarını hesaplar. Backtest ile aynı varsayımları kullanır
 * (ertesi gün açılıştan giriş, önce stop, en fazla 30 gün, komisyon + kayma dahil).
 *
 * @param {Array} bars hissenin uzun dönem günlük barları
 * @param {Array} benchBars XU100'ün aynı dönemdeki günlük barları
 * @param {object} config strateji ayarları
 * @param {"FIRSAT"|"DÖNÜŞ"} type geçmişi istenen sinyal türü
 * @returns {{trades:number, tp:number, sl:number, time:number, winRate:number|null, avgReturn:number|null}}
 */
function computeSignalHistory(symbol, bars, benchBars, config, type) {
  const contexts = buildMarketContexts(benchBars, config);
  const trades = simulateSymbol(symbol, bars, contexts, {
    config,
    allowReversal: type === "DÖNÜŞ",
    trailAtr: config.trailAtr > 0 ? config.trailAtr : null,
    maxHoldBars: config.trailAtr > 0 ? config.maxHoldDays : 30,
  }).filter((t) => t.type === type);

  const s = summarizeTrades(trades);
  return {
    trades: s.trades,
    tp: s.tp,
    sl: s.sl,
    trail: s.trail,
    time: s.time,
    winRate: s.winRate != null ? Math.round(s.winRate * 10) / 10 : null,
    avgReturn: s.avgReturn != null ? Math.round(s.avgReturn * 100) / 100 : null,
  };
}

function formatSignalHistory(history, years) {
  if (!history) return null;
  if (!history.trades) {
    return `📜 Geçmiş (${years} yıl): bu hissede bu kurulum daha önce çıkmadı`;
  }
  const avg = history.avgReturn > 0 ? `+${history.avgReturn}` : `${history.avgReturn}`;
  return [
    `📜 Geçmiş (${years} yıl): ${history.trades} sinyal → ${history.trail ? `📈 ${history.trail} takip eden stop` : `🎯 ${history.tp} hedef`} · 🛑 ${history.sl} stop · ⌛ ${history.time} süre doldu`,
    `   Kazanma %${history.winRate} · ortalama ${avg}% (komisyon dahil)`,
  ].join("\n");
}

module.exports = { computeSignalHistory, formatSignalHistory };
