# BIST Confluence Swing Radar

Node.js Express scanner for BIST 30 stocks using Yahoo Finance daily/weekly OHLCV. Polls every 15 minutes, scores confluence setups (0–100), and sends Telegram alerts on FIRSAT entries and stop/target hits.

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

## Confluence score (max 100)

| Signal | Points |
|--------|--------|
| Support zone (60d cluster low or Fib 50/61.8 ±2%) | +25 |
| EMA 50/200 hold within ±1.5% | +20 |
| Volume ≥ 20d SMA at support | +20 |
| Daily RSI turning up from 30–40 | +15 |
| XU100 above EMA50 | +20 |

**FIRSAT** when score ≥ 75 and risk/reward ≥ 1:2. Otherwise **BEKLE**.

## Deploy (Render)

Docker build runs `node server.js`. Set `PORT`, `TELEGRAM_BOT_TOKEN`, and `TELEGRAM_CHAT_ID` in Render environment variables.
