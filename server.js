"use strict";

require("dotenv").config();

const express = require("express");
const YahooFinance = require("yahoo-finance2").default;
const yahooFinance = new YahooFinance({ suppressNotices: ["yahooSurvey"] });
const { BIST_30, BENCHMARK, DISPLAY_NAMES } = require("./lib/symbols");
const { analyzeSymbol, normalizeBars, scoreMarketRegime } = require("./lib/confluence");
const { TelegramNotifier } = require("./lib/telegram");

const PORT = Number(process.env.PORT || 10000);
const POLL_MS = 60 * 1000;
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

async function fetchQuote(symbol, retries = 3) {
  for (let attempt = 1; attempt <= retries; attempt += 1) {
    try {
      return await yahooFinance.quote(symbol);
    } catch (err) {
      if (attempt === retries) throw err;
      await sleep(1200 * attempt);
    }
  }
  return null;
}

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
        const quote = await fetchQuote(symbol);
        await sleep(FETCH_DELAY_MS);
        const dailyBars = await fetchBars(symbol, "1d");
        await sleep(FETCH_DELAY_MS);
        const weeklyBars = await fetchBars(symbol, "1wk");
        await sleep(FETCH_DELAY_MS);
        const row = analyzeSymbol({
          symbol,
          dailyBars,
          weeklyBars,
          marketRegime,
          quote,
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
:root{--bg:#07111f;--panel:#0d1b2d;--line:#203952;--ink:#e7f0fb;--muted:#93a9c3;--green:#2dd4a3;--amber:#fbbf24;--blue:#4bb3fd;--pct-up:#00C851;--pct-down:#ff4444}
*{box-sizing:border-box}body{margin:0;background:var(--bg);color:var(--ink);font:14px Inter,system-ui,sans-serif;min-height:100vh;display:flex;flex-direction:column}
main{flex:1;max-width:1680px;margin:0 auto;padding:24px;width:100%}
h1{margin:0 0 6px;font-size:26px}.sub{color:var(--muted);margin:0 0 18px}
.meta{display:flex;gap:12px;flex-wrap:wrap;margin-bottom:18px}
.pill{background:var(--panel);border:1px solid var(--line);border-radius:8px;padding:8px 12px;font-size:13px}
.pill strong{display:block;font-size:16px;margin-top:4px}
.search-wrap{margin-bottom:14px}
#searchInput{width:100%;max-width:360px;padding:10px 14px;border:1px solid var(--line);border-radius:8px;background:var(--panel);color:var(--ink);font-size:14px}
#searchInput::placeholder{color:var(--muted)}
.table-wrap{overflow:auto;border:1px solid var(--line);border-radius:10px}
table{width:100%;border-collapse:collapse;min-width:1200px;background:var(--panel)}
th{text-align:left;color:var(--muted);font-size:11px;letter-spacing:.05em;padding:12px;border-bottom:1px solid var(--line)}
td{padding:12px;border-bottom:1px solid #172c42;white-space:nowrap}
tr:last-child td{border:0}
.firsat{color:var(--green);font-weight:800}.bekle{color:var(--amber)}
.score-high{color:var(--green);font-weight:700}
.pct-up{color:var(--pct-up);font-weight:600}.pct-down{color:var(--pct-down);font-weight:600}
.chart-btn{border:1px solid var(--line);background:#14253b;color:var(--ink);padding:6px 10px;border-radius:6px;cursor:pointer;font-size:13px}
.chart-btn:hover{border-color:var(--blue);color:var(--blue)}
.modal{position:fixed;inset:0;background:rgba(0,0,0,.75);display:none;align-items:center;justify-content:center;z-index:1000;padding:20px}
.modal.open{display:flex}
.modal-panel{background:var(--panel);border:1px solid var(--line);border-radius:12px;width:min(1100px,96vw);height:min(720px,88vh);display:flex;flex-direction:column;overflow:hidden}
.modal-header{display:flex;justify-content:space-between;align-items:center;padding:12px 16px;border-bottom:1px solid var(--line)}
.modal-title{font-weight:700;font-size:16px}
.modal-close{background:transparent;border:1px solid var(--line);color:var(--ink);border-radius:6px;padding:6px 12px;cursor:pointer}
.modal-body{flex:1;min-height:0}
#chartContainer{height:100%;width:100%}
footer{margin-top:auto;padding:18px 24px;border-top:1px solid var(--line);background:var(--panel);text-align:center;color:var(--ink)}
@media(max-width:700px){main{padding:14px}h1{font-size:22px}#searchInput{max-width:100%}}
</style></head><body>
<main>
  <h1>BIST Confluence Swing Radar</h1>
  <p class="sub">Yahoo Finance günlük/haftalık veri · 1 dk tarama · Skor ≥75 + R/R ≥1:2 → FIRSAT</p>
  <div class="meta">
    <div class="pill">Son Tarama (15 dk gecikmeli)<strong id="scan">—</strong></div>
    <div class="pill">XU100 rejim<strong id="regime">—</strong></div>
    <div class="pill">FIRSAT<strong id="firsat-count">—</strong></div>
    <div class="pill">Tarama<strong id="status">—</strong></div>
  </div>
  <div class="search-wrap">
    <input id="searchInput" type="search" placeholder="Hisse Ara (Örn: THYAO)..." autocomplete="off" aria-label="Hisse ara">
  </div>
  <div class="table-wrap">
    <table>
      <thead><tr>
        <th>Sembol</th><th>Fiyat</th><th>Günlük %</th><th>Haftalık %</th><th>Aylık %</th><th>Yıllık %</th>
        <th>Skor</th><th>Durum</th><th>Stop</th><th>Hedef</th><th>R/R</th><th>RSI</th><th>Grafik</th>
      </tr></thead>
      <tbody id="rows"><tr><td colspan="13" style="color:var(--muted);padding:24px">Veri yükleniyor…</td></tr></tbody>
    </table>
  </div>
</main>
<div id="chartModal" class="modal" role="dialog" aria-modal="true" aria-labelledby="chartTitle">
  <div class="modal-panel">
    <div class="modal-header">
      <span class="modal-title" id="chartTitle">Grafik</span>
      <button type="button" class="modal-close" id="chartClose" aria-label="Kapat">✕ Kapat</button>
    </div>
    <div class="modal-body"><div id="chartContainer"></div></div>
  </div>
</div>
<footer role="contentinfo">Hüseyin Can Polat tarafından yapılmıştır</footer>
<script>
let allRows=[];
const fmt=n=>n==null?'—':Number(n).toLocaleString('tr-TR',{minimumFractionDigits:2,maximumFractionDigits:2});
const fmtPct=v=>{if(v==null||Number.isNaN(v))return'—';const sign=v>=0?'+':'';return sign+Number(v).toFixed(2)+'%'};
const pctCls=v=>v==null?'':v>=0?'pct-up':'pct-down';
const cls=s=>s==='FIRSAT'?'firsat':'bekle';
const tvSymbol=s=>('BIST:'+(s||'').replace('.IS',''));
function filterRows(rows,query){
  const q=query.trim().toLocaleLowerCase('tr-TR');
  if(!q)return rows;
  return rows.filter(r=>\`\${r.symbol} \${r.name||''}\`.toLocaleLowerCase('tr-TR').includes(q));
}
function renderTable(rows){
  const body=document.getElementById('rows');
  body.innerHTML=rows.length?rows.map(row=>\`
    <tr>
      <td><b>\${row.symbol.replace('.IS','')}</b><br><small style="color:var(--muted)">\${row.name||''}</small></td>
      <td>\${fmt(row.price)}</td>
      <td class="\${pctCls(row.dailyChangePercent)}">\${fmtPct(row.dailyChangePercent)}</td>
      <td class="\${pctCls(row.weeklyChangePercent)}">\${fmtPct(row.weeklyChangePercent)}</td>
      <td class="\${pctCls(row.monthlyChangePercent)}">\${fmtPct(row.monthlyChangePercent)}</td>
      <td class="\${pctCls(row.yearlyChangePercent)}">\${fmtPct(row.yearlyChangePercent)}</td>
      <td class="\${row.score>=75?'score-high':''}">\${row.score}</td>
      <td class="\${cls(row.status)}">\${row.status}</td>
      <td>\${fmt(row.stop)}</td>
      <td>\${fmt(row.target)}</td>
      <td>\${row.rr??'—'}</td>
      <td>\${row.rsi??'—'}</td>
      <td><button type="button" class="chart-btn" data-symbol="\${row.symbol}" title="TradingView grafik">📊 Grafik</button></td>
    </tr>\`).join(''):'<tr><td colspan="13" style="color:var(--muted);padding:24px">Sonuç bulunamadı.</td></tr>';
}
function openChart(symbol){
  const modal=document.getElementById('chartModal');
  const container=document.getElementById('chartContainer');
  const ticker=tvSymbol(symbol);
  document.getElementById('chartTitle').textContent=ticker+' — TradingView';
  container.innerHTML='';
  const wrap=document.createElement('div');
  wrap.className='tradingview-widget-container';
  wrap.style.cssText='height:100%;width:100%';
  const widget=document.createElement('div');
  widget.className='tradingview-widget-container__widget';
  widget.style.cssText='height:100%;width:100%';
  wrap.appendChild(widget);
  const script=document.createElement('script');
  script.type='text/javascript';
  script.src='https://s3.tradingview.com/external-embedding/embed-widget-advanced-chart.js';
  script.async=true;
  script.text=JSON.stringify({
    autosize:true,symbol:ticker,interval:'D',timezone:'Europe/Istanbul',theme:'dark',style:'1',locale:'tr',
    allow_symbol_change:false,support_host:'https://www.tradingview.com',backgroundColor:'#0d1b2d',gridColor:'#203952'
  });
  wrap.appendChild(script);
  container.appendChild(wrap);
  modal.classList.add('open');
}
function closeChart(){
  document.getElementById('chartModal').classList.remove('open');
  document.getElementById('chartContainer').innerHTML='';
}
document.getElementById('chartClose').onclick=closeChart;
document.getElementById('chartModal').onclick=e=>{if(e.target.id==='chartModal')closeChart()};
document.getElementById('rows').onclick=e=>{
  const btn=e.target.closest('.chart-btn');
  if(btn)openChart(btn.dataset.symbol);
};
document.getElementById('searchInput').oninput=e=>{
  renderTable(filterRows(allRows,e.target.value));
};
async function render(){
  const r=await fetch('/api/state');const s=await r.json();
  document.getElementById('scan').textContent=s.lastScanAt?new Date(s.lastScanAt).toLocaleString('tr-TR'):'—';
  document.getElementById('regime').textContent=s.xu100AboveEma50?'EMA50 ÜSTÜ':'EMA50 ALTINDA';
  document.getElementById('firsat-count').textContent=s.firsatCount;
  document.getElementById('status').textContent=s.scanning?'TARANIYOR':'HAZIR';
  allRows=s.rows||[];
  renderTable(filterRows(allRows,document.getElementById('searchInput').value));
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
    pollIntervalMs: POLL_MS,
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
