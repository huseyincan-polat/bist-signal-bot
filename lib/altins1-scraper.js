"use strict";

const axios = require("axios");
const cheerio = require("cheerio");

const SOURCE_URL =
  "https://www.isyatirim.com.tr/tr-tr/Analiz/hisse/Sayfalar/default.aspx";

function isAltins1(symbol) {
  return symbol === "ALTINS1.IS" || symbol === "ALTINS1";
}

function parseTrNumber(value) {
  if (value == null) return null;
  const cleaned = String(value)
    .replace(/\u200b/g, "")
    .replace(/\s+/g, "")
    .replace(/\./g, "")
    .replace(",", ".");
  const num = Number(cleaned);
  return Number.isFinite(num) ? num : null;
}

/**
 * Fetch ALTINS1 last price and daily % from İş Yatırım public daily prices table.
 * @returns {Promise<{symbol:string,price:number,dailyChangePercent:number,sourceUrl:string}>}
 */
async function fetchAltins1Quote() {
  const response = await axios.get(SOURCE_URL, {
    timeout: 20000,
    headers: {
      "User-Agent":
        "Mozilla/5.0 (compatible; BIST-Confluence-Radar/2.0; +https://bist-signal-bot-sfuv.onrender.com)",
      Accept: "text/html,application/xhtml+xml",
    },
  });

  const $ = cheerio.load(response.data);
  let price = null;
  let dailyChangePercent = null;

  $("tr").each((_i, row) => {
    const link = $(row).find('a[href*="hisse=ALTINS1"]');
    if (!link.length) return;

    const cells = $(row)
      .find("td")
      .map((_j, cell) => $(cell).text().replace(/\u200b/g, "").trim())
      .get();

    if (cells.length >= 3) {
      price = parseTrNumber(cells[1]);
      dailyChangePercent = parseTrNumber(cells[2]);
    }
  });

  if (price == null || dailyChangePercent == null) {
    throw new Error("ALTINS1 satırı İş Yatırım tablosunda bulunamadı");
  }

  return {
    symbol: "ALTINS1.IS",
    price,
    dailyChangePercent,
    sourceUrl: SOURCE_URL,
  };
}

/** Map scraped quote into yahoo-finance2 quote shape. */
function toYahooQuoteShape(scraped) {
  return {
    symbol: scraped.symbol,
    regularMarketPrice: scraped.price,
    regularMarketChangePercent: scraped.dailyChangePercent,
    sourceUrl: scraped.sourceUrl,
    source: "isyatirim-scrape",
  };
}

module.exports = {
  SOURCE_URL,
  isAltins1,
  fetchAltins1Quote,
  toYahooQuoteShape,
  parseTrNumber,
};
