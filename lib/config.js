"use strict";

/**
 * Strateji ayarları. Hepsi ortam değişkeniyle (.env / Render) değiştirilebilir.
 * Backtest scripti aynı varsayılanları kullanır, böylece canlı bot ile test aynı kurallarla çalışır.
 */

function num(name, fallback) {
  const raw = process.env[name];
  if (raw == null || raw === "") return fallback;
  const n = Number(String(raw).replace(",", "."));
  return Number.isFinite(n) ? n : fallback;
}

function bool(name, fallback) {
  const raw = process.env[name];
  if (raw == null || raw === "") return fallback;
  return /^(1|true|evet|yes|on)$/i.test(String(raw).trim());
}

const DEFAULTS = Object.freeze({
  // FIRSAT (kırılım) ayarları
  rsWindowDays: num("RS_WINDOW_DAYS", 63), // göreceli güç penceresi (~3 ay). Eski değer: 10
  // RSI 50–70 şartı. Backtest'te (E ve C versiyonları) şartsız hali daha iyi ya da aynı çıktı, bu yüzden kapalı.
  requireRsiMomentum: bool("REQUIRE_RSI_MOMENTUM", false),
  minRr: num("MIN_RR", 2),

  // Filtreler (FIRSAT ve DÖNÜŞ)
  maxBeta: num("MAX_BETA", 1.5), // XU100'e göre 120 günlük beta üst sınırı (0 = kapalı)
  minTurnoverTl: num("MIN_TURNOVER_TL", 20_000_000), // 20 günlük ortalama TL işlem hacmi alt sınırı
  maxDailyJumpPct: num("MAX_DAILY_JUMP_PCT", 25), // bunun üstünde günlük hareket = düzeltilmemiş bedelsiz şüphesi

  // DÖNÜŞ (zayıf piyasada dönüş) ayarları
  // Backtest'te teknik kısmı kâr getirmedi (kâr faktörü ~1,0), bu yüzden varsayılan olarak kapalı.
  enableReversal: bool("ENABLE_DONUS", false),
  reversalDropPct: num("REVERSAL_DROP_PCT", 7), // son 10 günde en az %7 düşüş
  reversalRsiMax: num("REVERSAL_RSI_MAX", 35), // ya da RSI bu seviyenin altına inmiş olmalı
  maxPe: num("MAX_PE", 15), // ucuzluk: F/K bu değerin altında
  maxPb: num("MAX_PB", 2), // ya da PD/DD bu değerin altında
  requireFundamentals: bool("REQUIRE_FUNDAMENTALS", true), // F/K ve PD/DD verisi yoksa DÖNÜŞ verme

  // Risk yönetimi (lot hesabı)
  capitalTl: num("CAPITAL_TL", 0), // 0 = lot hesabı gösterilmez
  riskPct: num("RISK_PCT", 1), // işlem başına sermayenin yüzde kaçı riske edilir
  maxOpenSignals: num("MAX_OPEN_SIGNALS", 5), // aynı anda en fazla kaç açık sinyal (0 = sınırsız)

  // Sinyal geçmişi ("zaman makinesi"): her yeni sinyalde aynı kurulumun bu hissedeki geçmişi
  signalHistoryYears: num("SIGNAL_HISTORY_YEARS", 3), // 0 = kapalı

  // Backtest maliyetleri
  commissionPct: num("COMMISSION_PCT", 0.1), // tek yön komisyon (%)
  slippagePct: num("SLIPPAGE_PCT", 0.1), // tek yön kayma (%)
});

function getConfig(overrides = {}) {
  return { ...DEFAULTS, ...overrides };
}

module.exports = { getConfig, DEFAULTS };
