# Binance Futures Sinyal Merkezi

Binance USDⓈ-M perpetual futures için teknik analiz ve fırsat tarayıcısı. Uygulama yalnızca analiz ve Telegram bildirimleri üretir; **emir iletimi, broker anahtarı veya işlem API'si içermez.**

## Veri mimarisi

- Evren, REST erişim kısıtlamalarında dahi WebSocket'in başlayabilmesi için 50 likit USDT perpetual sözleşmeyle sabitlenmiştir.
- Bu 50 sözleşmenin resmî `bookTicker` ve `kline_1m` / `kline_1h` akışları `wss://fstream.binance.com/ws` üzerinden JSON `SUBSCRIBE` ile asenkron tüketilir.
- Her sembol için ~50 barlık 1m/1h tamponları bellekte tutulur; swing, ATR ve order-block bölgeleri artımlı hesaplanır.
- REST ve WebSocket sözleşmeleri için [Binance USDⓈ-M Futures dokümantasyonu](https://developers.binance.com/docs/derivatives/usds-margined-futures) esas alınır.

Kline WS akışı sessiz kalırsa 1m mumlar bookTicker fiyatlarından sentezlenir; 20 sn boyunca sessiz kalan semboller evrenden çıkarılır.

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
