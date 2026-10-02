// Canlı HLS yayınını sunucuda kaydetme. Telefondaki tarayıcı ekran kapanınca sekmeyi dondurur ve
// kayıt parça kaçırır; bu sunucu ise uyumaz. Playlist düzenli aralıklarla okunur, yeni parçalar
// sırayla diske yazılır; süre sınırı dolunca ya da "durdur" gelince dosya kapanır. İstenirse TS
// parçaları mux.js ile (yeniden kodlamadan) MP4'e/M4A'ya çevrilir.
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { randomBytes, createDecipheriv } from 'node:crypto';

const MAX_ACTIVE = 4;
const SEGMENT_RETRY = 3;
const PLAYLIST_FAILURES_LIMIT = 8;
const KEEP_FINISHED_MS = 48 * 60 * 60 * 1000;

/* ---------------- Playlist ---------------- */

function parseAttributes(input) {
    const attrs = {};
    const re = /([A-Z0-9-]+)=("[^"]*"|[^,]*)/g;
    let m;
    while ((m = re.exec(input)) !== null) attrs[m[1]] = m[2].replace(/^"|"$/g, '');
    return attrs;
}

function parseByteRange(value, previousEnd) {
    const [lenStr, offStr] = String(value).split('@');
    return { length: parseInt(lenStr, 10), offset: offStr !== undefined ? parseInt(offStr, 10) : previousEnd };
}

export function parsePlaylist(text, baseUrl) {
    const lines = text.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
    const resolve = (uri) => new URL(uri, baseUrl).href;
    if (lines.some((l) => l.startsWith('#EXT-X-STREAM-INF'))) {
        const variants = [];
        for (let i = 0; i < lines.length; i++) {
            if (!lines[i].startsWith('#EXT-X-STREAM-INF')) continue;
            const attrs = parseAttributes(lines[i].slice(lines[i].indexOf(':') + 1));
            const uri = lines.slice(i + 1).find((l) => !l.startsWith('#'));
            if (uri) variants.push({ url: resolve(uri), bandwidth: parseInt(attrs.BANDWIDTH || '0', 10) });
        }
        variants.sort((a, b) => b.bandwidth - a.bandwidth);
        return { type: 'master', variants };
    }

    const segments = [];
    let key = null;
    let map = null;
    let range = null;
    let duration = 0;
    let seq = 0;
    let lastByteEnd = 0;
    let targetDuration = 0;
    for (const line of lines) {
        if (line.startsWith('#EXT-X-MEDIA-SEQUENCE')) seq = parseInt(line.split(':')[1], 10) || 0;
        else if (line.startsWith('#EXT-X-TARGETDURATION')) targetDuration = parseFloat(line.split(':')[1]) || 0;
        else if (line.startsWith('#EXTINF')) duration = parseFloat(line.split(':')[1]) || 0;
        else if (line.startsWith('#EXT-X-BYTERANGE')) range = parseByteRange(line.split(':')[1], lastByteEnd);
        else if (line.startsWith('#EXT-X-KEY')) {
            const attrs = parseAttributes(line.slice(line.indexOf(':') + 1));
            const method = (attrs.METHOD || 'NONE').toUpperCase();
            key = method === 'NONE' ? null : { method, uri: attrs.URI ? resolve(attrs.URI) : null, iv: attrs.IV || null };
        } else if (line.startsWith('#EXT-X-MAP')) {
            const attrs = parseAttributes(line.slice(line.indexOf(':') + 1));
            map = { url: resolve(attrs.URI), range: attrs.BYTERANGE ? parseByteRange(attrs.BYTERANGE, 0) : null };
        } else if (!line.startsWith('#')) {
            segments.push({ url: resolve(line), duration, range, key, seq: seq + segments.length });
            if (range) lastByteEnd = range.offset + range.length;
            range = null;
            duration = 0;
        }
    }
    return { type: 'media', segments, map, targetDuration, isLive: !lines.includes('#EXT-X-ENDLIST') };
}

/* ---------------- TS → MP4 (mux.js) ---------------- */

let muxjs = null;
function loadMux(appRoot) {
    if (muxjs) return muxjs;
    // Uygulamanın kullandığı aynı dosya; tarayıcı paketi olduğu için ayrı bir bağlamda çalıştırılır.
    const code = fs.readFileSync(path.join(appRoot, 'assets', 'vendor', 'mux-mp4.min.js'), 'utf8');
    const context = { console };
    context.window = context;
    context.self = context;
    vm.createContext(context);
    vm.runInContext(code, context);
    muxjs = context.muxjs;
    if (!muxjs) throw new Error('mux.js yüklenemedi');
    return muxjs;
}

function createWriter(file, { format, isFmp4, appRoot }) {
    const stream = fs.createWriteStream(file);
    const write = (chunk) => new Promise((resolve, reject) => {
        stream.write(chunk, (err) => (err ? reject(err) : resolve()));
    });
    const close = () => new Promise((resolve) => stream.end(resolve));

    let tm = null;
    if (!isFmp4 && (format === 'mp4' || format === 'audio')) {
        try {
            const mux = loadMux(appRoot);
            tm = new (mux.mp4 || mux).Transmuxer({ remux: format !== 'audio' });
        } catch (err) {
            console.warn('Dönüştürücü yok, TS olarak kaydediliyor:', err.message);
        }
    }
    if (!tm) return { fellBack: Boolean(!isFmp4 && format !== 'ts'), push: write, finish: close };

    let initWritten = false;
    let out = [];
    tm.on('data', (segment) => {
        if (format === 'audio' && segment.type !== 'audio') return;
        if (!initWritten) {
            out.push(Buffer.from(segment.initSegment.buffer, segment.initSegment.byteOffset, segment.initSegment.byteLength));
            initWritten = true;
        }
        out.push(Buffer.from(segment.data.buffer, segment.data.byteOffset, segment.data.byteLength));
    });
    return {
        fellBack: false,
        async push(data) {
            tm.push(new Uint8Array(data.buffer, data.byteOffset, data.byteLength));
            tm.flush();
            const chunks = out;
            out = [];
            for (const chunk of chunks) await write(chunk);
        },
        finish: close
    };
}

/* ---------------- Kayıt yöneticisi ---------------- */

const EXT = { mp4: 'mp4', ts: 'ts', audio: 'm4a' };
const MIME = { mp4: 'video/mp4', ts: 'video/mp2t', m4a: 'audio/mp4' };

/**
 * @param {object} deps
 * @param {string} deps.dir         kayıtların yazılacağı klasör
 * @param {string} deps.appRoot     mux.js'in bulunduğu uygulama kökü
 * @param {(url: URL) => Promise<void>} deps.assertPublicTarget
 * @param {(url: string) => string} deps.refererFor
 * @param {string} deps.userAgent
 */
export function createRecorder({ dir, appRoot, assertPublicTarget, refererFor, userAgent }) {
    fs.mkdirSync(dir, { recursive: true });
    const recordings = new Map();

    const metaFile = (id) => path.join(dir, `${id}.json`);
    const persist = (rec) => {
        try {
            fs.writeFileSync(metaFile(rec.id), JSON.stringify(publicState(rec)));
        } catch (_) { /* disk dolu: durum yalnızca bellekte */ }
    };

    // Sunucu yeniden başladıysa önceki kayıtlar listede kalsın; yarıda kalanlar "bitti" sayılır.
    for (const name of fs.readdirSync(dir)) {
        if (!name.endsWith('.json')) continue;
        try {
            const state = JSON.parse(fs.readFileSync(path.join(dir, name), 'utf8'));
            if (!fs.existsSync(path.join(dir, state.file))) continue;
            if (state.state === 'recording' || state.state === 'stopping') {
                state.state = 'done';
                state.reason = 'sunucu yeniden başladı';
                state.endedAt = state.endedAt || Date.now();
            }
            recordings.set(state.id, { ...state, stopRequested: false, controller: new AbortController() });
        } catch (_) { /* bozuk kayıt dosyası */ }
    }

    function publicState(rec) {
        return {
            id: rec.id, state: rec.state, url: rec.url, fileName: rec.fileName, file: rec.file, ext: rec.ext,
            format: rec.format, quality: rec.quality, limitSec: rec.limitSec, limitLabel: rec.limitLabel,
            startedAt: rec.startedAt, endedAt: rec.endedAt, mediaSec: rec.mediaSec, bytes: rec.bytes,
            missed: rec.missed, reason: rec.reason, error: rec.error, warning: rec.warning
        };
    }

    async function upstream(url, { range, signal } = {}) {
        const target = new URL(url);
        await assertPublicTarget(target);
        const headers = { 'user-agent': userAgent, accept: '*/*' };
        const referer = refererFor(url);
        if (referer) headers.referer = referer;
        if (range) headers.range = `bytes=${range.offset}-${range.offset + range.length - 1}`;
        const res = await fetch(target, { headers, signal, cache: 'no-store' });
        if (!res.ok && res.status !== 206) throw new Error(`Kaynak ${res.status} döndü`);
        return res;
    }

    async function loadPlaylist(url, signal) {
        const res = await upstream(url, { signal });
        return parsePlaylist(await res.text(), url);
    }

    async function run(rec) {
        const { signal } = rec.controller;
        const keyCache = new Map();
        const fetchSegment = async (segment) => {
            let lastError;
            for (let attempt = 1; attempt <= SEGMENT_RETRY; attempt++) {
                if (signal.aborted) throw new Error('iptal');
                try {
                    const res = await upstream(segment.url, { range: segment.range, signal });
                    let data = Buffer.from(await res.arrayBuffer());
                    if (segment.key) {
                        if (!keyCache.has(segment.key.uri)) {
                            const keyRes = await upstream(segment.key.uri, { signal });
                            keyCache.set(segment.key.uri, Buffer.from(await keyRes.arrayBuffer()));
                        }
                        const iv = Buffer.alloc(16);
                        if (segment.key.iv) Buffer.from(segment.key.iv.replace(/^0x/i, ''), 'hex').copy(iv);
                        else iv.writeUInt32BE(segment.seq >>> 0, 12);
                        const decipher = createDecipheriv('aes-128-cbc', keyCache.get(segment.key.uri), iv);
                        data = Buffer.concat([decipher.update(data), decipher.final()]);
                    }
                    return data;
                } catch (err) {
                    if (signal.aborted) throw err;
                    lastError = err;
                    await new Promise((r) => setTimeout(r, 400 * attempt));
                }
            }
            throw lastError || new Error('Parça indirilemedi');
        };

        let wake = null;
        const wait = (ms) => new Promise((resolve) => {
            const timer = setTimeout(resolve, ms);
            wake = () => {
                clearTimeout(timer);
                resolve();
            };
        });
        rec.wake = () => wake && wake();
        const elapsed = () => (Date.now() - rec.startedAt) / 1000;
        const limitReached = () => rec.limitSec > 0 && elapsed() >= rec.limitSec;

        let writer = null;
        try {
            let playlist = await loadPlaylist(rec.url, signal);
            if (playlist.type === 'master') {
                rec.url = playlist.variants[0].url; // kalite seçilmemişse en yükseği
                playlist = await loadPlaylist(rec.url, signal);
            }
            const drm = playlist.segments.find((s) => s.key && s.key.method !== 'AES-128');
            if (drm) throw new Error(`Yayın DRM korumalı (${drm.key.method})`);

            const isFmp4 = Boolean(playlist.map);
            rec.ext = isFmp4 ? 'mp4' : EXT[rec.format] || 'ts';
            writer = createWriter(path.join(dir, rec.file), { format: rec.format, isFmp4, appRoot });
            if (writer.fellBack) rec.ext = 'ts';
            rec.fileName = `${rec.baseName}.${rec.ext}`;

            let lastSeq = null;
            let mapWritten = false;
            let failures = 0;
            for (;;) {
                if (signal.aborted) throw new Error('iptal');
                if (rec.stopRequested) { rec.reason = 'durduruldu'; break; }
                if (limitReached()) { rec.reason = 'süre doldu'; break; }

                if (lastSeq !== null) {
                    try {
                        playlist = await loadPlaylist(rec.url, signal);
                        failures = 0;
                        rec.warning = '';
                    } catch (err) {
                        if (signal.aborted) throw err;
                        failures++;
                        rec.warning = `Playlist okunamadı (${failures}/${PLAYLIST_FAILURES_LIMIT}): ${err.message}`;
                        if (failures >= PLAYLIST_FAILURES_LIMIT) { rec.reason = 'yayına ulaşılamadı'; break; }
                        await wait(2000);
                        continue;
                    }
                }

                if (playlist.map && !mapWritten) {
                    const init = await fetchSegment({ ...playlist.map, key: null });
                    await writer.push(init);
                    rec.bytes += init.length;
                    mapWritten = true;
                }

                const all = playlist.segments;
                let fresh;
                if (lastSeq === null) {
                    fresh = all.slice(-1);
                } else {
                    fresh = all.filter((s) => s.seq > lastSeq);
                    const newest = all.length ? all[all.length - 1].seq : lastSeq;
                    if (!fresh.length && newest < lastSeq - 10) fresh = all.slice(-1);
                    else if (fresh.length && fresh[0].seq > lastSeq + 1) rec.missed += fresh[0].seq - lastSeq - 1;
                }

                for (const segment of fresh) {
                    if (rec.stopRequested || limitReached() || signal.aborted) break;
                    let data;
                    try {
                        data = await fetchSegment(segment);
                    } catch (err) {
                        if (signal.aborted) throw err;
                        rec.missed++;
                        lastSeq = segment.seq;
                        continue;
                    }
                    await writer.push(data);
                    lastSeq = segment.seq;
                    rec.mediaSec += segment.duration;
                    rec.bytes += data.length;
                }
                persist(rec);

                if (!playlist.isLive) { rec.reason = 'yayın bitti'; break; }
                let ms = Math.min(6000, Math.max(1000, ((playlist.targetDuration || 6) * 1000) / 2));
                if (rec.limitSec > 0) ms = Math.min(ms, Math.max(250, (rec.limitSec - elapsed()) * 1000));
                await wait(ms);
            }
            await writer.finish();
            rec.state = 'done';
        } catch (err) {
            if (writer) await writer.finish().catch(() => {});
            if (signal.aborted) {
                rec.state = 'cancelled';
                remove(rec.id);
                return;
            }
            rec.state = rec.bytes > 0 ? 'done' : 'error';
            if (rec.state === 'done') rec.reason = `hata: ${err.message}`;
            rec.error = err.message;
        } finally {
            rec.endedAt = Date.now();
            rec.warning = '';
            if (recordings.has(rec.id)) persist(rec);
        }
    }

    function remove(id) {
        const rec = recordings.get(id);
        if (!rec) return false;
        recordings.delete(id);
        for (const file of [path.join(dir, rec.file), metaFile(id)]) {
            fs.rm(file, { force: true }, () => {});
        }
        return true;
    }

    // Eski bitmiş kayıtlar diski doldurmasın.
    setInterval(() => {
        for (const rec of recordings.values()) {
            if (rec.state !== 'recording' && rec.state !== 'stopping' && Date.now() - (rec.endedAt || 0) > KEEP_FINISHED_MS) {
                remove(rec.id);
            }
        }
    }, 60 * 60 * 1000).unref();

    return {
        list() {
            return [...recordings.values()].map(publicState).sort((a, b) => b.startedAt - a.startedAt);
        },
        get(id) {
            const rec = recordings.get(id);
            return rec ? publicState(rec) : null;
        },
        async start({ url, name, format, limitSec, limitLabel, quality }) {
            const target = new URL(url);
            await assertPublicTarget(target);
            const active = [...recordings.values()].filter((r) => r.state === 'recording').length;
            if (active >= MAX_ACTIVE) throw new Error(`Aynı anda en fazla ${MAX_ACTIVE} kayıt yapılabilir`);
            const id = randomBytes(12).toString('hex');
            const baseName = String(name || 'kayit').replace(/[\\/:*?"<>|]+/g, '_').slice(0, 100) || 'kayit';
            const fmt = ['mp4', 'ts', 'audio'].includes(format) ? format : 'mp4';
            const rec = {
                id, url: target.href, baseName, format: fmt, quality: String(quality || '').slice(0, 40),
                ext: EXT[fmt], file: `${id}.bin`, fileName: `${baseName}.${EXT[fmt]}`,
                limitSec: Math.max(0, Math.min(24 * 3600, Number(limitSec) || 0)),
                limitLabel: String(limitLabel || '').slice(0, 20),
                state: 'recording', startedAt: Date.now(), endedAt: 0, mediaSec: 0, bytes: 0, missed: 0,
                reason: '', error: '', warning: '', stopRequested: false, controller: new AbortController()
            };
            recordings.set(id, rec);
            persist(rec);
            run(rec);
            return publicState(rec);
        },
        stop(id) {
            const rec = recordings.get(id);
            if (!rec) return null;
            if (rec.state === 'recording') {
                rec.state = 'stopping';
                rec.stopRequested = true;
                if (rec.wake) rec.wake();
            }
            return publicState(rec);
        },
        /** Süren kaydı iptal eder (dosya silinir) ya da bitmiş kaydı siler. */
        delete(id) {
            const rec = recordings.get(id);
            if (!rec) return false;
            if (rec.state === 'recording' || rec.state === 'stopping') {
                rec.controller.abort();
                if (rec.wake) rec.wake();
            }
            return remove(id);
        },
        /** Bitmiş kaydın dosyası (akış olarak gönderilir). */
        file(id) {
            const rec = recordings.get(id);
            if (!rec || rec.state !== 'done') return null;
            const full = path.join(dir, rec.file);
            if (!fs.existsSync(full)) return null;
            return { path: full, name: rec.fileName, mime: MIME[rec.ext] || 'application/octet-stream', size: fs.statSync(full).size };
        }
    };
}
