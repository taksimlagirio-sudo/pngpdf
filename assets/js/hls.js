// HLS (m3u8): ayrıştırma, tamamlanmış yayını (VOD) indirme ve canlı yayını süre sınırıyla kaydetme.
//
// Canlı yayında playlist yalnızca son birkaç parçayı gösterir; tek seferde indirmek birkaç saniyelik
// dosya üretir. Bu yüzden canlı yayın "kayıt" olarak ele alınır: playlist düzenli aralıklarla yeniden
// okunur, yeni parçalar sırayla dosyaya eklenir; kullanıcı durdurunca ya da süre sınırı dolunca
// dosya kapanıp kaydedilir.
import { formatSize, smartFetch, fileNameFromUrl, proxyUrl, probeAccess, hms, sleep } from './util.js';
import { startBackgroundDownload, canBackgroundFetch } from './downloads.js';

const MAX_PARALLEL = 4;
const SEGMENT_RETRY = 3;
const MAX_BG_SEGMENTS = 400;
const PLAYLIST_FAILURES_LIMIT = 8;

/** m3u8 metnini ayrıştırır: master ise varyantlar, media ise parçalar döner. */
export function parsePlaylist(text, baseUrl) {
    const lines = text.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
    const isMaster = lines.some((l) => l.startsWith('#EXT-X-STREAM-INF'));
    const resolve = (uri) => new URL(uri, baseUrl).href;

    if (isMaster) {
        const variants = [];
        for (let i = 0; i < lines.length; i++) {
            if (!lines[i].startsWith('#EXT-X-STREAM-INF')) continue;
            const attrs = parseAttributes(lines[i].slice(lines[i].indexOf(':') + 1));
            const uriLine = lines.slice(i + 1).find((l) => !l.startsWith('#'));
            if (!uriLine) continue;
            variants.push({
                url: resolve(uriLine),
                bandwidth: parseInt(attrs.BANDWIDTH || attrs['AVERAGE-BANDWIDTH'] || '0', 10),
                resolution: attrs.RESOLUTION || '',
                codecs: attrs.CODECS || ''
            });
        }
        variants.sort((a, b) => b.bandwidth - a.bandwidth);
        return { type: 'master', variants };
    }

    const segments = [];
    let key = null;
    let map = null;
    let pendingRange = null;
    let duration = 0;
    let totalDuration = 0;
    let seq = 0;
    let lastByteEnd = 0;
    let targetDuration = 0;
    const isLive = !lines.includes('#EXT-X-ENDLIST');

    for (const line of lines) {
        if (line.startsWith('#EXT-X-MEDIA-SEQUENCE')) {
            seq = parseInt(line.split(':')[1], 10) || 0;
        } else if (line.startsWith('#EXT-X-TARGETDURATION')) {
            targetDuration = parseFloat(line.split(':')[1]) || 0;
        } else if (line.startsWith('#EXTINF')) {
            duration = parseFloat(line.split(':')[1]) || 0;
        } else if (line.startsWith('#EXT-X-BYTERANGE')) {
            pendingRange = parseByteRange(line.split(':')[1], lastByteEnd);
        } else if (line.startsWith('#EXT-X-KEY')) {
            const attrs = parseAttributes(line.slice(line.indexOf(':') + 1));
            const method = (attrs.METHOD || 'NONE').toUpperCase();
            key = method === 'NONE' ? null : {
                method,
                uri: attrs.URI ? resolve(attrs.URI) : null,
                iv: attrs.IV || null,
                keyFormat: attrs.KEYFORMAT || 'identity'
            };
        } else if (line.startsWith('#EXT-X-MAP')) {
            const attrs = parseAttributes(line.slice(line.indexOf(':') + 1));
            map = {
                url: resolve(attrs.URI),
                range: attrs.BYTERANGE ? parseByteRange(attrs.BYTERANGE, 0) : null
            };
        } else if (!line.startsWith('#')) {
            segments.push({
                url: resolve(line),
                duration,
                start: totalDuration,
                range: pendingRange,
                key,
                seq: seq + segments.length
            });
            totalDuration += duration;
            if (pendingRange) lastByteEnd = pendingRange.offset + pendingRange.length;
            pendingRange = null;
            duration = 0;
        }
    }

    return { type: 'media', segments, map, totalDuration, isLive, targetDuration };
}

function parseAttributes(input) {
    const attrs = {};
    // ATTR=VALUE çiftleri; tırnak içindeki virgüller ayırıcı sayılmaz.
    const re = /([A-Z0-9-]+)=("[^"]*"|[^,]*)/g;
    let m;
    while ((m = re.exec(input)) !== null) {
        attrs[m[1]] = m[2].replace(/^"|"$/g, '');
    }
    return attrs;
}

function parseByteRange(value, previousEnd) {
    const [lenStr, offStr] = String(value).split('@');
    const length = parseInt(lenStr, 10);
    const offset = offStr !== undefined ? parseInt(offStr, 10) : previousEnd;
    return { length, offset };
}

function hexToBytes(hex) {
    const clean = hex.replace(/^0x/i, '');
    const out = new Uint8Array(clean.length / 2);
    for (let i = 0; i < out.length; i++) {
        out[i] = parseInt(clean.substr(i * 2, 2), 16);
    }
    return out;
}

// IV verilmemişse HLS spesifikasyonu medya sırası numarasını IV olarak kullanır.
function ivFromSequence(seq) {
    const iv = new Uint8Array(16);
    new DataView(iv.buffer).setUint32(12, seq >>> 0);
    return iv;
}

export function findDrm(segments) {
    return segments.find((s) => s.key && s.key.method !== 'AES-128');
}

/** Playlist'i okuyup ayrıştırır. Canlı yayında önbelleğe takılmamak için her seferinde tazelenir. */
export async function loadPlaylist(url, { mode = 'auto', signal } = {}) {
    const res = await smartFetch(url, { mode, init: { signal, cache: 'no-store' } });
    return parsePlaylist(await res.text(), url);
}

/* ---------------- Çıktı biçimi ---------------- */

/**
 * Kaynağa göre sunulan biçimler. TS yayınlar tarayıcıda MP4'e çevrilebilir (mux.js ile, yeniden
 * kodlama yok) ya da yalnızca sesi M4A olarak alınabilir; fMP4 yayınlar zaten MP4'tür.
 */
export function formatsFor(isFmp4) {
    return isFmp4
        ? [{ id: 'mp4', label: 'MP4', ext: 'mp4', hint: 'fMP4 parçaları birleştirilir · her cihazda oynar' }]
        : [
            { id: 'mp4', label: 'MP4', ext: 'mp4', hint: 'Her cihazda ve galeride oynar · kayıpsız dönüştürülür' },
            { id: 'ts', label: 'TS', ext: 'ts', hint: 'Olduğu gibi birleştirilir · VLC ile açılır' },
            { id: 'audio', label: 'Ses', ext: 'm4a', hint: 'Yalnızca ses (M4A) · görüntü atılır' }
        ];
}

export function extFor(format, isFmp4) {
    if (isFmp4) return 'mp4';
    return { mp4: 'mp4', ts: 'ts', audio: 'm4a' }[format] || 'ts';
}

const MIME = { mp4: 'video/mp4', ts: 'video/mp2t', m4a: 'audio/mp4' };
export const mimeFor = (ext) => MIME[ext] || 'application/octet-stream';

let muxPromise = null;
/** TS→MP4 dönüştürücüsünü (mux.js) ilk ihtiyaçta yükler. */
function loadMux() {
    if (window.muxjs) return Promise.resolve(window.muxjs);
    if (!muxPromise) {
        muxPromise = new Promise((resolve, reject) => {
            const script = document.createElement('script');
            script.src = new URL('../vendor/mux-mp4.min.js', import.meta.url).href;
            script.onload = () => (window.muxjs ? resolve(window.muxjs) : reject(new Error('mux.js yüklenemedi')));
            script.onerror = () => {
                muxPromise = null;
                reject(new Error('Dönüştürücü yüklenemedi (çevrimdışı olabilirsiniz)'));
            };
            document.head.appendChild(script);
        });
    }
    return muxPromise;
}

/**
 * Parçaları sırayla alıp hedefe yazan yazıcı. MP4/Ses seçiliyse TS parçaları dönüştürülerek yazılır.
 * Dönüştürücü yüklenemezse TS olarak devam edilir (veri kaybolmaz) ve `fellBack` işaretlenir.
 */
async function createWriter(sink, { format, isFmp4 }) {
    const transmux = !isFmp4 && (format === 'mp4' || format === 'audio');
    let tm = null;
    let fellBack = false;
    if (transmux) {
        try {
            const muxjs = await loadMux();
            tm = new (muxjs.mp4 || muxjs).Transmuxer({ remux: format !== 'audio' });
        } catch (err) {
            console.warn(err);
            fellBack = true;
        }
    }
    if (!tm) {
        return {
            fellBack,
            async push(data) { await sink.write(data); },
            async finish() {}
        };
    }

    let initWritten = false;
    let out = [];
    tm.on('data', (segment) => {
        if (format === 'audio' && segment.type !== 'audio') return;
        if (!initWritten) {
            out.push(new Uint8Array(segment.initSegment));
            initWritten = true;
        }
        out.push(new Uint8Array(segment.data));
    });
    const drain = async () => {
        const chunks = out;
        out = [];
        for (const chunk of chunks) await sink.write(chunk);
    };
    return {
        fellBack: false,
        async push(data) {
            tm.push(data);
            tm.flush();
            await drain();
        },
        async finish() {
            await drain();
        }
    };
}

/* ---------------- Parça indirme ---------------- */

function createSegmentFetcher({ mode, signal }) {
    const keyCache = new Map();

    async function decrypt(buffer, segment) {
        const { key } = segment;
        if (!key.uri) throw new Error('Şifreleme anahtarı adresi bulunamadı');
        if (!keyCache.has(key.uri)) {
            const res = await smartFetch(key.uri, { mode, init: { signal } });
            const raw = new Uint8Array(await res.arrayBuffer());
            if (raw.length !== 16) throw new Error('Geçersiz AES-128 anahtarı');
            keyCache.set(key.uri, await crypto.subtle.importKey('raw', raw, 'AES-CBC', false, ['decrypt']));
        }
        const iv = key.iv ? hexToBytes(key.iv) : ivFromSequence(segment.seq);
        const plain = await crypto.subtle.decrypt({ name: 'AES-CBC', iv }, keyCache.get(key.uri), buffer);
        return new Uint8Array(plain);
    }

    return async function fetchSegment(segment) {
        let lastError;
        for (let attempt = 1; attempt <= SEGMENT_RETRY; attempt++) {
            if (signal.aborted) throw new DOMException('Aborted', 'AbortError');
            try {
                const init = { signal };
                if (segment.range) {
                    init.headers = {
                        Range: `bytes=${segment.range.offset}-${segment.range.offset + segment.range.length - 1}`
                    };
                }
                const res = await smartFetch(segment.url, { mode, init });
                const buffer = new Uint8Array(await res.arrayBuffer());
                return segment.key ? await decrypt(buffer, segment) : buffer;
            } catch (err) {
                if (err.name === 'AbortError') throw err;
                lastError = err;
                await sleep(400 * attempt);
            }
        }
        throw new Error(`Parça indirilemedi: ${lastError ? lastError.message : 'bilinmeyen hata'}`);
    };
}

/** Yazıcının dönüştürme yapamadığı durumda dosya adının uzantısını düzeltir. */
function finalName(name, writer) {
    return writer.fellBack ? name.replace(/\.(mp4|m4a)$/i, '.ts') : name;
}

/* ---------------- Tamamlanmış yayın (VOD) ---------------- */

/**
 * Media playlist'i indirir. `range` ({start, end} saniye) verilirse yalnızca o aralıktaki parçalar
 * alınır. İş "Durdur ve kaydet" ile durdurulursa o ana kadar inen kısım kaydedilir.
 * `createSinkFor(fileName, mime)` hedefi açar (disk seçiliyse konum zaten tıklamada sorulmuştur).
 */
export async function downloadHlsVod({
    job, url, playlist = null, name, format = 'mp4', range = null, mode = 'auto',
    background = false, createSinkFor
}) {
    playlist = playlist || await loadPlaylist(url, { mode, signal: job.signal });
    if (playlist.type === 'master') throw new Error('Önce bir kalite seçin');

    let { segments } = playlist;
    const { map } = playlist;
    if (segments.length === 0) throw new Error('Playlist içinde parça bulunamadı');
    const drm = findDrm(segments);
    if (drm) throw new Error(`Bu yayın DRM korumalı (${drm.key.method}); indirilemez.`);

    if (range && (range.start > 0 || (range.end && range.end < playlist.totalDuration))) {
        const end = range.end || Infinity;
        segments = segments.filter((s) => s.start + s.duration > range.start && s.start < end);
        if (!segments.length) throw new Error('Seçilen aralıkta parça yok');
    }

    const isFmp4 = Boolean(map);
    const ext = extFor(format, isFmp4);
    const fileName = `${name}.${ext}`;
    const encrypted = segments.some((s) => s.key);
    const raw = isFmp4 || format === 'ts';

    // Şifresiz, dönüştürme gerektirmeyen ve makul uzunluktaki yayınlar service worker'a devredilebilir.
    if (background && canBackgroundFetch && raw && !encrypted && segments.length <= MAX_BG_SEGMENTS
        && job.saveMode !== 'disk') {
        const access = await probeAccess(segments[0].url, mode);
        const rawUrls = (map ? [map.url] : []).concat(segments.map((s) => s.url));
        const urls = access === 'proxy' ? rawUrls.map((u) => proxyUrl(u)) : rawUrls;
        job.name = fileName;
        const started = await startBackgroundDownload({
            urls,
            name: fileName,
            job,
            fallback: () => downloadHlsVod({
                job, url, playlist, name, format, range, mode, background: false, createSinkFor
            })
        });
        if (started) return;
    }

    const sink = await createSinkFor(fileName, mimeFor(ext));
    const writer = await createWriter(sink, { format, isFmp4 });
    job.name = finalName(sink.name || fileName, writer);
    job.canStop = true;
    const fetchSegment = createSegmentFetcher({ mode, signal: job.signal });

    let downloaded = 0;
    let nextToWrite = 0;
    const buffered = new Map();
    let writing = Promise.resolve();

    const report = () => {
        job.progress(downloaded, segments.length);
        job.detail = `${downloaded}/${segments.length} parça · ${formatSize(job.bytes)}`;
    };

    try {
        if (map) {
            const init = await fetchSegment({ url: map.url, range: map.range, key: null });
            await writer.push(init);
            job.addBytes(init.length);
        }

        let cursor = 0;
        const worker = async () => {
            for (;;) {
                if (job.stopRequested) return;
                const index = cursor++;
                if (index >= segments.length) return;
                const data = await fetchSegment(segments[index]);
                buffered.set(index, data);
                job.addBytes(data.length);
                downloaded++;
                // Paralel indiriyoruz ama dosyaya sırayla yazıyoruz.
                writing = writing.then(async () => {
                    while (buffered.has(nextToWrite)) {
                        const chunk = buffered.get(nextToWrite);
                        buffered.delete(nextToWrite);
                        await writer.push(chunk);
                        nextToWrite++;
                    }
                });
                await writing;
                report();
            }
        };

        report();
        await Promise.all(Array.from({ length: Math.min(MAX_PARALLEL, segments.length) }, worker));
        await writing;
        await writer.finish();
        const blob = await sink.close();
        if (blob) job.attachResult(blob);

        const duration = segments.slice(0, nextToWrite).reduce((sum, s) => sum + s.duration, 0);
        const parts = [hms(duration), formatSize(blob ? blob.size : job.bytes)];
        if (job.stopRequested && nextToWrite < segments.length) parts.push(`durduruldu (${nextToWrite}/${segments.length} parça)`);
        if (writer.fellBack) parts.push('TS olarak kaydedildi');
        if (ext === 'ts' && !writer.fellBack) parts.push('VLC ile açılır');
        job.done(parts.join(' · '));
    } catch (err) {
        if (!job.signal.aborted) job.controller.abort(); // diğer paralel parçalar da dursun
        await sink.abort();
        throw err;
    }
}

/* ---------------- Canlı yayın kaydı ---------------- */

/**
 * Canlı yayını "şu andan itibaren" kaydeder. `limitSec` > 0 ise o kadar süre sonra kendiliğinden
 * durur ve kaydeder; kullanıcı "Durdur ve kaydet" ile istediği an bitirebilir.
 * Sekme dondurulursa (telefonda ekran kapanınca) kaçan parçalar sayılır ve kartta gösterilir.
 */
export async function recordHlsLive({
    job, url, name, format = 'mp4', limitSec = 0, limitLabel = '', quality = '', mode = 'auto', createSinkFor
}) {
    const signal = job.signal;
    let playlist = await loadPlaylist(url, { mode, signal });
    if (playlist.type === 'master') throw new Error('Önce bir kalite seçin');
    const drm = findDrm(playlist.segments);
    if (drm) throw new Error(`Bu yayın DRM korumalı (${drm.key.method}); kaydedilemez.`);

    const isFmp4 = Boolean(playlist.map);
    const ext = extFor(format, isFmp4);
    const sink = await createSinkFor(`${name}.${ext}`, mimeFor(ext));
    const writer = await createWriter(sink, { format, isFmp4 });
    const fetchSegment = createSegmentFetcher({ mode, signal });

    job.name = finalName(sink.name || `${name}.${ext}`, writer);
    job.kind = 'rec';
    job.canStop = true;
    job.rec = { startedAt: Date.now(), endedAt: 0, limitSec, limitLabel, mediaSec: 0, missed: 0, quality, server: false };

    // Bekleme "Durdur"a basılınca hemen biter.
    let wake = null;
    job.hooks.stop = () => wake && wake();
    const wait = (ms) => new Promise((resolve) => {
        const timer = setTimeout(resolve, ms);
        wake = () => {
            clearTimeout(timer);
            resolve();
        };
        signal.addEventListener('abort', wake, { once: true });
    });

    const elapsed = () => (Date.now() - job.rec.startedAt) / 1000;
    const limitReached = () => limitSec > 0 && elapsed() >= limitSec;

    let lastSeq = null;
    let mapWritten = false;
    let failures = 0;
    let reason = '';

    try {
        for (;;) {
            if (signal.aborted) throw new DOMException('Aborted', 'AbortError');
            if (job.stopRequested) { reason = 'durduruldu'; break; }
            if (limitReached()) { reason = 'süre doldu'; break; }

            if (lastSeq !== null) {
                try {
                    playlist = await loadPlaylist(url, { mode, signal });
                    failures = 0;
                    if (job.rec.warning) {
                        job.rec.warning = false;
                        job.detail = '';
                    }
                } catch (err) {
                    if (err.name === 'AbortError') throw err;
                    failures++;
                    job.rec.warning = true;
                    job.detail = `Playlist okunamadı (${failures}/${PLAYLIST_FAILURES_LIMIT}), tekrar deneniyor...`;
                    if (failures >= PLAYLIST_FAILURES_LIMIT) {
                        reason = 'yayına ulaşılamadı';
                        break;
                    }
                    await wait(2000);
                    continue;
                }
            }

            if (playlist.map && !mapWritten) {
                const init = await fetchSegment({ url: playlist.map.url, range: playlist.map.range, key: null });
                await writer.push(init);
                job.addBytes(init.length);
                mapWritten = true;
            }

            const all = playlist.segments;
            let fresh;
            if (lastSeq === null) {
                fresh = all.slice(-1); // şu andan itibaren: en yeni parçadan başla
            } else {
                fresh = all.filter((s) => s.seq > lastSeq);
                const newest = all.length ? all[all.length - 1].seq : lastSeq;
                if (!fresh.length && newest < lastSeq - 10) {
                    fresh = all.slice(-1); // yayın sıra numarasını sıfırladı (yeniden başladı)
                } else if (fresh.length && fresh[0].seq > lastSeq + 1) {
                    job.rec.missed += fresh[0].seq - lastSeq - 1; // sekme donduysa parçalar kaydı
                }
            }

            for (const segment of fresh) {
                if (job.stopRequested || limitReached() || signal.aborted) break;
                let data;
                try {
                    data = await fetchSegment(segment);
                } catch (err) {
                    if (err.name === 'AbortError') throw err;
                    job.rec.missed++;
                    lastSeq = segment.seq;
                    continue;
                }
                await writer.push(data);
                lastSeq = segment.seq;
                job.rec.mediaSec += segment.duration;
                job.addBytes(data.length);
            }

            if (!playlist.isLive) { reason = 'yayın bitti'; break; }

            // Yeni parça çıkana kadar bekle (hedef sürenin yarısı); süre sınırını aşma.
            const target = playlist.targetDuration || 6;
            let ms = Math.min(6000, Math.max(1000, (target * 1000) / 2));
            if (limitSec > 0) ms = Math.min(ms, Math.max(250, (limitSec - elapsed()) * 1000));
            await wait(ms);
        }

        await writer.finish();
        const blob = await sink.close();
        if (blob) job.attachResult(blob);
        job.rec.endedAt = Date.now();
        const parts = [hms(job.rec.mediaSec), formatSize(blob ? blob.size : job.bytes), reason];
        if (job.rec.missed) parts.push(`${job.rec.missed} parça kaçtı`);
        if (writer.fellBack) parts.push('TS olarak kaydedildi');
        job.done(parts.filter(Boolean).join(' · '));
    } catch (err) {
        job.rec.endedAt = Date.now();
        await sink.abort();
        throw err;
    }
}

/** Kayıt/indirme için önerilen dosya adı (uzantısız). "index.m3u8" gibi genel adlarda klasör adı alınır. */
export function baseNameFor(url) {
    try {
        const parts = new URL(url).pathname.split('/').filter(Boolean).map((p) => decodeURIComponent(p));
        let name = (parts.pop() || '').replace(/\.(m3u8|mp4|ts|m4a)$/i, '');
        const generic = /^(index|master|playlist|chunklist.*|prog_index|manifest|stream|live|main|video|media.*|\d+p?)?$/i;
        while (generic.test(name) && parts.length) name = parts.pop();
        name = name.replace(/[\\/:*?"<>|]+/g, '_').trim().slice(0, 80);
        return generic.test(name) ? 'yayin' : name;
    } catch (_) {
        return 'yayin';
    }
}
