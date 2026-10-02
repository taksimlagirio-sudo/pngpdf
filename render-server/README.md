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
- Sunucu videoları sessiz başlatır; medya gelmezse oynat düğmesine, oynatıcının ortasına ve
  sayfanın ortasına sırayla tıklar (açılan reklam pencerelerini kapatır). Bu Chromium'da H.264
  olmadığından oynatıcılara H.264/AAC "destekleniyor" gösterilir; video oynatılmaz, yalnızca
  adresi bulunur. Yine de birkaç adım tıklama, giriş ya da captcha isteyen sayfalarda bulamayabilir.
- WebRTC ile gelen yayınlar (HTTP isteği olmadan) bulunamaz.
- DRM (Widevine/FairPlay/SAMPLE-AES) korumalı yayınlar sunucu bulsa da İndirici tarafından
  yine indirilmez.

## Uç noktalar

| Yöntem | Yol | Açıklama |
| --- | --- | --- |
| GET | `/` , `/assets/…` | İndirici uygulamasının kendisi (token gerekmez) |
| GET | `/local-config` | Bu cihazdan açılan uygulamaya token'ı verir |
| GET | `/health` | Bağlantı ve token kontrolü |
| POST | `/sniff` `{url, waitMs}` | Sayfayı çalıştırır, `{title, finalUrl, items[]}` döner |
| GET/HEAD | `/fetch?url=…[&referer=…]` | Akışlı indirme proxy'si, `Range` iletilir |

Token `Authorization: Bearer <token>` başlığıyla ya da `?token=` parametresiyle gönderilir.
