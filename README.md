# BIST 100 Sinyal Merkezi

Borsa İstanbul 100 için teknik analiz, risk seviyeleri, çoklu zaman dilimi değerlendirmesi ve Telegram bildirimleri üreten Python uygulaması. Bu proje analiz ve kullanıcı sinyalleri içindir: **emir gönderme, broker entegrasyonu veya gerçek alım/satım API'si içermez.**

## Emniyet ilkesi

Sinyal motoru ve Telegram yalnızca aşağıdakiler başarıyla tamamlandıktan sonra açılır:

1. Sağlayıcı bağlantısı kurulur.
2. Akıştan veri geldiği doğrulanır.
3. Her tick zaman damgasının güncel olduğu doğrulanır.
4. `config.yaml` içindeki tüm BIST 100 sembolleri ve endeks verisi alındığı doğrulanır.

Eksik, gecikmeli, mock veya bayat veri durumunda panel açıkça `⚠️ REAL-TIME DATA NOT AVAILABLE` gösterir ve Telegram'a sinyal gönderilmez.

## Çalıştırma

```bash
python3 -m venv .venv
.venv/bin/pip install -r requirements.txt
cp .env.example .env
.venv/bin/python -m app.main
```

Ardından `http://127.0.0.1:8347` adresini açın.

Varsayılan `DATA_PROVIDER=mock` seçeneği yalnızca yerel kullanıcı arayüzü ve test içindir. Suni veri üretir, hiçbir zaman gerçek zamanlı olarak etiketlenmez ve sinyal motorunu/Telgram bildirimlerini açmaz.

## dxFeed gerçek zamanlı sağlayıcısı

Uygulanan lisanslı adaptör `dxfeed` (`dxLink`) seçeneğidir. Bu adaptör yalnızca dxFeed'in belgelenmiş dxLink WebSocket protokolünü kullanır:

- [dxLink genel bakış ve yetkilendirme](https://kb.dxfeed.com/en/market-data-api/dxlink.html)
- [dxLink AsyncAPI protokol tanımı](https://github.com/dxFeed/dxLink/blob/main/dxlink-specification/asyncapi.yml)
- [Borsa İstanbul sembol biçimi](https://kb.dxfeed.com/en/data-model/symbology-guide/equities,-futures,-options,-and-spreads-symbology/turkish-formats.html)

dxFeed karşılama mektubundaki WSS uç noktasını ve BIST gerçek-zamanlı yetkili token'ını `.env` içine yazın:

```dotenv
DATA_PROVIDER=dxfeed
DXFEED_WS_URL=wss://<dxfeed-tarafindan-verilen-uc-nokta>
DXFEED_TOKEN=<lisansli-token>
TELEGRAM_BOT_TOKEN=<opsiyonel>
TELEGRAM_CHAT_ID=<opsiyonel>
```

Demo uç noktası BIST gerçek zamanlı sinyalleri için kullanılmaz; demo/veri gecikmesi gerçek zamanlı sayılmaz. Anahtar ve BIST yetkisi olmadan canlı BIST akışı çalışmaz.

`config.yaml` BIST 100 takip listesini içerir. Endeks bileşenleri değiştiğinde, bu listeyi sağlayıcının yetkili enstrüman profiline göre gözden geçirin.

## İçerik

- `data/`: bağımsız `DataProvider` sözleşmesi, `MockProvider`, dxFeed dxLink adaptörü, tick doğrulama, bağlantı sağlığı ve mum verisi
- `indicators/`: EMA/SMA/ADX/DI, RSI/MACD/Stochastic/Williams %R/CCI/ROC, ATR/Bollinger, VWAP/OBV/hacim ve fiyat-mum yapısı
- `strategy/`: ağırlıklı 0–100 skor, BIST 100 piyasa rejimi ve göreli güç
- `risk/`: ATR + swing stop ile 1R/2R/3R analitik hedefleri
- `notifications/`: gerçek-zamanlılık kapılı Telegram Bot API bildirimi
- `dashboard/`: mobil uyumlu FastAPI paneli ve sembol bazlı WebSocket güncellemeleri
- `backtest/`: aynı sinyal motoru ile komisyon/slippage destekli uzun yönlü simülasyon ve performans metrikleri

## Testler

```bash
.venv/bin/python -m pytest -q
```

Bu uygulama yatırım tavsiyesi değildir. Verilerin lisansını, BIST sembol setini ve kendi risk yönetiminizi doğrulayın.
