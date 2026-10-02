# İndirici render sunucusu

İndirici'ye bir sayfa linki verdiğinde site, sayfanın HTML'ini metin olarak tarar; JavaScript
çalıştırmadığı için oynatma anında üretilen video adreslerini göremez. Bu küçük sunucu **senin
cihazında** çalışır ve sayfayı gerçek (görünmez) bir Chromium'da açar, sayfanın attığı medya
isteklerini toplar ve İndirici'ye listeler. Yani link paylaşmak, tarayıcı eklentisine yakın sonuç verir.

Ek olarak süre sınırı olmayan bir indirme proxy'si sunar: İndirici, CORS'a kapalı dosyaları
Netlify fonksiyonu yerine bunun üzerinden indirir (Netlify'ın 10–26 sn sınırı yok). Medyayı
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

## Telefondan bağlanma

İndirici `https` üzerinde çalıştığı için tarayıcı, düz `http://192.168.x.x:8787` gibi bir adrese
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

## Kurulum (telefonun kendisi: Android + Termux) — deneysel

Sunucu telefonda çalışırsa İndirici'ye `http://127.0.0.1:8787` yazabilirsin (localhost, https
sayfalardan da çağrılabiliyor; Chrome yerel ağ erişimi için izin isteyebilir, izin ver).

```bash
pkg install nodejs x11-repo
pkg install chromium
cd render-server && npm install
CHROME_PATH="$(command -v chromium-browser || command -v chromium)" npm start
```

Playwright Termux'u resmi olarak desteklemiyor; çalışmazsa bilgisayar kurulumunu kullan.
Uzun işlerde Termux'un uyumaması için `termux-wake-lock` çalıştır.

## Güvenlik

- Her istek token ister (OPTIONS ön kontrolleri hariç).
- Varsayılan olarak yalnızca `127.0.0.1` üzerinde dinler; Tailscale/tünel buraya yönlendirir.
  Yerel ağa doğrudan açmak için `HOST=0.0.0.0` verilebilir ama önerilmez.
- Token sızsa bile sunucu ev ağındaki cihazlara (modem paneli vb.) ve bulut metadata adreslerine
  istek atmaz; yerel adresler engellidir. Kendi yerel test siten için `ALLOW_PRIVATE=1`.
- Aynı anda en fazla 3 sayfa çalıştırılır, sayfa başına en fazla 30 sn beklenir.

## Sınırlar

- Sayfa temiz bir tarayıcı profiliyle açılır: senin oturumun/çerezlerin yok, giriş gerektiren
  içerik görünmez. Bunun için tarayıcı eklentisi (`../extension`) daha uygun.
- Oynatıcı mutlaka bir tıklama bekliyorsa medya isteği hiç gelmeyebilir; sunucu videoları sessiz
  başlatmayı dener ama her oynatıcıda işe yaramaz.
- DRM (Widevine/FairPlay/SAMPLE-AES) korumalı yayınlar sunucu bulsa da İndirici tarafından
  yine indirilmez.

## Uç noktalar

| Yöntem | Yol | Açıklama |
| --- | --- | --- |
| GET | `/health` | Bağlantı ve token kontrolü |
| POST | `/sniff` `{url, waitMs}` | Sayfayı çalıştırır, `{title, finalUrl, items[]}` döner |
| GET/HEAD | `/fetch?url=…[&referer=…]` | Akışlı indirme proxy'si, `Range` iletilir |

Token `Authorization: Bearer <token>` başlığıyla ya da `?token=` parametresiyle gönderilir.
