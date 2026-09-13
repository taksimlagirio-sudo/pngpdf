# Dönüştürücü & İndirici

Tamamen tarayıcıda çalışan, sunucuya dosya yüklemeyen küçük bir araç seti.
Netlify üzerinde statik site olarak yayınlanır.

## Sekmeler

| Sekme | Ne yapar |
| --- | --- |
| 🔎 **Algıla** | Yapıştırdığınız adresin ardında ne olduğunu bulur (tür, format, boyut, çözünürlük/süre, şifreleme), önizleme gösterir ve uygun indirme yolunu sunar. |
| 📄 **PDF** | Seçtiğiniz resimleri tek tek PDF'e çevirir, yeni sekmede açar veya indirir. Kalite kaydırıcısıyla dosya boyutunu ayarlarsınız. |
| 🖼️ **JPG / PNG** | Resimleri JPG, PNG veya WEBP olarak yeniden kaydeder. Kalite ve maksimum genişlik (yeniden boyutlandırma) ayarlanabilir; resim bir adresten de eklenebilir. |
| 🎬 **MP4** | Doğrudan dosya bağlantılarını (mp4, webm, mp3, jpg...) ilerleme çubuğuyla indirir. |
| 📡 **HLS** | `.m3u8` yayınlarını indirir: master playlist'te kalite seçtirir, parçaları paralel indirip tek dosyada birleştirir. |

## Telefonda uygulama gibi kullanma (PWA)

- **Android/Chrome:** site açıkken üstteki **📲 Ana ekrana ekle** düğmesi (veya menüden "Uygulamayı yükle").
- **iOS/Safari:** **Paylaş → Ana Ekrana Ekle**.
- Eklendikten sonra tam ekran açılır, çevrimdışıyken de arayüz yüklenir (service worker kabuk önbelleği).
- **Paylaş hedefi:** başka bir uygulamadan bir bağlantıyı paylaşırken listede bu uygulama çıkar; paylaşılan adres
  doğrudan "Algıla" sekmesine düşer ve otomatik analiz edilir.
- Ana ekran kısayolundan uzun basınca "Algıla / MP4 / HLS / Resim" kısayolları gelir.

## İçerik algılama

"Algıla" sekmesine herhangi bir adres yapıştırın:

- İlk 64 KB indirilip **başlıklar + magic number** ile tür belirlenir (mp4, mov, webm, mp3, m4a, wav, flac, ogg,
  png, jpg, gif, webp, pdf, zip, MPEG-TS, m3u8, mpd, html).
- Resimlerde önizleme ve piksel boyutu gösterilir; **videolarda oynatıcıdan bir kare yakalanıp küçük
  önizleme (poster) üretilir** ve bu görsel indirme çubuğunda da kullanılır. Süre ve çözünürlük okunur.
  (Doğrudan erişimde CORS izni yoksa kare proxy üzerinden alınır; HLS yayınlarında kare üretilmez.)
- HLS'te parça sayısı, süre, kapsayıcı (TS/fMP4) ve şifreleme durumu gösterilir.
- Adres bir **web sayfasıysa** indirme kapatılır ve sayfa kaynağındaki `.m3u8`, `.mp4`, `.webm`, `.mp3`
  bağlantıları listelenir; birine dokunup onu analiz edebilirsiniz.
- **DRM korumalı** yayınlarda indirme düğmesi çıkmaz, sebebi yazılır.
- Master playlist algılanırsa kalite listesi çıkar; seçtiğiniz kalite indirilir.

## Arka planda indirme, alt çubuk ve galeriye kaydetme

- Ekranın altındaki **mini görev çubuğu** tüm indirmeleri sekmeden bağımsız gösterir. Dokununca liste açılır;
  her satırda küçük önizleme, ad, yüzde, hız ve kalan süre, ayrıca iptal düğmesi vardır. Biten işler
  **indirme geçmişi** olarak listede kalır (en fazla 12 kayıt, "Kapat" ile silinir).
- Biten bir dosyada **📤 Galeriye kaydet** düğmesi çıkar: Web Share ile sistem paylaşım sayfası açılır,
  oradan Fotoğraflar/Galeri veya Dosyalar'a kaydedebilirsiniz (Android ve iOS'ta çalışır; masaüstü
  tarayıcılarda düğme görünmez).
- Resim dönüştürme ve PDF indirmeleri de çubukta görünür; onlar da paylaşılabilir.
- **🌙 Arka planda indir** (varsayılan **kapalı**, isteğe bağlı) seçiliyken indirme service worker'a devredilir
  (Background Fetch): uygulamayı kapatsanız bile sürer ve Android'de sistem indirme çubuğunda görünür.
  Kaynak siteye tarayıcıdan doğrudan erişilemiyorsa (CORS) arka plan isteği `/api/proxy` üzerinden yapılır.
  Bu yol her sitede çalışmaz; bu yüzden **otomatik yedeklemesi** var: arka plan başarısız olursa ya da 25
  saniye ilerleme olmazsa indirme kendiliğinden normal (uygulama açıkken) yola geçer, çubukta da
  **⚡ Normal indir** düğmesi çıkar. Yani arka plan denemesi indirmeyi asla yarıda bırakmaz. Bittiğinde uygulamaya döndüğünüzde
  alt çubukta **💾 Kaydet** olarak belirir (dosya, siz kaydedene kadar önbellekte durur).
- HLS'te arka plan yalnızca şifresiz, canlı olmayan ve 400 parçadan kısa yayınlarda kullanılır; diğerlerinde
  indirme uygulama açıkken sürer ve destekleyen cihazlarda ekran kilidi (wake lock) alınır.
- Background Fetch'i desteklemeyen tarayıcılarda (Safari, Firefox) seçenek pasifleşir, indirme normal şekilde
  uygulama açıkken yapılır.

## Diğer uygulamaların üstünde yüzen mini pencere

Web sayfaları Android'deki gibi sistem üstü bir katman (overlay) çizemez; tarayıcıların böyle bir API'si yok.
En yakın yol **resim-içinde-resim (PiP)**: indirme durumu bir canvas'a çizilip video akışına çevriliyor ve
PiP penceresinde gösteriliyor. Android Chrome'da bu pencere uygulamadan çıkınca da **diğer uygulamaların
üstünde yüzer**; masaüstü Chrome'da diğer pencerelerin üstünde kalır.

- İki yerden açılır: **Algıla** sekmesinin en üstünde, "Bağlantıyı yapıştırın" alanının hemen üstündeki
  **🪟 Üstte göster** düğmesi (her zaman görünür, indirme olmasa da açılır) ve indirme sürerken alt çubuktaki
  **🪟** düğmesi. Tarayıcı izni gereği açmak için bir dokunuş şarttır.
- Pencerede dosya adı, yüzde, ilerleme çubuğu ve hız/kalan süre görünür; bittiğinde yeşile döner.
- iOS Safari'de canvas akışıyla PiP desteklenmediği için düğme görünmez.
- Sekme tamamen arka planda kalırsa tarayıcı zamanlayıcıları yavaşlatabilir; bu yüzden **gerçek** arka plan
  göstergesi Background Fetch'in Android sistem bildirimidir. Yüzen pencere onun görsel tamamlayıcısıdır.
- Sistem seviyesinde gerçek bir "diğer uygulamaların üstünde çubuk" (SYSTEM_ALERT_WINDOW) yalnızca yerel bir
  Android uygulamasıyla (TWA/Capacitor sarmalayıcı + overlay izni) mümkündür; bu depo saf web uygulamasıdır.

## Yerele kaydetme

- **💾 Doğrudan seçtiğim konuma kaydet** seçiliyse File System Access API ile dosya konumu sorulur ve veri
  indirilirken parça parça diske yazılır — büyük videolarda bellek şişmez.
- Desteklenmeyen tarayıcılarda (ör. iOS Safari) seçenek pasifleşir; dosya normal şekilde "İndirilenler"
  klasörüne kaydedilir.

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
index.html                    # sekmeli arayüz + alt görev çubuğu
manifest.webmanifest          # PWA tanımı (ikonlar, paylaş hedefi, kısayollar)
sw.js                         # service worker: çevrimdışı kabuk + Background Fetch
assets/css/style.css
assets/icons/                 # PWA ikonları (192, 512, maskable, apple-touch)
assets/js/app.js              # sekmeler, PWA kurulumu, paylaşım hedefi
assets/js/util.js             # ortak yardımcılar (fetch, akış, canvas)
assets/js/downloads.js        # indirme yöneticisi, alt çubuk, diske yazma, arka plan
assets/js/detect.js           # tür/format algılama (magic number + başlıklar)
assets/js/detect-tab.js       # "Algıla" sekmesi arayüzü
assets/js/floatbar.js         # PiP ile yüzen mini indirme penceresi
assets/js/pdf.js              # resim -> PDF
assets/js/image.js            # resim -> JPG/PNG/WEBP
assets/js/video.js            # doğrudan dosya indirici
assets/js/hls.js              # m3u8 ayrıştırma + parça birleştirme
netlify/functions/proxy.mjs   # CORS proxy'si
```

> Service worker ve Background Fetch yalnızca **HTTPS** (veya localhost) üzerinde çalışır; Netlify'da
> yayınlandığında bu koşul sağlanır.

## Sorumluluk

Araçlar yalnızca indirme hakkına sahip olduğunuz içerikler için kullanılmalıdır.
DRM korumalı yayınlar desteklenmez.
