// "Videoyu aç ve kaydet": bağlantısı inmeyen videolar için (403, oturum/çerez isteyen, adresi
// gizlenmiş). Sunucudaki tarayıcıda video açılır ve sessiz, hızlandırılmış (16 kata kadar) oynatılır;
// oynatıcının yüklediği video/ses verisi yakalanıp tek, sarılabilir MP4'e dönüştürülür. Ekran
// görüntüsü yeniden kodlanmadığından kalite orijinaldir ve dosya normal hızda oynar.
//
// Sıra:
//   1) Videonun kendi adresi biliniyorsa temiz bir oynatıcıda açılır (reklam, yanlış video yok).
//      Sayfa biliniyorsa önce sayfa açılır ki çerezler/Referer otursun.
//   2) Olmazsa sayfanın kendisi açılır, oynat düğmeleri denenir.
//   3) Video yine başlamazsa kullanıcı beklenir: uygulamada sayfanın görüntüsü çıkar, kullanıcı
//      oynata dokunur; video başladığı an kayıt kendiliğinden başlar.
// Olmazsa nedeni (DRM, kodek, erişim reddi, video yok...) açıkça yazılır.
// Oynatıcı MediaSource kullanmıyorsa (düz <video src>) dosya, tarayıcının oturumuyla indirilir.
import fs from 'node:fs';
import path from 'node:path';
import { randomBytes, createDecipheriv } from 'node:crypto';
import { mergeFmp4 } from './fmp4.mjs';
import { parsePlaylist, createMuxer } from './recorder.mjs';
import { installRouting, guardNavigation } from './adblock.mjs';

const MAX_ACTIVE = 2;
const SPEED = 16;                 // Chrome'un izin verdiği en yüksek oynatma hızı
const TICK_MS = 700;
const PLAYER_TIMEOUT_MS = 25000;  // temiz oynatıcıda veri gelmezse sayfaya geç
const PAGE_TIMEOUT_MS = 40000;    // sayfada oynat düğmeleri denenirken
const USER_TIMEOUT_MS = 5 * 60 * 1000; // kullanıcının oynata dokunması beklenir
const STALL_MS = 60000;           // bu kadar ilerleme olmazsa elde olanla bitir
const KEEP_FINISHED_MS = 48 * 60 * 60 * 1000;
const RANGE_CHUNK = 8 * 1024 * 1024;

// Sayfaya (ve tüm çerçevelerine) en başta eklenir: MediaSource'a eklenen veriyi sunucuya iletir.
// Her MediaSource'a bir kimlik verilir ki reklamın ayrı oynatıcısındaki veri asıl videoya karışmasın.
const CAPTURE_SCRIPT = `(() => {
    if (window.__indiriciHooked) return;
    window.__indiriciHooked = true;
    window.__indiriciBlobs = {};
    const send = (...args) => { try { window.__indiriciMse(...args); } catch (_) {} };
    const toB64 = (u8) => {
        let s = '';
        for (let i = 0; i < u8.length; i += 0x8000) s += String.fromCharCode.apply(null, u8.subarray(i, i + 0x8000));
        return btoa(s);
    };
    const ids = new WeakMap();
    let next = 0;
    const idOf = (ms) => {
        if (!ids.has(ms)) ids.set(ms, 'm' + (++next) + Math.random().toString(36).slice(2, 6));
        return ids.get(ms);
    };
    const hook = (MS) => {
        if (!MS || !MS.prototype || MS.prototype.__indiriciHooked) return;
        MS.prototype.__indiriciHooked = true;
        const add = MS.prototype.addSourceBuffer;
        MS.prototype.addSourceBuffer = function (mime) {
            const sb = add.call(this, mime);
            const id = (++next) + '-' + Math.random().toString(36).slice(2, 8);
            send('sb', id, String(mime), idOf(this));
            const append = sb.appendBuffer;
            sb.appendBuffer = function (data) {
                try {
                    const u8 = data instanceof ArrayBuffer ? new Uint8Array(data)
                        : new Uint8Array(data.buffer, data.byteOffset, data.byteLength);
                    send('data', id, toB64(u8));
                } catch (_) {}
                return append.call(this, data);
            };
            return sb;
        };
    };
    hook(window.MediaSource);
    hook(window.ManagedMediaSource);
    hook(window.WebKitMediaSource);
    const createUrl = URL.createObjectURL;
    URL.createObjectURL = function (obj) {
        const url = createUrl.call(this, obj);
        try {
            if ((window.MediaSource && obj instanceof MediaSource) || (window.ManagedMediaSource && obj instanceof ManagedMediaSource)) {
                window.__indiriciBlobs[url] = idOf(obj);
            }
        } catch (_) {}
        return url;
    };
    if (navigator.requestMediaKeySystemAccess) {
        const original = navigator.requestMediaKeySystemAccess.bind(navigator);
        navigator.requestMediaKeySystemAccess = (system, config) => {
            send('drm', String(system));
            return original(system, config);
        };
    }
})();`;

// Sayfadaki asıl videoyu bulur, sessiz + hızlı oynatır, durumunu döner.
function driveVideo(speed) {
    const videos = [...document.querySelectorAll('video')];
    let best = null;
    let bestScore = -1;
    for (const v of videos) {
        const r = v.getBoundingClientRect();
        const dur = isFinite(v.duration) ? v.duration : (v.duration === Infinity ? 1e6 : 0);
        const score = dur * 1000 + r.width * r.height + (v.currentTime > 0 ? 1e9 : 0);
        if (score > bestScore) {
            best = v;
            bestScore = score;
        }
    }
    if (!best) return null;
    best.muted = true;
    if (!best.ended) {
        if (best.playbackRate !== speed) {
            try { best.playbackRate = speed; } catch (_) { /* oynatıcı sınırlıyor */ }
        }
        if (best.paused && (best.currentTime > 0 || best.readyState > 0 || best.autoplay || best.src)) {
            const p = best.play();
            if (p && p.catch) p.catch(() => {});
        }
    }
    const src = best.currentSrc || best.src || '';
    return {
        time: best.currentTime || 0,
        duration: isFinite(best.duration) ? best.duration : (best.duration === Infinity ? -1 : 0),
        ended: best.ended,
        paused: best.paused,
        src: src.startsWith('blob:') ? 'blob' : src,
        ms: (window.__indiriciBlobs || {})[src] || null,
        error: best.error ? best.error.code : 0,
        width: best.videoWidth,
        height: best.videoHeight
    };
}

/** Temiz oynatıcı sayfası: video ya da hls.js ile HLS. */
function playerHtml() {
    return '<!doctype html><html><head><meta name="viewport" content="width=device-width"></head>' +
        '<body style="margin:0;background:#000"><video id="__v" muted playsinline controls ' +
        'style="width:100vw;height:100vh"></video></body></html>';
}

const ERROR_TEXT = {
    1: 'oynatma iptal edildi',
    2: 'video indirilirken ağ hatası oluştu',
    3: 'video çözülemedi (bozuk ya da desteklenmeyen veri)',
    4: 'bu video biçimi/kodeki sunucudaki tarayıcıda oynatılamıyor'
};

/**
 * @param {object} deps
 * @param {string} deps.dir
 * @param {() => Promise<any>} deps.getBrowser
 * @param {(page: any, started: number, state: object) => Promise<void>} deps.nudgePlayback
 * @param {(url: URL) => Promise<void>} deps.assertPublicTarget
 * @param {(url: string) => string} deps.refererFor
 * @param {string} deps.userAgent
 * @param {string} deps.hlsScript  hls.min.js dosyasının yolu
 * @param {() => Promise<{h264: boolean}>} deps.codecSupport
 */
export function createCapturer({ dir, appRoot, getBrowser, nudgePlayback, assertPublicTarget, refererFor, userAgent, hlsScript, codecSupport }) {
    fs.mkdirSync(dir, { recursive: true });
    const captures = new Map();
    const metaFile = (id) => path.join(dir, `${id}.json`);

    function publicState(cap) {
        return {
            id: cap.id, state: cap.state, url: cap.pageUrl || cap.mediaUrl, pageUrl: cap.pageUrl, mediaUrl: cap.mediaUrl,
            fileName: cap.fileName, file: cap.file, ext: cap.ext, startedAt: cap.startedAt, endedAt: cap.endedAt,
            mediaSec: cap.mediaSec, duration: cap.duration, bytes: cap.bytes, total: cap.total || 0, speed: cap.speed,
            reason: cap.reason, error: cap.error, warning: cap.warning, phase: cap.phase, blockedAds: cap.blockedAds || 0,
            needsUser: cap.state === 'waiting', mode: 'capture'
        };
    }
    const persist = (cap) => {
        try {
            fs.writeFileSync(metaFile(cap.id), JSON.stringify(publicState(cap)));
        } catch (_) { /* disk dolu */ }
    };

    for (const name of fs.readdirSync(dir)) {
        if (!name.endsWith('.json')) continue;
        try {
            const state = JSON.parse(fs.readFileSync(path.join(dir, name), 'utf8'));
            if (state.state !== 'done' || !fs.existsSync(path.join(dir, state.file))) continue;
            captures.set(state.id, { ...state });
        } catch (_) { /* bozuk kayıt */ }
    }

    function remove(id) {
        const cap = captures.get(id);
        if (!cap) return false;
        captures.delete(id);
        fs.rm(metaFile(id), { force: true }, () => {});
        if (cap.file) fs.rm(path.join(dir, cap.file), { force: true }, () => {});
        if (cap.work) fs.rm(cap.work, { recursive: true, force: true }, () => {});
        return true;
    }

    async function run(cap) {
        const browser = await getBrowser();
        const context = await browser.newContext({
            userAgent,
            viewport: { width: 1280, height: 720 },
            bypassCSP: true // temiz oynatıcıyı sitenin sayfasına yerleştirebilmek için
        });
        cap.context = context;
        const tracks = new Map(); // SourceBuffer kimliği → {mime, ms, fd, file, bytes}
        const msBytes = new Map();
        const mediaStatus = new Map(); // yayın isteklerinin HTTP durumları (neden olmadığını söylemek için)
        let drm = '';
        let lastDataAt = 0;
        let playerMode = false;

        await installRouting(context, {
            onBlocked: () => { cap.blockedAds = (cap.blockedAds || 0) + 1; },
            // Temiz oynatıcıda başka kökenden yayın istekleri: sunucuda alınıp CORS izniyle verilir.
            needsCors: (request) => playerMode && ['xhr', 'fetch', 'media'].includes(request.resourceType())
        });
        await context.exposeBinding('__indiriciMse', (_source, type, id, payload, ms) => {
            if (cap.finishing) return;
            if (type === 'drm') {
                drm = id;
                return;
            }
            if (type === 'sb') {
                const file = path.join(cap.work, `${tracks.size}.bin`);
                tracks.set(id, { mime: payload || '', ms: ms || '', fd: fs.openSync(file, 'w'), file, bytes: 0 });
                return;
            }
            if (type === 'data') {
                const track = tracks.get(id);
                if (!track) return;
                const buf = Buffer.from(payload, 'base64');
                fs.writeSync(track.fd, buf);
                track.bytes += buf.length;
                msBytes.set(track.ms, (msBytes.get(track.ms) || 0) + buf.length);
                cap.bytes += buf.length;
                lastDataAt = Date.now();
            }
        });
        await context.addInitScript(CAPTURE_SCRIPT);
        const page = await context.newPage();
        cap.page = page;
        // Oynat'a basınca sayfa reklama yönlendirilirse videonun sayfasına geri dönülür.
        const guard = guardNavigation(page, { onReturn: () => { cap.blockedAds = (cap.blockedAds || 0) + 1; } });
        context.on('page', (popup) => { if (popup !== page) popup.close().catch(() => {}); });
        page.on('response', (response) => {
            const type = response.request().resourceType();
            if (['media', 'xhr', 'fetch'].includes(type) && /\.(m3u8|mpd|mp4|m4s|ts|webm|m4v|aac)(\?|$)/i.test(response.url())) {
                mediaStatus.set(response.url(), response.status());
            }
        });

        // Oynatmayı sürer; video başlayıp veri gelirse sonuna kadar kaydeder.
        // Dönüş: 'done' (kayıt bitti) | 'nostart' (süre içinde başlamadı).
        let progressive = null;
        const playLoop = async ({ timeoutMs, nudge, waitingUser = false }) => {
            const started = Date.now();
            const nudgeState = {};
            let lastProgress = { at: Date.now(), time: 0 };
            let sample = { at: Date.now(), time: 0 };
            let lastVideo = null;
            for (;;) {
                if (cap.cancelled) throw new Error('iptal');
                if (cap.stopRequested) { cap.reason = 'durduruldu'; return 'done'; }
                if (drm) throw new Error(`Video DRM ile korunuyor (${drm}); kopyalanması engellenmiş, kaydedilemez`);

                let video = null;
                let videoFrame = null;
                for (const frame of page.frames()) {
                    const v = await frame.evaluate(driveVideo, waitingUser && !cap.bytes ? 1 : SPEED).catch(() => null);
                    if (v && (!video || v.time > video.time || (v.duration > video.duration && v.time >= video.time))) {
                        video = v;
                        videoFrame = frame;
                    }
                }
                lastVideo = video || lastVideo;
                const flowing = cap.bytes > 0 || progressive;

                if (video && video.ms) cap.mainMs = video.ms;
                if (video && video.src && video.src !== 'blob' && !tracks.size && !progressive && video.time > 0) {
                    // MSE yok: düz dosya. Tarayıcının çerez/oturumuyla parça parça indirilir.
                    if (cap.state === 'waiting') {
                        cap.state = 'capturing'; // kullanıcı başlattı
                        persist(cap);
                    }
                    progressive = downloadProgressive(context, video.src, { referer: videoFrame.url() || page.url() }, cap)
                        .catch((err) => { cap.progressiveError = err.message; });
                    videoFrame.evaluate(() => document.querySelectorAll('video').forEach((v) => v.pause())).catch(() => {});
                }
                if (cap.progressiveError) throw new Error(cap.progressiveError);
                if (cap.progressiveDone) { cap.reason = 'video indirildi'; return 'done'; }

                if (video && flowing && !progressive) {
                    if (cap.state === 'waiting') {
                        cap.state = 'capturing'; // kullanıcı başlattı
                        persist(cap);
                    }
                    if (video.duration > 0) cap.duration = video.duration;
                    if (video.duration === -1) cap.duration = 0;
                    if (video.time > cap.mediaSec + 0.01) {
                        cap.mediaSec = video.time;
                        lastProgress = { at: Date.now(), time: video.time };
                        cap.phase = 'Kaydediliyor';
                    }
                    const now = Date.now();
                    if (now - sample.at >= 3000) {
                        cap.speed = Math.max(0, (cap.mediaSec - sample.time) / ((now - sample.at) / 1000));
                        sample = { at: now, time: cap.mediaSec };
                    }
                    if (video.ended || (cap.duration > 0 && video.time >= cap.duration - 0.3)) {
                        cap.reason = 'video bitti';
                        cap.mediaSec = cap.duration || cap.mediaSec;
                        return 'done';
                    }
                    if (Date.now() - Math.max(lastProgress.at, lastDataAt) > STALL_MS) {
                        cap.reason = 'oynatma durdu, elde olan kaydedildi';
                        return 'done';
                    }
                }
                if (!flowing) {
                    if (Date.now() - started > timeoutMs) {
                        cap.lastFailure = explain(lastVideo, mediaStatus);
                        return 'nostart';
                    }
                    if (nudge) await nudgePlayback(page, started, nudgeState);
                }
                persistThrottled(cap);
                await new Promise((r) => setTimeout(r, TICK_MS));
            }
        };

        try {
            let result = 'nostart';
            const attempts = [];
            if (cap.mediaUrl) {
                // 1) Bağlantıyı tarayıcıya istet; geçerse aynı başlık/çerezlerle oynatmadan indir
                //    (kodek desteği gerekmez, ağ hızında).
                cap.phase = 'Bağlantı deneniyor';
                const direct = await tryDirect(page, context, cap, (on) => { playerMode = on; });
                if (direct === 'done') result = 'done';
                // Tarayıcının kendi isteği de reddedildiyse oynatıcıda açmak işe yaramaz.
                else if (!(cap.directStatus >= 400)) attempts.push('player');
            }
            if (cap.pageUrl) attempts.push('page');
            for (const attempt of result === 'done' ? [] : attempts) {
                if (attempt === 'player') {
                    cap.phase = 'Video açılıyor';
                    playerMode = true;
                    guard.expect();
                    await openPlayer(page, cap);
                    guard.arm();
                    result = await playLoop({ timeoutMs: PLAYER_TIMEOUT_MS, nudge: false });
                    playerMode = false;
                } else {
                    cap.phase = 'Sayfa açılıyor';
                    guard.expect();
                    await page.goto(cap.pageUrl, { waitUntil: 'domcontentloaded', timeout: 30000 }).catch(() => {});
                    guard.arm();
                    cap.phase = 'Oynatıcı başlatılıyor';
                    result = await playLoop({ timeoutMs: PAGE_TIMEOUT_MS, nudge: true });
                }
                if (result === 'done') break;
            }

            if (result === 'nostart' && cap.pageUrl) {
                // Kullanıcı başlatsın: uygulamada sayfanın görüntüsü çıkar, oynata dokunur.
                cap.state = 'waiting';
                cap.phase = 'Videoyu başlatmak için dokun';
                cap.warning = cap.lastFailure || '';
                persist(cap);
                result = await playLoop({ timeoutMs: USER_TIMEOUT_MS, nudge: false, waitingUser: true });
                if (result === 'nostart') {
                    throw new Error('Video başlatılmadı (5 dakika beklendi). ' +
                        (cap.directStatus >= 400 ? directReason(cap.directStatus, true) : (cap.lastFailure || '')));
                }
            } else if (result === 'nostart') {
                throw new Error(cap.directStatus >= 400 ? directReason(cap.directStatus, Boolean(cap.pageUrl)) : (cap.lastFailure || 'Video oynatılamadı'));
            }

            cap.state = 'capturing';
            cap.finishing = true;
            if (progressive) {
                cap.phase = 'Dosya indiriliyor';
                await progressive;
                if (cap.progressiveError) throw new Error(cap.progressiveError);
            }
            cap.phase = 'Dosya hazırlanıyor';
            await finalize(cap, tracks, msBytes);
            cap.state = 'done';
            cap.warning = '';
        } catch (err) {
            cap.finishing = true;
            if (cap.cancelled) {
                remove(cap.id);
                return;
            }
            // Bir şey yakalandıysa (ör. ortada hata) onu kaydetmeyi dene.
            if (cap.bytes > 0 && !progressive && !/DRM/.test(err.message)) {
                try {
                    await finalize(cap, tracks, msBytes);
                    cap.state = 'done';
                    cap.reason = `yarıda kaldı: ${err.message}`;
                } catch (_) {
                    cap.state = 'error';
                    cap.error = err.message;
                }
            } else {
                cap.state = 'error';
                cap.error = err.message;
            }
        } finally {
            for (const track of tracks.values()) {
                try { fs.closeSync(track.fd); } catch (_) { /* zaten kapalı */ }
            }
            await context.close().catch(() => {});
            cap.context = null;
            cap.page = null;
            cap.endedAt = Date.now();
            cap.phase = '';
            if (captures.has(cap.id)) persist(cap);
            if (cap.work) fs.rm(cap.work, { recursive: true, force: true }, () => {});
            cap.work = null;
        }
    }

    /** Videonun kendi adresini temiz oynatıcıda açar (sayfa biliniyorsa onun kökeninde). */
    async function openPlayer(page, cap) {
        const base = cap.pageUrl || new URL(cap.mediaUrl).origin + '/';
        await page.goto(base, { waitUntil: 'domcontentloaded', timeout: 25000 }).catch(() => {});
        await page.setContent(playerHtml()).catch(() => {});
        const isHls = cap.kind === 'hls' || /\.m3u8(\?|$)/i.test(cap.mediaUrl);
        if (isHls) await page.addScriptTag({ path: hlsScript }).catch(() => {});
        await page.evaluate(({ src, hls }) => {
            const v = document.getElementById('__v');
            if (hls && window.Hls && window.Hls.isSupported()) {
                const h = new window.Hls({ maxBufferLength: 60, startLevel: -1, capLevelToPlayerSize: false });
                h.on(window.Hls.Events.MANIFEST_PARSED, () => { h.currentLevel = h.levels.length - 1; });
                h.loadSource(src);
                h.attachMedia(v);
                window.__hls = h;
            } else {
                v.src = src;
            }
            v.play().catch(() => {});
        }, { src: cap.mediaUrl, hls: isHls }).catch(() => {});
    }

    let lastPersist = 0;
    function persistThrottled(cap) {
        if (Date.now() - lastPersist > 5000) {
            lastPersist = Date.now();
            persist(cap);
        }
    }

    /** Düz video dosyasını tarayıcının çerezleriyle, parça parça (Range) indirir. */
    /**
     * Videonun adresini tarayıcıya istetir (önce sayfa/Referer kökeni açılır ki çerezler otursun).
     * İstek geçerse dosya ya da HLS yayını, tarayıcının o isteğindeki başlıklarla oynatmadan indirilir.
     * Dönüş: 'done' | 'failed' (cap.directStatus son HTTP durumunu tutar).
     */
    async function tryDirect(page, context, cap, setPlayerMode) {
        const isHls = cap.kind === 'hls' || /\.m3u8(\?|$)/i.test(cap.mediaUrl);
        const origin = new URL(cap.mediaUrl).origin + '/';
        const bases = [...new Set([cap.pageUrl, refererFor(cap.mediaUrl), origin].filter(Boolean))];
        for (const base of bases) {
            if (cap.cancelled) throw new Error('iptal');
            await page.goto(base, { waitUntil: 'domcontentloaded', timeout: 20000 }).catch(() => {});
            const waiter = page.waitForResponse((r) => sameResource(r.url(), cap.mediaUrl), { timeout: 15000 }).catch(() => null);
            if (isHls) {
                setPlayerMode(true); // başka kökene fetch: sunucu tarafında alınıp CORS izniyle verilir
                await page.evaluate((u) => { fetch(u, { credentials: 'include' }).catch(() => {}); }, cap.mediaUrl).catch(() => {});
            } else {
                const src = cap.mediaUrl.replace(/"/g, '&quot;');
                await page.setContent(`<video preload="auto" muted src="${src}"></video>`).catch(() => {});
            }
            const response = await waiter;
            setPlayerMode(false);
            if (!response) continue;
            cap.directStatus = response.status();
            if (cap.directStatus >= 400) continue;
            const headers = replayHeaders(await response.request().allHeaders().catch(() => ({})));
            if (isHls) {
                const text = await response.text().catch(() => '');
                if (!text.includes('#EXTM3U')) continue;
                const done = await downloadHlsDirect(context, cap, text, headers);
                if (done) return 'done';
                return 'failed'; // canlı yayın: oynatıcıyla yakalanır
            }
            await page.goto('about:blank').catch(() => {}); // tarayıcının kendi ön yüklemesini durdur
            // Uzantısız bağlantı aslında HLS playlist'i olabilir (türünden ya da içeriğinden anlaşılır).
            const type = (response.headers()['content-type'] || '').toLowerCase();
            const head = await context.request.get(cap.mediaUrl, { headers: { ...headers, range: 'bytes=0-2047' }, timeout: 30000 })
                .then((r) => (r.status() < 400 ? r.body() : Buffer.alloc(0))).catch(() => Buffer.alloc(0));
            if (/mpegurl/.test(type) || head.toString('latin1', 0, 7) === '#EXTM3U') {
                const full = await context.request.get(cap.mediaUrl, { headers, timeout: 30000 });
                const text = full.status() < 400 ? (await full.body()).toString('utf8') : '';
                if (text.includes('#EXTM3U') && await downloadHlsDirect(context, cap, text, headers)) return 'done';
                return 'failed';
            }
            await downloadProgressive(context, cap.mediaUrl, headers, cap);
            cap.reason = cap.stopRequested ? 'durduruldu' : 'video indirildi';
            return 'done';
        }
        return 'failed';
    }

    /** HLS (VOD): parçalar tarayıcının başlık/çerezleriyle indirilip tek, sarılabilir MP4'e yazılır. */
    async function downloadHlsDirect(context, cap, text, headers) {
        const get = async (url, range) => {
            const h = { ...headers };
            if (range) h.range = `bytes=${range.offset}-${range.offset + range.length - 1}`;
            const res = await context.request.get(url, { headers: h, timeout: 60000 });
            if (res.status() >= 400) throw new Error(`Parça alınamadı (HTTP ${res.status()})`);
            return res.body();
        };
        let playlist = parsePlaylist(text, cap.mediaUrl);
        let audioUrl = null;
        if (playlist.type === 'master') {
            const best = playlist.variants[0];
            const group = playlist.audio[best.audioGroup] || [];
            const audio = group.find((a) => a.isDefault) || group[0];
            if (audio) audioUrl = audio.url;
            playlist = parsePlaylist((await get(best.url)).toString('utf8'), best.url);
        }
        if (playlist.type !== 'media' || playlist.isLive) return false;
        const streams = [{ id: 'v', playlist }];
        if (audioUrl) streams.push({ id: 'a', playlist: parsePlaylist((await get(audioUrl)).toString('utf8'), audioUrl) });
        for (const st of streams) {
            const drm = st.playlist.segments.find((x) => x.key && x.key.method !== 'AES-128');
            if (drm) throw new Error(`Video DRM ile korunuyor (${drm.key.method}); kaydedilemez`);
            let t = 0;
            for (const seg of st.playlist.segments) {
                seg.start = t;
                t += seg.duration;
            }
            if (st.id === 'v') cap.duration = t;
        }
        const items = streams.flatMap((st) => st.playlist.segments.map((seg) => ({ stream: st.id, seg })))
            .sort((a, b) => (a.seg.start - b.seg.start) || (a.stream === 'v' ? -1 : 1));

        const file = path.join(cap.work, 'hls.mp4');
        const muxer = await createMuxer(file, appRoot);
        const keys = new Map();
        const maps = new Map();
        const fetchItem = async ({ seg }) => {
            let map = null;
            if (seg.map) {
                if (!maps.has(seg.map.url)) maps.set(seg.map.url, await get(seg.map.url, seg.map.range));
                map = maps.get(seg.map.url);
            }
            let data = await get(seg.url, seg.range);
            if (seg.key) {
                if (!keys.has(seg.key.uri)) keys.set(seg.key.uri, await get(seg.key.uri));
                const iv = Buffer.alloc(16);
                if (seg.key.iv) Buffer.from(seg.key.iv.replace(/^0x/i, ''), 'hex').copy(iv);
                else iv.writeUInt32BE(seg.seq >>> 0, 12);
                const decipher = createDecipheriv('aes-128-cbc', keys.get(seg.key.uri), iv);
                data = Buffer.concat([decipher.update(data), decipher.final()]);
            }
            return { data, map };
        };

        cap.phase = 'Kaydediliyor';
        let cursor = 0;
        let next = 0;
        const ready = new Map();
        let writing = Promise.resolve();
        let sample = { at: Date.now(), time: 0 };
        const worker = async () => {
            for (;;) {
                if (cap.cancelled) throw new Error('iptal');
                if (cap.stopRequested) return;
                const index = cursor++;
                if (index >= items.length) return;
                ready.set(index, await fetchItem(items[index]));
                writing = writing.then(async () => {
                    while (ready.has(next)) {
                        const { data, map } = ready.get(next);
                        ready.delete(next);
                        await muxer.push(items[next].stream, data, map);
                        cap.bytes += data.length;
                        next++;
                    }
                    cap.mediaSec = muxer.builder.duration;
                    const now = Date.now();
                    if (now - sample.at >= 2000) {
                        cap.speed = (cap.mediaSec - sample.time) / ((now - sample.at) / 1000);
                        sample = { at: now, time: cap.mediaSec };
                    }
                });
                await writing;
            }
        };
        try {
            await Promise.all(Array.from({ length: Math.min(4, items.length) }, worker));
            await writing;
            const result = await muxer.finish();
            cap.mediaSec = result.duration;
            cap.hlsFile = file;
            cap.hlsExt = result.hasVideo ? 'mp4' : 'm4a';
            cap.reason = cap.stopRequested ? 'durduruldu' : 'video indirildi';
            return true;
        } catch (err) {
            muxer.close();
            throw err;
        }
    }

    async function downloadProgressive(context, src, baseHeaders, cap) {
        const file = path.join(cap.work, 'direct.bin');
        const fd = fs.openSync(file, 'w');
        cap.directFile = file;
        cap.phase = 'Video indiriliyor';
        try {
            let offset = 0;
            let total = 0;
            for (;;) {
                if (cap.cancelled || cap.stopRequested) break;
                const end = offset + RANGE_CHUNK - 1;
                const headers = { ...baseHeaders, range: `bytes=${offset}-${end}` };
                if (!headers.referer && refererFor(src)) headers.referer = refererFor(src);
                const res = await context.request.get(src, {
                    headers,
                    timeout: 60000
                });
                const status = res.status();
                if (status !== 200 && status !== 206) throw new Error(directReason(status, Boolean(cap.pageUrl)));
                const body = await res.body();
                fs.writeSync(fd, body, 0, body.length, offset);
                offset += body.length;
                cap.bytes = offset;
                cap.directType = res.headers()['content-type'] || cap.directType;
                if (status === 200) { total = offset; break; } // sunucu Range desteklemiyor: tamamı geldi
                const range = res.headers()['content-range'] || '';
                total = Number(range.split('/')[1]) || 0;
                cap.total = total;
                if (!body.length || (total && offset >= total)) break;
            }
            cap.total = total || offset;
            cap.progressiveDone = true;
        } finally {
            fs.closeSync(fd);
        }
    }

    async function finalize(cap, tracks, msBytes) {
        const out = path.join(dir, `${cap.id}.out`);
        if (cap.hlsFile && fs.existsSync(cap.hlsFile)) {
            fs.renameSync(cap.hlsFile, out);
            cap.ext = cap.hlsExt || 'mp4';
        } else if (cap.directFile && fs.existsSync(cap.directFile) && fs.statSync(cap.directFile).size > 0) {
            const type = cap.directType || '';
            cap.ext = /webm/.test(type) ? 'webm' : /audio/.test(type) ? 'm4a' : 'mp4';
            fs.renameSync(cap.directFile, out);
        } else {
            for (const track of tracks.values()) {
                try { fs.closeSync(track.fd); } catch (_) { /* zaten kapalı */ }
                track.fd = null;
            }
            // Yalnızca asıl videonun MediaSource'u (reklam oynatıcısının verisi karışmasın).
            let main = cap.mainMs;
            if (!main || !msBytes.get(main)) main = [...msBytes.entries()].sort((a, b) => b[1] - a[1])[0]?.[0];
            const list = [...tracks.values()].filter((t) => t.bytes > 0 && (!main || t.ms === main));
            if (!list.length) throw new Error('Video verisi yakalanamadı');
            const result = await mergeFmp4(list, out);
            cap.ext = result.ext;
            if (result.duration) cap.mediaSec = result.duration;
            if (result.warning) cap.warning = result.warning;
        }
        cap.file = `${cap.id}.out`;
        cap.fileName = `${cap.baseName}.${cap.ext}`;
        cap.bytes = fs.statSync(out).size;
    }

    setInterval(() => {
        for (const cap of captures.values()) {
            if (!['capturing', 'waiting'].includes(cap.state) && Date.now() - (cap.endedAt || 0) > KEEP_FINISHED_MS) remove(cap.id);
        }
    }, 60 * 60 * 1000).unref();

    return {
        list() {
            return [...captures.values()].map(publicState).sort((a, b) => b.startedAt - a.startedAt);
        },
        get(id) {
            const cap = captures.get(id);
            return cap ? publicState(cap) : null;
        },
        /**
         * pageUrl: videonun bulunduğu sayfa (biliniyorsa). mediaUrl: videonun/yayının kendi adresi.
         * Eski istemciler için `url` sayfa adresi sayılır.
         */
        async start({ url, pageUrl, mediaUrl, kind, name, maxSec }) {
            pageUrl = pageUrl || (!mediaUrl ? url : '');
            if (!pageUrl && !mediaUrl) throw new Error('Adres gerekli');
            for (const u of [pageUrl, mediaUrl]) if (u) await assertPublicTarget(new URL(u));
            const active = [...captures.values()].filter((c) => ['capturing', 'waiting'].includes(c.state)).length;
            if (active >= MAX_ACTIVE) throw new Error(`Aynı anda en fazla ${MAX_ACTIVE} video kaydı yapılabilir`);
            const id = randomBytes(12).toString('hex');
            const baseName = String(name || 'video').replace(/[\\/:*?"<>|]+/g, '_').trim().slice(0, 100) || 'video';
            const work = path.join(dir, `${id}.work`);
            fs.mkdirSync(work, { recursive: true });
            const cap = {
                id, pageUrl: pageUrl ? new URL(pageUrl).href : '', mediaUrl: mediaUrl ? new URL(mediaUrl).href : '',
                kind: kind || '', baseName, fileName: `${baseName}.mp4`, file: '', ext: 'mp4', work,
                state: 'capturing', phase: 'Başlıyor', startedAt: Date.now(), endedAt: 0, mediaSec: 0, duration: 0,
                bytes: 0, speed: 0, maxSec: Math.max(0, Number(maxSec) || 0), reason: '', error: '', warning: '',
                stopRequested: false, cancelled: false
            };
            const codecs = await codecSupport().catch(() => null);
            if (codecs && !codecs.h264) {
                cap.warning = 'Sunucudaki tarayıcı H.264 oynatamıyor; çoğu sitede kayıt başarısız olur ' +
                    '(Google Chrome kurulu bir bilgisayarda sunucu onu kendiliğinden kullanır).';
            }
            captures.set(id, cap);
            persist(cap);
            run(cap).catch((err) => {
                cap.state = 'error';
                cap.error = err.message;
                cap.endedAt = Date.now();
                persist(cap);
            });
            return publicState(cap);
        },
        stop(id) {
            const cap = captures.get(id);
            if (!cap) return null;
            if (['capturing', 'waiting'].includes(cap.state)) {
                cap.stopRequested = true;
                cap.phase = 'Durduruluyor';
            }
            return publicState(cap);
        },
        delete(id) {
            const cap = captures.get(id);
            if (!cap) return false;
            if (['capturing', 'waiting'].includes(cap.state)) {
                cap.cancelled = true;
                if (cap.context) cap.context.close().catch(() => {});
                return true; // run() iptali görünce dosyaları siler
            }
            return remove(id);
        },
        /** Kullanıcının dokunması için sayfanın görüntüsü (JPEG). */
        async shot(id) {
            const cap = captures.get(id);
            if (!cap || !cap.page) return null;
            return cap.page.screenshot({ type: 'jpeg', quality: 55, timeout: 8000 });
        },
        /** Kullanıcının dokunuşu/kaydırması sayfaya uygulanır. */
        async action(id, action) {
            const cap = captures.get(id);
            if (!cap || !cap.page) throw new Error('Kayıt sayfası kapalı');
            const page = cap.page;
            const { width, height } = page.viewportSize() || { width: 1280, height: 720 };
            const fraction = (v) => Math.min(1, Math.max(0, Number(v) || 0));
            if (action.type === 'tap') await page.mouse.click(fraction(action.x) * width, fraction(action.y) * height);
            else if (action.type === 'scroll') await page.mouse.wheel(0, Math.max(-3, Math.min(3, Number(action.dy) || 0)) * height);
            else if (action.type === 'type') await page.keyboard.type(String(action.text || '').slice(0, 500), { delay: 20 });
            else if (action.type === 'key' && ['Enter', 'Backspace', 'Escape', 'Tab', 'Space'].includes(action.key)) await page.keyboard.press(action.key);
            else if (action.type === 'back') await page.goBack({ timeout: 10000 }).catch(() => {});
            else if (action.type === 'reload') await page.reload({ waitUntil: 'domcontentloaded', timeout: 20000 }).catch(() => {});
            await page.waitForTimeout(300);
            return publicState(cap);
        },
        file(id) {
            const cap = captures.get(id);
            if (!cap || cap.state !== 'done' || !cap.file) return null;
            const full = path.join(dir, cap.file);
            if (!fs.existsSync(full)) return null;
            const mime = { mp4: 'video/mp4', m4a: 'audio/mp4', webm: 'video/webm' }[cap.ext] || 'application/octet-stream';
            return { path: full, name: cap.fileName, mime, size: fs.statSync(full).size };
        }
    };
}

/** Video neden başlamadı/oynamadı: kullanıcıya gösterilecek açıklama. */
function explain(video, mediaStatus) {
    const denied = [...mediaStatus.values()].find((s) => s === 401 || s === 403 || s === 451);
    if (denied) return `Video sunucusu erişimi reddetti (HTTP ${denied}); giriş, bölge ya da süreli bağlantı gerekiyor olabilir.`;
    const missing = [...mediaStatus.values()].find((s) => s === 404 || s === 410);
    if (missing) return `Video bulunamadı (HTTP ${missing}); bağlantının süresi dolmuş olabilir.`;
    if (!video) return 'Sayfada video oynatıcısı bulunamadı.';
    if (video.error) return `Video oynatılamadı: ${ERROR_TEXT[video.error] || 'bilinmeyen hata'}.`;
    if (!video.time && (video.paused || !video.src)) return 'Video kendiliğinden başlamadı; oynat düğmesine basılması gerekiyor.';
    return 'Video başladı ama veri gelmedi.';
}

const DROP_HEADERS = new Set(['range', 'host', 'content-length', 'cookie', 'connection', 'accept-encoding', 'if-range']);
/** Tarayıcının başarılı isteğindeki başlıklar (çerezleri bağlam ekler). */
function replayHeaders(headers) {
    const out = {};
    for (const [key, value] of Object.entries(headers || {})) {
        if (!key.startsWith(':') && !DROP_HEADERS.has(key.toLowerCase())) out[key] = value;
    }
    return out;
}

function sameResource(a, b) {
    try {
        const x = new URL(a);
        const y = new URL(b);
        return x.origin + x.pathname + x.search === y.origin + y.pathname + y.search;
    } catch (_) {
        return a === b;
    }
}

/** Bağlantı reddedildiğinde kullanıcıya gösterilecek açıklama. */
function directReason(status, hadPage) {
    if (status === 404 || status === 410) {
        return `Video bulunamadı (HTTP ${status}); bağlantının süresi dolmuş olabilir. Videonun sayfasından yeni bağlantı al.`;
    }
    if (status === 401 || status === 403 || status === 451) {
        return `Video sunucusu bağlantıyı reddetti (HTTP ${status}). Bağlantı büyük ihtimalle süreli/imzalı ya da yalnızca ` +
            `açıldığı cihaza (IP) veya sitenin oturumuna bağlı.` +
            (hadPage ? '' : ' Videonun bulunduğu sayfanın adresini de ver;') +
            ' olmazsa "Telefonda aç" ile kendi tarayıcında açıp indir.';
    }
    return `Video sunucusu hata verdi (HTTP ${status}).`;
}
