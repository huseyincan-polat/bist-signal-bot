"""FastAPI dashboard for Futures technical analysis (analysis only)."""

from __future__ import annotations

import asyncio
import json
from datetime import UTC, datetime
from typing import Any, AsyncContextManager, Callable

from fastapi import FastAPI, WebSocket, WebSocketDisconnect
from fastapi.responses import HTMLResponse

from app.config import AppConfig
from data.models import MarketTick, ProviderHealth, Signal, SignalState
from strategy.signal_engine import SignalEngine


class DashboardState:
    def __init__(self, config: AppConfig, engine: SignalEngine, health: ProviderHealth) -> None:
        self.config = config
        self.engine = engine
        self.health = health
        self.connections: set[WebSocket] = set()
        self.last_ticks: dict[str, MarketTick] = {}

    def record_tick(self, tick: MarketTick) -> None:
        self.last_ticks[tick.symbol] = tick

    def state(self) -> dict[str, Any]:
        now = datetime.now(UTC)
        data_age = (
            round((now - self.health.last_data_at).total_seconds(), 1)
            if self.health.last_data_at else None
        )
        rows = [self._row(symbol, data_age) for symbol in self.config.symbols]
        priority = {SignalState.STRONG_BUY.value: 4, SignalState.BUY.value: 3, SignalState.WAIT.value: 2, SignalState.SELL.value: 1, SignalState.STRONG_SELL.value: 0}
        buys = sorted((row for row in rows if row["signal"] in ("LONG", "GÜÇLÜ LONG")), key=lambda item: item["score"], reverse=True)[:10]
        sells = sorted((row for row in rows if row["signal"] in ("SHORT", "GÜÇLÜ SHORT")), key=lambda item: item["score"])[:10]
        return {
            "provider": self.health.provider,
            "data_state": self.health.data_state.value,
            "ready_for_signals": self.health.ready_for_signals,
            "connected": self.health.connected,
            "last_error": self.health.last_error,
            "symbols_received": len(self.health.symbols_received),
            "symbols_expected": len(self.health.expected_symbols),
            "rotation_stale_after_seconds": self.health.rotation_stale_after_seconds,
            "primed_signals": len(self.engine.signals),
            "actionable_count": sum(
                signal.state
                in (SignalState.BUY, SignalState.STRONG_BUY, SignalState.SELL, SignalState.STRONG_SELL)
                for signal in self.engine.signals.values()
            ),
            "data_age": data_age,
            "market_regime": self.engine.market_regime,
            "rows": rows,
            "top_buys": buys,
            "top_sells": sells,
            "priority": priority,
        }

    def _row(self, symbol: str, global_age: float | None) -> dict[str, Any]:
        signal = self.engine.signals.get(symbol)
        live_at = self.health.last_data_by_symbol.get(symbol)
        live_age = round((datetime.now(UTC) - live_at).total_seconds(), 1) if live_at else None
        price, previous_close, price_change, price_change_pct = self._price_change(symbol, signal)
        if self.health.data_state.value != "REAL_TIME" and live_at is not None:
            row_data_state = "STALE_DATA"
        elif live_at is None:
            row_data_state = "PRIMED" if signal else "WAITING_LIVE"
        elif self.health.symbol_is_stale(symbol):
            row_data_state = "STALE_DATA"
        else:
            row_data_state = "REAL_TIME"
        if not signal:
            return {
                "symbol": symbol, "name": self.config.symbol_names.get(symbol, symbol),
                "price": price,
                "prev_close": previous_close,
                "price_change": price_change,
                "price_change_pct": price_change_pct,
                "change": price_change_pct,
                "signal": "DOĞRULANMADI" if price is not None else "YÜKLENİYOR",
                "score": None, "rsi": None, "macd": None, "adx": None, "relative_volume": None,
                "trend": "—", "15m": "—", "1h": "—", "daily": "—", "stop": None,
                "target": None,
                "data_age": live_age,
                "row_data_state": row_data_state,
            }
        metric = signal.metrics
        return {
            "symbol": symbol,
            "name": self.config.symbol_names.get(symbol, symbol),
            "price": price,
            "prev_close": previous_close,
            "price_change": price_change,
            "price_change_pct": price_change_pct,
            "change": price_change_pct,
            "signal": signal.state.value, "score": signal.confidence, "rsi": metric.get("rsi"),
            "macd": metric.get("macd"), "adx": metric.get("adx"),
            "relative_volume": metric.get("relative_volume"), "trend": metric.get("trend"),
            "15m": metric.get("15m"), "1h": metric.get("1h"), "daily": metric.get("daily"),
            "stop": signal.stop,
            "target": signal.targets[0],
            "data_age": live_age,
            "row_data_state": row_data_state,
            "data_quality": metric.get("data_quality"),
        }

    def _price_change(
        self,
        symbol: str,
        signal: Signal | None,
    ) -> tuple[float | None, float | None, float | None, float | None]:
        tick = self.last_ticks.get(symbol)
        price = tick.price if tick else signal.price if signal else None
        previous_close = (
            tick.previous_close
            if tick and tick.previous_close is not None
            else self.engine.previous_close(symbol)
        )
        if price is None or previous_close is None or previous_close == 0:
            return price, previous_close, None, None
        change = price - previous_close
        return price, previous_close, round(change, 2), round(change / previous_close * 100, 2)

    async def publish(self, symbol: str) -> None:
        if not self.connections:
            return
        row = next(item for item in self.state()["rows"] if item["symbol"] == symbol)
        payload = json.dumps({"type": "symbol_update", "row": row, "status": self.state()})
        stale: list[WebSocket] = []
        for connection in self.connections:
            try:
                await connection.send_text(payload)
            except Exception:
                stale.append(connection)
        for connection in stale:
            self.connections.discard(connection)

    async def broadcast_state(self) -> None:
        if not self.connections:
            return
        payload = json.dumps({"type": "state_update", "status": self.state()})
        stale: list[WebSocket] = []
        for connection in self.connections:
            try:
                await connection.send_text(payload)
            except Exception:
                stale.append(connection)
        for connection in stale:
            self.connections.discard(connection)


def create_dashboard(
    config: AppConfig,
    engine: SignalEngine,
    health: ProviderHealth,
    lifespan: Callable[[FastAPI], AsyncContextManager[None]] | None = None,
) -> tuple[FastAPI, DashboardState]:
    state = DashboardState(config, engine, health)
    api = FastAPI(title="Binance Futures Sinyal Merkezi", docs_url=None, redoc_url=None, lifespan=lifespan)

    @api.get("/", response_class=HTMLResponse)
    async def index() -> str:
        return DASHBOARD_HTML

    @api.get("/api/state")
    async def get_state() -> dict[str, Any]:
        return state.state()

    @api.websocket("/ws")
    async def updates(websocket: WebSocket) -> None:
        await websocket.accept()
        state.connections.add(websocket)
        await websocket.send_json({"type": "initial", "status": state.state()})
        try:
            while True:
                await websocket.receive_text()
        except WebSocketDisconnect:
            state.connections.discard(websocket)

    return api, state


DASHBOARD_HTML = r"""<!doctype html>
<html lang="tr"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Binance Futures Sinyal Merkezi</title>
<style>
:root{--bg:#07111f;--panel:#0d1b2d;--soft:#14253b;--line:#203952;--ink:#e7f0fb;--muted:#93a9c3;--blue:#4bb3fd;--green:#2dd4a3;--red:#fb7185;--amber:#fbbf24}
*{box-sizing:border-box}body{margin:0;background:var(--bg);color:var(--ink);font:14px Inter,ui-sans-serif,system-ui,sans-serif}main{max-width:1680px;margin:auto;padding:24px}.top{display:flex;gap:16px;justify-content:space-between;align-items:flex-start}.eyebrow{color:var(--blue);font-weight:700;letter-spacing:.08em;font-size:11px}.top h1{font-size:28px;margin:5px 0}.sub{color:var(--muted);margin:0}.status{background:var(--panel);padding:12px 16px;border:1px solid var(--line);border-radius:10px;text-align:right}.pill{display:inline-block;border-radius:999px;padding:4px 9px;font-size:12px;font-weight:700;background:#14324d;color:#a7d8ff}.warning{margin:22px 0;padding:14px 16px;border-radius:9px;background:#4b1f2a;border:1px solid #fb7185;color:#ffe1e7;font-weight:800;letter-spacing:.02em}.hide{display:none}.summary{display:grid;grid-template-columns:repeat(4,1fr);gap:12px;margin:16px 0}.card{background:var(--panel);border:1px solid var(--line);border-radius:10px;padding:16px}.card label{color:var(--muted);font-size:12px}.card strong{display:block;font-size:20px;margin-top:8px}.panels{display:grid;grid-template-columns:1fr 1fr;gap:16px}.panel{background:var(--panel);border:1px solid var(--line);border-radius:10px;padding:16px}.panel h2{font-size:14px;margin:0 0 12px}.leaders{display:flex;gap:10px;flex-wrap:wrap}.leader{padding:8px 10px;background:var(--soft);border-radius:7px;font-weight:700}.toolbar{display:flex;gap:9px;align-items:center;margin:24px 0 12px;flex-wrap:wrap}.toolbar button,.toolbar input{border:1px solid var(--line);background:var(--panel);color:var(--ink);padding:8px 11px;border-radius:7px}.toolbar input{min-width:230px}.toolbar button{cursor:pointer}.toolbar button.active{background:var(--blue);color:#06101d;border-color:var(--blue);font-weight:800}.table-wrap{overflow:auto;border:1px solid var(--line);border-radius:10px}table{border-collapse:collapse;min-width:1260px;width:100%;background:var(--panel)}th{text-align:left;color:var(--muted);font-size:11px;letter-spacing:.04em;padding:12px;border-bottom:1px solid var(--line);white-space:nowrap}td{padding:12px;border-bottom:1px solid #172c42;white-space:nowrap}tr:last-child td{border:0}.signal{font-weight:800}.buy,.up{color:var(--green)}.sell,.down{color:var(--red)}.wait{color:var(--amber)}.flat{color:var(--muted)}.muted{color:var(--muted)}.empty{padding:26px;color:var(--muted);text-align:center}@media(max-width:760px){main{padding:15px}.top{display:block}.status{text-align:left;margin-top:12px}.summary{grid-template-columns:1fr 1fr}.panels{grid-template-columns:1fr}.top h1{font-size:23px}.toolbar input{width:100%;min-width:0}}
</style></head><body><main>
<header class="top"><div><div class="eyebrow">BINANCE USDⓈ-M FUTURES • TEKNİK ANALİZ</div><h1>Sinyal Merkezi</h1><p class="sub">Anlık veri doğrulanmadan bildirim gönderilmez. Emir iletimi yoktur.</p></div><div class="status"><span id="connection" class="pill">BAĞLANIYOR</span><div class="muted" id="provider">Sağlayıcı yükleniyor</div></div></header>
<div id="warning" class="warning">⚠️ REAL-TIME DATA NOT AVAILABLE — Sinyaller ve Telegram bildirimleri devre dışı.</div>
<section class="summary"><div class="card"><label>Piyasa rejimi</label><strong id="regime">—</strong></div><div class="card"><label>Alınan sembol</label><strong id="coverage">—</strong></div><div class="card"><label>Veri yaşı</label><strong id="age">—</strong></div><div class="card"><label>Sinyal motoru</label><strong id="engine">BEKLEMEDE</strong></div></section>
<section class="panels"><div class="panel"><h2>En güçlü 10 LONG</h2><div id="buys" class="leaders"><span class="muted">Doğrulanmış veri bekleniyor.</span></div></div><div class="panel"><h2>En güçlü 10 SHORT</h2><div id="sells" class="leaders"><span class="muted">Doğrulanmış veri bekleniyor.</span></div></div></section>
<div class="toolbar" id="filters"><input id="search" type="search" placeholder="Sözleşme ara (ör. BTCUSDT)" aria-label="Sözleşme ara"><span class="muted">Görünüm:</span><button class="active" data-filter="ACTIVE">LONG / SHORT</button><button data-filter="GÜÇLÜ AL">GÜÇLÜ LONG</button><button data-filter="AL">LONG</button><button data-filter="BEKLE">BEKLE</button><button data-filter="SAT">SHORT</button><button data-filter="GÜÇLÜ SAT">GÜÇLÜ SHORT</button></div>
<div class="table-wrap"><table><thead><tr><th>Sözleşme</th><th>Fiyat</th><th>Değişim %</th><th>Sinyal</th><th>Score</th><th>RSI</th><th>MACD</th><th>ADX</th><th>Bağıl Hacim</th><th>Trend</th><th>15m</th><th>1h</th><th>Günlük</th><th>Stop</th><th>Hedef 1</th><th>Veri Yaşı</th></tr></thead><tbody id="rows"><tr><td colspan="16" class="empty">Futures sözleşmeleri yükleniyor…</td></tr></tbody></table></div>
</main><script>
let rows=[],filter='ACTIVE',query='',currentStatus={};const f=n=>n==null?'—':Number(n).toLocaleString('tr-TR',{maximumFractionDigits:2});const esc=s=>String(s??'—').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));const ageCell=r=>r.row_data_state==='REAL_TIME'?`${f(r.data_age)} sn · CANLI`:r.row_data_state==='STALE_DATA'?`${f(r.data_age)} sn · BAYAT`:r.row_data_state==='PRIMED'?'GEÇMİŞ VERİ · SIRADA':'SIRADA';const priceCell=r=>{if(r.price==null)return'—';let c=Number(r.price_change||0),p=Number(r.price_change_pct||0),cls=c>0?'up':c<0?'down':'flat',arrow=c>0?'▲':c<0?'▼':'●',sign=c>0?'+':'';return `<b class="${cls}">${f(r.price)} USDT</b>${r.prev_close==null?'':`<br><small class="${cls}">${arrow} ${sign}${f(c)} USDT (${sign}%${f(p)})</small>`}`};
function cls(signal){return signal.includes('LONG')?'buy':signal.includes('SHORT')?'sell':'wait'}function leader(row){return `<span class="leader ${cls(row.signal)}">${esc(row.symbol)} · ${esc(row.signal)} ${f(row.score)}</span>`}
function render(status){currentStatus=status;rows=status.rows||rows;document.querySelector('#provider').textContent=status.provider;document.querySelector('#connection').textContent=status.connected?'BAĞLI':'BAĞLANTI YOK';document.querySelector('#regime').textContent=status.market_regime;document.querySelector('#coverage').textContent=`${status.symbols_received}/${status.symbols_expected}`;document.querySelector('#age').textContent=status.data_age==null?'—':`${status.data_age} sn`;document.querySelector('#engine').textContent=status.ready_for_signals?'AKTİF':'EMNİYET KİLİDİ';document.querySelector('#warning').classList.toggle('hide',status.data_state==='REAL_TIME');document.querySelector('#buys').innerHTML=status.top_buys.length?status.top_buys.map(leader).join(''):'<span class="muted">Uygun LONG sinyali yok.</span>';document.querySelector('#sells').innerHTML=status.top_sells.length?status.top_sells.map(leader).join(''):'<span class="muted">Uygun SHORT sinyali yok.</span>';let base=query?rows:filter==='ACTIVE'?rows.filter(r=>['LONG','GÜÇLÜ LONG','SHORT','GÜÇLÜ SHORT'].includes(r.signal)):rows.filter(r=>r.signal===filter);let visible=base.filter(r=>`${r.symbol} ${r.name}`.toLocaleLowerCase('tr-TR').includes(query));document.querySelector('#rows').innerHTML=visible.length?visible.map(r=>`<tr><td><b>${esc(r.symbol)}</b><br><small class="muted">${esc(r.name)}</small></td><td>${priceCell(r)}</td><td>${r.price_change_pct==null?'—':`${r.price_change_pct>0?'+':''}%${f(r.price_change_pct)}`}</td><td class="signal ${cls(r.signal)}">${esc(r.signal)}</td><td>${f(r.score)}</td><td>${f(r.rsi)}</td><td>${f(r.macd)}</td><td>${f(r.adx)}</td><td>${f(r.relative_volume)}x</td><td>${esc(r.trend)}</td><td>${esc(r['15m'])}</td><td>${esc(r['1h'])}</td><td>${esc(r.daily)}</td><td>${f(r.stop)}</td><td>${f(r.target)}</td><td>${ageCell(r)}</td></tr>`).join(''):'<tr><td colspan="16" class="empty">Bu arama veya filtre için sözleşme yok.</td></tr>'}
document.querySelector('#filters').onclick=e=>{if(!e.target.dataset.filter)return;filter=e.target.dataset.filter;document.querySelectorAll('button').forEach(b=>b.classList.toggle('active',b.dataset.filter===filter));render(currentStatus)};document.querySelector('#search').oninput=e=>{query=e.target.value.toLocaleLowerCase('tr-TR').trim();render(currentStatus)};fetch('/api/state').then(r=>r.json()).then(render);let ws=new WebSocket(`${location.protocol==='https:'?'wss':'ws'}://${location.host}/ws`);ws.onmessage=e=>{let p=JSON.parse(e.data);if(p.status)render(p.status)};ws.onclose=()=>setTimeout(()=>location.reload(),3000);
</script></body></html>"""
