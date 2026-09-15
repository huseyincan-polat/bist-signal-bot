"use strict";

require("dotenv").config();

const express = require("express");
const YahooFinance = require("yahoo-finance2").default;
const yahooFinance = new YahooFinance({ suppressNotices: ["yahooSurvey"] });
const { BIST_30, BENCHMARK, DISPLAY_NAMES } = require("./lib/symbols");
const { analyzeSymbol, normalizeBars, scoreMarketRegime } = require("./lib/confluence");
const { TelegramNotifier } = require("./lib/telegram");
const {
  isAltins1,
  fetchAltins1Quote,
  toYahooQuoteShape,
} = require("./lib/altins1-scraper");
const targetsStore = require("./lib/targets");
const { enrichRow, collectTriggerEvents } = require("./lib/alerts");

const PORT = Number(process.env.PORT || 10000);
const POLL_MS = 60 * 1000;
const HISTORY_DAYS = 400;
const FETCH_DELAY_MS = 350;

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

targetsStore.init();

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
  alarmRegistered: false,
  telegramTestSent: false,
};

async function fetchQuote(symbol, retries = 3) {
  for (let attempt = 1; attempt <= retries; attempt += 1) {
    try {
      const quote = await yahooFinance.quote(symbol);
      if (quote?.regularMarketPrice != null || quote?.regularMarketChangePercent != null) {
        return quote;
      }
      return null;
    } catch (err) {
      if (attempt === retries) return null;
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
        let quote = null;
        let dailyBars = [];
        let weeklyBars = [];

        if (isAltins1(symbol)) {
          const scraped = await fetchAltins1Quote();
          quote = toYahooQuoteShape(scraped);
        } else {
          quote = await fetchQuote(symbol);
          await sleep(FETCH_DELAY_MS);
          try {
            dailyBars = await fetchBars(symbol, "1d");
          } catch (err) {
            if (!quote) throw err;
          }
          await sleep(FETCH_DELAY_MS);
          try {
            weeklyBars = await fetchBars(symbol, "1wk");
          } catch {
            weeklyBars = [];
          }
          await sleep(FETCH_DELAY_MS);
        }

        const row = analyzeSymbol({
          symbol,
          dailyBars,
          weeklyBars,
          marketRegime,
          quote,
        });
        row.name = DISPLAY_NAMES[symbol] || symbol;
        if (quote?.sourceUrl) row.dataSource = quote.sourceUrl;
        rows.push(row);
      } catch (err) {
        rows.push({
          symbol,
          name: DISPLAY_NAMES[symbol] || symbol,
          price: null,
          score: 0,
          status: "BEKLE",
          dailyChangePercent: null,
          weeklyChangePercent: null,
          monthlyChangePercent: null,
          yearlyChangePercent: null,
          error: err.message,
        });
      }
    }

    rows.sort((a, b) => b.score - a.score);

    const targets = targetsStore.load();
    const enriched = rows.map((row) => enrichRow(row, targets));
    state.rows = enriched;
    state.lastScanAt = new Date().toISOString();

    const triggerEvents = collectTriggerEvents(enriched);
    for (const event of triggerEvents) {
      await notifier.send(event.message);
    }

    try {
      const tg = await notifier.processRows(enriched);
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
<title>BIST SMC Alerts</title>
<style>
:root{--bg:#0a0a0a;--panel:#111;--line:#222;--ink:#d8d8d8;--muted:#666;--green:#00C851;--red:#ff4444;--gray:#888;--pct-up:#00C851;--pct-down:#ff4444}
*{box-sizing:border-box}
body{margin:0;background:var(--bg);color:var(--ink);font:13px ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;min-height:100vh;display:flex;flex-direction:column}
main{flex:1;max-width:1680px;margin:0 auto;padding:20px;width:100%}
.brand{font-size:12px;letter-spacing:.22em;text-transform:uppercase;color:#9ef01a;margin-bottom:18px}
.brand span{color:#fff;font-weight:700}
.system-line{color:var(--muted);margin:0 0 18px;font-size:12px}
.meta{display:flex;gap:10px;flex-wrap:wrap;margin-bottom:16px}
.pill{background:var(--panel);border:1px solid var(--line);padding:8px 10px;font-size:11px}
.pill strong{display:block;font-size:13px;margin-top:4px;color:#fff}
.search-wrap{margin-bottom:12px}
#searchInput{width:100%;max-width:360px;padding:9px 12px;border:1px solid var(--line);background:var(--panel);color:var(--ink);font:inherit}
#searchInput::placeholder{color:var(--muted)}
.table-wrap{overflow:auto;border:1px solid var(--line)}
table{width:100%;border-collapse:collapse;min-width:1180px;background:var(--panel)}
th{text-align:left;color:var(--muted);font-size:10px;letter-spacing:.12em;text-transform:uppercase;padding:10px;border-bottom:1px solid var(--line)}
td{padding:10px;border-bottom:1px solid #1a1a1a;white-space:nowrap}
tr:last-child td{border:0}
.score-high{color:var(--green);font-weight:700}
.pct-up{color:var(--pct-up)}.pct-down{color:var(--pct-down)}
.action-watch{color:var(--gray)}.action-tp{color:var(--green);font-weight:700}
.action-sl{color:var(--red);font-weight:700}.action-none{color:var(--muted)}
.firsat{color:var(--green)}.bekle{color:var(--gray)}
.chart-btn{border:1px solid var(--line);background:#0a0a0a;color:var(--ink);padding:5px 8px;cursor:pointer;font:inherit}
.chart-btn:hover{border-color:#9ef01a;color:#9ef01a}
.modal{position:fixed;inset:0;background:rgba(0,0,0,.82);display:none;align-items:center;justify-content:center;z-index:1000;padding:20px}
.modal.open{display:flex}
.modal-panel{background:#111;border:1px solid var(--line);width:min(1100px,96vw);height:min(720px,88vh);display:flex;flex-direction:column}
.modal-header{display:flex;justify-content:space-between;align-items:center;padding:10px 12px;border-bottom:1px solid var(--line)}
.modal-close{background:#0a0a0a;border:1px solid var(--line);color:var(--ink);padding:5px 10px;cursor:pointer;font:inherit}
.modal-body{flex:1;min-height:0}
#chartContainer{height:100%;width:100%}
footer{margin-top:auto;padding:14px 20px;border-top:1px solid var(--line);text-align:center;color:var(--muted);font-size:11px}
@media(max-width:700px){main{padding:12px}#searchInput{max-width:100%}}
</style></head><body>
<main>
  <div class="brand">Powered By <span>Can Polat</span></div>
  <p class="system-line">[ System: BIST 1m Loop | Custom SMC Alerts ]</p>
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
        <th>Skor</th><th>Sinyal</th><th>Action</th><th>TP</th><th>SL</th><th>RSI</th><th>Grafik</th>
      </tr></thead>
      <tbody id="rows"><tr><td colspan="13" style="color:var(--muted);padding:24px">Veri yükleniyor…</td></tr></tbody>
    </table>
  </div>
</main>
<div id="chartModal" class="modal" role="dialog" aria-modal="true" aria-labelledby="chartTitle">
  <div class="modal-panel">
    <div class="modal-header">
      <span id="chartTitle">Grafik</span>
      <button type="button" class="modal-close" id="chartClose" aria-label="Kapat">✕ Kapat</button>
    </div>
    <div class="modal-body"><div id="chartContainer"></div></div>
  </div>
</div>
<footer role="contentinfo">Hüseyin Can Polat tarafından yapılmıştır</footer>
<script>
let allRows=[];
const fmt=n=>n==null||n==='-'?'—':Number(n).toLocaleString('tr-TR',{minimumFractionDigits:2,maximumFractionDigits:2});
const fmtPct=v=>{if(v==null||Number.isNaN(v))return'—';const sign=v>=0?'+':'';return sign+Number(v).toFixed(2)+'%'};
const pctCls=v=>v==null?'':v>=0?'pct-up':'pct-down';
const tvSymbol=s=>('BIST:'+(s||'').replace('.IS',''));
const actionCls=a=>a==='Take Profit'?'action-tp':a==='Stop Loss'?'action-sl':a==='Watch'?'action-watch':'action-none';
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
      <td class="\${row.score>=75?'score-high':''}">\${row.score??'—'}</td>
      <td class="\${row.status==='FIRSAT'?'firsat':'bekle'}">\${row.status||'—'}</td>
      <td class="\${actionCls(row.action)}">\${row.action||'No Alert'}</td>
      <td>\${row.tp??'-'}</td>
      <td>\${row.sl??'-'}</td>
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
    allow_symbol_change:false,support_host:'https://www.tradingview.com',backgroundColor:'#0a0a0a',gridColor:'#222222'
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
    alarmRegistered: state.alarmRegistered,
    targets: targetsStore.load(),
  });
});

async function boot() {
  console.log("BIST Confluence Swing Radar başlatılıyor…");

  app.listen(PORT, "0.0.0.0", () => {
    console.log(`Sunucu http://0.0.0.0:${PORT} adresinde dinliyor`);
  });

  if (notifier.enabled) {
    notifier.registerAlarmHandler({
      setAlert: targetsStore.setAlert,
      normalizeSymbol: targetsStore.normalizeSymbol,
    });
    state.alarmRegistered = true;
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
