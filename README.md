# Binance Futures Sinyal Merkezi

Binance USDⓈ-M perpetual futures için teknik analiz ve fırsat tarayıcısı. Uygulama yalnızca analiz ve Telegram bildirimleri üretir; **emir iletimi, broker anahtarı veya işlem API'si içermez.**

## Veri mimarisi

- Evren, Binance'in resmî `/fapi/v1/exchangeInfo` ve `/fapi/v1/ticker/24hr` market-data uç noktalarından USDT perpetual sözleşmelerin 24 saatlik quote hacmine göre yenilenir.
- En yüksek hacimli 50 sözleşmenin resmî `aggTrade` combined stream'i `wss://fstream.binance.com/stream?streams=...` üzerinden asenkron tüketilir.
- Gösterge serileri, resmî `/fapi/v1/klines` ile geçmiş 1 dakikalık mumlardan iş parçacığında hazırlanır.
- REST ve WebSocket sözleşmeleri için [Binance USDⓈ-M Futures dokümantasyonu](https://developers.binance.com/docs/derivatives/usds-margined-futures) esas alınır.

Binance REST erişimi `418` veya bölgesel `451` ile engellenirse uygulama 50 yaygın USDT perpetual sözleşmeden oluşan yedek evrenle WebSocket'i yine başlatır. Kline geçmişi alınamıyorsa fiyatlar gösterilir, ancak sinyal motoru açılmaz.

Sinyal motoru, en az bir güncel WebSocket tick'i ve hazırlanmış geçmiş seri olmadan çalışmaz. Akış kesilir veya bayatlarsa panel `⚠️ REAL-TIME DATA NOT AVAILABLE` gösterir; Telegram bildirimleri kapalı kalır.

## Risk filtresi

Fırsatlar teyitli swing high/low pivotları ve ATR ile hesaplanır:

- Long/short teknik stop girişten en fazla %3 uzak olabilir.
- Yapısal hedefte beklenen ödül/risk en az 1:3 olmalıdır.
- Bu koşullardan biri sağlanmazsa sonuç `BEKLE` olur ve ana fırsat tablosunda görünmez.

## Çalıştırma

```bash
python3 -m venv .venv
.venv/bin/pip install -r requirements.txt
cp .env.example .env
.venv/bin/python -m app.main
```

Panel: `http://127.0.0.1:8347`

Telegram isteğe bağlıdır. `TELEGRAM_BOT_TOKEN` ve `TELEGRAM_CHAT_ID` yalnızca `.env` veya barındırma platformunun gizli ortam değişkenleri aracılığıyla verilir.

## Testler

```bash
.venv/bin/python -m pytest -q
```

Yatırım tavsiyesi değildir. Kaldıraçlı futures işlemleri yüksek risk taşır.
