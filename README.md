# Dönüştürücü & İndirici

Tamamen tarayıcıda çalışan, sunucuya dosya yüklemeyen küçük bir araç seti.
Netlify üzerinde statik site olarak yayınlanır.

## Sekmeler

| Sekme | Ne yapar |
| --- | --- |
| 📄 **PDF** | Seçtiğiniz resimleri tek tek PDF'e çevirir, yeni sekmede açar veya indirir. Kalite kaydırıcısıyla dosya boyutunu ayarlarsınız. |
| 🖼️ **JPG / PNG** | Resimleri JPG, PNG veya WEBP olarak yeniden kaydeder. Kalite ve maksimum genişlik (yeniden boyutlandırma) ayarlanabilir; resim bir adresten de eklenebilir. |
| 🎬 **MP4** | Doğrudan dosya bağlantılarını (mp4, webm, mp3, jpg...) ilerleme çubuğuyla indirir. |
| 📡 **HLS** | `.m3u8` yayınlarını indirir: master playlist'te kalite seçtirir, parçaları paralel indirip tek dosyada birleştirir. |

## HLS hakkında

- **Master playlist** verilirse çözünürlük/bit hızı listesi çıkar, birini seçersiniz.
- Parçalar 4'lü paralellikle indirilir, başarısız parça 3 kez denenir.
- `#EXT-X-KEY:METHOD=AES-128` ile şifreli yayınlar WebCrypto ile çözülür (anahtar playlist'te açıkça verildiği için).
- `SAMPLE-AES`, Widevine, FairPlay gibi **DRM korumalı yayınlar desteklenmez** ve hata mesajıyla reddedilir.
- Çıktı: fMP4 (`#EXT-X-MAP` içeren) yayınlar `.mp4`, klasik TS yayınlar `.ts` olarak kaydedilir. `.ts` dosyaları VLC ve çoğu oynatıcıda doğrudan açılır; MP4'e çevirmek isterseniz `ffmpeg -i video.ts -c copy video.mp4` yeterlidir (tarayıcıda remux yapılmaz).
- Video tamamen bellekte birleştirildiği için çok uzun yayınlarda tarayıcı belleği sınır olabilir.

## CORS proxy'si

Tarayıcı, CORS izni vermeyen sitelerden dosya okuyamaz. Bunun için `netlify/functions/proxy.mjs`
içinde bir yedek proxy var (`/api/proxy?url=...`):

- Sadece `GET`/`HEAD` ve sadece `http`/`https`.
- `localhost`, özel IP aralıkları (10/8, 172.16/12, 192.168/16, 127/8, CGNAT), `169.254.169.254` gibi
  bulut metadata adresleri ve `.local`/`.internal` alan adları engellenir; alan adı özel bir IP'ye
  çözülüyorsa da reddedilir. Yönlendirmeler adım adım aynı kontrolden geçer (en fazla 5 adım).
- `Range` başlığı iletilir, `set-cookie` gibi başlıklar geri aktarılmaz, `content-length` 200 MB'ı aşarsa 413 döner.
- Netlify fonksiyonlarının çalışma süresi sınırlı olduğundan proxy **yedek** yoldur; büyük videolarda
  "doğrudan" modu tercih edin.

Her indirme sekmesinde bağlantı yöntemi seçilebilir: *Otomatik* (önce doğrudan, hata olursa proxy),
*Sadece doğrudan*, *Sadece proxy*.

## Yerel çalıştırma

```bash
npx serve .            # veya python3 -m http.server
```

Proxy fonksiyonunu da denemek için:

```bash
npx netlify dev
```

## Dosya yapısı

```
index.html                    # sekmeli arayüz
assets/css/style.css
assets/js/app.js              # sekme yönetimi
assets/js/util.js             # ortak yardımcılar (fetch, indirme, canvas)
assets/js/pdf.js              # resim -> PDF
assets/js/image.js            # resim -> JPG/PNG/WEBP
assets/js/video.js            # doğrudan dosya indirici
assets/js/hls.js              # m3u8 ayrıştırma + parça birleştirme
netlify/functions/proxy.mjs   # CORS proxy'si
```

## Sorumluluk

Araçlar yalnızca indirme hakkına sahip olduğunuz içerikler için kullanılmalıdır.
DRM korumalı yayınlar desteklenmez.
