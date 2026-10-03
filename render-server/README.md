# İndirici render sunucusu

İndirici'ye bir sayfa linki verdiğinde site, sayfanın HTML'ini metin olarak tarar; JavaScript
çalıştırmadığı için oynatma anında üretilen video adreslerini göremez. Bu küçük sunucu **senin
cihazında** çalışır ve sayfayı gerçek (görünmez) bir Chromium'da açar, sayfanın attığı medya
isteklerini toplar ve İndirici'ye listeler. Yani link paylaşmak, tarayıcı eklentisine yakın sonuç verir.

Ek olarak süre sınırı olmayan bir indirme proxy'si sunar: İndirici, CORS'a kapalı dosyaları
yalnızca bunun üzerinden indirir (başka bir aracı yok; Netlify sadece siteyi barındırır). Medyayı
ilk açan sayfanın `Referer` başlığını hatırlayıp iletir; "başka siteden gelen isteği reddeden"
CDN'ler de böylece çalışır.

## Kurulum (bilgisayar: Windows / macOS / Linux)

Node.js 18 veya üstü gerekir.

```bash
cd render-server
npm install
npx playwright-core install chromium   # ya da kurulu Chrome'u kullanmak için CHROME_PATH=... ver
npm start
```

Açılışta token yazdırılır ve `render-server/.render-token` dosyasına kaydedilir (yeniden
başlatınca değişmez). Kendi token'ını vermek için `RENDER_TOKEN=... npm start`.

## Başka cihazdan bağlanma (bilgisayardaki sunucuya telefondan)

Netlify'daki İndirici `https` üzerinde çalıştığı için tarayıcı, düz `http://192.168.x.x:8787` gibi bir adrese
isteği **engeller** (karışık içerik). Sunucuya https bir adresten ulaşman gerekir:

**Tailscale (önerilen, ücretsiz):**
1. Bilgisayara ve telefona Tailscale'i kur, aynı hesapla giriş yap.
2. Tailscale yönetim panelinde MagicDNS ve HTTPS sertifikalarını aç.
3. Bilgisayarda: `tailscale serve --bg 8787` (eski sürümlerde komut biraz farklı olabilir).
4. Çıkan `https://<bilgisayar-adı>.<tailnet>.ts.net` adresini İndirici → Algıla →
   **🖥️ Kendi sunucum** bölümüne token'la birlikte gir, **Kaydet ve test et**.

Sunucu yalnızca Tailscale ağındaki cihazlarından erişilebilir olur; internete açılmaz.

**Cloudflare Tunnel (alternatif):** `cloudflared tunnel --url http://127.0.0.1:8787` geçici bir
https adresi verir. Bu adres internete açıktır; koruma yalnızca token'dır.

## Kurulum (telefonun kendisi: Android + Termux) — önerilen

Sunucu telefonda çalışınca İndirici'nin kendisi de ondan açılır (`http://127.0.0.1:8787/`):
token girmek, Tailscale veya Netlify gerekmez.

1. Termux'u **F-Droid**'den kur (Play Store sürümü eski ve güncellenmiyor).
2. Termux'ta (bir kez):
   ```bash
   pkg update
   pkg install git nodejs x11-repo
   pkg install chromium
   git clone https://github.com/taksimlagirio-sudo/pngpdf
   cd pngpdf/render-server
   sh termux-autostart.sh
   sh start-termux.sh
   ```
   `termux-autostart.sh`, Termux her açıldığında sunucuyu başlatacak satırı `~/.bashrc`'ye ekler.
   İsteğe bağlı ama önerilir: `pkg install python && pip install "yt-dlp[default]" gallery-dl`
   (aşağıda "yt-dlp" ve "gallery-dl").
   `start-termux.sh` Chromium'u bulur, bağımlılıkları kurar, telefonun uyutmasını engeller
   (`termux-wake-lock`), sunucuyu başlatır ve İndirici'yi Chrome'da açar.
3. Bundan sonra: **Termux'u aç → İndirici kendiliğinden açılır.** Algıla → 🖥️ Kendi sunucum
   rozeti "açık" görünür; hiçbir şey girmen gerekmez.
4. Termux'u kapatma; arkada açık kalsın. Android ayarlarında Termux için pil optimizasyonunu
   kapatırsan arka planda öldürülmez. Sunucuyu durdurmak için Termux'ta Ctrl+C.

- Ana ekrana eklemek için: uygulama açıkken Chrome menüsü → **Ana ekrana ekle**. Bu kısayol
  sunucu kapalıyken açılmaz (önce Termux'u aç).
- Termux'ta komut yazmak için yeni oturum açarsan (sol kenardan kaydır → New session) sunucu
  "zaten çalışıyor" der ve o oturumda komut yazmaya devam edebilirsin.
- Otomatik başlatmayı kaldırmak: `sh termux-autostart.sh kaldir`.
- Güncellemek için: `cd ~/pngpdf && git pull`, sonra Termux'u kapatıp yeniden aç.
- Adres değiştiği için tarayıcı bunu ayrı bir site sayar: Netlify sürümündeki indirme geçmişi
  buraya taşınmaz. Ana ekrana eklenen bu sürüm Android'in paylaş menüsünde görünmeyebilir;
  o durumda linki kopyalayıp **📋 Yapıştır ve algıla**'yı kullan.

Notlar:
- Playwright, Termux'u resmi olarak desteklemiyor; `npx playwright-core install chromium`
  orada çalışmaz, bu yüzden Termux'un kendi `chromium` paketi kullanılıyor. Android'de Chromium
  kum havuzu desteklemediği için sunucu onu otomatik `--no-sandbox` ile başlatıyor.
- Başlatırken hata alırsan çıktıyı not et; büyük ihtimalle Chromium paketinin adı/yolu farklıdır,
  `CHROME_PATH=/tam/yol sh start-termux.sh` ile elle verebilirsin.
- Sayfa çalıştırmak telefonda bilgisayara göre yavaş ve pil yiyici; uzun canlı yayın gibi işler
  için bilgisayar kurulumu daha uygun.

## Güvenlik

- `/sniff`, `/fetch`, `/health` token ister (OPTIONS ön kontrolleri hariç). Token istemeyenler
  yalnızca uygulamanın kendi dosyaları (`index.html`, `sw.js`, `manifest.webmanifest`,
  `assets/`) ve `/local-config`'tir; `.git`, `.render-token` gibi diğer dosyalar asla sunulmaz.
- `/local-config` token'ı yalnızca `127.0.0.1`/`localhost` adresinden açılan uygulamanın
  kendisine verir: CORS başlığı yoktur (başka site okuyamaz), `Host` başlığı kontrol edilir
  (DNS rebinding ile başka alan adından okunamaz) ve başka siteden gelen istek reddedilir.
- Varsayılan olarak yalnızca `127.0.0.1` üzerinde dinler; Tailscale/tünel buraya yönlendirir.
  Yerel ağa doğrudan açmak için `HOST=0.0.0.0` verilebilir ama önerilmez.
- Token sızsa bile sunucu ev ağındaki cihazlara (modem paneli vb.) ve bulut metadata adreslerine
  istek atmaz; yerel adresler engellidir. Kendi yerel test siten için `ALLOW_PRIVATE=1`.
- Aynı anda en fazla 3 sayfa çalıştırılır, sayfa başına en fazla 30 sn beklenir.

## Sınırlar

- Sayfa temiz bir tarayıcı profiliyle açılır: senin oturumun/çerezlerin yok, giriş gerektiren
  içerik görünmez. Bunun için tarayıcı eklentisi (`../extension`) daha uygun.
- Sunucu videoları sessiz başlatır; medya gelmezse çerez onayına, oynat düğmesine, oynatıcının
  ortasına ve sayfanın ortasına sırayla tıklar (açılan reklam pencerelerini kapatır). Bu Chromium'da H.264
  olmadığından oynatıcılara H.264/AAC "destekleniyor" gösterilir; video oynatılmaz, yalnızca
  adresi bulunur. Bunlar yetmezse (yaş sorusu, birkaç adım tıklama, kod yazma vb.) Algıla'daki
  **👆 Sayfayı aç, kendim dokunayım** düğmesi sayfayı sunucuda açık tutar: ekran görüntüsü
  uygulamada canlı görünür, dokunduğun yer sunucudaki sayfada tıklanır, kaydırma ve yazı yazma
  da yapılabilir; bu sırada gelen medya listede çıkar. Kullanılmayan oturum 90 sn sonra kapanır.
  Captcha ve giriş gerektiren sayfalar yine sorun olabilir (temiz profil, çerez yok).
- WebRTC ile gelen yayınlar (HTTP isteği olmadan) bulunamaz.
- DRM (Widevine/FairPlay/SAMPLE-AES) korumalı yayınlar sunucu bulsa da İndirici tarafından
  yine indirilmez.

## Canlı yayını sunucuda kaydetme

Telefonda ekran kapanınca tarayıcı sekmeyi dondurur; tarayıcıdaki canlı kayıt bu sırada parça
kaçırır. Sunucu ayarlıysa Algıla'da canlı yayın açıldığında **Nerede kaydedilsin: Sunucumda**
seçilir: kayıt bu sunucuda sürer, telefonu kilitlesen ya da uygulamayı kapatsan da durmaz.
Süre sınırı (30 dk / 1 sa / 2 sa / özel) dolunca ya da **Durdur ve kaydet**'e basınca dosya kapanır,
İndirmeler'de **Kaydet** ile indirilir. Kayıtlar `render-server/.recordings/` klasörüne yazılır
(`RECORD_DIR` ile değiştirilebilir), 48 saat sonra ya da listeden silinince temizlenir. Termux'ta
uzun kayıtlar için `termux-wake-lock` açık olmalı.

## Bağlantısı inmeyen videoyu açıp kaydetme

Uygulamada bir videonun bağlantısı hata verince (403, oturum isteyen, süreli bağlantı...) indirme
kendiliğinden buraya geçer (`POST /capture {pageUrl, mediaUrl}`):

- Önce bağlantı tarayıcıya istetilir (sayfa, bilinen Referer ya da sitenin ana sayfası açıldıktan sonra).
  İstek geçerse dosya ya da HLS yayını (ayrı ses dahil, VOD) tarayıcının o isteğindeki başlıklar ve
  çerezlerle **oynatılmadan** indirilir — H.264 desteği gerekmez. Türü uzantıdan değil yanıttan
  anlaşılır (uzantısız bağlantılar da çalışır). Tarayıcının isteği de reddedilirse nedeni döner.
- Olmazsa videonun kendi adresi temiz bir oynatıcıda açılır (MP4 doğrudan, HLS hls.js ile); sayfa biliniyorsa
  önce sayfa açılır ki çerezler/Referer otursun. Başka kökenden gelen yayın istekleri tarayıcının
  kendi oturumuyla alınıp oynatıcıya verilir. Olmazsa sayfa açılıp oynat düğmeleri denenir.
- Video **sessiz ve 16 kata kadar hızlı** oynatılır; oynatıcının MediaSource'a eklediği veri yakalanıp
  tek, sarılabilir MP4'e dönüştürülür (normal hızda, orijinal kalite). Düz video dosyası oynatılıyorsa
  dosya tarayıcının çerezleriyle parça parça indirilir.
- Video başlamazsa kayıt **bekler** (5 dk): uygulama `GET /capture/:id/shot` ile sayfanın görüntüsünü
  gösterir, kullanıcının dokunuşları `POST /capture/:id/action` ile sayfaya uygulanır; video başladığı
  an kayıt kendiliğinden başlar.
- Olmazsa nedeni döner: DRM, erişim reddi (HTTP 403), bulunamadı (404), kodek, video yok, başlatılmadı.
- **DRM (Widevine vb.) korumalı videolar kaydedilmez.**
- **Codec:** Playwright'ın kendi Chromium'u H.264/AAC oynatamaz; sitelerin çoğu H.264 kullandığı
  için bilgisayarda **Google Chrome kurulu olmalı**. Sunucu kurulu Chrome'u kendiliğinden kullanır
  (`USE_CHROME=0` ile kapatılır). Termux'taki Chromium'un H.264 desteği cihaza göre değişebilir.
- Kayıtlar `render-server/.captures/` klasöründe tutulur (`CAPTURE_DIR`); uygulama dosyayı alınca silinir.

## Reklam engelleme

Sunucunun açtığı tüm sayfalarda (tarama, "kendim dokunayım", açıp kaydet) reklam ve izleme
istekleri engellenir. `npm install` ile gelen `@ghostery/adblocker` kuruluysa EasyList tabanlı hazır
listeler (video reklam SDK'ları dahil) açılışta indirilir; kurulu değilse ya da liste indirilemezse
yerleşik reklam alan adı listesi kullanılır. Kapatmak için `ADBLOCK=0`. Tarama sonuçlarından reklam
medyası da ayıklanır. Kayıtta reklam ayrı bir oynatıcıda geliyorsa onun verisi asıl videoya karışmaz.
Açılır pencereler kapatılır; açık bir sayfa reklam adresine gitmeye çalışırsa geçiş engellenir, başka bir
siteye kaçarsa (tıklama ele geçirme) videonun sayfasına geri dönülür ve oynat düğmesine yeniden basılır.
`/health` yanıtı engelleyicinin durumunu da içerir (`adblock.engine`: `lists` / `builtin` / `off`).

## Uç noktalar

| Yöntem | Yol | Açıklama |
| --- | --- | --- |
| GET | `/` , `/assets/…` | İndirici uygulamasının kendisi (token gerekmez) |
| GET | `/local-config` | Bu cihazdan açılan uygulamaya token'ı verir |
| GET | `/health` | Bağlantı ve token kontrolü |
| POST | `/sniff` `{url, waitMs}` | Sayfayı çalıştırır, `{title, finalUrl, items[]}` döner |
| GET/HEAD | `/fetch?url=…[&referer=…]` | Akışlı indirme proxy'si, `Range` iletilir |
| POST | `/session` `{url}` | Etkileşimli oturum açar (sayfa açık kalır) |
| GET | `/session/:id` , `/session/:id/shot` | Bulunan medya / ekran görüntüsü (JPEG) |
| POST | `/session/:id/action` | `{type:"tap",x,y}` (0–1 arası), `scroll`, `type`, `key`, `back`, `reload` |
| DELETE | `/session/:id` | Oturumu kapatır |
| GET | `/record` | Sunucudaki canlı kayıtlar (süren + biten) |
| POST | `/record` `{url, audioUrl, name, limitSec}` | Canlı HLS kaydını başlatır; çıktı sarılabilir MP4 (ayrı ses birleştirilir) |
| GET | `/record/:id` | Kayıt durumu (süre, boyut, kaçan parça) |
| POST | `/record/:id/stop` | Durdurur ve dosyayı kapatır |
| GET | `/record/:id/file` | Biten kaydın dosyası (indirme olarak) |
| DELETE | `/record/:id` | Süren kaydı iptal eder / biten kaydı siler |
| POST | `/capture` `{pageUrl, mediaUrl, kind, name}` | Videoyu açıp hızlandırılmış oynatarak kaydeder |
| GET / POST | `/capture/:id/shot`, `/capture/:id/action` | Video başlamazsa sayfanın görüntüsü / kullanıcının dokunuşu |
| GET / POST / DELETE | `/capture`, `/capture/:id`, `/capture/:id/stop`, `/capture/:id/file` | `/record` ile aynı |

Token `Authorization: Bearer <token>` başlığıyla ya da `?token=` parametresiyle gönderilir.

## Eşzamanlı kayıt sınırları

| Değişken | Varsayılan | Anlamı |
|---|---|---|
| `MAX_RECORDINGS` | 8 | Aynı anda çalışabilen canlı (m3u8) kayıt sayısı |
| `MAX_CAPTURES` | 4 | Aynı anda açık tutulan "açıp kaydet" tarayıcı sekmesi sayısı |

Kayıtlar sunucuda çalıştığından uygulama alta alınsa da sürer. Sunucu telefonda (Termux) çalışıyorsa
`termux-wake-lock` açın ve Termux için pil optimizasyonunu kapatın; yoksa Android Termux'u da uyutabilir.

## Sitelere girişler

"Kendim dokunayım" ekranında (ya da kayıt sırasında dokunarak) bir siteye giriş yapılınca sunucu
tarayıcısının çerezleri ve localStorage'ı `.logins.json` dosyasına (yalnızca sahibi okuyabilir, 0600)
yazılır; sonraki koklama, oturum ve "açıp kaydet" işleri bu girişle açılır. Dosya başka yere gönderilmez.

| Değişken | Varsayılan | Anlamı |
|---|---|---|
| `SAVE_LOGINS` | 1 | `0` ise girişler saklanmaz |
| `LOGIN_FILE` | `.logins.json` | Girişlerin yazılacağı dosya |

`GET /logins` kayıtlı siteleri listeler, `DELETE /logins?domain=ornek.com` o siteden (alan adı boşsa
hepsinden) çıkış yapar.

Video bağlantısı reddedildiğinde (403) istek sunucunun kendi makinesinden geliyorsa (sunucu telefonda)
hata açıklamasında "cihaza (IP) bağlı" ihtimali söylenmez; giriş/oturum ve süreli bağlantı öne çıkar.

## yt-dlp (veri katmanı)

Büyük platformlarda (TikTok, Instagram, YouTube, X…) uygulama yt-dlp mi kendi yöntemimiz mi diye sorar
(Ayarlar → Büyük platformlar); diğer sitelerde varsayılan kapalıdır (Ayarlar → "Diğer sitelerde de yt-dlp dene"). yt-dlp seçilince ve
kuruluysa, sunucu bir sayfa adresi gelince önce yt-dlp'ye sorar (`yt-dlp -J`): YouTube, Vimeo,
Instagram, X gibi bilinen ~1800 sitede videonun gerçek adresleri ve kalite listesi gelir. yt-dlp
**yalnızca bilgi verir**; dosya indirmez. Liste, kalite seçimi, önizleme, indirme ve birleştirme
İndirici'nin kendisinde yapılır:

- HLS (.m3u8): uygulamanın HLS indiricisi (kalite seçimi, ayrı ses birleştirme, canlı kayıt).
- Tek dosya: `/stream/<kimlik>` adresinden, yt-dlp'nin verdiği başlık/çerezlerle, 10 MB'lık
  parçalar halinde (YouTube tek büyük isteği yavaşlatır).
- Ayrı görüntü + ses (DASH, YouTube): ikisi ayrı akış olarak verilir, telefonda tek MP4'te birleştirilir.

yt-dlp kurulu değilse ya da siteyi tanımıyorsa sayfa eskisi gibi sunucudaki tarayıcıda açılır.
yt-dlp yalnızca kendine özel çıkarıcısı olan sitelerde kullanılır (`--ies default,-generic`): genel
bir sitede yt-dlp ağa hiç çıkmaz, sayfa doğrudan sunucudaki tarayıcıda açılır. yt-dlp'nin sonuçlarının
altında "Sayfayı kendi yöntemimizle tara" düğmesi vardır.

HLS'te yt-dlp'nin verdiği Referer/çerez, listenin (ve alt listelerinin) içindeki bütün sunuculara
(ör. parçaların geldiği CDN) uygulanır: sunucu yt-dlp'nin bulduğu listeyi bir kez okuyup bunları kaydeder.

```bash
pkg install python && pip install "yt-dlp[default]"    # Termux
pip install -U "yt-dlp[default]"            # güncelleme (siteler değiştikçe ara ara)
pip install "yt-dlp[default,curl-cffi]"      # TikTok gibi "tarayıcı taklidi" isteyen siteler için (kurulabilirse)
```

| Değişken | Anlamı |
|---|---|
| `YTDLP=0` | yt-dlp kullanılmaz |
| `YTDLP_PATH` | yt-dlp başka bir yerdeyse yolu |

YouTube'un imza çözümü için yt-dlp'ye sunucunun kendi Node.js'i verilir (`--js-runtimes node`);
`[default]` paketi gereken çözücüyü (yt-dlp-ejs) de kurar, deno gerekmez.

Gizlilik: yt-dlp yalnızca videosunu istediğin siteye bağlanır; telemetri yok, kendiliğinden güncelleme
denetimi yok, uzaktan bileşen indirmesi kapalı. Kayıtlı girişler (çerezler) geçici, yalnızca sahibinin
okuyabildiği bir dosyayla verilir ve iş bitince silinir.

## gallery-dl (resimler için veri katmanı)

Kuruluysa Resimler ekranı bir sayfa adresi gelince önce gallery-dl'e sorar (`gallery-dl -J`):
Instagram, X, Pinterest, Reddit, Tumblr, DeviantArt, Imgur gibi ~300 sitede küçültülmüş önizlemeler
yerine **tam boyutlu** resimler ve kaydırmalı galerinin tamamı gelir (en fazla 500 resim). gallery-dl
**yalnızca adresleri verir**, dosya indirmez; göstermek, seçmek ve (ZIP) indirmek Resimler ekranındadır.
Resim sunucuları çoğu zaman sayfanın Referer'ını istediğinden önizleme ve indirme gerekirse `/fetch`
üzerinden o Referer'la yapılır. Site tanınmazsa eski yol (sayfa taraması + sunucudaki tarayıcı) sürer.

```bash
pip install gallery-dl        # Termux (python kuruluysa)
pip install -U gallery-dl     # güncelleme
```

| Değişken | Anlamı |
|---|---|
| `GALLERYDL=0` | gallery-dl kullanılmaz |
| `GALLERYDL_PATH` | gallery-dl başka bir yerdeyse yolu |

Gizlilik: yalnızca resimlerini istediğin siteye bağlanır; telemetri yok, güncelleme denetimi yalnızca
elle `-U` ile. Kayıtlı girişler yt-dlp'deki gibi geçici bir çerez dosyasıyla verilir. Lisansı GPL-2.0;
kodu kopyalanmadan ayrı bir program olarak çalıştırılır.

## İndirmede çerezler

Sunucu, indirme isteklerinde (/fetch, /stream) tarayıcı gibi çerez gönderir: sayfayı açan sunucu
tarayıcısının çerezleri (koklama ve "Kendim dokunayım" sonunda), yt-dlp'nin verdiği çerezler ve kayıtlı
girişler bir kutuda tutulur; her istek (yönlendirmeler dahil) yalnızca alan adı/yolu uyan çerezlerle gider.
TikTok gibi video dosyasını sayfanın verdiği çerez olmadan vermeyen siteler böylece doğrudan iner.
Oturum çerezleri 2 saat tutulur; kutu yalnızca bellektedir (sunucu kapanınca silinir).
