"use strict";

const TIMEZONE = "Europe/Istanbul";
const MARKET_OPEN_MINUTES = 9 * 60 + 55; // 09:55
const MARKET_CLOSE_MINUTES = 18 * 60 + 10; // 18:10

const WEEKDAY_MAP = {
  Sun: 0,
  Mon: 1,
  Tue: 2,
  Wed: 3,
  Thu: 4,
  Fri: 5,
  Sat: 6,
};

function getIstanbulTimeParts(date = new Date()) {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: TIMEZONE,
    weekday: "short",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  }).formatToParts(date);

  const map = Object.fromEntries(
    parts.filter((p) => p.type !== "literal").map((p) => [p.type, p.value]),
  );

  return {
    weekday: WEEKDAY_MAP[map.weekday] ?? 0,
    hour: Number(map.hour),
    minute: Number(map.minute),
  };
}

/** BIST session window: Mon–Fri 09:55–18:10 Europe/Istanbul (inclusive). */
function isMarketOpen(date = new Date()) {
  const { weekday, hour, minute } = getIstanbulTimeParts(date);

  if (weekday === 0 || weekday === 6) return false;

  const minutes = hour * 60 + minute;
  return minutes >= MARKET_OPEN_MINUTES && minutes <= MARKET_CLOSE_MINUTES;
}

const SESSION_START_MINUTES = 10 * 60; // sürekli işlem başlangıcı
const SESSION_END_MINUTES = 18 * 60; // kapanış seansı başlangıcı
const CLOSING_AUCTION_SHARE = 0.15; // günlük hacmin yaklaşık kapanış seansına düşen payı

/**
 * Gün içinde bu saate kadar normalde günlük hacmin ne kadarının işlem görmüş olması beklenir (0–1).
 * Sabah saatlerinde hacim şartının hiç sağlanamamasını önlemek için kullanılır.
 */
function expectedVolumeFraction(date = new Date()) {
  const { weekday, hour, minute } = getIstanbulTimeParts(date);
  if (weekday === 0 || weekday === 6) return 1;
  const minutes = hour * 60 + minute;
  if (minutes >= SESSION_END_MINUTES) return 1;
  if (minutes <= SESSION_START_MINUTES) return 0.05;
  const elapsed = (minutes - SESSION_START_MINUTES) / (SESSION_END_MINUTES - SESSION_START_MINUTES);
  return Math.max(0.05, elapsed * (1 - CLOSING_AUCTION_SHARE));
}

module.exports = {
  expectedVolumeFraction,
  TIMEZONE,
  MARKET_OPEN_MINUTES,
  MARKET_CLOSE_MINUTES,
  getIstanbulTimeParts,
  isMarketOpen,
};
