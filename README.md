# BIST ALERTS

BIST 100 (+ ALTINS1) için Node.js/Express tarama botu. Yahoo Finance günlük verisini kullanır, sinyalleri Telegram'a gönderir ve bir panelde gösterir. Tarama yalnızca **BIST saatlerinde (hafta içi 09:55–18:10, İstanbul)** çalışır. Bir tarama bitince 60 saniye beklenir. Yahoo'nun BIST verisi yaklaşık 15 dakika gecikmelidir.

> Bu bot bir analiz aracıdır, yatırım tavsiyesi vermez. Karar ve risk kullanıcıya aittir.

## Sinyaller

Bot, piyasanın durumuna göre iki farklı mantıkla çalışır. Piyasa durumu, XU100 endeksinin 50 günlük EMA'sının üstünde ya da altında olmasına göre belirlenir.

### 🔔 FIRSAT: Güçlü piyasada kırılım (XU100 > EMA50)

Aşağıdakilerin hepsi doğru olmalı:

1. **Göreceli güç:** Hisse son `RS_WINDOW_DAYS` günde (varsayılan 63, yaklaşık 3 ay) XU100'den daha çok yükselmiş olmalı.
2. **Trend:** Fiyat EMA20 ve EMA50'nin üstünde, iki ortalama da yukarı eğimli olmalı. Son 20 günde daha yüksek tepe ve daha yüksek dip görülmeli.
3. **Tetik:** Fiyat 20 günlük direnci ya da önceki günün en yükseğini kırmalı. Aynı anda şunlar da sağlanmalı:
   - **Hacim:** Bugünkü hacim, önceki 20 günün ortalamasının *günün o saatine kadar beklenen kısmından* büyük olmalı.
   - **RSI(14) (isteğe bağlı, varsayılan kapalı):** `REQUIRE_RSI_MOMENTUM=true` ayarlanırsa Wilder RSI 50 ile 70 arasında olmalı. Backtest'te bu şart sonuçları iyileştirmedi.
4. **Kazanç/risk** en az `MIN_RR` (2) olmalı.
5. Ortak filtrelerden geçmeli (aşağıda).

### 🔄 DÖNÜŞ: Zayıf piyasada dönüş (XU100 < EMA50), varsayılan olarak KAPALI

> Backtest'te (Kasım 2024 – Kasım 2025, 99 hisse) DÖNÜŞ'ün teknik kısmı komisyon sonrası kâr getirmedi: 832 işlem, kâr faktörü 1,01, ortalama +%0,03. F/K ve PD/DD filtresi geçmiş veri olmadığı için test edilemedi. Bu yüzden `ENABLE_DONUS=false` varsayılandır. Açmak için `ENABLE_DONUS=true` ayarlayın.

Piyasa düşerken **sert düşmüş, ama kârlı ve ucuz** bir hisse yukarı dönmeye başladığında sinyal verir. Borsa İstanbul üzerine yapılan çalışmalar, kısa vadeli dönüşlerin piyasa durumuna bağlı olduğunu ve kârlı, düşük çarpanlı hisselerde daha güçlü olduğunu gösteriyor.

1. **Düşüş:** Hisse son 10 günde en az `REVERSAL_DROP_PCT` (%7) düşmüş olmalı ya da son 5 günde RSI `REVERSAL_RSI_MAX` (35) seviyesinin altına inmiş olmalı.
2. **Dönüş:** Fiyat önceki günün en yükseğini aşmalı ya da RSI dipten yukarı dönerken fiyat önceki kapanışın üstüne çıkmalı.
3. **Kârlılık:** Hisse başına kâr (EPS) sıfırdan büyük olmalı.
4. **Ucuzluk:** F/K ≤ `MAX_PE` (15) ya da PD/DD ≤ `MAX_PB` (2) olmalı.
5. **Kazanç/risk** en az 2 olmalı ve hisse ortak filtrelerden geçmeli.

Yahoo bir hisse için F/K ve PD/DD verisi vermezse DÖNÜŞ sinyali verilmez. `REQUIRE_FUNDAMENTALS=false` ayarıyla, verisi olmayan hisselerde yalnızca teknik şartlar aranır.

### Ortak filtreler

- **Likidite:** 20 günlük ortalama işlem hacmi en az `MIN_TURNOVER_TL` (20 milyon TL) olmalı. Tahtası sığ hisseler elenir.
- **Beta:** XU100'e göre 120 günlük beta en fazla `MAX_BETA` (1,5) olmalı. Aşırı oynak hisseler elenir. `0` değeri filtreyi kapatır.
- **Veri kontrolü:** Son 120 günde %25'ten büyük bir günlük hareket varsa sinyal verilmez. BIST'te günlük fiyat limiti var, bu kadar büyük bir hareket genelde düzeltilmemiş bir bedelsiz ya da bölünme demektir.

### Hedef ve stop

Stop, son dip, EMA20 ve 1,5×ATR değerlerinden en düşük olanıdır. Hedef, giriş fiyatı + 2,5 × risk olarak hesaplanır. `CAPITAL_TL` ayarlandıysa mesajda, sermayenin `RISK_PCT` yüzdesini (varsayılan %1) riske edecek **lot sayısı** da gösterilir.

### Sinyal geçmişi ("zaman makinesi")

Yeni bir sinyal geldiğinde bot, o hissenin son `SIGNAL_HISTORY_YEARS` yılının (varsayılan 3) verisini çeker. Aynı kuralların bu hissede geçmişte kaç kez sinyal verdiğini ve sonuçlarını mesaja ekler:

```
📜 Geçmiş (3 yıl): 9 sinyal → 🎯 2 hedef · 🛑 3 stop · ⌛ 4 süre doldu
   Kazanma %55,6 · ortalama +2,1% (komisyon dahil)
```

Hesap backtest ile aynı varsayımları kullanır. `SIGNAL_HISTORY_YEARS=0` bu özelliği kapatır.

### Açık sinyal sınırı

Aynı anda en fazla `MAX_OPEN_SIGNALS` (varsayılan 5) açık sinyal takip edilir. Sınır doluyken gelen yeni sinyaller yine bildirilir, ama "sınır dolu" uyarısıyla gelir: lot önerilmez ve günlüğe yazılmaz. Böylece çok sinyal çıkan günlerde toplam risk sınırlı kalır. `0` değeri sınırı kaldırır.

Paneldeki **Skor** sütunu yalnızca sıralama içindir: destek, EMA, hacim ve RSI dönüşüne yakınlığı özetler. Sinyali belirlemez.

## Telegram

| Komut | Açıklama |
|---|---|
| `/alarm THYAO 320 285` | Özel hedef ve stop alarmı kurar |
| `/alarmlar` veya `/list` | Kayıtlı alarmları listeler |
| `/sil THYAO` | Alarmı siler |
| `/rapor` | Son 7 günün ve tüm zamanların sinyal performansını gösterir |

Bot ayrıca şunları otomatik gönderir:
- Bir sinyal **hedefe ulaşınca, stop olunca ya da 30 gün içinde sonuçlanmayınca** bir mesaj atar.
- **Her cuma 18:00'den sonra** haftalık performans raporu gönderir.
- **Veri alınamazsa** (XU100 verisi gelmezse ya da hisselerin yarısından fazlasında hata olursa) saatte en fazla bir kez uyarı gönderir.

Her sinyal `signals.json` dosyasındaki günlüğe kaydedilir.

## Kurulum

```bash
npm install
```

`.env` dosyası oluşturun (repoya eklemeyin):

```
TELEGRAM_BOT_TOKEN=your_token
TELEGRAM_CHAT_ID=your_chat_id

# İsteğe bağlı
CAPITAL_TL=100000        # lot hesabı için sermaye (0 = kapalı)
RISK_PCT=1               # işlem başına risk (%)
DATA_DIR=/var/data       # alarmların ve sinyal günlüğünün tutulacağı klasör
```

Diğer ayarlar ve varsayılan değerleri `lib/config.js` dosyasında.

## Çalıştırma

```bash
npm start
```

Panel: `http://localhost:10000/`  
Sağlık kontrolü: `GET` / `HEAD` `/health`

## Test

```bash
npm test
```

## Backtest

Strateji versiyonlarını geçmiş veride karşılaştırır. Canlı botla **aynı sinyal fonksiyonunu** kullanır.

```bash
npm run backtest                          # BIST 100, son 2 yıl, tüm versiyonlar
npm run backtest -- --years 3
npm run backtest -- --symbols THYAO,ASELS,BIMAS
npm run backtest -- --variants C,D --csv sonuc.csv
```

| Versiyon | İçerik |
|---|---|
| A | Eski kurallar: 10 günlük güç, RSI 50–70, filtre yok |
| B | 63 günlük güç, RSI şartı yok, filtre yok |
| C | 63 günlük güç, RSI şartı, beta, likidite ve veri filtresi |
| D | C + DÖNÜŞ modu |
| E | **Varsayılan FIRSAT:** C, ama RSI 50–70 şartı yok |

Backtest'in varsayımları:
- İşleme sinyalden sonraki günün açılışında girilir.
- Aynı gün hem stop hem hedef görülürse önce stop olduğu varsayılır.
- Pozisyon en fazla 30 gün tutulur.
- Her yönde %0,1 komisyon ve %0,1 kayma düşülür (`COMMISSION_PCT`, `SLIPPAGE_PCT`).
- Geçmiş F/K verisi olmadığı için DÖNÜŞ'ün temel analiz şartı backtest'te uygulanmaz.

İndirilen veri `.cache/backtest/` klasöründe saklanır.

İlk sonuçlar (Kasım 2024 – Kasım 2025, 99 hisse, komisyon ve kayma dahil):

| Versiyon | İşlem | Kazanma % | Ort. % | Kâr faktörü | Max düşüş % |
|---|---|---|---|---|---|
| A (eski) | 460 | 45,9 | 0,68 | 1,10 | −1097 |
| B | 478 | 50,8 | 3,61 | 1,61 | −459 |
| C | 335 | 51,3 | 3,28 | 1,59 | −352 |
| **E (varsayılan)** | 471 | 51,0 | 3,76 | 1,64 | −436 |
| D-DÖNÜŞ | 832 | 38,8 | 0,03 | 1,01 | −1843 |

Test, bugünkü BIST 100 listesiyle yapıldı. Dönem içinde iyi gidip endekse giren hisseler listede olduğu için sonuçlar olduğundan iyi görünebilir (hayatta kalma yanlılığı).

## Deploy (Render)

Docker build `node server.js` komutunu çalıştırır. Render ortam değişkenlerine `PORT`, `TELEGRAM_BOT_TOKEN` ve `TELEGRAM_CHAT_ID` eklenmeli.

Render'ın dosya sistemi kalıcı değildir. Alarmların ve sinyal günlüğünün yeniden başlatmada kaybolmaması için bir **Persistent Disk** bağlayın (ör. `/var/data`) ve `DATA_DIR=/var/data` ayarlayın.
