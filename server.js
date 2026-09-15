"use strict";

require("dotenv").config();

const express = require("express");
const YahooFinance = require("yahoo-finance2").default;
const yahooFinance = new YahooFinance();
const { BIST_30, BENCHMARK, DISPLAY_NAMES } = require("./lib/symbols");
const { analyzeSymbol, normalizeBars, scoreMarketRegime } = require("./lib/confluence");
const { TelegramNotifier } = require("./lib/telegram");

const PORT = Number(process.env.PORT || 10000);
const POLL_MS = 15 * 60 * 1000;
const HISTORY_DAYS = 400;
const FETCH_DELAY_MS = 350;

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

const app = express();
const notifier = new TelegramNotifier(
  process.env.TELEGRAM_BOT_TOKEN,
  process.env.TELEGRAM_CHAT_ID,
);

const state = {
  rows: [],
  lastScanAt: null,
  lastError: null,
  scanning: false,
  xu100Regime: null,
  telegramEnabled: notifier.enabled,
  telegramTestSent: false,
};

async function fetchBars(symbol, interval, retries = 3) {
  const period1 = new Date(Date.now() - HISTORY_DAYS * 24 * 60 * 60 * 1000);
  for (let attempt = 1; attempt <= retries; attempt += 1) {
    try {
      const result = await yahooFinance.chart(symbol, { period1, interval });
      return normalizeBars(result.quotes);
    } catch (err) {
      if (attempt === retries) throw err;
      await sleep(1200 * attempt);
    }
  }
  return [];
}

async function scanMarket() {
  if (state.scanning) return;
  state.scanning = true;
  state.lastError = null;

  try {
    const xuDaily = await fetchBars(BENCHMARK, "1d");
    await sleep(FETCH_DELAY_MS);
    const marketRegime = scoreMarketRegime(xuDaily);
    state.xu100Regime = marketRegime;

    const rows = [];
    for (const symbol of BIST_30) {
      try {
        const dailyBars = await fetchBars(symbol, "1d");
        await sleep(FETCH_DELAY_MS);
        const weeklyBars = await fetchBars(symbol, "1wk");
        await sleep(FETCH_DELAY_MS);
        const row = analyzeSymbol({
          symbol,
          dailyBars,
          weeklyBars,
          marketRegime,
        });
        row.name = DISPLAY_NAMES[symbol] || symbol;
        rows.push(row);
      } catch (err) {
        rows.push({
          symbol,
          name: DISPLAY_NAMES[symbol] || symbol,
          price: null,
          score: 0,
          status: "BEKLE",
          stop: null,
          target: null,
          rr: 0,
          error: err.message,
        });
      }
    }

    rows.sort((a, b) => b.score - a.score);
    state.rows = rows;
    state.lastScanAt = new Date().toISOString();

    try {
      const tg = await notifier.processRows(rows);
      if (tg.sent > 0) {
        console.log(`Telegram: ${tg.sent} mesaj gönderildi (${tg.events.join(", ")})`);
      }
    } catch (err) {
      console.error("Telegram işleme hatası:", err.message);
    }
  } catch (err) {
    state.lastError = err.message;
    console.error("Tarama hatası:", err.message);
  } finally {
    state.scanning = false;
  }
}

function dashboardHtml() {
  return `<!DOCTYPE html>
<html lang="tr"><head>
<meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>BIST Confluence Swing Radar</title>
<style>
:root{--bg:#07111f;--panel:#0d1b2d;--line:#203952;--ink:#e7f0fb;--muted:#93a9c3;--green:#2dd4a3;--amber:#fbbf24;--blue:#4bb3fd}
*{box-sizing:border-box}body{margin:0;background:var(--bg);color:var(--ink);font:14px Inter,system-ui,sans-serif;min-height:100vh;display:flex;flex-direction:column}
main{flex:1;max-width:1400px;margin:0 auto;padding:24px;width:100%}
h1{margin:0 0 6px;font-size:26px}.sub{color:var(--muted);margin:0 0 18px}
.meta{display:flex;gap:12px;flex-wrap:wrap;margin-bottom:18px}
.pill{background:var(--panel);border:1px solid var(--line);border-radius:8px;padding:8px 12px;font-size:13px}
.pill strong{display:block;font-size:16px;margin-top:4px}
.table-wrap{overflow:auto;border:1px solid var(--line);border-radius:10px}
table{width:100%;border-collapse:collapse;min-width:900px;background:var(--panel)}
th{text-align:left;color:var(--muted);font-size:11px;letter-spacing:.05em;padding:12px;border-bottom:1px solid var(--line)}
td{padding:12px;border-bottom:1px solid #172c42;white-space:nowrap}
tr:last-child td{border:0}
.firsat{color:var(--green);font-weight:800}.bekle{color:var(--amber)}
.score-high{color:var(--green);font-weight:700}
footer{margin-top:auto;padding:18px 24px;border-top:1px solid var(--line);background:var(--panel);text-align:center;color:var(--ink)}
@media(max-width:700px){main{padding:14px}h1{font-size:22px}}
</style></head><body>
<main>
  <h1>BIST Confluence Swing Radar</h1>
  <p class="sub">Yahoo Finance günlük/haftalık veri · 15 dk tarama · Skor ≥75 + R/R ≥1:2 → FIRSAT</p>
  <div class="meta">
    <div class="pill">Son tarama<strong id="scan">—</strong></div>
    <div class="pill">XU100 rejim<strong id="regime">—</strong></div>
    <div class="pill">FIRSAT<strong id="firsat-count">—</strong></div>
    <div class="pill">Tarama<strong id="status">—</strong></div>
  </div>
  <div class="table-wrap">
    <table>
      <thead><tr>
        <th>Sembol</th><th>Fiyat</th><th>Skor</th><th>Durum</th><th>Stop</th><th>Hedef</th><th>R/R</th><th>RSI</th>
      </tr></thead>
      <tbody id="rows"><tr><td colspan="8" style="color:var(--muted);padding:24px">Veri yükleniyor…</td></tr></tbody>
    </table>
  </div>
</main>
<footer role="contentinfo">Hüseyin Can Polat tarafından yapılmıştır</footer>
<script>
const fmt=n=>n==null?'—':Number(n).toLocaleString('tr-TR',{minimumFractionDigits:2,maximumFractionDigits:2});
const cls=s=>s==='FIRSAT'?'firsat':'bekle';
async function render(){
  const r=await fetch('/api/state');const s=await r.json();
  document.getElementById('scan').textContent=s.lastScanAt?new Date(s.lastScanAt).toLocaleString('tr-TR'):'—';
  document.getElementById('regime').textContent=s.xu100AboveEma50?'EMA50 ÜSTÜ':'EMA50 ALTINDA';
  document.getElementById('firsat-count').textContent=s.firsatCount;
  document.getElementById('status').textContent=s.scanning?'TARANIYOR':'HAZIR';
  const rows=s.rows||[];
  document.getElementById('rows').innerHTML=rows.length?rows.map(row=>\`
    <tr>
      <td><b>\${row.symbol.replace('.IS','')}</b><br><small style="color:var(--muted)">\${row.name||''}</small></td>
      <td>\${fmt(row.price)}</td>
      <td class="\${row.score>=75?'score-high':''}">\${row.score}</td>
      <td class="\${cls(row.status)}">\${row.status}</td>
      <td>\${fmt(row.stop)}</td>
      <td>\${fmt(row.target)}</td>
      <td>\${row.rr??'—'}</td>
      <td>\${row.rsi??'—'}</td>
    </tr>\`).join(''):'<tr><td colspan="8" style="color:var(--muted);padding:24px">Henüz veri yok.</td></tr>';
}
render();setInterval(render,30000);
</script></body></html>`;
}

app.get("/health", (_req, res) => {
  res.status(200).send("ok");
});

app.head("/health", (_req, res) => {
  res.status(200).end();
});

app.head("/", (_req, res) => {
  res.status(200).end();
});

app.get("/", (_req, res) => {
  res.type("html").send(dashboardHtml());
});

app.get("/api/state", (_req, res) => {
  res.json({
    rows: state.rows,
    lastScanAt: state.lastScanAt,
    lastError: state.lastError,
    scanning: state.scanning,
    firsatCount: state.rows.filter((r) => r.status === "FIRSAT").length,
    xu100AboveEma50: state.xu100Regime?.xu100AboveEma50 ?? null,
    telegramEnabled: state.telegramEnabled,
  });
});

async function boot() {
  console.log("BIST Confluence Swing Radar başlatılıyor…");

  app.listen(PORT, "0.0.0.0", () => {
    console.log(`Sunucu http://0.0.0.0:${PORT} adresinde dinliyor`);
  });

  if (notifier.enabled) {
    try {
      state.telegramTestSent = await notifier.sendTest();
      console.log("Telegram test:", state.telegramTestSent ? "gönderildi" : "başarısız");
    } catch (err) {
      console.error("Telegram test hatası:", err.message);
    }
  } else {
    console.log("Telegram devre dışı (TOKEN/CHAT_ID eksik)");
  }

  await scanMarket();
  setInterval(scanMarket, POLL_MS);
}

boot().catch((err) => {
  console.error(err);
  process.exit(1);
});
