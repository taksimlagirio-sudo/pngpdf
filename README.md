# İndirici

Tamamen tarayıcıda çalışan, sunucuya dosya yüklemeyen küçük bir araç seti.
Netlify üzerinde statik site olarak yayınlanır.

## Bölümler

Telefonda alt sekme çubuğu, masaüstünde sol kenar çubuğu (geniş ekranda sağda indirmeler sütunu).
Koyu (varsayılan) ve açık tema; renk: sıcak grafit nötrler + lime.

| Bölüm | Ne yapar |
| --- | --- |
| **Algıla** | Yapıştırdığınız adresin ardında ne olduğunu bulur. Video/ses dosyası, HLS ya da DASH yayını (kalite, format, aralık seçimi), canlı yayın (süre sınırlı kayıt) ya da web sayfası (içindeki medya ve resimler). |
| **Resimler** | Bir sayfadaki görselleri bulur; türe göre süzer, simgeleri gizler, seçtiklerinizi ayrı ayrı dosyalar olarak (istenirse tek ZIP) indirir. Sunucuda gallery-dl kuruluysa bilinen sitelerde (Instagram, X, Pinterest, Reddit…) tam boyutlu resimleri ve galerinin tamamını o bulur. |
| **İndirmeler** | Süren kayıtlar, indirmeler, sıradakiler ve geçmiş. Aynı anda en fazla 1/2/3/5 iş; sıradakini "Şimdi başlat". |
| **Ayarlar** | Tema, varsayılan kaydetme yöntemi (İndirilenler / Galeri / Konum seç), bağlantı yöntemi, arka planda indirme, kendi sunucum. |

## Canlı yayın kaydı (başlat → süre dolunca ya da durdurunca kaydet)

Canlı bir `.m3u8` açıldığında indirme yerine kayıt ekranı çıkar:

- **Kayıt süresi:** Sınırsız, 30 dk, 1 sa, 2 sa veya özel dakika. Süre dolunca kayıt kendiliğinden
  durur ve dosya kaydedilir; **Durdur ve kaydet** ile istediğiniz an bitirebilirsiniz.
- Kayıt "şu andan itibaren"dir: playlist düzenli aralıklarla okunur, yeni parçalar sırayla dosyaya
  eklenir. Kartta geçen süre, boyut, bit hızı, kalan süre ve (varsa) kaçan parça sayısı görünür.
- **Nerede kaydedilsin:** kendi sunucunuz ayarlıysa varsayılan **Sunucumda**'dır — telefon
  kilitlense de uygulama kapansa da kayıt sürer. **Bu cihazda** seçilirse kayıt tarayıcıda yapılır;
  "Ekran kapansa da sürdür" ekran kilidini tutar (telefon ekranı kapanırsa tarayıcı sekmeyi
  dondurabilir, bu yüzden uzun kayıtlarda sunucu önerilir).
- Kayıt diğer indirmelerle aynı anda çalışır, sıra beklemez; aynı anda birden çok kayıt yapılabilir
  (sunucuda varsayılan en fazla 8 canlı kayıt ve 4 "açıp kaydet"; `MAX_RECORDINGS` / `MAX_CAPTURES`).
- **Uygulamayı alta almak kaydı durdurmaz** (sunucuda kaydederken): telefon arka plandaki sayfayı
  dondursa ya da kapatsa bile kayıt sunucuda sürer. Uygulama öne geldiğinde ya da yeniden açıldığında
  sunucudaki kayıtlarla eşitlenir; bu arada biten "açıp kaydet" videoları kendiliğinden iner.
  "Bu cihazda" kayıt tarayıcının içinde çalıştığı için uygulama alttayken durabilir; ekranda uyarı çıkar.

## Bağlantısı inmeyen videolar: otomatik "açıp kaydet"

Video algılanıp bağlantısı hata verirse (403, oturum/çerez isteyen, süreli bağlantı...) indirme
**kendiliğinden** "açıp kaydet"e geçer; ayrıca bir seçim yapılmaz:

1. Bağlantı önce kendi sunucundaki tarayıcıya istetilir (bulunduğu sayfa biliniyorsa önce o sayfa,
   yoksa sitenin ana sayfası açılır ki çerezler otursun). İstek geçerse dosya — HLS ise parçaları, ayrı
   ses dahil — tarayıcının o isteğindeki başlık ve çerezlerle **oynatılmadan** indirilir; kodek desteği
   gerekmez. Devtools'tan kopyalanan uzantısız bağlantılar (`…/videoplayback?…`, `…/get_file/…`) da
   video sayılır. Olmazsa video temiz bir oynatıcıda, o da olmazsa sayfanın kendisinde oynatılır.
2. Video sessiz ve hızlandırılmış (16 kata kadar) oynatılır; oynatıcının yüklediği veri yakalanır.
   İndirmeler'de kayıt süresi hızla dolar. Ekran filme alınmadığı için dosya **normal hızda, orijinal
   kalitede ve sesli** çıkar; düz video dosyalarında dosya tarayıcının oturumuyla indirilir.
3. Video kendiliğinden başlamazsa kartta **Videoyu başlat** çıkar: sayfanın görüntüsüne dokunup
   oynata basarsın, video başladığı an kayıt kendiliğinden başlar.
4. Bitince dosya bu cihaza normal bir indirme gibi iner (İndirilenler / Galeri).

Olmazsa video inmemiş görünür ve nedeni yazar: DRM koruması, erişim reddi (HTTP 403), bağlantının
süresinin dolması (404), kodek desteği, sayfada video olmaması ya da videonun başlatılmaması.
Bağlantı sunucudan reddediliyorsa (süreli/imzalı, IP'ye ya da sitenin oturumuna bağlı) kartta videonun
**bulunduğu sayfa** adresi verilebilir; o sayfanın çerez ve Referer'ıyla yeniden denenir. Yine olmazsa
**Telefonda aç** bağlantıyı telefonun kendi tarayıcısında (kendi IP'si ve oturumuyla) açar.
Sayfada video bağlantısı hiç bulunamazsa **Videoyu kaydet** düğmesi aynı yolu elle başlatır.
Bu özellik için Ayarlar → Kendi sunucum gerekir (ayrıntılar: `render-server/README.md`).

## Reklam engelleme

Sunucudaki tarayıcı reklamları engeller (`@ghostery/adblocker`, EasyList tabanlı listeler; video
reklam SDK'ları dahil — kurulu değilse yerleşik reklam alan adı listesi). Böylece sayfa taramasında
reklam videoları listeye düşmez, oynatıcı reklamla oyalanmaz, kayıtta yalnızca asıl videonun verisi
alınır (reklamın ayrı oynatıcısındaki veri ayıklanır). Açılır pencereler kapatılır; oynat düğmesine basınca
sayfa reklama yönlendirilirse geçiş engellenir ya da videonun sayfasına geri dönülüp düğmeye yeniden
basılır. Engellenen reklam sayısı kayıt kartında yazar. Ayarlar → Reklam engelleme bölümü durumu ve
engelleyicinin neyi görüp neyi görmediğini gösterir (yalnızca sunucunun açtığı sayfalar; telefonundaki
tarayıcı, dosyaların ve ayarların değil; listeler GitHub'dan indirilir, adresler hiçbir yere gönderilmez).

## DASH (.mpd)

DASH bildirimleri de HLS gibi açılır: kaliteler (720p, 360p…), süre, boyut tahmini ve aralık seçimi
aynı ekranda. Ayrı gelen görüntü ve ses indirilip tek, sarılabilir MP4'te birleştirilir (yeniden
kodlama yok). Desteklenen adreslemeler: `SegmentTemplate` (`$Number$` / `$Time$`, `SegmentTimeline`),
`SegmentList` (bayt aralıklı tek dosya dahil), `SegmentBase` (tek dosya; parçalar `sidx`'ten), birden
çok `Period`. Yalnızca MP4 (fMP4) akışlar; DRM'li (Widevine/PlayReady) ve canlı DASH indirilmez.
Önizleme gösterilmez (tarayıcı DASH'i kendi oynatamaz).

## HLS: önizleme, kalite, ses ve aralık

- **Önizleme:** algılanan yayın uygulamanın içinde oynatılır (hls.js, `assets/vendor/hls.min.js`);
  doğrudan erişilemeyen yayınlar kendi sunucun üzerinden oynatılır. İndirme kartındaki küçük resim
  önizlemeden alınır.
- **Kalite:** yalnızca görüntü içeren kaliteler listelenir (1080p, 720p...). Yalnızca ses olan
  "kaliteler" ve kalite parçaları gösterilmez.
- **Ses ayrı gelirse** (`EXT-X-MEDIA TYPE=AUDIO`): ses izi de indirilip görüntüyle **tek dosyada
  birleştirilir**.
- **Çıktı her zaman tek MP4'tür** ve normal (parçalı olmayan) MP4 olarak yazılır: süre doğru görünür,
  ileri-geri sarılabilir, zaman çizelgesi indirmenin/kaydın başladığı andan (0:00) başlar. TS
  parçaları yeniden kodlanmadan çevrilir (`assets/vendor/mux-mp4.min.js`), MP4'ü
  `assets/js/mp4mux.mjs` kurar (render-server da aynı dosyayı kullanır).
- **Aralık:** tamamlanmış yayının yalnızca bir bölümünü (ör. `0:12:00 – 0:20:30`) indirir.
- Süren bir indirme de **Durdur ve kaydet** ile o ana kadar inen kısmı kaydedebilir.
- Sayfada bulunan bağlantılar yoklanır: yalnızca görüntüsü olan ve açılabilen yayınlar listelenir,
  her birinin küçük resmi ve süresi gösterilir; önizlemesi oynamayanlar ayrıca gösterilebilir.

## Telefonda uygulama gibi kullanma (PWA)

- **Android/Chrome:** Ayarlar → **Ana ekrana ekle** (veya tarayıcı menüsünden "Uygulamayı yükle").
- **iOS/Safari:** **Paylaş → Ana Ekrana Ekle**.
- Eklendikten sonra tam ekran açılır, çevrimdışıyken de arayüz yüklenir (service worker kabuk önbelleği).
- **Paylaş hedefi:** başka bir uygulamadan bir bağlantıyı paylaşırken listede bu uygulama çıkar; paylaşılan adres
  doğrudan "Algıla" sekmesine düşer ve otomatik analiz edilir.
- Ana ekran simgesine uzun basınca "Algıla / Resimler / İndirmeler" kısayolları gelir.

## İçerik algılama

"Algıla" sekmesine herhangi bir adres yapıştırın:

- İlk 64 KB indirilip **başlıklar + magic number** ile tür belirlenir (mp4, mov, webm, mp3, m4a, wav, flac, ogg,
  png, jpg, gif, webp, pdf, zip, MPEG-TS, m3u8, mpd, html).
- Resimlerde önizleme ve piksel boyutu gösterilir; **videolarda oynatıcıdan bir kare yakalanıp küçük
  önizleme (poster) üretilir** ve bu görsel indirme çubuğunda da kullanılır. Süre ve çözünürlük okunur.
  (Doğrudan erişimde CORS izni yoksa kare kendi sunucun üzerinden alınır; HLS yayınlarında kare üretilmez.)
- HLS'te parça sayısı, süre, kapsayıcı (TS/fMP4) ve şifreleme durumu gösterilir.
- Adres bir **web sayfasıysa** sayfanın tamamı indirilip medya aranır: düz adresler, `src`/`href`/`content`/
  `data-*` nitelikleri, JSON içindeki kaçışlı adresler (`http:\/\/…`, `\u002F`) ve oynatıcı
  yapılandırmalarındaki `file`/`hlsUrl`/`playbackUrl` gibi anahtarlar taranır (m3u8, mpd, mp4, webm, mov,
  mkv, mp3, m4a, aac, ogg, wav, flac). Sayfada bir şey çıkmazsa sayfanın yüklediği ilk birkaç **script
  dosyası** da taranır. **Tek bir medya bulunursa doğrudan o açılır**, birkaç tane varsa liste çıkar;
  `<iframe>` gömülüleri de taranmak üzere listelenir.
- Medya JavaScript ile çalışma anında üretiliyorsa (ya da YouTube/Vimeo gibi platformlarda) kaynak
  taramada çıkmaz; bu durumda ne yapılacağı (tarayıcının Ağ sekmesinden .m3u8/.mp4 adresini kopyalama)
  ekranda yazar.
- **DRM korumalı** yayınlarda indirme düğmesi çıkmaz, sebebi yazılır.
- Master playlist algılanırsa kalite listesi çıkar; seçtiğiniz kalite indirilir.

## İndirmeler, kuyruk ve galeriye kaydetme

- Tüm işler **İndirmeler** bölümünde: süren kayıtlar (kırmızı kart), indirmeler (yüzde, hız, kalan süre),
  sıradakiler ve geçmiş. Telefonda diğer bölümlerdeyken sekme çubuğunun üstündeki şerit süren işleri gösterir;
  geniş masaüstü ekranında sağ sütunda durur.
- **Aynı anda en fazla** 1/2/3/5 iş çalışır, fazlası sıraya girer ("Sıraya ekle" ya da sınır dolunca).
  Sıradaki bir işi **Şimdi başlat** ile beklemeden başlatabilirsiniz. Canlı kayıtlar sıra beklemez.
- **Kaydet** yöntemi: *İndirilenler* (bitince indirilir), *Galeri* (bitince **Galeriye** düğmesi sistem
  paylaşım sayfasını açar → Fotoğraflar/Galeri) ya da *Konum seç* (dosya doğrudan diske yazılır).
- İndirme veya kayıt sürerken ekran kilidi tutulur (Ayarlar'dan kapatılabilir); sayfa yanlışlıkla
  kapatılmak istenirse uyarı çıkar. Bildirim izni verildiyse uygulama arka plandayken biten işler bildirilir.
- **🌙 Arka planda indir** (varsayılan **kapalı**, isteğe bağlı) seçiliyken indirme service worker'a devredilir
  (Background Fetch): uygulamayı kapatsanız bile sürer ve Android'de sistem indirme çubuğunda görünür.
  Kaynak siteye tarayıcıdan doğrudan erişilemiyorsa (CORS) arka plan isteği kendi sunucun üzerinden yapılır.
  Bu yol her sitede çalışmaz; bu yüzden **otomatik yedeklemesi** var: arka plan başarısız olursa ya da 25
  saniye ilerleme olmazsa indirme kendiliğinden normal (uygulama açıkken) yola geçer, İndirmeler'de de
  **Normal indir** düğmesi çıkar. Yani arka plan denemesi indirmeyi asla yarıda bırakmaz. Bittiğinde uygulamaya döndüğünüzde
  İndirmeler'de **Kaydet** olarak belirir (dosya, siz kaydedene kadar önbellekte durur).
- HLS indirmeleri arka plana (Background Fetch) devredilmez: ses/görüntü birleştirme ve MP4'e
  çevirme uygulama içinde yapılır; indirme sürerken ekran kilidi (wake lock) alınır.
- Background Fetch'i desteklemeyen tarayıcılarda (Safari, Firefox) seçenek pasifleşir, indirme normal şekilde
  uygulama açıkken yapılır.

## Diğer uygulamaların üstünde yüzen mini pencere

Web sayfaları Android'deki gibi sistem üstü bir katman (overlay) çizemez; tarayıcıların böyle bir API'si yok.
En yakın yol **resim-içinde-resim (PiP)**: indirme durumu bir canvas'a çizilip video akışına çevriliyor ve
PiP penceresinde gösteriliyor. Android Chrome'da bu pencere uygulamadan çıkınca da **diğer uygulamaların
üstünde yüzer**; masaüstü Chrome'da diğer pencerelerin üstünde kalır.

- **İndirmeler** başlığındaki **Üstte göster** düğmesiyle açılır (masaüstünde sağ sütunda da var).
  Tarayıcı izni gereği açmak için bir dokunuş şarttır.
- Pencerede dosya adı, yüzde, ilerleme çubuğu ve hız görünür; canlı kayıt sürerken kayıt süresi,
  kalan süre ve diğer indirmelerin hızı gösterilir.
- iOS Safari'de canvas akışıyla PiP desteklenmediği için düğme görünmez.
- Sekme tamamen arka planda kalırsa tarayıcı zamanlayıcıları yavaşlatabilir; bu yüzden **gerçek** arka plan
  göstergesi Background Fetch'in Android sistem bildirimidir. Yüzen pencere onun görsel tamamlayıcısıdır.
- Sistem seviyesinde gerçek bir "diğer uygulamaların üstünde çubuk" (SYSTEM_ALERT_WINDOW) yalnızca yerel bir
  Android uygulamasıyla (TWA/Capacitor sarmalayıcı + overlay izni) mümkündür; bu depo saf web uygulamasıdır.

## HLS hakkında

- Parçalar 4'lü paralellikle indirilir, başarısız parça 3 kez denenir.
- `#EXT-X-KEY:METHOD=AES-128` ile şifreli yayınlar WebCrypto ile çözülür (anahtar playlist'te açıkça verildiği için).
- `SAMPLE-AES`, Widevine, FairPlay gibi **DRM korumalı yayınlar desteklenmez** ve hata mesajıyla reddedilir.
- "Konum seç" kullanılmıyorsa dosya bellekte birleştirilir (büyük parçalar Blob'a katlanır); çok uzun yayınlarda "Konum seç" ya da sunucuda kayıt daha güvenlidir.

## CORS ve gizlilik

Tarayıcı, CORS izni vermeyen sitelerden dosya okuyamaz. Bu durumda indirme yalnızca **kendi
sunucun** (aşağıda) üzerinden yapılır; başka bir aracı yok. Netlify yalnızca sitenin dosyalarını
barındırır, indirmeler oradan geçmez.

- Kendi sunucun ayarlı değilse yalnızca doğrudan inebilen dosyalar iner; CORS'a kapalı sitede
  "Kendi sunucum'u ayarla" uyarısı çıkar.
- Sunucun ayarlı ama kapalıysa (bilgisayar uykuda vb.) bu tür indirmeler hata verir, başka bir
  yere düşmez.

Her indirme sekmesinde bağlantı yöntemi seçilebilir: *Otomatik* (önce doğrudan, olmazsa kendi
sunucum), *Sadece doğrudan*, *Sadece kendi sunucum*.

## Kendi sunucum (render sunucusu)

Statik sayfa taraması JavaScript çalıştırmadığı için oynatma anında üretilen video adreslerini
göremez. [`render-server/`](render-server/README.md) kendi bilgisayarında (veya Termux ile
telefonda) çalışan küçük bir sunucudur: sayfayı gerçek bir Chromium'da açıp attığı medya
isteklerini toplar. **Ayarlar → Kendi sunucum** bölümüne adresini ve token'ını girince:

- **Ayarlar → "Bilinen sitelerde yt-dlp kullan"** açıksa (varsayılan kapalı) ve sunucuda yt-dlp kuruluysa sayfa önce ona sorulur: bilinen sitelerde (YouTube, Vimeo, Instagram…)
  videonun kalite listesi gelir; ayrı gelen görüntü ve ses telefonda tek MP4'te birleştirilir. yt-dlp
  yalnızca adresleri bulur, indirme ve ekranlar İndirici'nindir (ayrıntı: render-server/README.md).
- Sayfa linkleri (paylaşılanlar dahil) bu sunucuda çalıştırılır; bulunan medya, statik taramanın
  buldukları ile birleştirilir. Tek medya bulunursa doğrudan o açılır.
- Site dışarıdan çekilmeyi tamamen reddediyorsa da sayfa doğrudan sunucuda açılmayı dener.
- Oynatıcı tıklama, onay ya da kod bekliyorsa **👆 Sayfayı aç, kendim dokunayım**: sunucudaki
  sayfanın canlı görüntüsüne dokunarak adımları kendin geçersin, gelen medya listelenir.
- **Girişler saklanır:** bu ekranda bir siteye bir kez giriş yaparsan çerezler sunucuda
  (`render-server/.logins.json`) saklanır; o sitenin sayfaları ve videoları sonra (sunucu yeniden
  başlasa da) girişli açılır, kaydedilir. **Ayarlar → Sitelere girişler**'den site site çıkış yapılır;
  hiç saklanmasın istersen sunucuyu `SAVE_LOGINS=0` ile başlat.
- CORS'a kapalı sitelerden indirmeler bu sunucu üzerinden yapılır: süre sınırı yok, medyayı
  açan sayfanın `Referer`'ı iletilir.

Sunucu uygulamanın kendisini de sunar: `http://127.0.0.1:8787/` adresinden açınca token'ı
kendiliğinden alır, hiçbir şey girmen gerekmez. Telefonda Termux ile kurup otomatik başlatmayı
açarsan, Termux'u açmak yeterli olur: sunucu başlar ve İndirici Chrome'da açılır. Başka bir
cihazdan (ör. Netlify'daki siteden bilgisayardaki sunucuya) bağlanmak için ise https adres ve
token gerekir (Tailscale önerilir). Ayrıntılar `render-server/README.md`'de.

## Tarayıcı eklentisi

[`extension/`](extension/README.md) Chrome/Edge için paketlenmemiş bir geliştirici uzantısıdır:
açık sekmenin gerçek ağ isteklerinden medyayı yakalar, canlı HLS yayınını "şu andan itibaren"
kaydedebilir ve senin oturumunla çalıştığı için giriş gerektiren sayfalarda da işe yarar.
Android Chrome eklenti desteklemediği için masaüstü içindir.

## Yerel çalıştırma

```bash
npx serve .            # veya python3 -m http.server
```


## Dosya yapısı

```
index.html                    # bölümler (Algıla, Resimler, İndirmeler, Ayarlar) + sekme/kenar çubuğu
manifest.webmanifest          # PWA tanımı (ikonlar, paylaş hedefi, kısayollar)
sw.js                         # service worker: çevrimdışı kabuk + Background Fetch
assets/css/style.css          # tasarım: tema değişkenleri, telefon + masaüstü yerleşimi
assets/icons/                 # uygulama ikonu (svg + PWA png'leri)
assets/vendor/mux-mp4.min.js  # mux.js (TS → MP4 dönüştürme, Apache-2.0)
assets/vendor/hls.min.js      # hls.js (önizleme, Apache-2.0)
assets/js/app.js              # kabuk: bölümler, tema, PWA kurulumu, paylaşım hedefi
assets/js/prefs.js            # tercihler (tema, kaydetme, bağlantı, eşzamanlılık)
assets/js/downloads.js        # iş kuyruğu, kayıt kartları, İndirmeler ekranı, hedefe yazma, arka plan
assets/js/hls.js              # m3u8 ayrıştırma (kalite, ayrı ses), VOD indirme (aralık), canlı kayıt
assets/js/mp4mux.mjs          # parçalardan sarılabilir MP4 kurucu (uygulama + render-server)
assets/js/preview.js          # yayın önizlemesi (hls.js), küçük resim/süre yoklama
assets/js/serverrec.js        # canlı kaydı kendi sunucunda başlatma/izleme
assets/js/detect.js           # tür/format algılama, sayfadaki medya ve resimleri bulma
assets/js/detect-tab.js       # Algıla ekranı
assets/js/images.js           # Resimler ekranı
assets/js/zip.js              # sıkıştırmasız ZIP üretici
assets/js/settings.js         # Ayarlar ekranı + kendi sunucum
assets/js/floatbar.js         # PiP ile yüzen mini indirme/kayıt penceresi
assets/js/remote.js           # "Sayfayı aç, kendim dokunayım"
assets/js/video.js            # doğrudan dosya indirici
assets/js/util.js             # ortak yardımcılar (fetch, akış, biçimleme)
render-server/                # render + indirme proxy + canlı kayıt + sunucuda oynatıp kaydetme
extension/                    # Chrome/Edge geliştirici uzantısı (ağ isteklerinden medya yakalama)
```

## Sorumluluk

Araçlar yalnızca indirme hakkına sahip olduğunuz içerikler için kullanılmalıdır.
DRM korumalı yayınlar desteklenmez.
