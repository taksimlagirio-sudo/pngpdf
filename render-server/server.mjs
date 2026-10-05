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
import os from 'node:os';
import fs from 'node:fs';
import path from 'node:path';
import dns from 'node:dns/promises';
import { randomBytes, timingSafeEqual } from 'node:crypto';
import { spawn } from 'node:child_process';
import { Readable } from 'node:stream';
import { fileURLToPath } from 'node:url';
import { classify, dedupKey, isSegment } from './media.mjs';
import { startCast, stopCast, serveStream as serveLive, liveAction, liveFocus, playingVideos } from './live.mjs';
import { createRecorder, parsePlaylist } from './recorder.mjs';
import { createWatcher } from './watcher.mjs';
import { createPush } from './push.mjs';
import { createCapturer } from './capture.mjs';
import { createLoginStore } from './logins.mjs';
import { findYtdlp, extractInfo, normalizeInfo, listEntries } from './ytdlp.mjs';
import { findGalleryDl, extractImages } from './gallerydl.mjs';
import { createCookieJar } from './cookiejar.mjs';
import { pairPage, redeemCode, networkAddresses, tailscaleName } from './pairing.mjs';
import { createLibStore } from './libstore.mjs';
import { createTv } from './tv.mjs';
import { findFfmpeg, analyzeAudio, createAudioJobs } from './audio.mjs';
import { createInbox } from './inbox.mjs';
import { mergeFmp4 } from './fmp4.mjs';
import qrcode from './vendor/qrcode.mjs';
import { installRouting, isAdRequest, warmAdblock, guardNavigation, adblockStatus, countVideoAd, installPageGuards, disarmOverlays } from './adblock.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const VERSION = '0.4.0';
const PORT = Number(process.env.PORT) || 8787;
// Sunucu tarayıcısında yapılan girişler saklanır (SAVE_LOGINS=0 ile kapatılır).
const logins = createLoginStore(process.env.LOGIN_FILE || path.join(HERE, '.logins.json'),
    { enabled: process.env.SAVE_LOGINS !== '0' });
// İndirme isteklerinin çerezleri: sayfayı açan tarayıcının ve yt-dlp'nin çerezleri + kayıtlı girişler.
const cookieJar = createCookieJar({ extra: () => logins.storageState()?.cookies || [] });
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
    'access-control-allow-methods': 'GET, HEAD, POST, PUT, DELETE, OPTIONS',
    'access-control-allow-headers': 'authorization, content-type, range, x-meta, x-device',
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
async function openRecordedPage(pageUrl, contextOptions, { interactive = false } = {}) {
    const browser = await getBrowser();
    const context = logins.attach(await browser.newContext({ storageState: logins.storageState(), bypassCSP: true, ...contextOptions }));
    await context.addInitScript(CODEC_SPOOF);
    // Otomatik taramada reklamlar engellenir: reklam videoları listeye düşmesin, oynatıcı reklamla
    // oyalanmasın. "Kendim dokunayım" ekranında (interactive) hiçbir şey engellenmez ve sayfaya
    // eklenmez: sayfa olduğu gibi, normal bir tarayıcıdaki hızıyla davranır.
    const state0 = { blockedAds: 0 };
    const blocked = new Set(); // engellenen reklam istekleri "başarısız istek" diye listeye girmesin
    if (!interactive) {
        await installRouting(context, { onBlocked: (url) => { state0.blockedAds++; blocked.add(url); } });
        await installPageGuards(context);
    }
    const page = await context.newPage();
    // Tıklamanın açtığı reklam pencereleri hemen kapatılsın (etkileşimli oturum kendisi karar verir).
    if (!interactive) context.on('page', (popup) => { if (popup !== page) popup.close().catch(() => {}); });
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

    // Uzantısı/türü gizlenmiş yayın listesi: "düz metin" ya da "ikili veri" diye gelen küçük
    // yanıtların başına bakılır (#EXTM3U → HLS, <MPD → DASH). Yalnızca kendim dokunayım ekranında
    // (kullanıcı videoyu oynatırken) ve sınırlı sayıda.
    const AMBIGUOUS = /^(text\/plain|application\/octet-stream|binary\/octet-stream|application\/x-mpegurl|text\/html|)$/i;
    const peeked = new Set();
    const peek = async (response, ct, size) => {
        const url = response.url();
        if (peeked.size > 400 || peeked.has(url) || size > 2 * 1024 * 1024 || response.status() !== 200) return;
        if (!['xhr', 'fetch', 'other', 'media'].includes(response.request().resourceType())) return;
        if (/\.(js|css|json|png|jpe?g|gif|webp|svg|woff2?|ico|html?)(\?|$)/i.test(url) && !/\.jpe?g\?.*m3u|\.png\?.*m3u/i.test(url)) return;
        peeked.add(url);
        const body = await response.body().catch(() => null);
        if (!body || !body.length) return;
        const head = body.subarray(0, 64).toString('utf8').replace(/^\uFEFF/, '').trimStart();
        const kind = head.startsWith('#EXTM3U') ? 'application/vnd.apple.mpegurl' : /^<\?xml[^>]*>\s*<MPD|^<MPD/i.test(head) ? 'application/dash+xml' : '';
        if (kind) record(url, kind, body.length, response.request().headers().referer, { response });
    };
    const watch = (pg) => {
        pg.on('response', (response) => {
            const headers = response.headers();
            const request = response.request();
            const ct = (headers['content-type'] || '').split(';')[0].trim();
            const size = Number(headers['content-length']) || 0;
            record(response.url(), headers['content-type'] || '', size, request.headers().referer, { response, failed: response.status() >= 400 });
            if (interactive && AMBIGUOUS.test(ct) && !classify(response.url(), ct)) peek(response, ct, size).catch(() => {});
        });
        pg.on('requestfailed', (request) => {
            record(request.url(), '', 0, request.headers().referer, { failed: true });
        });
    };
    watch(page);
    // Kendim dokunayım: video yeni açılan pencerede oynasa da bulunsun.
    if (interactive) context.on('page', (pg) => { if (pg !== page) watch(pg); });
    state.record = record;
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
        if ((nudge.rounds || 1) < 3 && Date.now() - nudge.emptiedAt > 1500) {
            nudge.rounds = (nudge.rounds || 1) + 1;
            nudge.steps = null;
            nudge.emptiedAt = 0;
        }
    }
    if (!nudge.steps) {
        nudge.nextAt = Math.max(nudge.nextAt || 0, started + 2500);
        nudge.steps = [
            async () => {
                // Tıklamayı yutan görünmez reklam katmanları önce etkisizleştirilir.
                await disarmOverlays(page);
                return false;
            },
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
        // Sayfanın verdiği çerezler (ör. TikTok'un video için istediği) indirmede kullanılsın.
        cookieJar.add(await context.cookies().catch(() => []));
    } finally {
        await context.close().catch(() => {});
    }

    // Engelleyiciden kaçan reklam medyası da listeden çıkarılır.
    const items = [];
    for (const item of foundItems(state)) {
        if (!(await isAdRequest(item.url, pageUrl, 'media'))) items.push(item);
        else countVideoAd();
    }
    return { title, finalUrl, items, main, blockedAds: state.blockedAds, elapsedMs: Date.now() - started };
}

/* ---------------- Etkileşimli oturum: kullanıcı sayfaya kendisi dokunur ---------------- */

// Uygulama sayfanın ekran görüntüsünü gösterir, dokunuşları buraya iletir. Telefon boyutunda
// açılır ki ekranda okunabilsin. Kullanılmayan oturumlar kendiliğinden kapanır.
const MOBILE_UA = 'Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Mobile Safari/537.36';
const SESSION_VIEWPORT = { width: 412, height: 800 };
const MAX_SESSIONS = 2;
const SESSION_IDLE_MS = 5 * 60 * 1000; // SMS/doğrulama kodu için uygulamadan çıkılabilir
const SESSION_MAX_MS = 15 * 60 * 1000;
const sessions = new Map();

async function closeSession(id) {
    const session = sessions.get(id);
    if (!session) return;
    sessions.delete(id);
    clearTimeout(session.saveTimer);
    stopCast(session);
    cookieJar.add(await session.context.cookies().catch(() => []));
    await logins.save(session.context);
    await session.context.close().catch(() => {});
}

setInterval(() => {
    const now = Date.now();
    for (const [id, session] of sessions) {
        if (now - session.lastUsed > SESSION_IDLE_MS || now - session.created > SESSION_MAX_MS) closeSession(id);
    }
}, 15000).unref();

/** Uygulamanın gönderdiği ekran boyutu (telefonun kendi ekranı); yoksa varsayılan telefon boyu. */
function sessionViewport(screen = {}) {
    const clamp = (v, lo, hi, d) => (Number.isFinite(Number(v)) ? Math.max(lo, Math.min(hi, Math.round(Number(v)))) : d);
    return {
        width: clamp(screen.width, 240, 1600, SESSION_VIEWPORT.width),
        height: clamp(screen.height, 320, 2400, SESSION_VIEWPORT.height),
        dpr: Math.max(1, Math.min(3, Number(screen.dpr) || 1.5))
    };
}

async function openSession(pageUrl, screen = {}) {
    // Sınır dolduysa en uzun süredir kullanılmayanı kapat (telefonda bellek kısıtlı).
    while (sessions.size >= MAX_SESSIONS) {
        const oldest = [...sessions.values()].sort((a, b) => a.lastUsed - b.lastUsed)[0];
        await closeSession(oldest.id);
    }
    const vp = sessionViewport(screen);
    const { context, page, state } = await openRecordedPage(pageUrl, {
        userAgent: MOBILE_UA, viewport: { width: vp.width, height: vp.height }, deviceScaleFactor: vp.dpr, isMobile: true, hasTouch: true
    }, { interactive: true });
    // page: ekranda gösterilen sayfa; main: asıl sayfa. Sayfa yeni pencere açınca (giriş penceresi,
    // yeni sekme) ekran ona geçer; pencere kapanınca (ya da ondan Geri ile çıkılınca) önceki sayfaya dönülür.
    const session = { id: randomBytes(12).toString('hex'), context, page, main: page, state, created: Date.now(), lastUsed: Date.now(),
        viewers: new Set(), frame: null, viewport: vp };
    context.on('page', async (popup) => {
        if (popup === page) return;
        await popup.setViewportSize({ width: session.viewport.width, height: session.viewport.height }).catch(() => {});
        const previous = session.page;
        setActivePage(session, popup);
        popup.on('close', () => {
            if (session.page === popup) setActivePage(session, previous.isClosed() ? session.main : previous);
        });
    });
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
    startCast(session).catch(() => {});
    return session;
}

/** Gösterilen sayfa kapandıysa (giriş penceresi işini bitirdi) asıl sayfaya dönülür. */
function activePage(session) {
    if (session.page.isClosed()) setActivePage(session, session.main);
    return session.page;
}

function setActivePage(session, page) {
    session.page = page;
    startCast(session).catch(() => {});
}

/** Girişleri art arda dokunuşlarda bir kez sakla (her saklama tüm çerezleri okur). */
function saveLoginsSoon(session) {
    clearTimeout(session.saveTimer);
    session.saveTimer = setTimeout(() => logins.save(session.context).catch(() => {}), 1500);
}

async function sessionState(session) {
    activePage(session);
    return {
        id: session.id,
        title: await session.page.title().catch(() => ''),
        url: session.page.url(),
        popup: session.page !== session.main, // giriş penceresi gösteriliyor
        width: session.viewport.width,
        height: session.viewport.height,
        items: foundItems(session.state)
    };
}

async function sessionAction(session, action) {
    const page = activePage(session);
    if (action.type === 'viewport') {
        // Telefon klavyesi açılıp kapanınca ekran boyu değişir; sayfa da aynısını görsün.
        const next = sessionViewport({ ...action, dpr: session.viewport.dpr });
        if (next.width === session.viewport.width && next.height === session.viewport.height) return null;
        session.viewport = next;
        for (const pg of session.context.pages()) await pg.setViewportSize({ width: next.width, height: next.height }).catch(() => {});
        await startCast(session, true);
        return null;
    }
    const result = await liveAction(session, action);
    if (!result) throw new Error('Bilinmeyen işlem');
    // Açılan pencerede geri gidilecek yer yoksa pencere kapanır, önceki sayfaya dönülür.
    if (action.type === 'back' && !result.went && page !== session.main) {
        await page.close().catch(() => {});
        return { went: true };
    }
    if (!['touch', 'text', 'tap', 'wheel'].includes(action.type) && !page.isClosed()) await page.waitForTimeout(150).catch(() => {});
    return result;
}

const sessionFocus = (session) => liveFocus(activePage(session));

/**
 * "Bu videoyu yakala": sayfada oynayan videolara bakılır (tüm pencere ve çerçeveler). Doğrudan dosya
 * adresi olanlar listeye eklenir; parça parça yükleniyorsa (blob) oynatıcının yüklediği yayın listesi
 * zaten listededir ya da "oynatıp kaydet" önerilir.
 */
async function catchPlaying(session) {
    const videos = await playingVideos(session.context);
    for (const v of videos) {
        if (!/^https?:/i.test(v.src)) continue;
        const ct = /\.m3u8(\?|$)/i.test(v.src) ? 'application/vnd.apple.mpegurl' : /\.mpd(\?|$)/i.test(v.src) ? 'application/dash+xml' : 'video/mp4';
        session.state.record(v.src, ct, 0, v.frameUrl);
        const kind = classify(v.src, ct);
        const it = kind && session.state.found.get(dedupKey(v.src, kind));
        if (it) {
            it.manual = true; // oynayan video: listeden elenmesin
            it.failed = false;
        }
    }
    await Promise.all(session.state.pending.splice(0));
    const playing = videos.filter((v) => v.time > 0 || !v.paused);
    return {
        items: foundItems(session.state),
        playing: playing.slice(0, 5).map((v) => ({ src: /^blob:/i.test(v.src) ? 'blob' : v.src, time: v.time, duration: v.duration, live: v.live, w: v.w, h: v.h })),
        blob: playing.some((v) => /^blob:/i.test(v.src)),
        pageUrl: activePage(session).url()
    };
}

/**
 * Önizleme: medyanın bir karesi (küçük resim), süresi ve çözünürlüğü sunucudaki ffmpeg ile, sayfanın
 * oturumuyla (çerez, Referer) alınır. ffmpeg yoksa yalnızca bilinenler döner.
 */
async function probeMedia(session, url) {
    session.probes = session.probes || new Map();
    if (session.probes.has(url)) return session.probes.get(url);
    const job = (async () => {
        let target;
        try {
            target = new URL(url);
            if (!/^https?:$/.test(target.protocol)) throw new Error();
            await assertPublicTarget(target); // yerel ağ adreslerine ffmpeg ile gidilmesin
        } catch (_) {
            return { error: 'Geçersiz adres' };
        }
        const tool = await findFfmpeg();
        if (!tool) return { error: 'Sunucuda ffmpeg yok' };
        const item = [...session.state.found.values()].find((i) => i.url === url) || {};
        const cookies = await session.context.cookies(url).catch(() => []);
        const headers = [`Referer: ${item.referer || session.main.url()}`, cookies.length ? `Cookie: ${cookies.map((c) => `${c.name}=${c.value}`).join('; ')}` : '']
            .filter(Boolean).map((l) => l + '\r\n').join('');
        // Uzantısı gizlenmiş yayın listesi (.txt, .jpg...) için ffmpeg'in uzantı denetimi gevşetilir.
        // (extension_picky ffmpeg 7'de geldi; eskisinde bilinmeyen seçenek hata verir.)
        const major = Number(String(tool.version || '').replace(/^n/, '').split('.')[0]) || 0;
        const hls = item.kind === 'hls' ? ['-f', 'hls', '-allowed_extensions', 'ALL', ...(major >= 7 ? ['-extension_picky', '0'] : [])] : [];
        const args = ['-hide_banner', '-nostdin', '-user_agent', MOBILE_UA, '-headers', headers, '-rw_timeout', '15000000',
            ...hls, '-ss', '3', '-i', url, '-frames:v', '1', '-vf', 'scale=320:-2', '-f', 'image2', '-c:v', 'mjpeg', '-q:v', '6', 'pipe:1'];
        return new Promise((resolve) => {
            const child = spawn(tool.cmd, args, { stdio: ['ignore', 'pipe', 'pipe'] });
            const out = [];
            let err = '';
            const timer = setTimeout(() => child.kill('SIGKILL'), 25000);
            child.stdout.on('data', (d) => out.push(d));
            child.stderr.on('data', (d) => { if (err.length < 20000) err += d; });
            child.on('error', () => resolve({ error: 'ffmpeg çalışmadı' }));
            child.on('close', () => {
                clearTimeout(timer);
                const dur = /Duration: (\d+):(\d+):([\d.]+)/.exec(err);
                const res = /Video:.*?\s(\d{2,5})x(\d{2,5})[\s,]/.exec(err);
                const jpeg = Buffer.concat(out);
                resolve({
                    thumb: jpeg.length ? `data:image/jpeg;base64,${jpeg.toString('base64')}` : '',
                    duration: dur ? Number(dur[1]) * 3600 + Number(dur[2]) * 60 + Number(dur[3]) : 0,
                    width: res ? Number(res[1]) : 0,
                    height: res ? Number(res[2]) : 0,
                    error: jpeg.length || dur ? '' : (err.trim().split('\n').pop() || 'açılamadı').slice(0, 160)
                });
            });
        });
    })();
    session.probes.set(url, job);
    return job;
}

// HLS playlist'iyle aynı klasördeki .mp4 adlı fMP4 parçaları ayrı video gibi listelenmesin.
function dropHlsSiblings(items) {
    const dirs = new Set(items.filter((i) => i.kind === 'hls').map((i) => dirOf(i.url)));
    // Elle yakalanan (oynayan) video hiç elenmez; diğerlerinden yalnızca parça gibi görünenler (.mp4/.m4v).
    return items.filter((i) => i.kind !== 'video' || i.manual || !/\.(mp4|m4v)(\?|$)/i.test(i.url) || !dirs.has(dirOf(i.url)));
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
    const explicit = headers.cookie || '';
    const sent = { ...headers };
    for (let hop = 0; ; hop++) {
        await assertPublicTarget(current);
        // Tarayıcı gibi: her adımda yalnızca o adresin alan adına/yoluna uyan çerezler.
        const names = new Set();
        const parts = [];
        for (const part of [current.host === startHost ? explicit : '', cookieJar.header(current.href)].join('; ').split(/;\s*/)) {
            const name = part.split('=')[0];
            if (!part || names.has(name)) continue;
            names.add(name);
            parts.push(part);
        }
        if (parts.length) sent.cookie = parts.join('; ');
        else delete sent.cookie;
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
    if (request.cookies && request.cookies.length) cookieJar.add(request.cookies);
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
function pairPageAllowed(req) {
    const host = (req.headers.host || '').toLowerCase();
    const loopback = [`127.0.0.1:${PORT}`, `localhost:${PORT}`, `[::1]:${PORT}`].includes(host);
    const site = req.headers['sec-fetch-site'];
    return loopback && (!site || site === 'none' || site === 'same-origin');
}

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

/* ---------------- Takip (yayın bekle, zamanla, kanal) ---------------- */

const push = createPush({
    keyFile: path.join(HERE, '.push-keys.json'),
    subsFile: path.join(HERE, '.push-subs.json')
});

async function fetchText(url) {
    const headers = { 'user-agent': DESKTOP_UA, accept: '*/*' };
    const referer = refererByUrl.get(url) || refererByHost.get(new URL(url).host);
    if (referer) headers.referer = referer;
    const res = await fetchUpstream(url, headers, { signal: AbortSignal.timeout(20000) });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return res.text();
}

/** Sayfada (ya da doğrudan .m3u8 adresinde) şu an canlı bir yayın var mı? */
async function findLive(pageUrl) {
    let candidates = [];
    let title = '';
    if (/\.m3u8(\?|$)/i.test(pageUrl)) {
        candidates = [pageUrl];
    } else {
        const r = await sniff(pageUrl, 20000);
        if (r.main && r.main.status >= 400) return { reachable: false, error: `Sayfa HTTP ${r.main.status} döndü` };
        title = r.title || '';
        if (r.main && /mpegurl/.test(r.main.contentType)) candidates = [pageUrl];
        candidates.push(...r.items.filter((i) => i.kind === 'hls').map((i) => i.url));
    }
    for (const url of candidates) {
        try {
            const list = parsePlaylist(await fetchText(url), url);
            const media = list.type === 'master' ? parsePlaylist(await fetchText(list.variants[0].url), list.variants[0].url) : list;
            if (media.isLive) return { reachable: true, live: { url }, title };
        } catch (_) { /* bu aday açılmadı */ }
    }
    return { reachable: true, live: null, title };
}

/** /stream/... (yt-dlp biçimi) adresini sunucudaki dosyaya indirir. */
async function saveStream(streamUrl, file, onBytes, signal) {
    const id = (String(streamUrl).match(/^\/stream\/([0-9a-f]{24})$/) || [])[1];
    const entry = id && streams.get(id);
    if (!entry || (entry.fragments && entry.fragments.length)) throw new Error('Bu biçim sunucuya indirilemiyor');
    const headers = { 'user-agent': DESKTOP_UA, accept: '*/*', ...entry.headers };
    const out = fs.createWriteStream(file);
    try {
        const chunk = entry.chunk || STREAM_CHUNK;
        let offset = 0;
        for (;;) {
            const up = await fetchUpstream(entry.url, { ...headers, range: `bytes=${offset}-${offset + chunk - 1}` }, { signal });
            if (!up.ok) throw new Error(`Dosya alınamadı (HTTP ${up.status})`);
            let got = 0;
            for await (const c of up.body) {
                got += c.length;
                onBytes(c.length);
                if (!out.write(c)) await new Promise((r) => out.once('drain', r));
            }
            offset += got;
            const total = Number((up.headers.get('content-range') || '').split('/')[1]) || 0;
            if (up.status === 200 || got < chunk || (total && offset >= total)) break;
        }
    } finally {
        await new Promise((r) => out.end(r));
    }
}

/** Kanalın yeni videosunu sunucuya indirir (en uygun kalite; sesli tek dosya ya da HLS). */
async function downloadEntry(entry, { maxHeight = 0, keepMs = 0, source = '' } = {}) {
    const r = await extractWithYtdlp(entry.url);
    if (!r.ok) throw new Error(r.reason || 'Video bulunamadı');
    const name = (r.title || entry.title || 'video').slice(0, 100);
    const fits = (i) => !maxHeight || !i.height || i.height <= maxHeight;
    const byHeight = (a, b) => (b.height || 0) - (a.height || 0);
    const hls = r.items.filter((i) => i.kind === 'hls').sort(byHeight)[0];
    const single = r.items.filter((i) => i.kind === 'video' && !i.audioUrl).sort(byHeight).find(fits);
    const hlsBetter = hls && (!single || (hls.height || 0) > (single.height || 0));
    if (hls && (hlsBetter || !single)) {
        return recorder.start({ url: hls.url, name, vod: true, maxHeight, keepMs, source: source || entry.url });
    }
    if (single) {
        return recorder.importFile({
            name, ext: single.ext || 'mp4', keepMs, source: source || entry.url, quality: single.height ? `${single.height}p` : '',
            fetchTo: (file, onBytes, signal) => saveStream(single.url, file, onBytes, signal)
        });
    }
    throw new Error('Sesli tek dosya ya da akış bulunamadı');
}

/* ---------------- Sunucuda indir ("arka planda indir") ---------------- */

/**
 * Bağlantıyı sunucudaki dosyaya indirir; bağlantı koparsa kaldığı yerden sürdürür. Sunucunun kendi
 * "/stream/…" adresleri (gelişmiş bulma) sunucunun kendisinden okunur.
 */
async function fetchToFile(src, file, onBytes, signal, onTotal = () => {}) {
    const own = String(src).match(/\/stream\/([0-9a-f]{24})(?:[?#]|$)/);
    let url;
    let headers = { 'user-agent': DESKTOP_UA, accept: '*/*' };
    if (own) {
        url = `http://${HOST === '0.0.0.0' || HOST === '::' ? '127.0.0.1' : HOST}:${PORT}/stream/${own[1]}`;
        headers = { authorization: `Bearer ${TOKEN}` };
    } else {
        url = new URL(src).href;
        const referer = refererByUrl.get(url) || refererByHost.get(new URL(url).host);
        if (referer) headers.referer = referer;
    }
    let offset = 0;
    for (let tries = 0; ; tries++) {
        try {
            const h = offset ? { ...headers, range: `bytes=${offset}-` } : headers;
            const up = own ? await fetch(url, { headers: h, signal }) : await fetchUpstream(url, h, { signal });
            if (!up.ok) {
                up.body?.cancel().catch(() => {});
                throw Object.assign(new Error(`Dosya alınamadı (HTTP ${up.status})`), { fatal: up.status < 500 && up.status !== 429 });
            }
            if (offset && up.status !== 206) offset = 0; // kaynak sürdürmeyi desteklemiyor: baştan
            const total = Number((up.headers.get('content-range') || '').split('/')[1]) || (Number(up.headers.get('content-length')) || 0) + offset;
            if (total) onTotal(total);
            const out = fs.createWriteStream(file, { flags: offset ? 'a' : 'w' });
            try {
                for await (const c of up.body) {
                    offset += c.length;
                    onBytes(c.length);
                    if (!out.write(c)) await new Promise((r) => out.once('drain', r));
                }
            } finally {
                await new Promise((r) => out.end(r));
            }
            if (total && offset < total) throw new Error('Bağlantı yarıda kesildi');
            return;
        } catch (err) {
            if (signal.aborted || err.fatal || tries >= 6) throw err;
            await new Promise((r) => setTimeout(r, 2000 * (tries + 1)));
        }
    }
}

/** İstemcinin "arka planda indir"i: dosya (ayrı sesiyle) ya da HLS sunucuda iner. */
async function startServerDownload({ url, audioUrl = '', name = 'video', hls = false, page = '' }) {
    if (!/^https?:\/\//i.test(url || '')) throw new Error('Geçersiz adres');
    const base = String(name).replace(/\.[a-z0-9]{2,4}$/i, '') || 'video';
    if (page) rememberReferer(url, page);
    if (hls) return { ...await recorder.start({ url, audioUrl: audioUrl || undefined, name: base, vod: true, source: page || url }), download: true };
    const ext = audioUrl ? 'mp4' : ((String(name).match(/\.([a-z0-9]{2,4})$/i) || [])[1] || 'mp4').toLowerCase();
    return recorder.importFile({
        name: base, ext, source: page || url, download: true,
        fetchTo: async (file, onBytes, signal, onTotal) => {
            if (!audioUrl) return fetchToFile(url, file, onBytes, signal, onTotal);
            // Ayrı görüntü + ses: ikisi de indirilip tek MP4'te birleştirilir.
            const v = `${file}.v`;
            const a = `${file}.a`;
            let vt = 0;
            let at = 0;
            try {
                await Promise.all([
                    fetchToFile(url, v, onBytes, signal, (t) => { vt = t; onTotal(vt + at); }),
                    fetchToFile(audioUrl, a, onBytes, signal, (t) => { at = t; onTotal(vt + at); })
                ]);
                const r = await mergeFmp4([{ file: v, mime: 'video/mp4' }, { file: a, mime: 'audio/mp4' }], file);
                return { ext: r.ext };
            } finally {
                fs.rm(v, { force: true }, () => {});
                fs.rm(a, { force: true }, () => {});
            }
        }
    });
}

const watcher = createWatcher({
    file: process.env.WATCH_FILE || path.join(HERE, '.watches.json'),
    recorder,
    findLive,
    listEntries: (url) => listEntries(url, { cookies: logins.storageState()?.cookies || [] }),
    downloadEntry,
    push,
    log: (m) => console.log(m)
});

async function handleWatch(req, res, url) {
    if (url.pathname === '/watch' && req.method === 'GET') return sendJson(res, 200, watcher.list());
    if (url.pathname === '/watch' && req.method === 'POST') return sendJson(res, 200, watcher.add(await readJson(req)));
    if (url.pathname === '/watch/probe' && req.method === 'POST') {
        const body = await readJson(req);
        const target = new URL(String(body.url || ''));
        if (!/^https?:$/.test(target.protocol)) return sendJson(res, 400, { error: 'Adres http/https olmalı' });
        const r = await findLive(target.href).catch((err) => ({ reachable: false, error: err.message }));
        return sendJson(res, 200, { reachable: r.reachable, live: Boolean(r.live), title: r.title || '', error: r.error || '' });
    }
    if (url.pathname === '/watch/events/seen' && req.method === 'POST') {
        const body = await readJson(req);
        watcher.seenEvents(Array.isArray(body.ids) ? body.ids.map(String) : []);
        return sendJson(res, 200, { ok: true });
    }
    const m = url.pathname.match(/^\/watch\/([0-9a-f]{16})(\/(check|stop))?$/);
    if (!m) return sendJson(res, 404, { error: 'Bulunamadı' });
    const [, id, , action] = m;
    let result = null;
    if (action === 'check' && req.method === 'POST') result = watcher.checkNow(id);
    else if (action === 'stop' && req.method === 'POST') result = watcher.stop(id);
    else if (!action && req.method === 'POST') result = watcher.update(id, await readJson(req));
    else if (!action && req.method === 'DELETE') result = watcher.remove(id) ? { ok: true } : null;
    return result ? sendJson(res, 200, result) : sendJson(res, 404, { error: 'Takip bulunamadı' });
}

/* ---------------- Cihazlar arası kitaplık ve TV'de oynat ---------------- */

const libstore = createLibStore({ dir: process.env.LIBRARY_DIR || path.join(HERE, '.library') });
const tv = createTv();

/** Dosyayı Range desteğiyle gönderir (oynatıcılar ileri sarabilsin). */
function sendFileRange(req, res, file, extra = {}) {
    const size = file.size;
    const m = /bytes=(\d*)-(\d*)/.exec(req.headers.range || '');
    let start = 0;
    let end = size - 1;
    if (m) {
        if (m[1]) start = Number(m[1]);
        if (m[2]) end = Math.min(size - 1, Number(m[2]));
        if (!m[1] && m[2]) start = Math.max(0, size - Number(m[2]));
        if (start > end || start >= size) {
            res.writeHead(416, { ...CORS_HEADERS, 'content-range': `bytes */${size}` });
            return res.end();
        }
    }
    const ascii = file.name.replace(/[^\x20-\x7e]/g, '_').replace(/"/g, '');
    res.writeHead(m ? 206 : 200, {
        ...CORS_HEADERS, ...extra,
        'content-type': file.mime,
        'content-length': end - start + 1,
        'accept-ranges': 'bytes',
        ...(m ? { 'content-range': `bytes ${start}-${end}/${size}` } : {}),
        'content-disposition': `inline; filename="${ascii}"; filename*=UTF-8''${encodeURIComponent(file.name)}`,
        'cache-control': 'no-store'
    });
    if (req.method === 'HEAD') return res.end();
    const stream = fs.createReadStream(file.path, { start, end });
    res.on('close', () => stream.destroy());
    stream.on('error', () => res.destroy());
    stream.pipe(res);
}

/** "library:ID" / "record:ID" / "capture:ID" → dosya. */
function sourceFile(source) {
    const [kind, id] = String(source || '').split(':');
    if (kind === 'library') return libstore.file(id);
    if (kind === 'record') return recorder.file(id);
    if (kind === 'capture') return capturer.file(id);
    return null;
}

/** TV'nin açabileceği adresler (bu ağ / Tailscale / PUBLIC_URL). */
async function reachableBases() {
    const out = [];
    const publicUrl = (process.env.PUBLIC_URL || '').replace(/\/+$/, '');
    if (publicUrl) out.push({ label: 'Uzaktan', url: publicUrl });
    if (HOST === '0.0.0.0' || HOST === '::') {
        const { lan, tailnet } = networkAddresses();
        for (const ip of lan.slice(0, 2)) out.push({ label: 'Bu ağda', url: `http://${ip}:${PORT}` });
        const ts = await tailscaleName();
        if (ts || tailnet[0]) out.push({ label: 'Tailscale', url: `http://${ts || tailnet[0]}:${PORT}` });
    }
    out.push({ label: 'Bu cihaz', url: `http://127.0.0.1:${PORT}` });
    return out;
}

/** Token istemeyen TV uçları: oynatıcı sayfası, dosya, komut bekleme, durum bildirme. */
async function handleTvPublic(req, res, url) {
    const m = url.pathname.match(/^\/tv\/([0-9a-f]{12})\/([A-Za-z0-9_-]{16})(\/(file|poll|state))?$/);
    if (!m) return false;
    const s = tv.check(m[1], m[2]);
    if (!s) {
        res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' });
        res.end('Oturum bulunamadı ya da süresi doldu');
        return true;
    }
    const part = m[4];
    if (!part && req.method === 'GET') {
        res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' });
        res.end(tv.page(s));
        return true;
    }
    if (part === 'file' && (req.method === 'GET' || req.method === 'HEAD')) {
        const file = sourceFile(s.source);
        if (!file) {
            res.writeHead(404);
            res.end();
            return true;
        }
        sendFileRange(req, res, file);
        return true;
    }
    if (part === 'poll' && req.method === 'GET') {
        sendJson(res, 200, await tv.poll(s, Number(url.searchParams.get('after')) || 0));
        return true;
    }
    if (part === 'state' && req.method === 'POST') {
        tv.report(s, await readJson(req, 4096).catch(() => ({})));
        sendJson(res, 200, { ok: true });
        return true;
    }
    return false;
}

async function handleTv(req, res, url) {
    if (url.pathname === '/tv' && req.method === 'POST') {
        const body = await readJson(req);
        if (!sourceFile(body.source)) return sendJson(res, 404, { error: 'Dosya sunucuda bulunamadı' });
        const s = tv.create({ source: body.source, title: body.title });
        const path_ = `/tv/${s.id}/${s.secret}`;
        const urls = (await reachableBases()).map((b) => ({ ...b, url: b.url + path_ }));
        return sendJson(res, 200, { id: s.id, urls });
    }
    const m = url.pathname.match(/^\/tv\/([0-9a-f]{12})(\/(cmd|qr))?$/);
    if (!m) return sendJson(res, 404, { error: 'Bulunamadı' });
    const s = tv.get(m[1]);
    if (!s) return sendJson(res, 404, { error: 'Oturum bulunamadı' });
    if (m[3] === 'cmd' && req.method === 'POST') {
        const body = await readJson(req);
        tv.command(s.id, body.action, body.value);
        return sendJson(res, 200, tv.publicState(s));
    }
    if (m[3] === 'qr' && req.method === 'GET') {
        const qr = qrcode(0, 'M');
        qr.addData(String(url.searchParams.get('u') || '').slice(0, 500));
        qr.make();
        res.writeHead(200, { ...CORS_HEADERS, 'content-type': 'image/svg+xml', 'cache-control': 'no-store' });
        return res.end(qr.createSvgTag({ cellSize: 6, margin: 2, scalable: true }));
    }
    if (!m[3] && req.method === 'GET') return sendJson(res, 200, tv.publicState(s));
    if (!m[3] && req.method === 'DELETE') {
        tv.command(s.id, 'close');
        setTimeout(() => tv.remove(s.id), 3000);
        return sendJson(res, 200, { ok: true });
    }
    return sendJson(res, 404, { error: 'Bulunamadı' });
}

const audioJobs = createAudioJobs({ outDir: path.join(HERE, '.audio') });

async function handleAudio(req, res, url) {
    if (url.pathname === '/audio/analyze' && req.method === 'POST') {
        const body = await readJson(req);
        const file = sourceFile(body.source);
        if (!file) return sendJson(res, 404, { error: 'Dosya sunucuda bulunamadı' });
        return sendJson(res, 200, await analyzeAudio(file.path));
    }
    if (url.pathname === '/audio/export' && req.method === 'POST') {
        const body = await readJson(req);
        const file = sourceFile(body.source);
        if (!file) return sendJson(res, 404, { error: 'Dosya sunucuda bulunamadı' });
        return sendJson(res, 200, await audioJobs.start({ ...body, file: file.path, name: String(body.name || 'ses').slice(0, 100) }));
    }
    const m = url.pathname.match(/^\/audio\/job\/([0-9a-f]{16})(\/file)?$/);
    if (!m) return sendJson(res, 404, { error: 'Bulunamadı' });
    if (m[2] && (req.method === 'GET' || req.method === 'HEAD')) {
        const file = audioJobs.file(m[1]);
        return file ? sendFileRange(req, res, file) : sendJson(res, 404, { error: 'Dosya hazır değil' });
    }
    if (!m[2] && req.method === 'GET') {
        const j = audioJobs.get(m[1]);
        return j ? sendJson(res, 200, j) : sendJson(res, 404, { error: 'İş bulunamadı' });
    }
    if (!m[2] && req.method === 'DELETE') return sendJson(res, 200, { ok: audioJobs.remove(m[1]) });
    return sendJson(res, 404, { error: 'Bulunamadı' });
}

/* ---------------- Bilgisayardan gönder (yer imi) ---------------- */

const inbox = createInbox({ file: path.join(HERE, '.inbox.json'), push });

/** Token istemeyen uçlar: /yerimi sayfası ve /gonder (yalnızca gönderme anahtarıyla). */
function handleInboxPublic(req, res, url) {
    if (url.pathname === '/gonder' && req.method === 'GET') {
        const json = url.searchParams.get('json') === '1';
        let item = null;
        let error = '';
        if (!inbox.checkKey(url.searchParams.get('k'))) error = 'Düğme eski; İndirici > Ayarlar > Bilgisayardan gönder sayfasından yenisini al';
        else {
            try {
                item = inbox.add({ url: url.searchParams.get('u'), title: url.searchParams.get('t') || '' });
            } catch (err) {
                error = err.message;
            }
        }
        if (json) {
            sendJson(res, error ? 400 : 200, error ? { error } : item);
            return true;
        }
        res.writeHead(error ? 400 : 200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' });
        res.end(inbox.sentPage(item, error));
        return true;
    }
    if (url.pathname === '/yerimi' && req.method === 'GET') {
        // Sayfa gönderme anahtarını içerdiğinden anahtarla açılır (uygulama adresi tam verir).
        if (!inbox.checkKey(url.searchParams.get('k'))) {
            res.writeHead(403, { 'content-type': 'text/plain; charset=utf-8' });
            res.end('Bu adresi İndirici > Ayarlar > Bilgisayardan gönder ekranından kopyala.');
            return true;
        }
        const base = `http://${req.headers.host || `127.0.0.1:${PORT}`}`;
        res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store', 'x-frame-options': 'DENY' });
        res.end(inbox.page(base));
        return true;
    }
    return false;
}

/* ---------------- Sunucu durumu ---------------- */

const DAY_MS = 24 * 60 * 60 * 1000;
const KEEP_CHOICES = [0, 7, 30, 90];
const SETTINGS_FILE = path.join(HERE, '.server-settings.json');
let serverSettings = { keepDays: 7 };
try {
    serverSettings = { ...serverSettings, ...JSON.parse(fs.readFileSync(SETTINGS_FILE, 'utf8')) };
} catch (_) { /* varsayılanlar */ }
recorder.setKeepDefault(serverSettings.keepDays * DAY_MS);

const recentErrors = [];
function noteError(title, where = '') {
    recentErrors.unshift({ at: Date.now(), title: String(title).slice(0, 160), where: String(where).slice(0, 200) });
    recentErrors.length = Math.min(recentErrors.length, 20);
}

const hostOf = (u) => {
    try {
        return new URL(u).host.replace(/^www\./, '');
    } catch (_) {
        return '';
    }
};

function dirSize(dir) {
    let n = 0;
    try {
        for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
            const p = path.join(dir, e.name);
            n += e.isDirectory() ? dirSize(p) : fs.statSync(p).size;
        }
    } catch (_) { /* yok */ }
    return n;
}

function serverStatus() {
    let disk = null;
    try {
        const st = fs.statfsSync(HERE);
        disk = { total: st.blocks * st.bsize, free: st.bavail * st.bsize };
    } catch (_) { /* eski Node */ }
    const recs = recorder.list();
    const caps = capturer.list();
    const sizes = {
        records: dirSize(process.env.RECORD_DIR || path.join(HERE, '.recordings')) + dirSize(process.env.CAPTURE_DIR || path.join(HERE, '.captures')),
        library: dirSize(process.env.LIBRARY_DIR || path.join(HERE, '.library')),
        other: dirSize(path.join(HERE, '.audio'))
    };
    const running = [...recs, ...caps].filter((r) => r.state === 'recording' || r.state === 'stopping' || r.state === 'capturing')
        .map((r) => ({ id: r.id, name: r.fileName || '', quality: r.quality || '', startedAt: r.startedAt, mediaSec: r.mediaSec || 0, bytes: r.bytes || 0, live: !r.vod && r.mode !== 'capture' }));
    const w = watcher.list();
    const waiting = w.items.filter((x) => x.enabled && x.state !== 'recording');
    const next = waiting.map((x) => x.nextCheck || 0).filter((t) => t > Date.now()).sort((a, b) => a - b)[0] || 0;
    const weekAgo = Date.now() - 7 * DAY_MS;
    const doneWeek = [...recs, ...caps].filter((r) => r.state === 'done' && r.endedAt > weekAgo);
    const errors = [
        ...recentErrors,
        ...[...recs, ...caps].filter((r) => r.state === 'error' && r.error).map((r) => ({ at: r.endedAt || r.startedAt, title: r.error, where: hostOf(r.source || r.url) })),
        ...w.events.filter((e) => e.kind === 'unreachable').map((e) => ({ at: e.at, title: e.title, where: e.body }))
    ].sort((a, b) => b.at - a.at).slice(0, 6);
    const ab = adblockStatus();
    return {
        version: VERSION, host: os.hostname(), uptime: Math.round(process.uptime()), node: process.version,
        termux: (process.env.PREFIX || '').includes('com.termux'), disk, sizes, running,
        pending: { count: waiting.length, nextCheck: next },
        week: { count: doneWeek.length, bytes: doneWeek.reduce((n, r) => n + (r.bytes || 0), 0) },
        adblock: { blocked: ab.blocked, since: ab.since, enabled: ab.enabled },
        biggest: recs.filter((r) => r.state === 'done').sort((a, b) => b.bytes - a.bytes).slice(0, 3)
            .map((r) => ({ id: r.id, name: r.fileName, bytes: r.bytes, endedAt: r.endedAt })),
        errors,
        settings: serverSettings,
        deletable: KEEP_CHOICES.filter(Boolean).map((d) => ({ days: d, ...recorder.olderThan(d * DAY_MS) }))
    };
}

/** Sunucuyu yeniden başlatır: aynı komutla yeni bir kopya açılır, bu kopya kapanır. */
function restartServer() {
    setTimeout(async () => {
        server.close();
        if (browserPromise) {
            const browser = await browserPromise.catch(() => null);
            if (browser) await browser.close().catch(() => {});
        }
        const child = spawn(process.execPath, process.argv.slice(1), {
            cwd: process.cwd(), env: { ...process.env, INDIRICI_RESTART: '1', OPEN_APP: '0' }, stdio: 'inherit', detached: true
        });
        child.unref();
        process.exit(0);
    }, 300);
}

async function handleStatus(req, res, url) {
    if (url.pathname === '/status' && req.method === 'GET') return sendJson(res, 200, serverStatus());
    if (url.pathname === '/status/settings' && req.method === 'POST') {
        const body = await readJson(req);
        if (body.keepDays !== undefined) {
            if (!KEEP_CHOICES.includes(Number(body.keepDays))) throw new Error('Geçersiz süre');
            serverSettings.keepDays = Number(body.keepDays);
            recorder.setKeepDefault(serverSettings.keepDays * DAY_MS);
        }
        fs.writeFileSync(SETTINGS_FILE, JSON.stringify(serverSettings));
        return sendJson(res, 200, serverStatus());
    }
    if (url.pathname === '/status/restart' && req.method === 'POST') {
        sendJson(res, 200, { ok: true });
        restartServer();
        return;
    }
    if (url.pathname === '/inbox' && req.method === 'GET') {
        return sendJson(res, 200, { key: inbox.key, items: inbox.list(Number(url.searchParams.get('after')) || 0), bases: url.searchParams.get('bases') ? await reachableBases() : undefined });
    }
    return sendJson(res, 404, { error: 'Bulunamadı' });
}

async function handleLibrary(req, res, url) {
    if (url.pathname === '/library' && req.method === 'GET') return sendJson(res, 200, libstore.list());
    if (url.pathname === '/library/sync' && req.method === 'POST') return sendJson(res, 200, libstore.sync(await readJson(req, 4 * 1024 * 1024)));
    const m = url.pathname.match(/^\/library\/item\/([a-z0-9]{4,40})(\/file)?$/i);
    if (!m) return sendJson(res, 404, { error: 'Bulunamadı' });
    const [, id, isFile] = m;
    if (isFile && (req.method === 'GET' || req.method === 'HEAD')) {
        const file = libstore.file(id);
        if (!file) return sendJson(res, 404, { error: 'Dosya yok' });
        return sendFileRange(req, res, file);
    }
    if (!isFile && req.method === 'PUT') {
        let meta = {};
        try {
            meta = JSON.parse(Buffer.from(String(req.headers['x-meta'] || ''), 'base64').toString('utf8') || '{}');
        } catch (_) { /* üst veri yok */ }
        const item = await libstore.put(id, meta, req, String(req.headers['x-device'] || ''));
        return sendJson(res, 200, item);
    }
    if (!isFile && req.method === 'DELETE') return sendJson(res, libstore.remove(id) ? 200 : 404, { ok: true });
    return sendJson(res, 404, { error: 'Bulunamadı' });
}

/** /record (canlı HLS kaydı) ve /capture (sunucuda oynatıp kaydetme) aynı biçimde yönetilir. */
async function handleJobs(req, res, url) {
    const [, kind] = url.pathname.match(/^\/(record|capture)/) || [];
    const manager = kind === 'capture' ? capturer : recorder;
    if (kind === 'record' && url.pathname === '/record/import' && req.method === 'POST') {
        return sendJson(res, 200, await startServerDownload(await readJson(req)));
    }
    if (url.pathname === `/${kind}`) {
        if (req.method === 'GET') return sendJson(res, 200, { items: manager.list() });
        if (req.method === 'POST') {
            // İstek bu makineden geliyorsa (sunucu telefonda) video bağlantısı IP'ye takılmaz;
            // hata açıklaması buna göre seçilir.
            const sameDevice = /^(127\.|::1$|::ffff:127\.)/.test(req.socket.remoteAddress || '');
            return sendJson(res, 200, await manager.start({ ...(await readJson(req)), sameDevice }));
        }
    }
    const match = url.pathname.match(/^\/(?:record|capture)\/([0-9a-f]{24})(\/stop|\/file|\/shot|\/action|\/stream)?$/);
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
    if (kind === 'capture' && sub === '/stream' && req.method === 'GET') {
        if (!manager.stream(id, req, res, CORS_HEADERS)) return sendJson(res, 404, { error: 'Kayıt sayfası kapalı' });
        return;
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

    if (url.pathname.startsWith('/tv/') && await handleTvPublic(req, res, url).catch((err) => {
        if (!res.headersSent) sendJson(res, 400, { error: err.message });
        return true;
    })) return;

    if ((url.pathname === '/gonder' || url.pathname === '/yerimi') && handleInboxPublic(req, res, url)) return;

    if (req.method === 'GET' || req.method === 'HEAD') {
        const file = staticFile(url.pathname);
        if (file) return serveStatic(req, res, file);

        if (url.pathname === '/baglan') {
            // Token'ı gösteren sayfa: yalnızca sunucunun çalıştığı cihazdan açılır.
            if (!pairPageAllowed(req)) {
                res.writeHead(403, { 'content-type': 'text/plain; charset=utf-8' });
                return res.end('Bu sayfa yalnızca sunucunun çalıştığı cihazda açılır: http://127.0.0.1:' + PORT + '/baglan');
            }
            const html = await pairPage({
                host: HOST, port: PORT, token: TOKEN, version: VERSION,
                stats: [
                    `Reklam engeli: ${adblockStatus().enabled ? 'açık' : 'kapalı'}`,
                    `Girişler: ${logins.sites().length} site`
                ]
            });
            res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store', 'x-frame-options': 'DENY' });
            return res.end(html);
        }

        if (url.pathname === '/local-config') {
            // Bilerek CORS başlığı YOK: başka bir site bu yanıtı okuyamasın.
            const ok = localConfigAllowed(req);
            res.writeHead(ok ? 200 : 403, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
            return res.end(JSON.stringify(ok ? { token: TOKEN } : { error: 'Yalnızca bu cihazdan açılan uygulamaya verilir' }));
        }
    }

    if (url.pathname === '/pair' && req.method === 'POST') {
        // QR'daki tek kullanımlık kod karşılığında token verilir.
        const body = await readJson(req, 4096).catch(() => ({}));
        if (!redeemCode(body && body.code)) return sendJson(res, 403, { error: 'Kod geçersiz ya da süresi doldu; sunucudaki sayfayı yenileyip yeniden okut' });
        return sendJson(res, 200, { token: TOKEN, version: VERSION });
    }

    if (!authorized(req, url)) {
        return sendJson(res, 401, { error: 'Geçersiz veya eksik token' });
    }

    try {
        if (url.pathname === '/watch' || url.pathname.startsWith('/watch/')) return await handleWatch(req, res, url);
        if (url.pathname === '/tv' || url.pathname.startsWith('/tv/')) return await handleTv(req, res, url);
        if (url.pathname === '/library' || url.pathname.startsWith('/library/')) return await handleLibrary(req, res, url);
        if (url.pathname.startsWith('/audio/')) return await handleAudio(req, res, url);
        if (url.pathname === '/status' || url.pathname.startsWith('/status/') || url.pathname === '/inbox') return await handleStatus(req, res, url);
        if (url.pathname === '/list' && req.method === 'POST') {
            // Çalma listesi/kanal: içindeki videoların adresleri (toplu ekleme için).
            const body = await readJson(req);
            const target = new URL(String(body.url || ''));
            if (!/^https?:$/.test(target.protocol)) return sendJson(res, 400, { error: 'Adres http/https olmalı' });
            const r = await listEntries(target.href, { cookies: logins.storageState()?.cookies || [], limit: Math.min(200, Number(body.limit) || 100) });
            return sendJson(res, 200, r);
        }
        if (url.pathname === '/push/key' && req.method === 'GET') return sendJson(res, 200, { key: push.publicKey, subscribers: push.count() });
        if (url.pathname === '/push/subscribe' && req.method === 'POST') {
            push.subscribe(await readJson(req));
            return sendJson(res, 200, { ok: true, subscribers: push.count() });
        }
        if (url.pathname === '/push/unsubscribe' && req.method === 'POST') {
            push.unsubscribe((await readJson(req)).endpoint);
            return sendJson(res, 200, { ok: true });
        }
        if (url.pathname === '/push/test' && req.method === 'POST') {
            const sent = await push.send({ title: 'İndirici', body: 'Bildirimler çalışıyor', url: '#follow', kind: 'test' });
            return sendJson(res, 200, { sent });
        }

        if (url.pathname === '/health' && req.method === 'GET') {
            return sendJson(res, 200, { ok: true, name: 'indirici-render-server', version: VERSION, adblock: adblockStatus(), logins: { enabled: logins.enabled, sites: logins.sites().length },
                ytdlp: await findYtdlp().then((t) => (t ? { version: t.version } : null)),
                gallerydl: await findGalleryDl().then((t) => (t ? { version: t.version } : null)),
                ffmpeg: await findFfmpeg().then((t) => (t ? { version: t.version } : null)) });
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
            const session = await openSession(target.href, body.screen || {});
            return sendJson(res, 200, await sessionState(session));
        }

        if (/^\/(record|capture)(\/|$)/.test(url.pathname)) {
            if ((await handleJobs(req, res, url)) !== false) return;
        }

        const sessionMatch = url.pathname.match(/^\/session\/([0-9a-f]{24})(\/shot|\/action|\/stream)?$/);
        if (sessionMatch) {
            const [, id, sub = ''] = sessionMatch;
            const session = sessions.get(id);
            if (!session) return sendJson(res, 404, { error: 'Oturum kapanmış; sayfayı yeniden aç' });
            session.lastUsed = Date.now();

            if (sub === '' && req.method === 'GET') {
                const state = await sessionState(session);
                // ?videos=1: sayfada oynayan video var mı ("Bu videoyu yakala" düğmesi için).
                if (url.searchParams.get('videos')) state.playing = (await playingVideos(session.context)).some((v) => v.time > 0 && !v.paused);
                return sendJson(res, 200, state);
            }
            if (sub === '' && req.method === 'DELETE') {
                await closeSession(id);
                return sendJson(res, 200, { ok: true });
            }
            if (sub === '/stream' && req.method === 'GET') {
                serveLive(session, req, res, CORS_HEADERS, () => { session.lastUsed = Date.now(); });
                return;
            }
            if (sub === '/shot' && req.method === 'GET' && session.frame && session.castPage === session.page) {
                res.writeHead(200, { ...CORS_HEADERS, 'content-type': 'image/jpeg', 'content-length': session.frame.length, 'cache-control': 'no-store' });
                return res.end(session.frame);
            }
            if (sub === '/shot' && req.method === 'GET') {
                // Sayfa o an meşgulse (ağır yükleme) son görüntü verilir; ekran "yüklenemedi" diye kesilmesin.
                let image;
                try {
                    image = await activePage(session).screenshot({ type: 'jpeg', quality: 55, timeout: 8000 });
                    session.lastShot = image;
                } catch (err) {
                    if (!session.lastShot) throw err;
                    image = session.lastShot;
                }
                res.writeHead(200, { ...CORS_HEADERS, 'content-type': 'image/jpeg', 'content-length': image.length, 'cache-control': 'no-store' });
                return res.end(image);
            }
            if (sub === '/action' && req.method === 'POST') {
                const action = await readJson(req);
                if (action.type === 'catch') return sendJson(res, 200, await catchPlaying(session));
                if (action.type === 'probe') return sendJson(res, 200, await probeMedia(session, String(action.url || '')));
                const result = await sessionAction(session, action);
                if (['touch', 'text', 'viewport'].includes(action.type)) {
                    // Parmak kalkınca odaktaki kutucuk sorulur: yazılacak bir yerse telefon klavyesi açılır.
                    if (action.type === 'touch' && action.phase === 'end') {
                        await new Promise((r) => setTimeout(r, 120));
                        return sendJson(res, 200, { ok: true, popup: session.page !== session.main, focus: await sessionFocus(session) });
                    }
                    return sendJson(res, 200, { ok: true });
                }
                if (action.type === 'back') {
                    saveLoginsSoon(session);
                    return sendJson(res, 200, { ...await sessionState(session), ...(result || {}) });
                }
                saveLoginsSoon(session); // giriş yapıldıysa saklansın (her dokunuşta değil, kısa aralıkla)
                // Dokunuş ve kaydırma hızlı yanıtlanır (sonuç canlı görüntüde); diğerleri sayfa durumunu da döner.
                if (action.type === 'wheel') return sendJson(res, 200, { ok: true, popup: session.page !== session.main });
                if (action.type === 'tap') {
                    const focus = await sessionFocus(session);
                    return sendJson(res, 200, { ok: true, popup: session.page !== session.main, focus });
                }
                const focus = action.type === 'key' ? await sessionFocus(session) : undefined;
                return sendJson(res, 200, { ...await sessionState(session), ...(focus === undefined ? {} : { focus }) });
            }
        }

        return sendJson(res, 404, { error: 'Bulunamadı' });
    } catch (err) {
        if (/^\/(sniff|extract|images|session|record|capture|watch)/.test(url.pathname)) noteError(err.message || 'Hata', url.pathname.slice(1).split('/')[0]);
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

// Yeniden başlatılan kopya, eskisinin bağlantı noktasını bırakmasını bekler.
if (process.env.INDIRICI_RESTART === '1') await new Promise((r) => setTimeout(r, 1200));

server.listen(PORT, HOST, () => {
    console.log(`İndirici render sunucusu çalışıyor: http://${HOST}:${PORT}`);
    console.log(`Uygulama: ${APP_URL}  (bu adresten açınca token gerekmez)`);
    console.log(`Token (başka cihaz/adresten bağlanırken): ${TOKEN}`);
    console.log(`Telefonu QR ile bağlamak için bu cihazda aç: http://127.0.0.1:${PORT}/baglan`);
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
