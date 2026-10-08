// Canlı HLS yayınını sunucuda kaydetme. Telefondaki tarayıcı ekran kapanınca sekmeyi dondurur ve
// kayıt parça kaçırır; bu sunucu ise uyumaz. Playlist düzenli aralıklarla okunur, yeni parçalar
// diske yazılır; süre sınırı dolunca ya da "durdur" gelince dosya kapanır.
// Çıktı uygulamadakiyle aynı: tek, sarılabilir MP4 (ayrı ses izi varsa birleştirilir), zaman
// çizelgesi kaydın başladığı andan (0:00) başlar. TS parçaları mux.js ile çevrilir, MP4'ü
// uygulamanın assets/js/mp4mux.mjs dosyası kurar.
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { randomBytes, createDecipheriv } from 'node:crypto';
import { Mp4Builder } from '../assets/js/mp4mux.mjs';

const MAX_ACTIVE = Number(process.env.MAX_RECORDINGS) || 8;
const SEGMENT_RETRY = 3;
const PLAYLIST_FAILURES_LIMIT = 8;
const KEEP_FINISHED_MS = 48 * 60 * 60 * 1000;
const VIDEO_CODEC = /avc1|avc3|hvc1|hev1|dvh1|vp08|vp09|av01/i;

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
        const audio = {};
        const variants = [];
        for (let i = 0; i < lines.length; i++) {
            const attrs = parseAttributes(lines[i].slice(lines[i].indexOf(':') + 1));
            if (lines[i].startsWith('#EXT-X-MEDIA:') && (attrs.TYPE || '').toUpperCase() === 'AUDIO' && attrs.URI) {
                (audio[attrs['GROUP-ID'] || ''] = audio[attrs['GROUP-ID'] || ''] || [])
                    .push({ url: resolve(attrs.URI), isDefault: (attrs.DEFAULT || '').toUpperCase() === 'YES' });
            }
            if (!lines[i].startsWith('#EXT-X-STREAM-INF')) continue;
            const uri = lines.slice(i + 1).find((l) => !l.startsWith('#'));
            if (!uri) continue;
            const codecs = attrs.CODECS || '';
            variants.push({
                url: resolve(uri),
                height: parseInt(String(attrs.RESOLUTION || '').split('x')[1] || '0', 10),
                bandwidth: parseInt(attrs.BANDWIDTH || '0', 10),
                audioGroup: attrs.AUDIO || '',
                video: codecs ? VIDEO_CODEC.test(codecs) : true
            });
        }
        const video = variants.filter((v) => v.video);
        (video.length ? video : variants).sort((a, b) => b.bandwidth - a.bandwidth);
        return { type: 'master', variants: video.length ? video : variants, audio };
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
            segments.push({ url: resolve(line), duration, range, key, map, seq: seq + segments.length });
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

const sameBytes = (a, b) => a && b && a.length === b.length && a.every((x, i) => x === b[i]);

/** Dosyaya sarılabilir MP4 yazan birleştirici (uygulamadaki createMuxer'ın sunucu karşılığı). */
export async function createMuxer(file, appRoot) {
    const fd = fs.openSync(file, 'w');
    let pos = 0;
    const builder = new Mp4Builder({
        write: async (bytes) => {
            fs.writeSync(fd, bytes, 0, bytes.length, pos);
            pos += bytes.length;
        }
    });
    await builder.start();
    const transmuxers = new Map();
    const lastInit = new Map();
    const addInit = (id, bytes) => {
        if (sameBytes(lastInit.get(id), bytes)) return;
        lastInit.set(id, bytes);
        builder.addInit(id, bytes);
    };
    const u8 = (x) => new Uint8Array(x.buffer, x.byteOffset, x.byteLength);
    return {
        builder,
        async push(streamId, data, map) {
            if (map) {
                addInit(streamId, u8(map));
                await builder.addFragment(streamId, u8(data));
                return;
            }
            let entry = transmuxers.get(streamId);
            if (!entry) {
                const mux = loadMux(appRoot);
                const tm = new (mux.mp4 || mux).Transmuxer({ remux: false, keepOriginalTimestamps: true });
                entry = { tm, out: [] };
                tm.on('data', (segment) => entry.out.push(segment));
                transmuxers.set(streamId, entry);
            }
            entry.tm.push(u8(data));
            entry.tm.flush();
            for (const segment of entry.out.splice(0)) {
                const id = `${streamId}-${segment.type}`;
                addInit(id, Uint8Array.from(segment.initSegment));
                await builder.addFragment(id, Uint8Array.from(segment.data));
            }
        },
        async finish() {
            const result = await builder.finish();
            fs.writeSync(fd, result.patch.bytes, 0, result.patch.bytes.length, result.patch.position);
            fs.closeSync(fd);
            return result;
        },
        close() {
            try { fs.closeSync(fd); } catch (_) { /* zaten kapalı */ }
        }
    };
}

/* ---------------- Kayıt yöneticisi ---------------- */

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

    // Sunucu yeniden başladıysa önceki kayıtlar listede kalsın. Yarıda kalan kaydın dosyası
    // kapanmadığı (MP4 tabloları yazılmadığı) için oynatılamaz; hata olarak gösterilir.
    for (const name of fs.readdirSync(dir)) {
        if (!name.endsWith('.json')) continue;
        try {
            const state = JSON.parse(fs.readFileSync(path.join(dir, name), 'utf8'));
            if (!fs.existsSync(path.join(dir, state.file))) continue;
            if (state.state === 'recording' || state.state === 'stopping') {
                state.state = 'error';
                state.error = 'Sunucu kayıt sürerken kapandı; kayıt tamamlanamadı';
                state.endedAt = state.endedAt || Date.now();
            }
            recordings.set(state.id, { ...state, stopRequested: false, controller: new AbortController() });
        } catch (_) { /* bozuk kayıt dosyası */ }
    }

    function publicState(rec) {
        return {
            id: rec.id, state: rec.state, url: rec.url, audioUrl: rec.audioUrl, fileName: rec.fileName, file: rec.file,
            ext: rec.ext, quality: rec.quality, limitSec: rec.limitSec, limitLabel: rec.limitLabel,
            startedAt: rec.startedAt, endedAt: rec.endedAt, mediaSec: rec.mediaSec, bytes: rec.bytes,
            missed: rec.missed, reason: rec.reason, error: rec.error, warning: rec.warning,
            maxHeight: rec.maxHeight || 0, vod: Boolean(rec.vod), keepMs: rec.keepMs || 0, source: rec.source || '',
            total: rec.total || 0, download: Boolean(rec.download), device: rec.device || ''
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
        const mapCache = new Map();
        const bytesOf = async (url, range) => Buffer.from(await (await upstream(url, { range, signal })).arrayBuffer());
        const fetchSegment = async (segment) => {
            let lastError;
            for (let attempt = 1; attempt <= SEGMENT_RETRY; attempt++) {
                if (signal.aborted) throw new Error('iptal');
                try {
                    let map = null;
                    if (segment.map) {
                        const mapKey = segment.map.url + (segment.map.range ? '#' + segment.map.range.offset : '');
                        if (!mapCache.has(mapKey)) mapCache.set(mapKey, await bytesOf(segment.map.url, segment.map.range));
                        map = mapCache.get(mapKey);
                    }
                    let data = await bytesOf(segment.url, segment.range);
                    if (segment.key) {
                        if (!keyCache.has(segment.key.uri)) keyCache.set(segment.key.uri, await bytesOf(segment.key.uri));
                        const iv = Buffer.alloc(16);
                        if (segment.key.iv) Buffer.from(segment.key.iv.replace(/^0x/i, ''), 'hex').copy(iv);
                        else iv.writeUInt32BE(segment.seq >>> 0, 12);
                        const decipher = createDecipheriv('aes-128-cbc', keyCache.get(segment.key.uri), iv);
                        data = Buffer.concat([decipher.update(data), decipher.final()]);
                    }
                    return { data, map };
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

        let muxer = null;
        try {
            // Master verildiyse en yüksek kalite (ya da istenen üst sınırın altındaki en iyisi) + varsayılan ses.
            let first = rec.playlistText ? parsePlaylist(rec.playlistText, rec.url) : await loadPlaylist(rec.url, signal);
            rec.playlistText = '';
            if (first.type === 'master') {
                const capped = rec.maxHeight ? first.variants.filter((v) => !v.height || v.height <= rec.maxHeight) : [];
                const best = capped[0] || first.variants[0];
                if (best.height) rec.quality = rec.quality || `${best.height}p`;
                const group = first.audio[best.audioGroup] || [];
                const audio = group.find((a) => a.isDefault) || group[0];
                if (!rec.audioUrl && audio) rec.audioUrl = audio.url;
                rec.url = best.url;
                first = await loadPlaylist(rec.url, signal);
            }
            const streams = [{ id: 'v', url: rec.url, playlist: first, lastSeq: null }];
            if (rec.audioUrl) streams.push({ id: 'a', url: rec.audioUrl, playlist: await loadPlaylist(rec.audioUrl, signal), lastSeq: null });
            for (const s of streams) {
                const drm = s.playlist.segments.find((x) => x.key && x.key.method !== 'AES-128');
                if (drm) throw new Error(`Yayın DRM korumalı (${drm.key.method})`);
            }

            muxer = await createMuxer(path.join(dir, rec.file), appRoot);
            let failures = 0;
            let firstRound = true;
            for (;;) {
                if (signal.aborted) throw new Error('iptal');
                if (rec.stopRequested) { rec.reason = 'durduruldu'; break; }
                if (limitReached()) { rec.reason = 'süre doldu'; break; }

                if (!firstRound) {
                    try {
                        for (const s of streams) s.playlist = await loadPlaylist(s.url, signal);
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
                firstRound = false;

                let ended = false;
                for (const s of streams) {
                    const all = s.playlist.segments;
                    let fresh;
                    if (s.lastSeq === null) {
                        // Canlıda en yeni parçadan başlanır; bitmiş (VOD) yayın baştan sona alınır.
                        fresh = rec.vod || !s.playlist.isLive ? all : all.slice(-1);
                    } else {
                        fresh = all.filter((x) => x.seq > s.lastSeq);
                        const newest = all.length ? all[all.length - 1].seq : s.lastSeq;
                        if (!fresh.length && newest < s.lastSeq - 10) fresh = all.slice(-1);
                        else if (fresh.length && fresh[0].seq > s.lastSeq + 1 && s.id === 'v') rec.missed += fresh[0].seq - s.lastSeq - 1;
                    }
                    for (const segment of fresh) {
                        if (rec.stopRequested || limitReached() || signal.aborted) break;
                        let result;
                        try {
                            result = await fetchSegment(segment);
                        } catch (err) {
                            if (signal.aborted) throw err;
                            if (s.id === 'v') rec.missed++;
                            s.lastSeq = segment.seq;
                            continue;
                        }
                        await muxer.push(s.id, result.data, result.map);
                        s.lastSeq = segment.seq;
                        rec.bytes += result.data.length;
                    }
                    if (!s.playlist.isLive) ended = true;
                }
                rec.mediaSec = muxer.builder.duration;
                persist(rec);

                if (ended) { rec.reason = 'yayın bitti'; break; }
                let ms = Math.min(6000, Math.max(1000, ((streams[0].playlist.targetDuration || 6) * 1000) / 2));
                if (rec.limitSec > 0) ms = Math.min(ms, Math.max(250, (rec.limitSec - elapsed()) * 1000));
                await wait(ms);
            }
            if (!muxer.builder.hasSamples) throw new Error('Yayından veri alınamadı');
            const result = await muxer.finish();
            rec.mediaSec = result.duration;
            rec.ext = result.hasVideo ? 'mp4' : 'm4a';
            rec.fileName = `${rec.baseName}.${rec.ext}`;
            rec.bytes = fs.statSync(path.join(dir, rec.file)).size;
            rec.state = 'done';
        } catch (err) {
            if (muxer) muxer.close();
            if (signal.aborted) {
                rec.state = 'cancelled';
                remove(rec.id);
                return;
            }
            rec.state = 'error';
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

    // Eski bitmiş kayıtlar diski doldurmasın (süre "Sunucu durumu"ndan değişir; 0: silinmez).
    let keepDefault = KEEP_FINISHED_MS;
    const sweep = () => {
        for (const rec of recordings.values()) {
            const keep = rec.keepMs || keepDefault;
            if (keep && rec.state !== 'recording' && rec.state !== 'stopping' && Date.now() - (rec.endedAt || 0) > keep) {
                remove(rec.id);
            }
        }
    };
    setInterval(sweep, 60 * 60 * 1000).unref();

    return {
        setKeepDefault(ms) {
            keepDefault = Math.max(0, Number(ms) || 0);
            sweep();
        },
        /** Bu süreden eski bitmiş kayıtlar (silinecekler): adet ve boyut. */
        olderThan(ms) {
            const old = [...recordings.values()].filter((r) => r.state === 'done' && !r.keepMs && Date.now() - (r.endedAt || 0) > ms);
            return { count: old.length, bytes: old.reduce((n, r) => n + (r.bytes || 0), 0) };
        },
        list() {
            return [...recordings.values()].map(publicState).sort((a, b) => b.startedAt - a.startedAt);
        },
        get(id) {
            const rec = recordings.get(id);
            return rec ? publicState(rec) : null;
        },
        async start({ url, audioUrl, playlistText = '', device = '', name, limitSec, limitLabel, quality, maxHeight = 0, vod = false, keepMs = 0, source = '' }) {
            const target = new URL(url);
            await assertPublicTarget(target);
            const audio = audioUrl ? new URL(audioUrl) : null;
            if (audio) await assertPublicTarget(audio);
            const active = [...recordings.values()].filter((r) => r.state === 'recording').length;
            if (active >= MAX_ACTIVE) throw new Error(`Aynı anda en fazla ${MAX_ACTIVE} kayıt yapılabilir`);
            const id = randomBytes(12).toString('hex');
            const baseName = String(name || 'kayit').replace(/[\\/:*?"<>|]+/g, '_').slice(0, 100) || 'kayit';
            const rec = {
                id, url: target.href, audioUrl: audio ? audio.href : null, baseName, quality: String(quality || '').slice(0, 40),
                ext: 'mp4', file: `${id}.bin`, fileName: `${baseName}.mp4`,
                limitSec: Math.max(0, Math.min(24 * 3600, Number(limitSec) || 0)),
                limitLabel: String(limitLabel || '').slice(0, 20),
                state: 'recording', startedAt: Date.now(), endedAt: 0, mediaSec: 0, bytes: 0, missed: 0,
                reason: '', error: '', warning: '', stopRequested: false, controller: new AbortController(),
                maxHeight: Number(maxHeight) || 0, vod: Boolean(vod), keepMs: Number(keepMs) || 0, source: String(source || '').slice(0, 2000),
                // Kaydı isteyen cihaz (takibi kuran ya da kaydı başlatan): bitince yalnızca o cihaza aktarılır.
                device: String(device || '').replace(/[^0-9a-f]/gi, '').slice(0, 32),
                // Sayfanın oynatıcısının aldığı liste içeriği: ana liste tek kullanımlık anahtar taşıyorsa
                // yeniden istenince reddedilir; ilk okuma buradan yapılır.
                playlistText: typeof playlistText === 'string' && playlistText.length < 1024 * 1024 ? playlistText : ''
            };
            recordings.set(id, rec);
            persist(rec);
            run(rec);
            return publicState(rec);
        },
        /**
         * Düz bir dosyayı (ör. kanalın yeni videosu) sunucuya indirir; bitince kayıtlar gibi listelenir.
         * @param {(file: string, onBytes: (n: number) => void, signal: AbortSignal) => Promise<void>} fetchTo
         */
        importFile({ name, ext = 'mp4', fetchTo, keepMs = 0, source = '', quality = '', download = false, device = '' }) {
            const id = randomBytes(12).toString('hex');
            const baseName = String(name || 'video').replace(/[\\/:*?"<>|]+/g, '_').slice(0, 100) || 'video';
            const rec = {
                id, url: source, audioUrl: null, baseName, quality, ext, file: `${id}.bin`, fileName: `${baseName}.${ext}`,
                limitSec: 0, limitLabel: '', state: 'recording', startedAt: Date.now(), endedAt: 0, mediaSec: 0, bytes: 0, missed: 0,
                reason: '', error: '', warning: '', stopRequested: false, controller: new AbortController(), keepMs, source, vod: true,
                total: 0, download, device: String(device || '').replace(/[^0-9a-f]/gi, '').slice(0, 32)
            };
            recordings.set(id, rec);
            persist(rec);
            (async () => {
                try {
                    const result = await fetchTo(path.join(dir, rec.file), (n) => { rec.bytes += n; }, rec.controller.signal, (t) => { rec.total = t; });
                    if (result && result.ext) {
                        rec.ext = result.ext;
                        rec.fileName = `${rec.baseName}.${result.ext}`;
                    }
                    rec.bytes = fs.statSync(path.join(dir, rec.file)).size;
                    rec.state = 'done';
                } catch (err) {
                    if (rec.controller.signal.aborted) {
                        rec.state = 'cancelled';
                        remove(rec.id);
                        return;
                    }
                    rec.state = 'error';
                    rec.error = err.message;
                } finally {
                    rec.endedAt = Date.now();
                    if (recordings.has(rec.id)) persist(rec);
                }
            })();
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
            const mime = rec.ext === 'm4a' ? 'audio/mp4' : 'video/mp4';
            return { path: full, name: rec.fileName, mime, size: fs.statSync(full).size };
        }
    };
}
