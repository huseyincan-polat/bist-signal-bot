"""FastAPI dashboard for BIST technical analysis (analysis only)."""

from __future__ import annotations

import asyncio
import json
from datetime import UTC, datetime
from collections.abc import AsyncContextManager, Callable
from typing import Any

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
        buys = sorted((row for row in rows if row["signal"] in ("AL", "GÜÇLÜ AL")), key=lambda item: item["score"], reverse=True)[:10]
        sells = sorted((row for row in rows if row["signal"] in ("SAT", "GÜÇLÜ SAT")), key=lambda item: item["score"])[:10]
        return {
            "provider": self.health.provider,
            "data_state": self.health.data_state.value,
            "ready_for_signals": self.health.ready_for_signals,
            "connected": self.health.connected,
            "last_error": self.health.last_error,
            "symbols_received": len(self.health.symbols_received),
            "symbols_expected": len(self.health.expected_symbols),
            "data_age": data_age,
            "market_regime": self.engine.market_regime,
            "rows": rows,
            "top_buys": buys,
            "top_sells": sells,
            "priority": priority,
        }

    def _row(self, symbol: str, global_age: float | None) -> dict[str, Any]:
        signal = self.engine.signals.get(symbol)
        if not signal:
            tick = self.last_ticks.get(symbol)
            return {
                "symbol": symbol, "price": tick.price if tick else None, "change": None,
                "signal": "DOĞRULANMADI" if tick else "YÜKLENİYOR",
                "score": None, "rsi": None, "macd": None, "adx": None, "relative_volume": None,
                "trend": "—", "15m": "—", "1h": "—", "daily": "—", "stop": None,
                "target": None, "data_age": global_age,
            }
        metric = signal.metrics
        return {
            "symbol": symbol, "price": signal.price, "change": metric.get("relative_strength"),
            "signal": signal.state.value, "score": signal.confidence, "rsi": metric.get("rsi"),
            "macd": metric.get("macd"), "adx": metric.get("adx"),
            "relative_volume": metric.get("relative_volume"), "trend": metric.get("trend"),
            "15m": metric.get("15m"), "1h": metric.get("1h"), "daily": metric.get("daily"),
            "stop": signal.stop, "target": signal.targets[0], "data_age": round((datetime.now(UTC) - signal.data_timestamp).total_seconds(), 1),
        }

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


def create_dashboard(
    config: AppConfig,
    engine: SignalEngine,
    health: ProviderHealth,
    lifespan: Callable[[FastAPI], AsyncContextManager[None]] | None = None,
) -> tuple[FastAPI, DashboardState]:
    state = DashboardState(config, engine, health)
    api = FastAPI(title="BIST 100 Sinyal Merkezi", docs_url=None, redoc_url=None, lifespan=lifespan)

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
<title>BIST 100 Sinyal Merkezi</title>
<style>
:root{--bg:#07111f;--panel:#0d1b2d;--soft:#14253b;--line:#203952;--ink:#e7f0fb;--muted:#93a9c3;--blue:#4bb3fd;--green:#2dd4a3;--red:#fb7185;--amber:#fbbf24}
*{box-sizing:border-box}body{margin:0;background:var(--bg);color:var(--ink);font:14px Inter,ui-sans-serif,system-ui,sans-serif}main{max-width:1680px;margin:auto;padding:24px}.top{display:flex;gap:16px;justify-content:space-between;align-items:flex-start}.eyebrow{color:var(--blue);font-weight:700;letter-spacing:.08em;font-size:11px}.top h1{font-size:28px;margin:5px 0}.sub{color:var(--muted);margin:0}.status{background:var(--panel);padding:12px 16px;border:1px solid var(--line);border-radius:10px;text-align:right}.pill{display:inline-block;border-radius:999px;padding:4px 9px;font-size:12px;font-weight:700;background:#14324d;color:#a7d8ff}.warning{margin:22px 0;padding:14px 16px;border-radius:9px;background:#4b1f2a;border:1px solid #fb7185;color:#ffe1e7;font-weight:800;letter-spacing:.02em}.hide{display:none}.summary{display:grid;grid-template-columns:repeat(4,1fr);gap:12px;margin:16px 0}.card{background:var(--panel);border:1px solid var(--line);border-radius:10px;padding:16px}.card label{color:var(--muted);font-size:12px}.card strong{display:block;font-size:20px;margin-top:8px}.panels{display:grid;grid-template-columns:1fr 1fr;gap:16px}.panel{background:var(--panel);border:1px solid var(--line);border-radius:10px;padding:16px}.panel h2{font-size:14px;margin:0 0 12px}.leaders{display:flex;gap:10px;flex-wrap:wrap}.leader{padding:8px 10px;background:var(--soft);border-radius:7px;font-weight:700}.toolbar{display:flex;gap:9px;align-items:center;margin:24px 0 12px;flex-wrap:wrap}.toolbar button{border:1px solid var(--line);background:var(--panel);color:var(--ink);padding:8px 11px;border-radius:7px;cursor:pointer}.toolbar button.active{background:var(--blue);color:#06101d;border-color:var(--blue);font-weight:800}.table-wrap{overflow:auto;border:1px solid var(--line);border-radius:10px}table{border-collapse:collapse;min-width:1260px;width:100%;background:var(--panel)}th{text-align:left;color:var(--muted);font-size:11px;letter-spacing:.04em;padding:12px;border-bottom:1px solid var(--line);white-space:nowrap}td{padding:12px;border-bottom:1px solid #172c42;white-space:nowrap}tr:last-child td{border:0}.signal{font-weight:800}.buy{color:var(--green)}.sell{color:var(--red)}.wait{color:var(--amber)}.muted{color:var(--muted)}.empty{padding:26px;color:var(--muted);text-align:center}@media(max-width:760px){main{padding:15px}.top{display:block}.status{text-align:left;margin-top:12px}.summary{grid-template-columns:1fr 1fr}.panels{grid-template-columns:1fr}.top h1{font-size:23px}}
</style></head><body><main>
<header class="top"><div><div class="eyebrow">BIST 100 • TEKNİK ANALİZ</div><h1>Sinyal Merkezi</h1><p class="sub">Anlık veri doğrulanmadan bildirim gönderilmez. Emir iletimi yoktur.</p></div><div class="status"><span id="connection" class="pill">BAĞLANIYOR</span><div class="muted" id="provider">Sağlayıcı yükleniyor</div></div></header>
<div id="warning" class="warning">⚠️ REAL-TIME DATA NOT AVAILABLE — Sinyaller ve Telegram bildirimleri devre dışı.</div>
<section class="summary"><div class="card"><label>Piyasa rejimi</label><strong id="regime">—</strong></div><div class="card"><label>Alınan sembol</label><strong id="coverage">—</strong></div><div class="card"><label>Veri yaşı</label><strong id="age">—</strong></div><div class="card"><label>Sinyal motoru</label><strong id="engine">BEKLEMEDE</strong></div></section>
<section class="panels"><div class="panel"><h2>En güçlü 10 AL</h2><div id="buys" class="leaders"><span class="muted">Doğrulanmış veri bekleniyor.</span></div></div><div class="panel"><h2>En güçlü 10 SAT</h2><div id="sells" class="leaders"><span class="muted">Doğrulanmış veri bekleniyor.</span></div></div></section>
<div class="toolbar" id="filters"><span class="muted">Filtre:</span><button class="active" data-filter="ALL">Tümü</button><button data-filter="GÜÇLÜ AL">GÜÇLÜ AL</button><button data-filter="AL">AL</button><button data-filter="BEKLE">BEKLE</button><button data-filter="SAT">SAT</button><button data-filter="GÜÇLÜ SAT">GÜÇLÜ SAT</button></div>
<div class="table-wrap"><table><thead><tr><th>Hisse</th><th>Fiyat</th><th>Değişim %</th><th>Sinyal</th><th>Score</th><th>RSI</th><th>MACD</th><th>ADX</th><th>Bağıl Hacim</th><th>Trend</th><th>15m</th><th>1h</th><th>Günlük</th><th>Stop</th><th>Hedef 1</th><th>Veri Yaşı</th></tr></thead><tbody id="rows"><tr><td colspan="16" class="empty">BIST 100 sembolleri yükleniyor…</td></tr></tbody></table></div>
</main><script>
let rows=[],filter='ALL',currentStatus={};const f=n=>n==null?'—':Number(n).toLocaleString('tr-TR',{maximumFractionDigits:2});const esc=s=>String(s??'—').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
function cls(signal){return signal.includes('AL')?'buy':signal.includes('SAT')?'sell':'wait'}function leader(row){return `<span class="leader ${cls(row.signal)}">${esc(row.symbol)} · ${esc(row.signal)} ${f(row.score)}</span>`}
function render(status){currentStatus=status;rows=status.rows||rows;document.querySelector('#provider').textContent=status.provider;document.querySelector('#connection').textContent=status.connected?'BAĞLI':'BAĞLANTI YOK';document.querySelector('#regime').textContent=status.market_regime;document.querySelector('#coverage').textContent=`${status.symbols_received}/${status.symbols_expected}`;document.querySelector('#age').textContent=status.data_age==null?'—':`${status.data_age} sn`;document.querySelector('#engine').textContent=status.ready_for_signals?'AKTİF':'EMNİYET KİLİDİ';document.querySelector('#warning').classList.toggle('hide',status.data_state==='REAL_TIME'&&status.ready_for_signals);document.querySelector('#buys').innerHTML=status.top_buys.length?status.top_buys.map(leader).join(''):'<span class="muted">Uygun AL sinyali yok.</span>';document.querySelector('#sells').innerHTML=status.top_sells.length?status.top_sells.map(leader).join(''):'<span class="muted">Uygun SAT sinyali yok.</span>';let visible=filter==='ALL'?rows:rows.filter(r=>r.signal===filter);document.querySelector('#rows').innerHTML=visible.length?visible.map(r=>`<tr><td><b>${esc(r.symbol)}</b></td><td>${f(r.price)}</td><td>${f(r.change)}</td><td class="signal ${cls(r.signal)}">${esc(r.signal)}</td><td>${f(r.score)}</td><td>${f(r.rsi)}</td><td>${f(r.macd)}</td><td>${f(r.adx)}</td><td>${f(r.relative_volume)}x</td><td>${esc(r.trend)}</td><td>${esc(r['15m'])}</td><td>${esc(r['1h'])}</td><td>${esc(r.daily)}</td><td>${f(r.stop)}</td><td>${f(r.target)}</td><td>${r.data_age==null?'—':f(r.data_age)+' sn'}</td></tr>`).join(''):'<tr><td colspan="16" class="empty">Bu filtre için sinyal yok.</td></tr>'}
document.querySelector('#filters').onclick=e=>{if(!e.target.dataset.filter)return;filter=e.target.dataset.filter;document.querySelectorAll('button').forEach(b=>b.classList.toggle('active',b.dataset.filter===filter));render(currentStatus)};fetch('/api/state').then(r=>r.json()).then(render);let ws=new WebSocket(`${location.protocol==='https:'?'wss':'ws'}://${location.host}/ws`);ws.onmessage=e=>{let p=JSON.parse(e.data);if(p.status)render(p.status)};ws.onclose=()=>setTimeout(()=>location.reload(),3000);
</script></body></html>"""
