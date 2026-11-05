"use strict";

require("dotenv").config();

const express = require("express");
const YahooFinance = require("yahoo-finance2").default;
const yahooFinance = new YahooFinance({ suppressNotices: ["yahooSurvey"] });
const { BIST_100, BENCHMARK, DISPLAY_NAMES } = require("./lib/symbols");
const { analyzeSymbol, normalizeBars, computeMarketContext } = require("./lib/confluence");
const { TelegramNotifier } = require("./lib/telegram");
const {
  isAltins1,
  fetchAltins1Quote,
  toYahooQuoteShape,
} = require("./lib/altins1-scraper");
const targetsStore = require("./lib/targets");
const { enrichRow, collectTriggerEvents } = require("./lib/alerts");
const {
  isMarketOpen,
  expectedVolumeFraction,
  getIstanbulTimeParts,
  TIMEZONE,
} = require("./lib/market-hours");
const journal = require("./lib/journal");
const { getConfig } = require("./lib/config");
const { computeSignalHistory } = require("./lib/signal-history");
const { normalizeDailyChangePercent } = require("./lib/indicators");

const PORT = Number(process.env.PORT || 10000);
const POLL_MS = 60 * 1000;
const HISTORY_DAYS = 400;
const FETCH_DELAY_MS = 350;
const REQUEST_TIMEOUT_MS = 10 * 1000;
const HEALTH_ALERT_COOLDOWN_MS = 60 * 60 * 1000;
const HEALTH_ERROR_RATIO = 0.5;

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function withTimeout(promise, ms, label = "request") {
  return Promise.race([
    promise,
    new Promise((_, reject) => {
      setTimeout(() => reject(new Error(`${label} timeout`)), ms);
    }),
  ]);
}

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
  scannedCount: 0,
  universeCount: BIST_100.length,
  marketOpen: isMarketOpen(),
  xu100AboveEma50: null,
  telegramEnabled: notifier.enabled,
  alarmRegistered: false,
  telegramTestSent: false,
};

let scanLoopTimer = null;
let lastHealthAlertAt = 0;
/** XU100'ün uzun dönem verisi günde bir kez çekilir. */
const benchHistoryCache = { day: null, years: null, bars: null };
const MAX_HISTORY_LOOKUPS_PER_SCAN = 10;

async function fetchQuote(symbol) {
  try {
    const quote = await withTimeout(yahooFinance.quote(symbol), REQUEST_TIMEOUT_MS, `quote:${symbol}`);
    if (quote?.regularMarketPrice != null || quote?.regularMarketChangePercent != null) {
      return quote;
    }
    return null;
  } catch {
    return null;
  }
}

async function fetchBars(symbol, interval) {
  const period1 = new Date(Date.now() - HISTORY_DAYS * 24 * 60 * 60 * 1000);
  const result = await withTimeout(
    yahooFinance.chart(symbol, { period1, interval }),
    REQUEST_TIMEOUT_MS,
    `chart:${symbol}`,
  );
  return normalizeBars(result.quotes);
}

async function scanSymbol(symbol, marketContext, volumeFraction) {
  let quote = null;
  let dailyBars = [];

  if (isAltins1(symbol)) {
    const scraped = await withTimeout(fetchAltins1Quote(), REQUEST_TIMEOUT_MS, "altins1-scrape");
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
  }

  const row = analyzeSymbol({ symbol, dailyBars, quote, marketContext, volumeFraction });
  row.name = DISPLAY_NAMES[symbol] || symbol;
  if (quote?.sourceUrl) row.dataSource = quote.sourceUrl;
  if (row.dailyChangePercent == null && quote?.regularMarketChangePercent != null) {
    row.dailyChangePercent = normalizeDailyChangePercent(quote.regularMarketChangePercent);
  }
  return row;
}

async function scanMarket() {
  if (state.scanning) return;
  state.scanning = true;
  state.lastError = null;
  state.scannedCount = 0;

  try {
    const rows = [];
    let marketContext = { xu100AboveEma50: false, benchReturn: null, benchBars: [] };
    let benchmarkFailed = false;
    const volumeFraction = expectedVolumeFraction();

    try {
      const xuDaily = await fetchBars(BENCHMARK, "1d");
      marketContext = computeMarketContext(xuDaily);
      state.xu100AboveEma50 = marketContext.xu100AboveEma50;
      await sleep(FETCH_DELAY_MS);
    } catch (err) {
      console.error("XU100 rejim verisi alınamadı:", err.message);
      state.xu100AboveEma50 = false;
      benchmarkFailed = true;
    }

    for (const symbol of BIST_100) {
      try {
        const row = await scanSymbol(symbol, marketContext, volumeFraction);
        rows.push(row);
      } catch (err) {
        rows.push({
          symbol,
          name: DISPLAY_NAMES[symbol] || symbol,
          price: null,
          score: 0,
          status: "BEKLE",
          action: "—",
          dailyChangePercent: null,
          weeklyChangePercent: null,
          monthlyChangePercent: null,
          yearlyChangePercent: null,
          error: err.message,
        });
      }
      state.scannedCount += 1;
    }

    const statusRank = (status) => {
      if (status === "FIRSAT") return 0;
      if (status === "DÖNÜŞ") return 1;
      return 2;
    };

    rows.sort((a, b) => {
      const rankDiff = statusRank(a.status) - statusRank(b.status);
      if (rankDiff !== 0) return rankDiff;
      return b.score - a.score;
    });

    const targets = targetsStore.load();
    const enriched = rows.map((row) => enrichRow(row, targets));
    state.rows = enriched;
    state.lastScanAt = new Date().toISOString();
    state.universeCount = BIST_100.length;

    const triggerEvents = collectTriggerEvents(enriched);
    for (const event of triggerEvents) {
      await notifier.send(event.message);
    }

    try {
      const closedSignals = journal.updateOpenSignals(enriched);
      for (const signal of closedSignals) {
        await notifier.send(notifier.formatClosedSignal(signal));
      }
      journal.applyOpenSignalLimit(enriched, getConfig().maxOpenSignals);
      journal.recordSignals(enriched.filter((r) => !r.limitReached));
    } catch (err) {
      console.error("Sinyal günlüğü hatası:", err.message);
    }

    try {
      await attachSignalHistory(enriched);
    } catch (err) {
      console.error("Sinyal geçmişi hatası:", err.message);
    }

    const failed = enriched.filter((r) => r.price == null).length;
    await maybeSendHealthAlert(benchmarkFailed, failed, enriched.length);

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
    await maybeSendHealthAlert(true, 0, 0, err.message);
  } finally {
    state.scanning = false;
  }
}

async function fetchLongBars(symbol, years) {
  const days = years * 365 + 420; // göstergeler için ek geçmiş
  const period1 = new Date(Date.now() - days * 24 * 60 * 60 * 1000);
  const result = await withTimeout(
    yahooFinance.chart(symbol, { period1, interval: "1d" }),
    REQUEST_TIMEOUT_MS * 2,
    `history:${symbol}`,
  );
  return normalizeBars(result.quotes);
}

/** Bildirilecek her yeni sinyale, aynı kurulumun bu hissedeki geçmiş sonuçlarını ekler. */
async function attachSignalHistory(rows) {
  const config = getConfig();
  const years = config.signalHistoryYears;
  if (!years) return;

  const targets = rows
    .filter((r) => r.signalNotify && (r.status === "FIRSAT" || r.status === "DÖNÜŞ"))
    .slice(0, MAX_HISTORY_LOOKUPS_PER_SCAN);
  if (!targets.length) return;

  const today = istanbulYmd();
  if (benchHistoryCache.day !== today || benchHistoryCache.years !== years) {
    benchHistoryCache.bars = await fetchLongBars(BENCHMARK, years);
    benchHistoryCache.day = today;
    benchHistoryCache.years = years;
    await sleep(FETCH_DELAY_MS);
  }

  for (const row of targets) {
    try {
      const bars = await fetchLongBars(row.symbol, years);
      row.history = computeSignalHistory(row.symbol, bars, benchHistoryCache.bars, config, row.status);
      row.historyYears = years;
    } catch (err) {
      console.error(`${row.symbol} geçmişi alınamadı:`, err.message);
    }
    await sleep(FETCH_DELAY_MS);
  }
}

/** Veri kaynağı bozulursa bot sessizce durmasın: saatte en fazla bir uyarı. */
async function maybeSendHealthAlert(benchmarkFailed, failedCount, totalCount, errorMessage) {
  const tooManyFailures = totalCount > 0 && failedCount / totalCount >= HEALTH_ERROR_RATIO;
  if (!benchmarkFailed && !tooManyFailures && !errorMessage) return;
  if (Date.now() - lastHealthAlertAt < HEALTH_ALERT_COOLDOWN_MS) return;
  lastHealthAlertAt = Date.now();

  const lines = ["⚠️ BIST ALERTS veri uyarısı"];
  if (benchmarkFailed) lines.push("XU100 verisi alınamadı, piyasa durumu bilinmiyor.");
  if (tooManyFailures) lines.push(`${failedCount}/${totalCount} hissede fiyat alınamadı.`);
  if (errorMessage) lines.push(`Hata: ${errorMessage}`);
  lines.push("Sinyaller bu taramada güvenilir değil.");
  await notifier.send(lines.join("\n"));
}

function istanbulYmd(date = new Date()) {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: TIMEZONE,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(date);
}

function buildWeeklyReport() {
  const since = Date.now() - 7 * 24 * 60 * 60 * 1000;
  return journal.formatReport("Haftalık sinyal raporu (son 7 gün)", journal.summarize(since));
}

function buildFullReport() {
  return [
    buildWeeklyReport(),
    "",
    journal.formatReport("Tüm zamanlar", journal.summarize(0)),
  ].join("\n");
}

/** Cuma 18:00'den sonra haftada bir kez rapor gönderir. */
async function maybeSendWeeklyReport() {
  const { weekday, hour } = getIstanbulTimeParts();
  if (weekday !== 5 || hour < 18) return;
  const key = istanbulYmd();
  if (journal.getLastWeeklyReport() === key) return;
  const ok = await notifier.send(buildWeeklyReport());
  if (ok) journal.setLastWeeklyReport(key);
}

function scheduleNextLoop() {
  if (scanLoopTimer) clearTimeout(scanLoopTimer);
  scanLoopTimer = setTimeout(() => {
    scanLoop().catch((err) => console.error("Tarama döngüsü hatası:", err.message));
  }, POLL_MS);
}

async function scanLoop() {
  state.marketOpen = isMarketOpen();

  if (!state.marketOpen) {
    console.log("Piyasa kapalı, veri çekilmiyor");
    scheduleNextLoop();
    return;
  }

  await scanMarket();
  try {
    await maybeSendWeeklyReport();
  } catch (err) {
    console.error("Haftalık rapor hatası:", err.message);
  }
  scheduleNextLoop();
}

function dashboardHtml() {
  return `<!DOCTYPE html>
<html lang="tr"><head>
<meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>BIST ALERTS</title>
<style>
:root{--bg:#0a0a0a;--panel:#111;--line:#222;--ink:#d8d8d8;--muted:#666;--green:#00C851;--red:#ff4444;--gray:#888;--pct-up:#00C851;--pct-down:#ff4444}
*{box-sizing:border-box}
body{margin:0;background:var(--bg);color:var(--ink);font:13px ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;min-height:100vh;display:flex;flex-direction:column}
main{flex:1;max-width:1680px;margin:0 auto;padding:20px;width:100%}
h1{font-size:18px;letter-spacing:.18em;text-transform:uppercase;color:#fff;margin:0 0 6px}
.brand{font-size:12px;letter-spacing:.22em;text-transform:uppercase;color:#9ef01a;margin-bottom:18px}
.brand span{color:#fff;font-weight:700}
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
.action-firsat{color:#39ff14;font-weight:700;text-shadow:0 0 8px rgba(57,255,20,.45)}
.action-donus{color:#4fc3f7;font-weight:700}
.action-none{color:var(--muted)}
.firsat{color:var(--green)}.donus{color:#4fc3f7}.bekle{color:var(--gray)}
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
  <h1>BIST ALERTS</h1>
  <div class="brand">Powered By <span>Can Polat</span></div>
  <div class="meta">
    <div class="pill">Son Tarama (15 dk gecikmeli)<strong id="scan">—</strong></div>
    <div class="pill">TARANAN HİSSE<strong id="scanned-count">—</strong></div>
    <div class="pill">FIRSAT<strong id="firsat-count">—</strong></div>
    <div class="pill">DÖNÜŞ<strong id="donus-count">—</strong></div>
    <div class="pill">Tarama<strong id="status">—</strong></div>
  </div>
  <div class="search-wrap">
    <input id="searchInput" type="search" placeholder="Hisse Ara (Örn: THYAO)..." autocomplete="off" aria-label="Hisse ara">
  </div>
  <div class="table-wrap">
    <table>
      <thead><tr>
        <th>Sembol</th><th>Fiyat</th><th>Günlük %</th><th>Haftalık %</th><th>Aylık %</th><th>Yıllık %</th>
        <th>Skor</th><th>Sinyal</th><th>Action</th><th>TP</th><th>SL</th><th>Lot</th><th>RSI</th><th>Beta</th><th>F/K</th><th>Grafik</th>
      </tr></thead>
      <tbody id="rows"><tr><td colspan="16" style="color:var(--muted);padding:24px">Veri yükleniyor…</td></tr></tbody>
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
let renderTimer=null;
const fmt=n=>n==null||n==='-'?'—':Number(n).toLocaleString('tr-TR',{minimumFractionDigits:2,maximumFractionDigits:2});
const fmtPct=v=>{
  if(v==null||!Number.isFinite(Number(v)))return'—';
  const n=Number(v);
  const body=Math.abs(n).toLocaleString('tr-TR',{minimumFractionDigits:2,maximumFractionDigits:2});
  if(n>0)return '+'+body+'%';
  if(n<0)return '-'+body+'%';
  return body+'%';
};
const pctCls=v=>v==null||!Number.isFinite(Number(v))?'':Number(v)>=0?'pct-up':'pct-down';
const tvSymbol=s=>('BIST:'+(s||'').replace('.IS',''));
const actionCls=a=>a==='FIRSAT'?'action-firsat':a==='DÖNÜŞ'?'action-donus':'action-none';
const signalCls=s=>s==='FIRSAT'?'firsat':s==='DÖNÜŞ'?'donus':'bekle';
const esc=v=>String(v??'').replace(/[&<>"]/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;'}[c]));
const actionLabel=row=>{
  if(row.statusReason){
    return esc(row.action||'—')+'<br><small style="color:var(--muted)">'+esc(row.statusReason)+'</small>';
  }
  return esc(row.action||'—');
};
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
      <td class="\${signalCls(row.status)}">\${row.status||'—'}</td>
      <td class="\${actionCls(row.action)}">\${actionLabel(row)}</td>
      <td>\${row.tp??'-'}</td>
      <td>\${row.sl??'-'}</td>
      <td>\${row.lots??'—'}</td>
      <td>\${row.rsi??'—'}</td>
      <td>\${row.beta??'—'}</td>
      <td>\${row.pe??'—'}</td>
      <td><button type="button" class="chart-btn" data-symbol="\${row.symbol}" title="TradingView grafik">📊 Grafik</button></td>
    </tr>\`).join(''):'<tr><td colspan="16" style="color:var(--muted);padding:24px">Sonuç bulunamadı.</td></tr>';
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
function scheduleRender(delay){
  if(renderTimer)clearTimeout(renderTimer);
  renderTimer=setTimeout(render,delay);
}
async function render(){
  let delay=30000;
  try{
    const r=await fetch('/api/state');
    if(!r.ok)throw new Error('fetch failed');
    const s=await r.json();
    document.getElementById('scan').textContent=s.lastScanAt?new Date(s.lastScanAt).toLocaleString('tr-TR'):'—';
    document.getElementById('scanned-count').textContent=s.scannedCount??s.universeCount??'—';
    document.getElementById('firsat-count').textContent=s.firsatCount;
    document.getElementById('donus-count').textContent=s.donusCount??'—';
    const statusEl=document.getElementById('status');
    if(s.marketOpen===false){
      statusEl.textContent='PİYASA KAPALI - UYKUDA';
    }else{
      statusEl.textContent=s.scanning?'TARANIYOR':'HAZIR';
    }
    allRows=s.rows||[];
    renderTable(filterRows(allRows,document.getElementById('searchInput').value));
  }catch{
    document.getElementById('status').textContent='BAĞLANTI BEKLENİYOR...';
    delay=10000;
  }
  scheduleRender(delay);
}
render();
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
  const marketOpen = isMarketOpen();
  state.marketOpen = marketOpen;

  res.json({
    rows: state.rows,
    lastScanAt: state.lastScanAt,
    lastError: state.lastError,
    scanning: state.scanning,
    marketOpen,
    scannedCount: state.scannedCount || state.rows.length,
    universeCount: state.universeCount,
    pollIntervalMs: POLL_MS,
    firsatCount: state.rows.filter((r) => r.status === "FIRSAT").length,
    donusCount: state.rows.filter((r) => r.status === "DÖNÜŞ").length,
    xu100AboveEma50: state.xu100AboveEma50,
    telegramEnabled: state.telegramEnabled,
    alarmRegistered: state.alarmRegistered,
    targets: targetsStore.load(),
  });
});

async function boot() {
  console.log("BIST ALERTS radar başlatılıyor…");

  app.listen(PORT, "0.0.0.0", () => {
    console.log(`Sunucu http://0.0.0.0:${PORT} adresinde dinliyor`);
  });

  if (notifier.enabled) {
    notifier.registerAlarmHandler({
      setAlert: targetsStore.setAlert,
      listAlerts: targetsStore.listAlerts,
      removeAlert: targetsStore.removeAlert,
      normalizeSymbol: targetsStore.normalizeSymbol,
    });
    notifier.registerReportHandler(buildFullReport);
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

  await scanLoop();
}

boot().catch((err) => {
  console.error(err);
  process.exit(1);
});
