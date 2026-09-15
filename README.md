# BIST ALERTS

Node.js Express scanner for BIST 100 (+ ALTINS1) using Yahoo Finance daily OHLCV. Scans the full universe sequentially with 10s per-request timeouts, then waits 60s before the next pass. **FIRSAT** signals require a liquidity sweep near the 10-session low plus a 1.5× volume spike.

## Setup

```bash
npm install
```

Create `.env` (never commit):

```
TELEGRAM_BOT_TOKEN=your_token
TELEGRAM_CHAT_ID=your_chat_id
```

## Run

```bash
npm start
```

Dashboard: `http://localhost:10000/`  
Health: `GET` / `HEAD` `/health`

## FIRSAT criteria

Both must be true:

1. **Liquidity sweep** — last price within 2% above the prior 10-session low, or wicked below that low and recovered
2. **Volume** — `regularMarketVolume` ≥ 1.5× `averageDailyVolume10Day` (or 10-day volume SMA from history)

Custom TP/SL via Telegram: `/alarm THYAO 320 285`

## Deploy (Render)

Docker build runs `node server.js`. Set `PORT`, `TELEGRAM_BOT_TOKEN`, and `TELEGRAM_CHAT_ID` in Render environment variables.
