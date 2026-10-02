// Kendi cihazında çalışan "render sunucusu".
// İndirici'nin statik sayfa taraması JS ile oynatma anında üretilen medya adreslerini göremiyor.
// Bu sunucu sayfayı gerçek (başsız) bir Chromium'da açar, sayfanın attığı ağ isteklerini toplar
// (tarayıcı eklentisinin yaptığının aynısı) ve İndirici'ye listeler. Ayrıca süre sınırı olmayan
// bir indirme proxy'si sunar; böylece Netlify fonksiyonunun 10–26 sn sınırına takılınmaz.
//
// Uç noktalar (OPTIONS hariç hepsi token ister):
//   GET  /health             → bağlantı ve token kontrolü
//   POST /sniff {url,waitMs} → sayfayı çalıştırıp bulunan medya listesini döner
//   GET  /fetch?url=…        → akışlı indirme proxy'si (Range ve Referer iletilir)

import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import dns from 'node:dns/promises';
import { randomBytes, timingSafeEqual } from 'node:crypto';
import { Readable } from 'node:stream';
import { fileURLToPath } from 'node:url';
import { classify, dedupKey, isSegment } from './media.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const VERSION = '0.1.0';
const PORT = Number(process.env.PORT) || 8787;
// Varsayılan yalnızca bu cihazdan erişim; Tailscale/tünel localhost'a yönlendirir.
const HOST = process.env.HOST || '127.0.0.1';
const ALLOW_PRIVATE = process.env.ALLOW_PRIVATE === '1';
const DEFAULT_WAIT_MS = 7000;
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
    'access-control-allow-methods': 'GET, HEAD, POST, OPTIONS',
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
    for (const name of ['playwright-core', 'playwright']) {
        try {
            return await import(name);
        } catch (_) { /* sıradakini dene */ }
    }
    throw new Error('playwright-core bulunamadı — render-server klasöründe "npm install" çalıştırın');
}

let browserPromise = null;

async function getBrowser() {
    if (!browserPromise) {
        browserPromise = (async () => {
            const { chromium } = await loadPlaywright();
            const browser = await chromium.launch({
                headless: true,
                executablePath: process.env.CHROME_PATH || undefined,
                args: ['--autoplay-policy=no-user-gesture-required', '--mute-audio']
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

async function sniff(pageUrl, waitMs) {
    const browser = await getBrowser();
    const context = await browser.newContext({ userAgent: DESKTOP_UA, viewport: { width: 1280, height: 800 } });
    const page = await context.newPage();
    const found = new Map();
    let firstMediaAt = 0;

    const record = (url, contentType, size, referer) => {
        if (isSegment(url, contentType)) return;
        const kind = classify(url, contentType);
        if (!kind) return;
        const key = dedupKey(url, kind);
        const existing = found.get(key);
        if (existing) {
            existing.url = url;
            existing.size = size || existing.size;
            existing.seenCount += 1;
        } else {
            found.set(key, { url, kind, mime: contentType || '', size: size || 0, referer: referer || pageUrl, seenCount: 1 });
        }
        rememberReferer(url, referer || pageUrl);
        if (!firstMediaAt && (kind === 'hls' || kind === 'video' || kind === 'dash')) firstMediaAt = Date.now();
    };

    page.on('response', (response) => {
        const headers = response.headers();
        const request = response.request();
        record(response.url(), headers['content-type'] || '', Number(headers['content-length']) || 0,
            request.headers().referer);
    });
    page.on('requestfailed', (request) => {
        record(request.url(), '', 0, request.headers().referer);
    });

    const started = Date.now();
    let title = '';
    let finalUrl = pageUrl;
    try {
        await page.goto(pageUrl, { waitUntil: 'domcontentloaded', timeout: 25000 });
        finalUrl = page.url();

        // Oynatıcılar çoğu zaman "oynat"a basılmadan medyayı istemez; sessizce başlatmayı dene.
        const tryPlay = async () => {
            for (const frame of page.frames()) {
                await frame.evaluate(() => {
                    document.querySelectorAll('video, audio').forEach((el) => {
                        el.muted = true;
                        const p = el.play && el.play();
                        if (p && p.catch) p.catch(() => {});
                    });
                }).catch(() => {});
            }
        };
        await tryPlay();

        // Medya bulununca biraz daha bekleyip (master → varyant gibi takip istekleri için) bitir;
        // bulunamazsa süre dolana kadar bekle.
        while (Date.now() - started < waitMs) {
            if (firstMediaAt && Date.now() - firstMediaAt > 2000) break;
            await page.waitForTimeout(400);
            if (Date.now() - started > 2500 && !firstMediaAt) await tryPlay();
        }
        title = await page.title().catch(() => '');
    } finally {
        await context.close().catch(() => {});
    }

    const items = [...found.values()];
    return { title, finalUrl, items: dropHlsSiblings(items), elapsedMs: Date.now() - started };
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

async function proxyFetch(req, res, target, refererParam) {
    let current;
    try {
        current = new URL(target);
    } catch (_) {
        return sendJson(res, 400, { error: 'Geçersiz url' });
    }

    const referer = refererParam || refererByUrl.get(target) || refererByHost.get(current.host) || '';
    const headers = { 'user-agent': DESKTOP_UA, accept: '*/*' };
    if (req.headers.range) headers.range = req.headers.range;
    if (referer) headers.referer = referer;

    let upstream;
    for (let hop = 0; ; hop++) {
        try {
            await assertPublicTarget(current);
        } catch (err) {
            return sendJson(res, 400, { error: err.message });
        }
        upstream = await fetch(current, { method: req.method === 'HEAD' ? 'HEAD' : 'GET', headers, redirect: 'manual' });
        const location = upstream.headers.get('location');
        if (!location || upstream.status < 300 || upstream.status >= 400) break;
        if (hop >= MAX_REDIRECTS) return sendJson(res, 502, { error: 'Çok fazla yönlendirme' });
        current = new URL(location, current);
    }

    const out = { ...CORS_HEADERS, 'cache-control': 'no-store' };
    for (const key of ['content-type', 'content-length', 'content-range', 'accept-ranges', 'last-modified', 'etag']) {
        const value = upstream.headers.get(key);
        if (value) out[key] = value;
    }
    res.writeHead(upstream.status, out);

    if (req.method === 'HEAD' || !upstream.body) return res.end();
    const stream = Readable.fromWeb(upstream.body);
    // İstemci bağlantıyı keserse (iptal) kaynağı da kapat.
    res.on('close', () => stream.destroy());
    stream.on('error', () => res.destroy());
    stream.pipe(res);
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
    if (!authorized(req, url)) {
        return sendJson(res, 401, { error: 'Geçersiz veya eksik token' });
    }

    try {
        if (url.pathname === '/health' && req.method === 'GET') {
            return sendJson(res, 200, { ok: true, name: 'indirici-render-server', version: VERSION });
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

        return sendJson(res, 404, { error: 'Bulunamadı' });
    } catch (err) {
        if (!res.headersSent) return sendJson(res, 400, { error: err.message || 'Hata' });
        res.destroy();
    }
});

server.listen(PORT, HOST, () => {
    console.log(`İndirici render sunucusu çalışıyor: http://${HOST}:${PORT}`);
    console.log(`Token: ${TOKEN}`);
    console.log('İndirici → Algıla → "Kendi sunucum" bölümüne adresi ve token\'ı girin.');
    if (ALLOW_PRIVATE) console.log('UYARI: ALLOW_PRIVATE=1 — yerel ağ adreslerine erişim açık.');
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
