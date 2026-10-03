// Kendi cihazında çalışan "render sunucusu".
// İndirici'nin statik sayfa taraması JS ile oynatma anında üretilen medya adreslerini göremiyor.
// Bu sunucu sayfayı gerçek (başsız) bir Chromium'da açar, sayfanın attığı ağ isteklerini toplar
// (tarayıcı eklentisinin yaptığının aynısı) ve İndirici'ye listeler. Ayrıca süre sınırı olmayan
// bir indirme proxy'si sunar; böylece Netlify fonksiyonunun 10–26 sn sınırına takılınmaz.
//
// Ayrıca İndirici'nin kendisini sunar (http://127.0.0.1:8787/): uygulama bu adresten açılınca
// token'ı /local-config'ten kendisi alır, kullanıcı hiçbir şey girmez.
//
// Uç noktalar (statik dosyalar, /local-config ve OPTIONS hariç hepsi token ister):
//   GET  /local-config       → yalnızca bu cihazdan, aynı kökenli sayfaya token verir
//   GET  /health             → bağlantı ve token kontrolü
//   POST /sniff {url,waitMs} → sayfayı çalıştırıp bulunan medya listesini döner
//   GET  /fetch?url=…        → akışlı indirme proxy'si (Range ve Referer iletilir)
//   POST /session {url}      → etkileşimli oturum: sayfa açık kalır, kullanıcı dokunur
//   GET  /session/:id[/shot] → oturum durumu (bulunan medya) / ekran görüntüsü (JPEG)
//   POST /session/:id/action → {type:'tap',x,y} | scroll | type | key | back | reload
//   DELETE /session/:id      → oturumu kapat
//   GET  /record             → sunucudaki canlı kayıtlar (süren + biten)
//   POST /record {url,name,format,limitSec,...} → canlı HLS kaydını başlat (sunucuda sürer)
//   GET  /record/:id         → kayıt durumu; POST /record/:id/stop → durdur ve kaydet
//   GET  /record/:id/file    → biten kaydın dosyası; DELETE /record/:id → iptal et / sil
//   POST /capture {url,name} → inmeyen videoyu sunucuda hızlandırılmış oynatıp kaydet
//   GET  /capture[/:id[/file]], POST /capture/:id/stop, DELETE /capture/:id → /record ile aynı
//   GET  /capture/:id/shot, POST /capture/:id/action → video başlamazsa kullanıcı sayfaya dokunur

import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import dns from 'node:dns/promises';
import { randomBytes, timingSafeEqual } from 'node:crypto';
import { spawn } from 'node:child_process';
import { Readable } from 'node:stream';
import { fileURLToPath } from 'node:url';
import { classify, dedupKey, isSegment } from './media.mjs';
import { createRecorder } from './recorder.mjs';
import { createCapturer } from './capture.mjs';
import { createLoginStore } from './logins.mjs';
import { findYtdlp, extractInfo, normalizeInfo } from './ytdlp.mjs';
import { findGalleryDl, extractImages } from './gallerydl.mjs';
import { installRouting, isAdRequest, warmAdblock, guardNavigation, adblockStatus } from './adblock.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const VERSION = '0.4.0';
const PORT = Number(process.env.PORT) || 8787;
// Sunucu tarayıcısında yapılan girişler saklanır (SAVE_LOGINS=0 ile kapatılır).
const logins = createLoginStore(process.env.LOGIN_FILE || path.join(HERE, '.logins.json'),
    { enabled: process.env.SAVE_LOGINS !== '0' });
// Varsayılan yalnızca bu cihazdan erişim; Tailscale/tünel localhost'a yönlendirir.
const HOST = process.env.HOST || '127.0.0.1';
const ALLOW_PRIVATE = process.env.ALLOW_PRIVATE === '1';
const DEFAULT_WAIT_MS = 10000;
const MAX_WAIT_MS = 30000;
const MAX_REDIRECTS = 5;
const DESKTOP_UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36';

/* ---------------- Token ---------------- */

function loadToken() {
    if (process.env.RENDER_TOKEN) return process.env.RENDER_TOKEN;
    // Yeniden başlatmalarda değişmesin diye ilk üretilen token dosyada saklanır.
    const file = path.join(HERE, '.render-token');
    try {
        const saved = fs.readFileSync(file, 'utf8').trim();
        if (saved) return saved;
    } catch (_) { /* ilk çalıştırma */ }
    const token = randomBytes(18).toString('base64url');
    fs.writeFileSync(file, token + '\n', { mode: 0o600 });
    return token;
}

const TOKEN = loadToken();

function authorized(req, url) {
    const header = req.headers.authorization || '';
    const given = header.startsWith('Bearer ') ? header.slice(7) : url.searchParams.get('token') || '';
    const a = Buffer.from(given);
    const b = Buffer.from(TOKEN);
    return a.length === b.length && timingSafeEqual(a, b);
}

/* ---------------- CORS ---------------- */

const CORS_HEADERS = {
    'access-control-allow-origin': '*',
    'access-control-allow-methods': 'GET, HEAD, POST, DELETE, OPTIONS',
    'access-control-allow-headers': 'authorization, content-type, range',
    'access-control-expose-headers': 'content-length, content-type, content-range, accept-ranges',
    // https bir sayfadan yerel ağdaki/localhost'taki sunucuya istek için (Chrome Private Network Access).
    'access-control-allow-private-network': 'true',
    'access-control-max-age': '600'
};

function sendJson(res, status, body) {
    const data = JSON.stringify(body);
    res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', ...CORS_HEADERS });
    res.end(data);
}

/* ---------------- SSRF koruması ---------------- */

function isPrivateIPv4(ip) {
    const parts = ip.split('.').map(Number);
    if (parts.length !== 4 || parts.some((n) => Number.isNaN(n) || n < 0 || n > 255)) return false;
    const [a, b] = parts;
    return a === 0 || a === 10 || a === 127 || (a === 169 && b === 254) ||
        (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) ||
        (a === 100 && b >= 64 && b <= 127) || a >= 224;
}

function isPrivateIPv6(ip) {
    const addr = ip.replace(/^\[|\]$/g, '').toLowerCase();
    if (addr === '::1' || addr === '::') return true;
    if (addr.startsWith('fe80') || addr.startsWith('fc') || addr.startsWith('fd')) return true;
    const mapped = addr.match(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/);
    return mapped ? isPrivateIPv4(mapped[1]) : false;
}

// Token sızsa bile sunucu ev ağındaki cihazlara (modem paneli vb.) köprü olmasın.
async function assertPublicTarget(url) {
    if (url.protocol !== 'http:' && url.protocol !== 'https:') {
        throw new Error('Sadece http/https adresleri desteklenir');
    }
    if (ALLOW_PRIVATE) return;
    const host = url.hostname.toLowerCase();
    if (host === 'localhost' || host.endsWith('.local') || host.endsWith('.internal')) {
        throw new Error('Yerel adreslere erişim kapalı (ALLOW_PRIVATE=1 ile açılabilir)');
    }
    let records;
    try {
        records = await dns.lookup(host, { all: true });
    } catch (_) {
        throw new Error('Alan adı çözümlenemedi');
    }
    for (const { address, family } of records) {
        if (family === 6 ? isPrivateIPv6(address) : isPrivateIPv4(address)) {
            throw new Error('Özel IP adreslerine erişim kapalı (ALLOW_PRIVATE=1 ile açılabilir)');
        }
    }
}

/* ---------------- Tarayıcı ---------------- */

async function loadPlaywright() {
    // Playwright yüklenirken kendi tarayıcı klasörünü hesaplıyor ve Android'i (Termux) tanımadığı
    // için "Unsupported platform: android" diye patlıyor. Tarayıcıyı zaten CHROME_PATH ile
    // verdiğimizden bu klasör hiç kullanılmıyor; yalnızca hesaplanabilsin diye bir yol veriyoruz.
    if (process.platform === 'android' && !process.env.PLAYWRIGHT_BROWSERS_PATH) {
        process.env.PLAYWRIGHT_BROWSERS_PATH = path.join(HERE, '.pw-browsers');
    }
    let lastError = null;
    for (const name of ['playwright-core', 'playwright']) {
        try {
            return await import(name);
        } catch (err) {
            if (err.code !== 'ERR_MODULE_NOT_FOUND') throw new Error(`Playwright yüklenemedi: ${err.message}`);
            lastError = err;
        }
    }
    throw new Error('playwright-core bulunamadı — render-server klasöründe "npm install" çalıştırın' +
        (lastError ? ` (${lastError.message.split('\n')[0]})` : ''));
}

let browserPromise = null;

async function getBrowser() {
    if (!browserPromise) {
        browserPromise = (async () => {
            const { chromium } = await loadPlaywright();
            const args = ['--autoplay-policy=no-user-gesture-required', '--mute-audio'];
            // Termux'ta (Android) Chromium'un kum havuzu çalışmıyor; orada sandbox'sız başlat.
            if (process.platform === 'android' || process.env.NO_SANDBOX === '1') args.push('--no-sandbox');
            // Google Chrome kuruluysa onu kullan: Playwright'ın Chromium'unda H.264/AAC yok, bu yüzden
            // "sunucuda oynatıp kaydet" sitelerin çoğunda ancak gerçek Chrome ile çalışır.
            let browser = null;
            if (!process.env.CHROME_PATH && process.platform !== 'android' && process.env.USE_CHROME !== '0') {
                browser = await chromium.launch({ headless: true, channel: 'chrome', args }).catch(() => null);
            }
            browser = browser || await chromium.launch({
                headless: true,
                executablePath: process.env.CHROME_PATH || undefined,
                args
            });
            browser.on('disconnected', () => { browserPromise = null; });
            return browser;
        })().catch((err) => {
            browserPromise = null;
            throw err;
        });
    }
    return browserPromise;
}

// /fetch isteklerinde CDN'in beklediği Referer'ı göndermek için, koklama sırasında
// her medya adresi ve sunucusu için sayfanın kullandığı Referer saklanır.
const refererByUrl = new Map();
const refererByHost = new Map();

function rememberReferer(mediaUrl, referer) {
    if (!referer) return;
    if (refererByUrl.size > 2000) refererByUrl.clear();
    refererByUrl.set(mediaUrl, referer);
    try {
        refererByHost.set(new URL(mediaUrl).host, referer);
    } catch (_) { /* geçersiz adres */ }
}

// Bu Chromium derlemelerinde H.264/AAC yok. Oynatıcıların çoğu önce bunu sorup "desteklenmiyor"
// deyince playlist'i hiç istemiyor; biz videoyu oynatmayıp yalnızca adresini aradığımızdan
// bu türleri "destekleniyor" gösteriyoruz. Diğer sorular gerçek yanıtı alır.
const CODEC_SPOOF = `(() => {
    const wanted = /avc1|avc3|mp4a|hvc1|hev1|ec-3|ac-3|mpegurl|video\\/mp4|audio\\/mp4|audio\\/aac|video\\/mp2t/i;
    for (const name of ['MediaSource', 'ManagedMediaSource', 'WebKitMediaSource']) {
        const MS = window[name];
        if (!MS || !MS.isTypeSupported) continue;
        const original = MS.isTypeSupported.bind(MS);
        MS.isTypeSupported = (type) => original(type) || (wanted.test(String(type)) && !/mpegurl/i.test(String(type)));
    }
    const canPlay = HTMLMediaElement.prototype.canPlayType;
    HTMLMediaElement.prototype.canPlayType = function (type) {
        const real = canPlay.call(this, type);
        if (real || !wanted.test(String(type))) return real;
        return /mpegurl/i.test(String(type)) ? 'maybe' : 'probably';
    };
})();`;

// Medya gelmezse tıklanacak oynat düğmeleri (yaygın oynatıcılar + genel adlar).
const PLAY_SELECTORS = [
    '.vjs-big-play-button', '.plyr__control--overlaid', '.jw-display-icon-display', '.jw-icon-display',
    '.fp-play', '.mejs__overlay-button', '.ytp-large-play-button', '[data-plyr="play"]',
    'button[aria-label*="play" i]', 'button[aria-label*="oynat" i]', 'button[title*="play" i]',
    '[class*="play-button" i]', '[class*="playbutton" i]', '[class*="play_button" i]', '[class*="btn-play" i]',
    '[id*="play" i]:not(video):not(audio)', '[class*="play" i]:not(video):not(audio):not(body):not(html)'
].join(', ');

/**
 * Kayıt tutan bir sayfa açar: sayfanın (ve çerçevelerinin) yaptığı medya istekleri `state.found`a
 * toplanır. Hem otomatik koklama hem de kullanıcının dokunduğu etkileşimli oturum bunu kullanır.
 */
async function openRecordedPage(pageUrl, contextOptions) {
    const browser = await getBrowser();
    const context = logins.attach(await browser.newContext({ storageState: logins.storageState(), ...contextOptions }));
    await context.addInitScript(CODEC_SPOOF);
    // Reklamlar engellenir: reklam videoları listeye düşmesin, oynatıcı reklamla oyalanmasın.
    const state0 = { blockedAds: 0 };
    const blocked = new Set(); // engellenen reklam istekleri "başarısız istek" diye listeye girmesin
    await installRouting(context, { onBlocked: (url) => { state0.blockedAds++; blocked.add(url); } });
    const page = await context.newPage();
    // Tıklamanın açtığı reklam pencereleri hemen kapatılsın.
    context.on('page', (popup) => { if (popup !== page) popup.close().catch(() => {}); });
    const state = Object.assign(state0, { found: new Map(), firstMediaAt: 0, pending: [] });

    const record = (url, contentType, size, referer, { response = null, failed = false } = {}) => {
        if (failed && blocked.has(url)) return;
        if (isSegment(url, contentType)) return;
        const kind = classify(url, contentType);
        if (!kind) return;
        const key = dedupKey(url, kind);
        let item = state.found.get(key);
        if (item) {
            // Ana liste (tüm kaliteler) aynı yoldaki alt listeyle ezilmesin.
            if (!item.master) item.url = url;
            item.size = size || item.size;
            item.seenCount += 1;
            if (!failed) item.failed = false;
        } else {
            item = { url, kind, mime: contentType || '', size: size || 0, referer: referer || pageUrl, seenCount: 1, failed };
            state.found.set(key, item);
        }
        rememberReferer(url, referer || pageUrl);
        if (!state.firstMediaAt && (kind === 'hls' || kind === 'video' || kind === 'dash')) state.firstMediaAt = Date.now();

        // Liste içeriği tarayıcının aldığı anda saklanır: ana listenin adresi çoğu zaman tek kullanımlık
        // ya da kısa ömürlü bir anahtar taşır; uygulama yeniden isteyince 403 alır, kaliteler kaybolur.
        if (response && (kind === 'hls' || kind === 'dash') && response.status() === 200 && !(size > 2 * 1024 * 1024)) {
            state.pending.push(response.text().then((text) => {
                if (kind === 'hls' && text.includes('#EXT-X-STREAM-INF')) {
                    item.master = true;
                    item.url = url;
                    item.text = text;
                } else if (kind === 'dash' && /<MPD[\s>]/.test(text)) {
                    item.text = text;
                    item.url = url;
                }
            }).catch(() => {}));
        }
    };

    page.on('response', (response) => {
        const headers = response.headers();
        const request = response.request();
        record(response.url(), headers['content-type'] || '', Number(headers['content-length']) || 0,
            request.headers().referer, { response, failed: response.status() >= 400 });
    });
    page.on('requestfailed', (request) => {
        record(request.url(), '', 0, request.headers().referer, { failed: true });
    });
    return { context, page, state };
}

const foundItems = (state) => dropHlsSiblings([...state.found.values()]);

// Çerez/izin pencerelerinin onay düğmeleri (tam ad eşleşmesi; rastgele bağlantılara basılmasın).
const CONSENT_NAMES = /^\s*(accept( all)?( cookies)?|allow all|i agree|agree( and close)?|got it|ok(ay)?|continue|tümünü kabul et|kabul et|kabul ediyorum|kabul|onayla|tamam|anladım|devam et)\s*$/i;

async function clickConsent(page) {
    for (const frame of page.frames()) {
        const button = frame.getByRole('button', { name: CONSENT_NAMES }).first();
        if (await button.isVisible().catch(() => false)) {
            await button.click({ timeout: 2000 }).catch(() => {});
            return true;
        }
    }
    return false;
}

// Oynatıcılar çoğu zaman "oynat"a basılmadan medyayı istemez; sessizce başlatmayı dene.
async function tryPlay(page) {
    for (const frame of page.frames()) {
        await frame.evaluate(() => {
            document.querySelectorAll('video, audio').forEach((el) => {
                el.muted = true;
                const p = el.play && el.play();
                if (p && p.catch) p.catch(() => {});
            });
        }).catch(() => {});
    }
}

/**
 * Oynatıcı özel bir "oynat" düğmesi bekliyorsa sırayla dener: çerez onayı, bilinen düğmeler,
 * en büyük video/oynatıcı alanının ortası, en son sayfanın ortası. Her çağrıda (zamanı geldiyse)
 * bir adım ilerler; `nudge` çağrılar arasında durumu tutar.
 */
async function nudgePlayback(page, started, nudge) {
    // Adımlar bitince birkaç tur daha denenir: ilk tıklama reklama yönlendirip geri dönüldüyse
    // oynat düğmesine yeniden basılması gerekir.
    if (nudge.steps && !nudge.steps.length) {
        nudge.emptiedAt = nudge.emptiedAt || Date.now();
        if ((nudge.rounds || 1) < 3 && Date.now() - nudge.emptiedAt > 3000) {
            nudge.rounds = (nudge.rounds || 1) + 1;
            nudge.steps = null;
            nudge.emptiedAt = 0;
        }
    }
    if (!nudge.steps) {
        nudge.nextAt = Math.max(nudge.nextAt || 0, started + 2500);
        nudge.steps = [
            () => clickConsent(page),
            async () => {
                for (const frame of page.frames()) {
                    const button = await frame.$(PLAY_SELECTORS).catch(() => null);
                    if (button && await button.isVisible().catch(() => false)) {
                        await button.click({ timeout: 2000, force: true }).catch(() => {});
                        return true;
                    }
                }
                return false;
            },
            async () => {
                const box = await page.evaluate(() => {
                    let best = null;
                    document.querySelectorAll('video, iframe, [class*="player" i], [id*="player" i], .poster, [class*="poster" i]')
                        .forEach((el) => {
                            const r = el.getBoundingClientRect();
                            if (r.width * r.height > (best ? best.width * best.height : 2000)) best = r;
                        });
                    return best && { x: best.x + best.width / 2, y: best.y + best.height / 2 };
                }).catch(() => null);
                if (!box) return false;
                await page.mouse.click(box.x, box.y).catch(() => {});
                return true;
            },
            async () => {
                const size = page.viewportSize() || { width: 1280, height: 800 };
                await page.mouse.click(size.width / 2, size.height / 2).catch(() => {});
                return true;
            }
        ];
    }
    if (Date.now() < nudge.nextAt) return;
    await tryPlay(page);
    while (nudge.steps.length && !(await nudge.steps.shift()())) { /* sıradaki adım */ }
    nudge.nextAt = Date.now() + 1500;
}

let codecPromise = null;
/** Sunucudaki tarayıcı H.264/AAC oynatabiliyor mu? (bir kez ölçülür) */
function codecSupport() {
    if (!codecPromise) {
        codecPromise = (async () => {
            const browser = await getBrowser();
            const page = await browser.newPage();
            try {
                return await page.evaluate(() => ({
                    h264: Boolean(window.MediaSource && MediaSource.isTypeSupported('video/mp4; codecs="avc1.42E01E"')),
                    aac: Boolean(window.MediaSource && MediaSource.isTypeSupported('audio/mp4; codecs="mp4a.40.2"'))
                }));
            } finally {
                await page.close().catch(() => {});
            }
        })().catch((err) => {
            codecPromise = null;
            throw err;
        });
    }
    return codecPromise;
}

async function sniff(pageUrl, waitMs) {
    const { context, page, state } = await openRecordedPage(pageUrl,
        { userAgent: DESKTOP_UA, viewport: { width: 1280, height: 800 } });

    const started = Date.now();
    let title = '';
    let finalUrl = pageUrl;
    let main = null;
    try {
        // Otomatik tıklamalar sayfayı reklama yönlendirirse sayfaya geri dönülür.
        const guard = guardNavigation(page, { onReturn: () => { state.blockedAds++; } });
        // Adresin kendisi ne döndü? Uzantısız video bağlantıları (…/videoplayback?…) ve erişimi
        // kapalı bağlantılar (403) böyle anlaşılır; uygulama bunları sayfa değil video sayar.
        let response = null;
        try {
            response = await page.goto(pageUrl, { waitUntil: 'domcontentloaded', timeout: 25000 });
        } catch (err) {
            if (/Download is starting|net::ERR_ABORTED/i.test(err.message)) {
                main = { status: 200, contentType: '', download: true };
                return { title: '', finalUrl, items: [], main, elapsedMs: Date.now() - started };
            }
            throw err;
        }
        if (response) main = { status: response.status(), contentType: (response.headers()['content-type'] || '').toLowerCase() };
        finalUrl = page.url();
        guard.arm(finalUrl);
        if (main && (main.status >= 400 || /^(video|audio)\/|mpegurl|dash\+xml/.test(main.contentType))) {
            return { title: '', finalUrl, items: [], main, elapsedMs: Date.now() - started };
        }

        await tryPlay(page);
        const nudge = {};

        // Medya bulununca biraz daha bekleyip (master → varyant gibi takip istekleri için) bitir;
        // bulunamazsa süre dolana kadar bekle.
        while (Date.now() - started < waitMs) {
            if (state.firstMediaAt && Date.now() - state.firstMediaAt > 2000) break;
            await page.waitForTimeout(400);
            if (!state.firstMediaAt) await nudgePlayback(page, started, nudge);
        }
        title = await page.title().catch(() => '');
        // Saklanan liste içerikleri okunsun (sayfa kapanmadan).
        await Promise.race([Promise.allSettled(state.pending), new Promise((r) => setTimeout(r, 3000))]);
    } finally {
        await context.close().catch(() => {});
    }

    // Engelleyiciden kaçan reklam medyası da listeden çıkarılır.
    const items = [];
    for (const item of foundItems(state)) {
        if (!(await isAdRequest(item.url, pageUrl, 'media'))) items.push(item);
    }
    return { title, finalUrl, items, main, blockedAds: state.blockedAds, elapsedMs: Date.now() - started };
}

/* ---------------- Etkileşimli oturum: kullanıcı sayfaya kendisi dokunur ---------------- */

// Uygulama sayfanın ekran görüntüsünü gösterir, dokunuşları buraya iletir. Telefon boyutunda
// açılır ki ekranda okunabilsin. Kullanılmayan oturumlar kendiliğinden kapanır.
const MOBILE_UA = 'Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Mobile Safari/537.36';
const SESSION_VIEWPORT = { width: 412, height: 800 };
const MAX_SESSIONS = 2;
const SESSION_IDLE_MS = 90 * 1000;
const SESSION_MAX_MS = 15 * 60 * 1000;
const sessions = new Map();

async function closeSession(id) {
    const session = sessions.get(id);
    if (!session) return;
    sessions.delete(id);
    await logins.save(session.context);
    await session.context.close().catch(() => {});
}

setInterval(() => {
    const now = Date.now();
    for (const [id, session] of sessions) {
        if (now - session.lastUsed > SESSION_IDLE_MS || now - session.created > SESSION_MAX_MS) closeSession(id);
    }
}, 15000).unref();

async function openSession(pageUrl) {
    // Sınır dolduysa en uzun süredir kullanılmayanı kapat (telefonda bellek kısıtlı).
    while (sessions.size >= MAX_SESSIONS) {
        const oldest = [...sessions.values()].sort((a, b) => a.lastUsed - b.lastUsed)[0];
        await closeSession(oldest.id);
    }
    const { context, page, state } = await openRecordedPage(pageUrl, {
        userAgent: MOBILE_UA, viewport: SESSION_VIEWPORT, deviceScaleFactor: 1.5, isMobile: true, hasTouch: true
    });
    const session = { id: randomBytes(12).toString('hex'), context, page, state, created: Date.now(), lastUsed: Date.now() };
    sessions.set(session.id, session);
    try {
        await page.goto(pageUrl, { waitUntil: 'domcontentloaded', timeout: 25000 });
    } catch (err) {
        // Ağır sayfa zaman aşımına uğrasa da yüklenen kısmı kullanılabilir; hiç açılmadıysa hata.
        if (page.url() === 'about:blank') {
            await closeSession(session.id);
            throw new Error(`Sayfa açılamadı: ${err.message.split('\n')[0]}`);
        }
    }
    return session;
}

async function sessionState(session) {
    return {
        id: session.id,
        title: await session.page.title().catch(() => ''),
        url: session.page.url(),
        width: SESSION_VIEWPORT.width,
        height: SESSION_VIEWPORT.height,
        items: foundItems(session.state)
    };
}

const SESSION_KEYS = new Set(['Enter', 'Backspace', 'Escape', 'Tab']);

async function sessionAction(session, action) {
    const { page } = session;
    const { width, height } = SESSION_VIEWPORT;
    const fraction = (value) => Math.min(1, Math.max(0, Number(value) || 0));
    switch (action.type) {
        case 'tap':
            await page.touchscreen.tap(fraction(action.x) * width, fraction(action.y) * height);
            break;
        case 'scroll': {
            const dy = Math.max(-3, Math.min(3, Number(action.dy) || 0)) * height;
            await page.mouse.move(width / 2, height / 2);
            await page.mouse.wheel(0, dy);
            break;
        }
        case 'type':
            await page.keyboard.type(String(action.text || '').slice(0, 500), { delay: 20 });
            break;
        case 'key':
            if (!SESSION_KEYS.has(action.key)) throw new Error('Desteklenmeyen tuş');
            await page.keyboard.press(action.key);
            break;
        case 'back':
            await page.goBack({ timeout: 10000 }).catch(() => {});
            break;
        case 'reload':
            await page.reload({ waitUntil: 'domcontentloaded', timeout: 20000 }).catch(() => {});
            break;
        default:
            throw new Error('Bilinmeyen işlem');
    }
    await page.waitForTimeout(300);
}

// HLS playlist'iyle aynı klasördeki .mp4 adlı fMP4 parçaları ayrı video gibi listelenmesin.
function dropHlsSiblings(items) {
    const dirs = new Set(items.filter((i) => i.kind === 'hls').map((i) => dirOf(i.url)));
    return items.filter((i) => i.kind !== 'video' || !dirs.has(dirOf(i.url)));
}

function dirOf(url) {
    try {
        const u = new URL(url);
        return u.origin + u.pathname.slice(0, u.pathname.lastIndexOf('/') + 1);
    } catch (_) {
        return url;
    }
}

/* ---------------- İndirme proxy'si ---------------- */

/**
 * Yönlendirmeleri elle izleyerek ister: her adımda özel ağ kontrolü yapılır, başka bir siteye
 * yönlendirilince çerez gönderilmez.
 */
async function fetchUpstream(target, headers, { method = 'GET', signal } = {}) {
    let current = new URL(target);
    const startHost = current.host;
    const sent = { ...headers };
    for (let hop = 0; ; hop++) {
        await assertPublicTarget(current);
        if (current.host !== startHost) delete sent.cookie;
        const upstream = await fetch(current, { method, headers: sent, redirect: 'manual', signal });
        const location = upstream.headers.get('location');
        if (!location || upstream.status < 300 || upstream.status >= 400) return upstream;
        if (hop >= MAX_REDIRECTS) throw new Error('Çok fazla yönlendirme');
        upstream.body?.cancel().catch(() => {});
        current = new URL(location, current);
    }
}

async function proxyFetch(req, res, target, refererParam) {
    let current;
    try {
        current = new URL(target);
    } catch (_) {
        return sendJson(res, 400, { error: 'Geçersiz url' });
    }

    const referer = refererParam || refererByUrl.get(target) || refererByHost.get(current.host) || '';
    const base = { 'user-agent': DESKTOP_UA, accept: '*/*' };
    if (req.headers.range) base.range = req.headers.range;
    if (referer) base.referer = referer;

    // yt-dlp'nin başlıkları: bu adresin kendisi (ya da onun listesindeki adresler) için tamamı;
    // yalnızca aynı sunucudaysa sadece Referer/çerez/Origin (sayfanın tarayıcısının bulduğu Referer önce).
    const exact = requestHeadersByUrl.get(target) || null;
    const sameHost = !exact ? requestHeadersByHost.get(current.host) || null : null;
    let headers = base;
    if (exact) {
        headers = { ...base, ...exact, range: base.range };
        if (!headers.range) delete headers.range;
    } else if (sameHost) {
        headers = { ...base };
        for (const key of ['referer', 'cookie', 'origin']) {
            if (!sameHost[key]) continue;
            if (key === 'referer' && (refererParam || refererByUrl.has(target))) continue;
            headers[key] = sameHost[key];
        }
    }

    let upstream;
    try {
        const method = req.method === 'HEAD' ? 'HEAD' : 'GET';
        upstream = await fetchUpstream(current, headers, { method });
        // yt-dlp başlıklarıyla reddedildiyse bir kez yalın başlıklarla (eski yöntem) dene.
        if (headers !== base && (upstream.status === 401 || upstream.status === 403)) {
            const retry = await fetchUpstream(current, base, { method });
            if (retry.ok || retry.status === 206) {
                upstream.body?.cancel().catch(() => {});
                upstream = retry;
            } else {
                retry.body?.cancel().catch(() => {});
            }
        }
    } catch (err) {
        return sendJson(res, /yönlendirme/.test(err.message) ? 502 : 400, { error: err.message });
    }

    const out = { ...CORS_HEADERS, 'cache-control': 'no-store' };
    for (const key of ['content-type', 'content-length', 'content-range', 'accept-ranges', 'last-modified', 'etag']) {
        const value = upstream.headers.get(key);
        if (value) out[key] = value;
    }

    // yt-dlp'nin başlıklarıyla gelen m3u8: içindeki adresler (alt listeler, init, parçalar, anahtarlar)
    // çoğu zaman başka bir sunucuda (CDN) ve aynı Referer/çerezi ister; onlar için de kaydedilir.
    const type = upstream.headers.get('content-type') || '';
    if (exact && upstream.ok && req.method !== 'HEAD' && !req.headers.range &&
        (/mpegurl/i.test(type) || /\.m3u8(\?|$)/i.test(current.pathname))) {
        const text = await upstream.text();
        if (text.startsWith('#EXTM3U')) rememberPlaylistHeaders(text, upstream.url || current.href, exact);
        const body = Buffer.from(text);
        out['content-length'] = body.length;
        res.writeHead(upstream.status, out);
        return res.end(body);
    }
    res.writeHead(upstream.status, out);

    if (req.method === 'HEAD' || !upstream.body) return res.end();
    const stream = Readable.fromWeb(upstream.body);
    // İstemci bağlantıyı keserse (iptal) kaynağı da kapat.
    res.on('close', () => stream.destroy());
    stream.on('error', () => res.destroy());
    stream.pipe(res);
}

/* ---------------- yt-dlp: veri katmanı ---------------- */

// yt-dlp'nin bulduğu akışlar. HLS ham adresiyle verilir (uygulamanın HLS indiricisi kullanır),
// başlıkları /fetch'te kullanılmak üzere saklanır. Diğerleri sunucuda tek bir adres olarak sunulur:
// /stream/<kimlik> doğru başlık/çerezle, parça parça (YouTube yavaşlatmasın diye) ya da DASH
// parçalarını art arda ekleyerek tek dosya akıtır.
const requestHeadersByUrl = new Map();
const requestHeadersByHost = new Map();
const streams = new Map();
const STREAM_TTL_MS = 6 * 60 * 60 * 1000;
const STREAM_CHUNK = 10 * 1024 * 1024;

function registerStream(request, { hls = false } = {}) {
    if (hls) {
        if (requestHeadersByUrl.size > 2000) requestHeadersByUrl.clear();
        requestHeadersByUrl.set(request.url, request.headers);
        try {
            requestHeadersByHost.set(new URL(request.url).host, request.headers);
        } catch (_) { /* geçersiz adres */ }
        return request.url;
    }
    const id = randomBytes(12).toString('hex');
    streams.set(id, { ...request, created: Date.now() });
    return `/stream/${id}`;
}

setInterval(() => {
    const now = Date.now();
    for (const [id, entry] of streams) if (now - entry.created > STREAM_TTL_MS) streams.delete(id);
}, 10 * 60 * 1000).unref();

/** Listedeki her adres için yt-dlp başlıklarını kaydeder (adres ve sunucu bazında). */
function rememberPlaylistHeaders(text, baseUrl, headers) {
    const uris = [];
    for (const raw of text.split(/\r?\n/)) {
        const line = raw.trim();
        if (!line) continue;
        if (line.startsWith('#')) {
            for (const m of line.matchAll(/URI="([^"]+)"/g)) uris.push(m[1]);
        } else {
            uris.push(line);
        }
    }
    for (const uri of uris.slice(0, 20000)) {
        try {
            const abs = new URL(uri, baseUrl);
            if (!/^https?:$/.test(abs.protocol)) continue;
            if (requestHeadersByUrl.size > 50000) requestHeadersByUrl.clear();
            requestHeadersByUrl.set(abs.href, headers);
            if (!requestHeadersByHost.has(abs.host)) requestHeadersByHost.set(abs.host, headers);
        } catch (_) { /* geçersiz adres */ }
    }
}

/**
 * yt-dlp'nin bulduğu HLS listesini (ve alt listelerini) bir kez okuyup içindeki sunucuları kaydeder:
 * uygulama listeyi doğrudan çekse de parçalar /fetch'e düşünce doğru Referer/çerezle istenir.
 */
async function prefetchHlsHeaders(url, headers) {
    const read = async (target) => {
        const upstream = await fetchUpstream(target, { 'user-agent': DESKTOP_UA, accept: '*/*', ...headers },
            { signal: AbortSignal.timeout(8000) });
        const text = upstream.ok ? await upstream.text() : '';
        if (!text.startsWith('#EXTM3U')) return target === url ? null : [];
        rememberPlaylistHeaders(text, upstream.url || target, headers);
        // Alt listeler (kaliteler, ses): yalnızca ana listeden.
        return text.split(/\r?\n/).flatMap((line, i, lines) => {
            if (/^#EXT-X-MEDIA:/.test(line)) return [...line.matchAll(/URI="([^"]+)"/g)].map((m) => m[1]);
            if (/^#EXT-X-STREAM-INF/.test(line) && lines[i + 1] && !lines[i + 1].startsWith('#')) return [lines[i + 1].trim()];
            return [];
        }).map((u) => new URL(u, upstream.url || target).href);
    };
    let children;
    try {
        children = await read(url);
    } catch (_) {
        return false;
    }
    if (children === null) return false;
    await Promise.all(children.slice(0, 8).map((child) => read(child).catch(() => [])));
    return true;
}

/** yt-dlp'nin verdiği tek dosya/DASH akışı gerçekten açılıyor mu (ilk bayt)? */
async function streamWorks(entry) {
    const url = entry.fragments && entry.fragments.length ? entry.fragments[0] : entry.url;
    try {
        const upstream = await fetchUpstream(url, { 'user-agent': DESKTOP_UA, accept: '*/*', ...entry.headers, range: 'bytes=0-0' },
            { signal: AbortSignal.timeout(10000) });
        upstream.body?.cancel().catch(() => {});
        return upstream.ok || upstream.status === 206;
    } catch (_) {
        return false;
    }
}

async function extractWithYtdlp(url) {
    const result = await extractInfo(url, { cookies: logins.storageState()?.cookies || [] });
    if (!result.ok) return { available: !result.missing, ok: false, reason: result.reason, unsupported: Boolean(result.unsupported) };
    const page = normalizeInfo(result.info, registerStream);
    // Kullanmadan önce dene: yt-dlp'nin bulduğu bağlantı açılmıyorsa (403 vb.) atılır; hiçbiri
    // açılmıyorsa uygulama sayfayı kendi yöntemiyle (sunucudaki tarayıcıda) tarar.
    const checks = await Promise.all(page.items.map((item) => {
        if (item.kind === 'hls') return prefetchHlsHeaders(item.url, requestHeadersByUrl.get(item.url) || {});
        const id = (item.url.match(/^\/stream\/([0-9a-f]{24})$/) || [])[1];
        const entry = id && streams.get(id);
        const audioId = item.audioUrl && (item.audioUrl.match(/^\/stream\/([0-9a-f]{24})$/) || [])[1];
        return Promise.all([entry ? streamWorks(entry) : false, audioId ? streamWorks(streams.get(audioId)) : true])
            .then(([v, a]) => v && a);
    }));
    const working = page.items.filter((_, i) => checks[i]);
    if (!working.length) {
        return { available: true, ok: false, reason: 'yt-dlp\'nin bulduğu bağlantılar açılmıyor (ör. HTTP 403)', blocked: true };
    }
    return { available: true, ok: true, ...page, items: working };
}

async function serveStream(req, res, entry) {
    const headers = { 'user-agent': DESKTOP_UA, accept: '*/*', ...entry.headers };
    const controller = new AbortController();
    res.on('close', () => controller.abort());
    const signal = controller.signal;
    const pipeBody = async (upstream) => {
        for await (const chunk of upstream.body) {
            if (!res.write(chunk)) await new Promise((r) => res.once('drain', r));
        }
    };

    // DASH parçaları: art arda tek akış (ilk parça init segmenti).
    if (entry.fragments && entry.fragments.length) {
        res.writeHead(200, { ...CORS_HEADERS, 'content-type': 'video/mp4', 'cache-control': 'no-store' });
        if (req.method === 'HEAD') return res.end();
        for (const url of entry.fragments) {
            const upstream = await fetchUpstream(url, headers, { signal });
            if (!upstream.ok) throw new Error(`Parça alınamadı (HTTP ${upstream.status})`);
            await pipeBody(upstream);
        }
        return res.end();
    }

    // Uygulama aralık istediyse (önizleme, sürdürme) aynen iletilir.
    if (req.headers.range || req.method === 'HEAD') {
        const upstream = await fetchUpstream(entry.url, { ...headers, ...(req.headers.range ? { range: req.headers.range } : {}) },
            { method: req.method === 'HEAD' ? 'HEAD' : 'GET', signal });
        const out = { ...CORS_HEADERS, 'cache-control': 'no-store' };
        for (const key of ['content-type', 'content-length', 'content-range', 'accept-ranges']) {
            const value = upstream.headers.get(key);
            if (value) out[key] = value;
        }
        res.writeHead(upstream.status, out);
        if (req.method === 'HEAD' || !upstream.body) return res.end();
        await pipeBody(upstream);
        return res.end();
    }

    // Tamamı: parça parça (bazı sunucular, ör. YouTube, tek seferlik büyük isteği yavaşlatır).
    const chunk = entry.chunk || STREAM_CHUNK;
    let offset = 0;
    let total = 0;
    for (;;) {
        const upstream = await fetchUpstream(entry.url, { ...headers, range: `bytes=${offset}-${offset + chunk - 1}` }, { signal });
        if (offset === 0) {
            if (upstream.status !== 200 && upstream.status !== 206) {
                upstream.body?.cancel().catch(() => {});
                return sendJson(res, 502, { error: `Video sunucusu HTTP ${upstream.status} döndü` });
            }
            total = upstream.status === 206
                ? Number((upstream.headers.get('content-range') || '').split('/')[1]) || 0
                : Number(upstream.headers.get('content-length')) || 0;
            const out = { ...CORS_HEADERS, 'content-type': upstream.headers.get('content-type') || 'application/octet-stream', 'cache-control': 'no-store', 'accept-ranges': 'bytes' };
            if (total) out['content-length'] = total;
            res.writeHead(200, out);
            if (upstream.status === 200) {
                await pipeBody(upstream); // aralık desteklenmiyor: tamamı tek seferde geldi
                return res.end();
            }
        } else if (upstream.status !== 206) {
            throw new Error(`Video sunucusu HTTP ${upstream.status} döndü`);
        }
        const before = offset;
        for await (const piece of upstream.body) {
            offset += piece.length;
            if (!res.write(piece)) await new Promise((r) => res.once('drain', r));
        }
        if (offset === before || (total && offset >= total)) break;
    }
    res.end();
}

/* ---------------- Uygulamanın kendisi (statik dosyalar) ---------------- */

const APP_ROOT = path.resolve(HERE, '..');
const ASSETS_DIR = path.join(APP_ROOT, 'assets') + path.sep;
// Yalnızca bu dosyalar sunulur; .git, render-server/.render-token, node_modules vb. asla.
const APP_FILES = new Set(['/index.html', '/manifest.webmanifest', '/sw.js']);
const STATIC_TYPES = {
    '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8',
    '.css': 'text/css; charset=utf-8', '.webmanifest': 'application/manifest+json; charset=utf-8',
    '.mjs': 'text/javascript; charset=utf-8',
    '.png': 'image/png', '.svg': 'image/svg+xml', '.json': 'application/json; charset=utf-8'
};

function staticFile(pathname) {
    let decoded;
    try {
        decoded = decodeURIComponent(pathname);
    } catch (_) {
        return null;
    }
    if (decoded === '/') decoded = '/index.html';
    if (APP_FILES.has(decoded)) return path.join(APP_ROOT, decoded);
    if (!decoded.startsWith('/assets/')) return null;
    const full = path.resolve(APP_ROOT, '.' + decoded);
    // "../" ile assets klasörünün dışına çıkılamasın.
    return full.startsWith(ASSETS_DIR) ? full : null;
}

function serveStatic(req, res, file) {
    let body;
    try {
        if (!fs.statSync(file).isFile()) throw new Error('dosya değil');
        body = fs.readFileSync(file);
    } catch (_) {
        res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' });
        return res.end('Bulunamadı');
    }
    if (file.endsWith('index.html')) {
        // Uygulama bu sunucudan açıldığını anlasın ve token'ı kendisi alsın.
        body = Buffer.from(body.toString('utf8').replace('<html lang="tr">', '<html lang="tr" data-local-server="1">'));
    }
    res.writeHead(200, {
        'content-type': STATIC_TYPES[path.extname(file)] || 'application/octet-stream',
        'content-length': body.length,
        'cache-control': 'no-cache'
    });
    res.end(req.method === 'HEAD' ? undefined : body);
}

// Token yalnızca bu cihazın kendisinden açılan, aynı kökenli sayfaya verilir. Host başlığı
// kontrolü, kötü niyetli bir sitenin alan adını 127.0.0.1'e çözdürüp (DNS rebinding) token'ı
// okumasını engeller; tarayıcıdaki başka sitelerin istekleri de Sec-Fetch-Site ile ayıklanır.
function localConfigAllowed(req) {
    const host = (req.headers.host || '').toLowerCase();
    const loopback = [`127.0.0.1:${PORT}`, `localhost:${PORT}`, `[::1]:${PORT}`].includes(host);
    const site = req.headers['sec-fetch-site'];
    return loopback && (!site || site === 'same-origin');
}

/* ---------------- Canlı kayıt ---------------- */

const recorder = createRecorder({
    dir: process.env.RECORD_DIR || path.join(HERE, '.recordings'),
    appRoot: APP_ROOT,
    assertPublicTarget,
    userAgent: DESKTOP_UA,
    refererFor(url) {
        try {
            return refererByUrl.get(url) || refererByHost.get(new URL(url).host) || '';
        } catch (_) {
            return '';
        }
    }
});

function sendRecordFile(req, res, file) {
    // Türkçe karakterli adlar için RFC 5987; eski tarayıcılar için ASCII yedek.
    const ascii = file.name.replace(/[^\x20-\x7e]/g, '_').replace(/"/g, '');
    res.writeHead(200, {
        ...CORS_HEADERS,
        'content-type': file.mime,
        'content-length': file.size,
        'content-disposition': `attachment; filename="${ascii}"; filename*=UTF-8''${encodeURIComponent(file.name)}`,
        'cache-control': 'no-store'
    });
    if (req.method === 'HEAD') return res.end();
    const stream = fs.createReadStream(file.path);
    res.on('close', () => stream.destroy());
    stream.on('error', () => res.destroy());
    stream.pipe(res);
}

const capturer = createCapturer({
    dir: process.env.CAPTURE_DIR || path.join(HERE, '.captures'),
    appRoot: APP_ROOT,
    getBrowser,
    logins,
    nudgePlayback,
    assertPublicTarget,
    userAgent: DESKTOP_UA,
    codecSupport,
    hlsScript: path.join(APP_ROOT, 'assets', 'vendor', 'hls.min.js'),
    refererFor(url) {
        try {
            return refererByUrl.get(url) || refererByHost.get(new URL(url).host) || '';
        } catch (_) {
            return '';
        }
    }
});

/** /record (canlı HLS kaydı) ve /capture (sunucuda oynatıp kaydetme) aynı biçimde yönetilir. */
async function handleJobs(req, res, url) {
    const [, kind] = url.pathname.match(/^\/(record|capture)/) || [];
    const manager = kind === 'capture' ? capturer : recorder;
    if (url.pathname === `/${kind}`) {
        if (req.method === 'GET') return sendJson(res, 200, { items: manager.list() });
        if (req.method === 'POST') {
            // İstek bu makineden geliyorsa (sunucu telefonda) video bağlantısı IP'ye takılmaz;
            // hata açıklaması buna göre seçilir.
            const sameDevice = /^(127\.|::1$|::ffff:127\.)/.test(req.socket.remoteAddress || '');
            return sendJson(res, 200, await manager.start({ ...(await readJson(req)), sameDevice }));
        }
    }
    const match = url.pathname.match(/^\/(?:record|capture)\/([0-9a-f]{24})(\/stop|\/file|\/shot|\/action)?$/);
    if (!match) return false;
    const [, id, sub = ''] = match;
    if (sub === '' && req.method === 'GET') {
        const state = manager.get(id);
        return state ? sendJson(res, 200, state) : sendJson(res, 404, { error: 'Kayıt bulunamadı' });
    }
    if (sub === '' && req.method === 'DELETE') {
        return sendJson(res, manager.delete(id) ? 200 : 404, { ok: true });
    }
    if (sub === '/stop' && req.method === 'POST') {
        const state = manager.stop(id);
        return state ? sendJson(res, 200, state) : sendJson(res, 404, { error: 'Kayıt bulunamadı' });
    }
    if (kind === 'capture' && sub === '/shot' && req.method === 'GET') {
        const image = await manager.shot(id);
        if (!image) return sendJson(res, 404, { error: 'Kayıt sayfası kapalı' });
        res.writeHead(200, { ...CORS_HEADERS, 'content-type': 'image/jpeg', 'content-length': image.length, 'cache-control': 'no-store' });
        return res.end(image);
    }
    if (kind === 'capture' && sub === '/action' && req.method === 'POST') {
        return sendJson(res, 200, await manager.action(id, await readJson(req)));
    }
    if (sub === '/file' && (req.method === 'GET' || req.method === 'HEAD')) {
        const file = manager.file(id);
        return file ? sendRecordFile(req, res, file) : sendJson(res, 404, { error: 'Dosya hazır değil' });
    }
    return false;
}

/* ---------------- HTTP ---------------- */

function readJson(req, limit = 64 * 1024) {
    return new Promise((resolve, reject) => {
        let size = 0;
        const chunks = [];
        req.on('data', (chunk) => {
            size += chunk.length;
            if (size > limit) {
                reject(new Error('İstek gövdesi çok büyük'));
                req.destroy();
                return;
            }
            chunks.push(chunk);
        });
        req.on('end', () => {
            try {
                resolve(JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}'));
            } catch (_) {
                reject(new Error('Geçersiz JSON'));
            }
        });
        req.on('error', reject);
    });
}

let activeSniffs = 0;
const MAX_PARALLEL_SNIFFS = 3;

const server = http.createServer(async (req, res) => {
    const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);

    if (req.method === 'OPTIONS') {
        res.writeHead(204, CORS_HEADERS);
        return res.end();
    }

    if (req.method === 'GET' || req.method === 'HEAD') {
        const file = staticFile(url.pathname);
        if (file) return serveStatic(req, res, file);

        if (url.pathname === '/local-config') {
            // Bilerek CORS başlığı YOK: başka bir site bu yanıtı okuyamasın.
            const ok = localConfigAllowed(req);
            res.writeHead(ok ? 200 : 403, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
            return res.end(JSON.stringify(ok ? { token: TOKEN } : { error: 'Yalnızca bu cihazdan açılan uygulamaya verilir' }));
        }
    }

    if (!authorized(req, url)) {
        return sendJson(res, 401, { error: 'Geçersiz veya eksik token' });
    }

    try {
        if (url.pathname === '/health' && req.method === 'GET') {
            return sendJson(res, 200, { ok: true, name: 'indirici-render-server', version: VERSION, adblock: adblockStatus(), logins: { enabled: logins.enabled, sites: logins.sites().length },
                ytdlp: await findYtdlp().then((t) => (t ? { version: t.version } : null)),
                gallerydl: await findGalleryDl().then((t) => (t ? { version: t.version } : null)) });
        }

        if (url.pathname === '/extract' && req.method === 'POST') {
            const body = await readJson(req);
            let target;
            try {
                target = new URL(body.url);
            } catch (_) {
                return sendJson(res, 400, { error: 'Geçerli bir url gönderin' });
            }
            await assertPublicTarget(target);
            return sendJson(res, 200, await extractWithYtdlp(target.href));
        }

        if (url.pathname === '/images' && req.method === 'POST') {
            const body = await readJson(req);
            let target;
            try {
                target = new URL(body.url);
            } catch (_) {
                return sendJson(res, 400, { error: 'Geçerli bir url gönderin' });
            }
            await assertPublicTarget(target);
            const result = await extractImages(target.href, { cookies: logins.storageState()?.cookies || [] });
            // Resim sunucuları çoğu zaman sayfanın Referer'ını ister (/fetch bunu kullanır).
            for (const item of result.items || []) rememberReferer(item.url, target.href);
            return sendJson(res, 200, result);
        }

        const streamMatch = url.pathname.match(/^\/stream\/([0-9a-f]{24})$/);
        if (streamMatch && (req.method === 'GET' || req.method === 'HEAD')) {
            const entry = streams.get(streamMatch[1]);
            if (!entry) return sendJson(res, 404, { error: 'Akışın süresi doldu; sayfayı yeniden algıla' });
            try {
                await serveStream(req, res, entry);
            } catch (err) {
                if (!res.headersSent) return sendJson(res, 502, { error: err.message });
                res.destroy();
            }
            return;
        }

        if (url.pathname === '/logins' && req.method === 'GET') {
            return sendJson(res, 200, { enabled: logins.enabled, sites: logins.sites() });
        }
        if (url.pathname === '/logins' && req.method === 'DELETE') {
            logins.clear(String(url.searchParams.get('domain') || '').toLowerCase());
            return sendJson(res, 200, { enabled: logins.enabled, sites: logins.sites() });
        }

        if (url.pathname === '/sniff' && req.method === 'POST') {
            const body = await readJson(req);
            let target;
            try {
                target = new URL(body.url);
            } catch (_) {
                return sendJson(res, 400, { error: 'Geçerli bir url gönderin' });
            }
            await assertPublicTarget(target);
            if (activeSniffs >= MAX_PARALLEL_SNIFFS) {
                return sendJson(res, 429, { error: 'Sunucu meşgul, birazdan tekrar deneyin' });
            }
            const waitMs = Math.min(MAX_WAIT_MS, Math.max(1000, Number(body.waitMs) || DEFAULT_WAIT_MS));
            activeSniffs++;
            try {
                return sendJson(res, 200, await sniff(target.href, waitMs));
            } finally {
                activeSniffs--;
            }
        }

        if (url.pathname === '/fetch' && (req.method === 'GET' || req.method === 'HEAD')) {
            const target = url.searchParams.get('url');
            if (!target) return sendJson(res, 400, { error: 'url parametresi gerekli' });
            return await proxyFetch(req, res, target, url.searchParams.get('referer'));
        }

        if (url.pathname === '/session' && req.method === 'POST') {
            const body = await readJson(req);
            let target;
            try {
                target = new URL(body.url);
            } catch (_) {
                return sendJson(res, 400, { error: 'Geçerli bir url gönderin' });
            }
            await assertPublicTarget(target);
            const session = await openSession(target.href);
            return sendJson(res, 200, await sessionState(session));
        }

        if (/^\/(record|capture)(\/|$)/.test(url.pathname)) {
            if ((await handleJobs(req, res, url)) !== false) return;
        }

        const sessionMatch = url.pathname.match(/^\/session\/([0-9a-f]{24})(\/shot|\/action)?$/);
        if (sessionMatch) {
            const [, id, sub = ''] = sessionMatch;
            const session = sessions.get(id);
            if (!session) return sendJson(res, 404, { error: 'Oturum kapanmış; sayfayı yeniden aç' });
            session.lastUsed = Date.now();

            if (sub === '' && req.method === 'GET') return sendJson(res, 200, await sessionState(session));
            if (sub === '' && req.method === 'DELETE') {
                await closeSession(id);
                return sendJson(res, 200, { ok: true });
            }
            if (sub === '/shot' && req.method === 'GET') {
                const image = await session.page.screenshot({ type: 'jpeg', quality: 55, timeout: 8000 });
                res.writeHead(200, { ...CORS_HEADERS, 'content-type': 'image/jpeg', 'content-length': image.length, 'cache-control': 'no-store' });
                return res.end(image);
            }
            if (sub === '/action' && req.method === 'POST') {
                await sessionAction(session, await readJson(req));
                logins.save(session.context).catch(() => {}); // giriş yapıldıysa hemen saklansın
                return sendJson(res, 200, await sessionState(session));
            }
        }

        return sendJson(res, 404, { error: 'Bulunamadı' });
    } catch (err) {
        if (!res.headersSent) return sendJson(res, 400, { error: err.message || 'Hata' });
        res.destroy();
    }
});

const APP_URL = `http://${HOST === '0.0.0.0' ? '127.0.0.1' : HOST}:${PORT}/`;

// Termux'ta (OPEN_APP=1) sunucu açılınca uygulamayı Chrome'da aç.
function openApp() {
    if (process.env.OPEN_APP !== '1') return;
    const child = spawn('termux-open-url', [APP_URL], { stdio: 'ignore', detached: true });
    child.on('error', () => console.log(`Uygulamayı açmak için tarayıcıda şu adrese git: ${APP_URL}`));
    child.unref();
}

server.on('error', (err) => {
    if (err.code === 'EADDRINUSE') {
        // Başka bir Termux oturumunda zaten çalışıyor; ikinci kopyaya gerek yok.
        console.log(`Sunucu zaten çalışıyor: ${APP_URL}`);
        process.exit(0);
    }
    throw err;
});

warmAdblock();

server.listen(PORT, HOST, () => {
    console.log(`İndirici render sunucusu çalışıyor: http://${HOST}:${PORT}`);
    console.log(`Uygulama: ${APP_URL}  (bu adresten açınca token gerekmez)`);
    console.log(`Token (başka cihaz/adresten bağlanırken): ${TOKEN}`);
    if (ALLOW_PRIVATE) console.log('UYARI: ALLOW_PRIVATE=1 — yerel ağ adreslerine erişim açık.');
    openApp();
});

const shutdown = async () => {
    server.close();
    if (browserPromise) {
        const browser = await browserPromise.catch(() => null);
        if (browser) await browser.close().catch(() => {});
    }
    process.exit(0);
};
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
