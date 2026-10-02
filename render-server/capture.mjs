// "Sunucuda oynatıp kaydet": adresi bulunamayan / doğrudan inmeyen videolar için.
// Sayfa sunucudaki tarayıcıda açılır, video sessiz ve hızlandırılmış (16 kata kadar) oynatılır.
// Oynatıcının MediaSource'a (MSE) eklediği video/ses verisi yakalanıp diske yazılır; bitince
// izler tek bir MP4'te birleştirilir. Ekran görüntüsü yeniden kodlanmadığından kalite orijinaldir
// ve dosya normal hızda oynar. Oynatıcı MSE kullanmıyorsa (düz <video src>) dosya sayfanın kendi
// oturumuyla (çerezleriyle) indirilir. DRM'li (EME) yayınlar kaydedilmez.
import fs from 'node:fs';
import path from 'node:path';
import { randomBytes } from 'node:crypto';
import { mergeFmp4 } from './fmp4.mjs';

const MAX_ACTIVE = 2;
const SPEED = 16;                 // Chrome'un izin verdiği en yüksek oynatma hızı
const TICK_MS = 700;
const START_TIMEOUT_MS = 45000;   // bu sürede veri gelmezse başarısız
const STALL_MS = 60000;           // bu kadar ilerleme olmazsa elde olanla bitir
const KEEP_FINISHED_MS = 48 * 60 * 60 * 1000;

// Sayfaya (ve tüm çerçevelerine) en başta eklenir: MediaSource'a eklenen veriyi sunucuya iletir.
const CAPTURE_SCRIPT = `(() => {
    if (window.__indiriciHooked) return;
    window.__indiriciHooked = true;
    const send = (...args) => { try { window.__indiriciMse(...args); } catch (_) {} };
    const toB64 = (u8) => {
        let s = '';
        for (let i = 0; i < u8.length; i += 0x8000) s += String.fromCharCode.apply(null, u8.subarray(i, i + 0x8000));
        return btoa(s);
    };
    let next = 0;
    const hook = (MS) => {
        if (!MS || !MS.prototype || MS.prototype.__indiriciHooked) return;
        MS.prototype.__indiriciHooked = true;
        const add = MS.prototype.addSourceBuffer;
        MS.prototype.addSourceBuffer = function (mime) {
            const sb = add.call(this, mime);
            const id = (++next) + '-' + Math.random().toString(36).slice(2, 8);
            send('sb', id, String(mime));
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
        if (best.paused) {
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
        rate: best.playbackRate,
        src: src.startsWith('blob:') ? 'blob' : src,
        error: best.error ? best.error.code : 0,
        width: best.videoWidth,
        height: best.videoHeight
    };
}

/**
 * @param {object} deps
 * @param {string} deps.dir
 * @param {() => Promise<import('playwright-core').Browser>} deps.getBrowser
 * @param {(page: any, started: number, state: object) => Promise<void>} deps.nudgePlayback
 * @param {(url: URL) => Promise<void>} deps.assertPublicTarget
 * @param {string} deps.userAgent
 * @param {() => Promise<{h264: boolean}>} deps.codecSupport
 */
export function createCapturer({ dir, getBrowser, nudgePlayback, assertPublicTarget, userAgent, codecSupport }) {
    fs.mkdirSync(dir, { recursive: true });
    const captures = new Map();
    const metaFile = (id) => path.join(dir, `${id}.json`);

    function publicState(cap) {
        return {
            id: cap.id, state: cap.state, url: cap.url, fileName: cap.fileName, file: cap.file, ext: cap.ext,
            startedAt: cap.startedAt, endedAt: cap.endedAt, mediaSec: cap.mediaSec, duration: cap.duration,
            bytes: cap.bytes, speed: cap.speed, maxSec: cap.maxSec, reason: cap.reason, error: cap.error,
            warning: cap.warning, phase: cap.phase, mode: 'capture'
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
        const context = await browser.newContext({ userAgent, viewport: { width: 1280, height: 720 } });
        cap.context = context;
        const tracks = new Map(); // id -> {mime, fd, file, bytes}
        let drm = '';
        let lastDataAt = 0;

        await context.exposeBinding('__indiriciMse', (_source, type, id, payload) => {
            if (cap.finishing) return;
            if (type === 'drm') {
                drm = id;
                return;
            }
            if (type === 'sb') {
                const file = path.join(cap.work, `${tracks.size}.bin`);
                tracks.set(id, { mime: payload || '', fd: fs.openSync(file, 'w'), file, bytes: 0 });
                return;
            }
            if (type === 'data') {
                const track = tracks.get(id);
                if (!track) return;
                const buf = Buffer.from(payload, 'base64');
                fs.writeSync(track.fd, buf);
                track.bytes += buf.length;
                cap.bytes += buf.length;
                lastDataAt = Date.now();
            }
        });
        await context.exposeBinding('__indiriciChunk', (_source, b64) => {
            if (cap.directFd === undefined || cap.directFd === null) return;
            const buf = Buffer.from(b64, 'base64');
            fs.writeSync(cap.directFd, buf);
            cap.bytes += buf.length;
            lastDataAt = Date.now();
        });
        await context.addInitScript(CAPTURE_SCRIPT);
        const page = await context.newPage();
        context.on('page', (popup) => { if (popup !== page) popup.close().catch(() => {}); });

        const started = Date.now();
        const nudgeState = {};
        let lastProgress = { at: Date.now(), time: 0 };
        let direct = null;
        let sample = { at: Date.now(), time: 0 };

        try {
            cap.phase = 'Sayfa açılıyor';
            await page.goto(cap.url, { waitUntil: 'domcontentloaded', timeout: 30000 });
            cap.phase = 'Oynatıcı başlatılıyor';

            for (;;) {
                if (cap.cancelled) throw new Error('iptal');
                if (cap.stopRequested) { cap.reason = 'durduruldu'; break; }
                if (drm) throw new Error(`Yayın DRM korumalı (${drm}); kaydedilemez`);

                // Ana çerçeve ve iframe'lerdeki videoları sür; en çok ilerleyeni esas al.
                let video = null;
                let videoFrame = null;
                for (const frame of page.frames()) {
                    const v = await frame.evaluate(driveVideo, SPEED).catch(() => null);
                    if (v && (!video || v.time > video.time || (v.duration > video.duration && v.time >= video.time))) {
                        video = v;
                        videoFrame = frame;
                    }
                }

                if (video && video.src && video.src !== 'blob' && !tracks.size && !direct && video.time > 0) {
                    // MSE yok: dosya düz adresten geliyor; videonun çerçevesinden, sayfanın oturumuyla indirilir.
                    cap.phase = 'Dosya indiriliyor';
                    direct = downloadDirect(videoFrame, video.src, cap).catch((err) => {
                        cap.directError = err.message;
                    });
                }
                if (direct && cap.directError) throw new Error(cap.directError);

                if (video) {
                    if (video.duration > 0) cap.duration = video.duration;
                    if (video.duration === -1) cap.duration = 0; // canlı yayın
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
                        break;
                    }
                }
                if (cap.maxSec > 0 && cap.mediaSec >= cap.maxSec) { cap.reason = 'süre doldu'; break; }
                if (cap.directDone) { cap.reason = 'dosya indirildi'; break; }

                if (!cap.bytes && !direct) {
                    if (Date.now() - started > START_TIMEOUT_MS) {
                        throw new Error(video
                            ? (video.error ? 'Video bu sunucudaki tarayıcıda oynatılamadı (codec desteklenmiyor olabilir)' : 'Video oynatılmaya başlamadı')
                            : 'Sayfada oynatılabilir video bulunamadı');
                    }
                    await nudgePlayback(page, started, nudgeState);
                } else if (Date.now() - Math.max(lastProgress.at, lastDataAt) > STALL_MS) {
                    cap.reason = 'oynatma ilerlemiyor, elde olan kaydedildi';
                    break;
                }
                cap.warning = video && video.error ? 'Oynatıcı hata verdi; elde olan kaydedilecek' : cap.warning;
                persistThrottled(cap);
                await new Promise((r) => setTimeout(r, TICK_MS));
            }

            cap.finishing = true;
            if (direct) {
                cap.phase = 'Dosya indiriliyor';
                await direct;
            }
            cap.phase = 'Dosya hazırlanıyor';
            await finalize(cap, tracks);
            cap.state = 'done';
        } catch (err) {
            cap.finishing = true;
            if (cap.cancelled) {
                remove(cap.id);
                return;
            }
            // Bir şey yakalandıysa (ör. durdurmadan önce hata) onu kaydetmeyi dene.
            if (cap.bytes > 0 && !/DRM/.test(err.message)) {
                try {
                    await finalize(cap, tracks);
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
            cap.endedAt = Date.now();
            cap.phase = '';
            if (captures.has(cap.id)) persist(cap);
            if (cap.work) fs.rm(cap.work, { recursive: true, force: true }, () => {});
            cap.work = null;
        }
    }

    let lastPersist = 0;
    function persistThrottled(cap) {
        if (Date.now() - lastPersist > 5000) {
            lastPersist = Date.now();
            persist(cap);
        }
    }

    /** MSE kullanmayan oynatıcı: dosyayı sayfanın içinden (çerez/oturumla) akış olarak çeker. */
    async function downloadDirect(frame, src, cap) {
        const file = path.join(cap.work, 'direct.bin');
        cap.directFd = fs.openSync(file, 'w');
        cap.directFile = file;
        try {
            const info = await frame.evaluate(async (url) => {
                const res = await fetch(url, { credentials: 'include' });
                if (!res.ok) throw new Error(`Kaynak ${res.status} döndü`);
                const total = Number(res.headers.get('content-length')) || 0;
                const reader = res.body.getReader();
                for (;;) {
                    const { done, value } = await reader.read();
                    if (done) break;
                    let s = '';
                    for (let i = 0; i < value.length; i += 0x8000) s += String.fromCharCode.apply(null, value.subarray(i, i + 0x8000));
                    await window.__indiriciChunk(btoa(s));
                }
                return { type: res.headers.get('content-type') || '', total };
            }, src);
            cap.directType = info.type;
            cap.directDone = true;
        } finally {
            fs.closeSync(cap.directFd);
            cap.directFd = null;
        }
    }

    async function finalize(cap, tracks) {
        const out = path.join(dir, `${cap.id}.out`);
        if (cap.directFile && fs.existsSync(cap.directFile) && fs.statSync(cap.directFile).size > 0) {
            const ext = /webm/.test(cap.directType || '') ? 'webm' : /audio/.test(cap.directType || '') ? 'm4a' : 'mp4';
            fs.renameSync(cap.directFile, out);
            cap.ext = ext;
        } else {
            for (const track of tracks.values()) {
                try { fs.closeSync(track.fd); } catch (_) { /* zaten kapalı */ }
                track.fd = null;
            }
            const list = [...tracks.values()].filter((t) => t.bytes > 0);
            if (!list.length) throw new Error('Video verisi yakalanamadı');
            const result = await mergeFmp4(list, out);
            cap.ext = result.ext;
            if (result.warning) cap.warning = result.warning;
        }
        cap.file = `${cap.id}.out`;
        cap.fileName = `${cap.baseName}.${cap.ext}`;
        cap.bytes = fs.statSync(out).size;
    }

    setInterval(() => {
        for (const cap of captures.values()) {
            if (cap.state !== 'capturing' && Date.now() - (cap.endedAt || 0) > KEEP_FINISHED_MS) remove(cap.id);
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
        async start({ url, name, maxSec }) {
            const target = new URL(url);
            await assertPublicTarget(target);
            const active = [...captures.values()].filter((c) => c.state === 'capturing').length;
            if (active >= MAX_ACTIVE) throw new Error(`Aynı anda en fazla ${MAX_ACTIVE} sunucu kaydı yapılabilir`);
            const id = randomBytes(12).toString('hex');
            const baseName = String(name || 'video').replace(/[\\/:*?"<>|]+/g, '_').trim().slice(0, 100) || 'video';
            const work = path.join(dir, `${id}.work`);
            fs.mkdirSync(work, { recursive: true });
            const cap = {
                id, url: target.href, baseName, fileName: `${baseName}.mp4`, file: '', ext: 'mp4', work,
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
            if (cap.state === 'capturing') {
                cap.stopRequested = true;
                cap.phase = 'Durduruluyor';
            }
            return publicState(cap);
        },
        delete(id) {
            const cap = captures.get(id);
            if (!cap) return false;
            if (cap.state === 'capturing') {
                cap.cancelled = true;
                if (cap.context) cap.context.close().catch(() => {});
                return true; // run() iptali görünce dosyaları siler
            }
            return remove(id);
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
