// HLS (m3u8): ayrıştırma, tamamlanmış yayını (VOD) indirme ve canlı yayını süre sınırıyla kaydetme.
//
// Çıktı her zaman tek, normal (sarılabilir) bir MP4'tür: görüntü ve ses (ayrı m3u8'de gelse bile)
// birleştirilir, zaman çizelgesi indirmenin/kaydın başladığı andan (0:00) başlar. TS parçaları
// mux.js ile yeniden kodlanmadan MP4 örneklerine çevrilir; MP4'ü mp4mux.mjs kurar.
//
// Canlı yayında playlist yalnızca son birkaç parçayı gösterir; bu yüzden canlı yayın "kayıt" olarak
// ele alınır: playlist düzenli aralıklarla okunur, yeni parçalar eklenir; kullanıcı durdurunca ya da
// süre sınırı dolunca dosya kapanır.
import { formatSize, smartFetch, fileNameFromUrl, hms, sleep, isNetworkError } from './util.js';
import { Mp4Builder, initHasVideo, tsHasVideo } from './mp4mux.mjs';
import { createAdTracker, dropAds } from './hlsads.mjs';

const MAX_PARALLEL = 4;
const SEGMENT_RETRY = 3;
const PLAYLIST_FAILURES_LIMIT = 8;
const VIDEO_CODEC = /avc1|avc3|hvc1|hev1|dvh1|dvhe|vp08|vp09|vp8|vp9|av01|mp4v/i;

/** m3u8 metnini ayrıştırır: master ise video kaliteleri + ses grupları, media ise parçalar döner. */
export function parsePlaylist(text, baseUrl) {
    const lines = text.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
    const isMaster = lines.some((l) => l.startsWith('#EXT-X-STREAM-INF'));
    const resolve = (uri) => new URL(uri, baseUrl).href;

    if (isMaster) {
        const audio = {}; // GROUP-ID → [{url, name, language, isDefault}]
        const subtitles = []; // altyazı izleri (WebVTT parça listeleri)
        for (const line of lines) {
            if (!line.startsWith('#EXT-X-MEDIA:')) continue;
            const attrs = parseAttributes(line.slice(line.indexOf(':') + 1));
            if ((attrs.TYPE || '').toUpperCase() === 'SUBTITLES' && attrs.URI) {
                const url = resolve(attrs.URI);
                if (!subtitles.some((s) => s.url === url)) {
                    subtitles.push({ url, name: attrs.NAME || '', language: attrs.LANGUAGE || '', auto: /auto|otomatik|machine/i.test(attrs.NAME || ''), hls: true });
                }
                continue;
            }
            if ((attrs.TYPE || '').toUpperCase() !== 'AUDIO') continue;
            const group = attrs['GROUP-ID'] || '';
            (audio[group] = audio[group] || []).push({
                url: attrs.URI ? resolve(attrs.URI) : null, // URI yoksa ses video parçalarının içinde
                name: attrs.NAME || '',
                language: attrs.LANGUAGE || '',
                isDefault: (attrs.DEFAULT || '').toUpperCase() === 'YES'
            });
        }

        const all = [];
        for (let i = 0; i < lines.length; i++) {
            if (!lines[i].startsWith('#EXT-X-STREAM-INF')) continue;
            const attrs = parseAttributes(lines[i].slice(lines[i].indexOf(':') + 1));
            const uriLine = lines.slice(i + 1).find((l) => !l.startsWith('#'));
            if (!uriLine) continue;
            const codecs = attrs.CODECS || '';
            const resolution = attrs.RESOLUTION || '';
            all.push({
                url: resolve(uriLine),
                bandwidth: parseInt(attrs.BANDWIDTH || attrs['AVERAGE-BANDWIDTH'] || '0', 10),
                resolution,
                height: parseInt(resolution.split('x')[1] || '0', 10),
                codecs,
                audioGroup: attrs.AUDIO || '',
                // Kodek ya da çözünürlük bilgisi videosuz diyorsa yalnızca ses kalitesidir.
                audioOnly: codecs ? !VIDEO_CODEC.test(codecs) : !resolution && all.some((v) => v.resolution)
            });
        }
        // Yalnızca ses olan "kaliteler" listelenmez; aynı çözünürlükten en yüksek bit hızı kalır.
        const video = all.filter((v) => !v.audioOnly);
        const byKey = new Map();
        for (const v of video.length ? video : all) {
            const key = v.height ? `h${v.height}` : `b${v.bandwidth}`;
            const prev = byKey.get(key);
            if (!prev || v.bandwidth > prev.bandwidth) byKey.set(key, v);
        }
        const variants = [...byKey.values()].sort((a, b) => (b.height - a.height) || (b.bandwidth - a.bandwidth));
        return { type: 'master', variants, audio, subtitles, audioOnly: video.length === 0 };
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
    const ads = createAdTracker();

    for (const line of lines) {
        ads.line(line);
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
                map,
                seq: seq + segments.length,
                ad: ads.tag()
            });
            totalDuration += duration;
            if (pendingRange) lastByteEnd = pendingRange.offset + pendingRange.length;
            pendingRange = null;
            duration = 0;
        }
    }

    // Videoya gömülü reklam parçaları çıkarılır; zaman çizelgesi reklamsız haliyle yeniden kurulur.
    const clean = dropAds(segments, { live: isLive, base: baseUrl, ranges: ads.ranges });
    const allDuration = totalDuration;
    totalDuration = 0;
    for (const s of clean.segments) {
        s.start = totalDuration;
        totalDuration += s.duration;
    }
    // allSegments: ayıklanmamış hâli (ses ayrı listeden geliyorsa ikisi senkron kalsın diye bu kullanılır).
    return { type: 'media', segments: clean.segments, allSegments: segments, allDuration, map, totalDuration, isLive, targetDuration, adCount: clean.adCount, adSeconds: clean.adSeconds };
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

/**
 * Parçalar: reklamlar ayıklanmış hâli; ses ayrı bir listeden geliyorsa ayıklanmamış hâli (ses listesinde
 * reklam işareti olmayabilir; yalnızca görüntüden reklam atılırsa ses ve görüntü kayar).
 */
export function segmentsOf(playlist, separateAudio) {
    return separateAudio && playlist.allSegments ? playlist.allSegments : playlist.segments;
}

export function findDrm(segments) {
    return segments.find((s) => s.key && s.key.method !== 'AES-128');
}

/** Playlist'i okuyup ayrıştırır. Canlı yayında önbelleğe takılmamak için her seferinde tazelenir. */
export async function loadPlaylist(url, { mode = 'auto', signal } = {}) {
    const res = await smartFetch(url, { mode, init: { signal, cache: 'no-store' } });
    return parsePlaylist(await res.text(), url);
}

/** Bir kalitenin ses izi: grubun varsayılanı (yoksa ilki). Ses video parçalarındaysa null. */
export function audioFor(master, variant) {
    const group = master.audio && variant ? master.audio[variant.audioGroup] : null;
    if (!group || !group.length) return null;
    const pick = group.find((a) => a.isDefault && a.url) || group.find((a) => a.url);
    return pick ? pick.url : null;
}

/**
 * Media playlist'te görüntü var mı? fMP4'te init segmenti, TS'de ilk parçanın PMT'si okunur.
 * true/false; anlaşılamazsa null.
 */
export async function playlistHasVideo(playlist, { mode = 'auto', signal } = {}) {
    const first = playlist.segments[0];
    if (!first) return null;
    if (/\.(aac|mp3|m4a|ac3|ec3)(\?|$)/i.test(first.url)) return false;
    try {
        if (playlist.map) {
            const res = await smartFetch(playlist.map.url, { mode, init: { signal } });
            return initHasVideo(new Uint8Array(await res.arrayBuffer()));
        }
        const res = await smartFetch(first.url, { mode, init: { signal, headers: { Range: 'bytes=0-200000' } } });
        let bytes = new Uint8Array(await res.arrayBuffer());
        if (first.key) return null; // şifreli: içerik okunamaz, oynatmaya bırak
        bytes = bytes.subarray(0, Math.floor(bytes.length / 188) * 188);
        return tsHasVideo(bytes);
    } catch (_) {
        return null;
    }
}

/* ---------------- Dönüştürme ---------------- */

let muxPromise = null;
/** TS → MP4 örnekleri dönüştürücüsünü (mux.js) ilk ihtiyaçta yükler. */
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

const sameBytes = (a, b) => a && b && a.length === b.length && a.every((x, i) => x === b[i]);

/**
 * Akışları (görüntü, ses) tek MP4'e yazan birleştirici. Her akış ya TS (mux.js ile çevrilir) ya da
 * fMP4'tür. Zaman damgaları özgün haliyle bırakılır ki ayrı gelen ses ve görüntü hizalansın;
 * mp4mux en sonda her şeyi 0'dan başlatır.
 */
async function createMuxer(sink) {
    const builder = new Mp4Builder({ write: (bytes) => sink.write(bytes) });
    await builder.start();
    const transmuxers = new Map();
    const lastInit = new Map();
    let muxjs = null;

    const addInit = (id, bytes) => {
        if (sameBytes(lastInit.get(id), bytes)) return;
        lastInit.set(id, bytes);
        builder.addInit(id, bytes);
    };

    return {
        builder,
        async push(streamId, data, { map = null } = {}) {
            if (map) {
                addInit(streamId, map);
                await builder.addFragment(streamId, data);
                return;
            }
            muxjs = muxjs || await loadMux();
            let entry = transmuxers.get(streamId);
            if (!entry) {
                const tm = new (muxjs.mp4 || muxjs).Transmuxer({ remux: false, keepOriginalTimestamps: true });
                entry = { tm, out: [] };
                tm.on('data', (segment) => entry.out.push(segment));
                transmuxers.set(streamId, entry);
            }
            entry.tm.push(data);
            entry.tm.flush();
            for (const segment of entry.out.splice(0)) {
                const id = `${streamId}-${segment.type}`;
                addInit(id, new Uint8Array(segment.initSegment));
                await builder.addFragment(id, new Uint8Array(segment.data));
            }
        },
        async finish() {
            const result = await builder.finish();
            await sink.patch(result.patch.position, result.patch.bytes);
            return result;
        }
    };
}

/* ---------------- Parça indirme ---------------- */

function createSegmentFetcher({ mode, signal, waitNet = null }) {
    const keyCache = new Map();
    const mapCache = new Map();

    async function fetchBytes(url, range) {
        const init = { signal };
        if (range) init.headers = { Range: `bytes=${range.offset}-${range.offset + range.length - 1}` };
        const res = await smartFetch(url, { mode, init });
        return new Uint8Array(await res.arrayBuffer());
    }

    async function decrypt(buffer, segment) {
        const { key } = segment;
        if (!key.uri) throw new Error('Şifreleme anahtarı adresi bulunamadı');
        if (!keyCache.has(key.uri)) {
            const raw = await fetchBytes(key.uri);
            if (raw.length !== 16) throw new Error('Geçersiz AES-128 anahtarı');
            keyCache.set(key.uri, await crypto.subtle.importKey('raw', raw, 'AES-CBC', false, ['decrypt']));
        }
        const iv = key.iv ? hexToBytes(key.iv) : ivFromSequence(segment.seq);
        const plain = await crypto.subtle.decrypt({ name: 'AES-CBC', iv }, keyCache.get(key.uri), buffer);
        return new Uint8Array(plain);
    }

    async function retry(fn) {
        let lastError;
        for (let attempt = 1; attempt <= SEGMENT_RETRY; attempt++) {
            if (signal.aborted) throw new DOMException('Aborted', 'AbortError');
            try {
                return await fn();
            } catch (err) {
                if (err.name === 'AbortError') throw err;
                lastError = err;
                // Bağlantı koptuysa deneme sayılmaz: bağlantı gelince aynı parçadan sürülür.
                if (waitNet && isNetworkError(err)) {
                    await waitNet();
                    attempt--;
                    continue;
                }
                await sleep(400 * attempt);
            }
        }
        throw new Error(`Parça indirilemedi: ${lastError ? lastError.message : 'bilinmeyen hata'}`);
    }

    /** Parçayı (gerekirse çözüp) ve fMP4 ise init segmentini döner. */
    return async function fetchSegment(segment) {
        let map = null;
        if (segment.map) {
            const mapKey = `${segment.map.url}#${segment.map.range ? segment.map.range.offset : ''}`;
            if (!mapCache.has(mapKey)) mapCache.set(mapKey, await retry(() => fetchBytes(segment.map.url, segment.map.range)));
            map = mapCache.get(mapKey);
        }
        const data = await retry(async () => {
            const bytes = await fetchBytes(segment.url, segment.range);
            return segment.key ? decrypt(bytes, segment) : bytes;
        });
        return { data, map };
    };
}

function sliceRange(segments, range, total) {
    if (!range || (!(range.start > 0) && !(range.end && range.end < total))) return segments;
    const end = range.end || Infinity;
    return segments.filter((s) => s.start + s.duration > range.start && s.start < end);
}

/* ---------------- Tamamlanmış yayın (VOD) ---------------- */

/**
 * Görüntü (ve varsa ayrı ses) playlist'ini indirip tek MP4 yazar. `range` ({start, end} sn)
 * verilirse yalnızca o aralık alınır. "Durdur ve kaydet" ile o ana kadar inen kısım kaydedilir.
 * `createSinkFor(fileName, mime)` hedefi açar (konum seçildiyse tıklamada sorulmuştur).
 */
export async function downloadHlsVod({
    job, videoUrl, videoPlaylist = null, audioUrl = null, audioPlaylist = null, name, range = null, mode = 'auto', createSinkFor
}) {
    // Kendi denetleyicisi: hata olunca paralel parçalar durur ama iş iptal sayılmaz
    // (bağlantı hata verirse aynı iş "video açılıp kaydedilerek" sürebilir).
    const local = new AbortController();
    job.signal.addEventListener('abort', () => local.abort(), { once: true });
    const signal = local.signal;
    const video = videoPlaylist || await loadPlaylist(videoUrl, { mode, signal });
    if (video.type === 'master') throw new Error('Önce bir kalite seçin');
    const audio = audioPlaylist || (audioUrl ? await loadPlaylist(audioUrl, { mode, signal }) : null);

    const streams = [{ id: 'v', playlist: video }];
    if (audio && audio.type === 'media' && audio.segments.length) streams.push({ id: 'a', playlist: audio });
    for (const s of streams) {
        const drm = findDrm(s.playlist.segments);
        if (drm) throw new Error(`Bu yayın DRM korumalı (${drm.key.method}); indirilemez.`);
    }

    // Tüm parçalar zamana göre tek sırada: indirme paralel, dosyaya yazma bu sırayla.
    const items = streams
        .flatMap((s) => sliceRange(segmentsOf(s.playlist, streams.length > 1), range, streams.length > 1 ? s.playlist.allDuration || s.playlist.totalDuration : s.playlist.totalDuration)
            .map((seg) => ({ stream: s.id, seg })))
        .sort((a, b) => (a.seg.start - b.seg.start) || (a.stream === 'v' ? -1 : 1));
    if (!items.length) throw new Error(range ? 'Seçilen aralıkta parça yok' : 'Playlist içinde parça bulunamadı');

    const sink = await createSinkFor(`${name}.mp4`, 'video/mp4');
    job.name = sink.name || `${name}.mp4`;
    job.canStop = true;
    const muxer = await createMuxer(sink);
    const fetchSegment = createSegmentFetcher({ mode, signal, waitNet: () => job.waitNetwork() });

    let downloaded = 0;
    let nextToWrite = 0;
    const buffered = new Map();
    let writing = Promise.resolve();
    const report = () => {
        job.progress(downloaded, items.length);
        job.detail = `${hms(muxer.builder.duration)} · ${formatSize(job.bytes)}`;
    };

    try {
        let cursor = 0;
        const worker = async () => {
            for (;;) {
                if (job.stopRequested) return;
                const index = cursor++;
                if (index >= items.length) return;
                const result = await fetchSegment(items[index].seg);
                buffered.set(index, result);
                job.addBytes(result.data.length);
                downloaded++;
                writing = writing.then(async () => {
                    while (buffered.has(nextToWrite)) {
                        const { data, map } = buffered.get(nextToWrite);
                        buffered.delete(nextToWrite);
                        await muxer.push(items[nextToWrite].stream, data, { map });
                        nextToWrite++;
                    }
                });
                await writing;
                report();
            }
        };
        report();
        await Promise.all(Array.from({ length: Math.min(MAX_PARALLEL, items.length) }, worker));
        await writing;

        const result = await muxer.finish();
        const blob = await sink.close();
        if (blob) job.attachResult(blob);
        if (!result.hasVideo) job.name = job.name.replace(/\.mp4$/i, '.m4a');
        const parts = [hms(result.duration), formatSize(blob ? blob.size : job.bytes)];
        if (job.stopRequested && nextToWrite < items.length) parts.push('durduruldu');
        if (streams.length > 1) parts.push('ses birleştirildi');
        job.done(parts.join(' · '));
    } catch (err) {
        local.abort(); // diğer paralel parçalar da dursun
        await sink.abort();
        throw err;
    }
}

/* ---------------- Canlı yayın kaydı ---------------- */

/**
 * Canlı yayını "şu andan itibaren" kaydeder (ayrı ses varsa o da). `limitSec` > 0 ise o kadar süre
 * sonra kendiliğinden durur ve kaydeder; "Durdur ve kaydet" ile istediğin an bitirilir.
 * Sekme dondurulursa (telefonda ekran kapanınca) kaçan parçalar sayılır ve kartta gösterilir.
 */
export async function recordHlsLive({
    job, videoUrl, audioUrl = null, name, limitSec = 0, limitLabel = '', quality = '', mode = 'auto', createSinkFor
}) {
    const signal = job.signal;
    const streams = [{ id: 'v', url: videoUrl, lastSeq: null, playlist: null }];
    if (audioUrl) streams.push({ id: 'a', url: audioUrl, lastSeq: null, playlist: null });
    for (const s of streams) {
        s.playlist = await loadPlaylist(s.url, { mode, signal });
        if (s.playlist.type === 'master') throw new Error('Önce bir kalite seçin');
        const drm = findDrm(s.playlist.segments);
        if (drm) throw new Error(`Bu yayın DRM korumalı (${drm.key.method}); kaydedilemez.`);
    }

    const sink = await createSinkFor(`${name}.mp4`, 'video/mp4');
    const muxer = await createMuxer(sink);
    const fetchSegment = createSegmentFetcher({ mode, signal });

    job.name = sink.name || `${name}.mp4`;
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

    let failures = 0;
    let reason = '';
    let first = true;

    try {
        for (;;) {
            if (signal.aborted) throw new DOMException('Aborted', 'AbortError');
            if (job.stopRequested) { reason = 'durduruldu'; break; }
            if (limitReached()) { reason = 'süre doldu'; break; }

            if (!first) {
                try {
                    for (const s of streams) s.playlist = await loadPlaylist(s.url, { mode, signal });
                    failures = 0;
                    if (job.rec.warning) {
                        job.rec.warning = false;
                        job.detail = '';
                    }
                } catch (err) {
                    if (err.name === 'AbortError') throw err;
                    // Uygulama alttayken telefon sayfayı dondurur; o sırada oluşan bağlantı hataları
                    // "yayına ulaşılamadı" sayılmaz, öne gelince kayıt sürer.
                    if (document.visibilityState === 'visible') failures++;
                    job.rec.warning = true;
                    job.detail = `Playlist okunamadı (${failures}/${PLAYLIST_FAILURES_LIMIT}), tekrar deneniyor...`;
                    if (failures >= PLAYLIST_FAILURES_LIMIT) { reason = 'yayına ulaşılamadı'; break; }
                    await wait(2000);
                    continue;
                }
            }
            first = false;

            let ended = false;
            for (const s of streams) {
                const all = segmentsOf(s.playlist, streams.length > 1);
                let fresh;
                if (s.lastSeq === null) {
                    fresh = all.slice(-1); // şu andan itibaren: en yeni parçadan başla
                } else {
                    fresh = all.filter((seg) => seg.seq > s.lastSeq);
                    const newest = all.length ? all[all.length - 1].seq : s.lastSeq;
                    if (!fresh.length && newest < s.lastSeq - 10) {
                        fresh = all.slice(-1); // yayın sıra numarasını sıfırladı
                    } else if (fresh.length && fresh[0].seq - (fresh[0].adsBefore || 0) > s.lastSeq + 1 && s.id === 'v') {
                        // sekme donduysa parçalar kaçtı (atlanan reklamlar sayılmaz)
                        job.rec.missed += fresh[0].seq - (fresh[0].adsBefore || 0) - s.lastSeq - 1;
                    }
                }
                for (const segment of fresh) {
                    if (job.stopRequested || limitReached() || signal.aborted) break;
                    let result;
                    try {
                        result = await fetchSegment(segment);
                    } catch (err) {
                        if (err.name === 'AbortError') throw err;
                        if (s.id === 'v') job.rec.missed++;
                        s.lastSeq = segment.seq;
                        continue;
                    }
                    await muxer.push(s.id, result.data, { map: result.map });
                    s.lastSeq = segment.seq;
                    job.addBytes(result.data.length);
                }
                if (!s.playlist.isLive) ended = true;
            }
            job.rec.mediaSec = muxer.builder.duration;

            if (ended) { reason = 'yayın bitti'; break; }

            // Yeni parça çıkana kadar bekle (hedef sürenin yarısı); süre sınırını aşma.
            const target = streams[0].playlist.targetDuration || 6;
            let ms = Math.min(6000, Math.max(1000, (target * 1000) / 2));
            if (limitSec > 0) ms = Math.min(ms, Math.max(250, (limitSec - elapsed()) * 1000));
            await wait(ms);
        }

        if (!muxer.builder.hasSamples) throw new Error('Yayından veri alınamadı');
        const result = await muxer.finish();
        const blob = await sink.close();
        if (blob) job.attachResult(blob);
        job.rec.endedAt = Date.now();
        job.rec.mediaSec = result.duration;
        if (!result.hasVideo) job.name = job.name.replace(/\.mp4$/i, '.m4a');
        const parts = [hms(result.duration), formatSize(blob ? blob.size : job.bytes), reason];
        if (job.rec.missed) parts.push(`${job.rec.missed} parça kaçtı`);
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

export { fileNameFromUrl };
