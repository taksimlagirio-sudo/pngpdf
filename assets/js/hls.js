// HLS (m3u8) ayrıştırma ve indirme — hem "HLS" sekmesi hem algılama sekmesi kullanır.
import {
    $, formatSize, isHttpUrl, smartFetch, fileNameFromUrl,
    createProgress, escapeHtml, formatSpeed
} from './util.js';
import { createJob, createSink, startBackgroundDownload, canBackgroundFetch } from './downloads.js';

const MAX_PARALLEL = 4;
const SEGMENT_RETRY = 3;
const MAX_BG_SEGMENTS = 400;

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
    const isLive = !lines.includes('#EXT-X-ENDLIST');

    for (const line of lines) {
        if (line.startsWith('#EXT-X-MEDIA-SEQUENCE')) {
            seq = parseInt(line.split(':')[1], 10) || 0;
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

    return { type: 'media', segments, map, totalDuration, isLive };
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

/** Playlist'i (master ise verilen varyantı) indirir. */
export async function downloadHls({
    url, name, mode = 'auto', toDisk = false, background = false,
    onStage = () => {}, onProgress = () => {}
}) {
    if (!isHttpUrl(url)) throw new Error('Geçerli bir .m3u8 adresi girin.');

    onStage('Playlist okunuyor...');
    const controller = new AbortController();
    const listRes = await smartFetch(url, {
        mode,
        init: { signal: controller.signal },
        onFallback: () => onStage('Doğrudan erişilemedi (CORS), proxy deneniyor...')
    });
    const playlist = parsePlaylist(await listRes.text(), url);

    if (playlist.type === 'master') {
        return { type: 'master', variants: playlist.variants };
    }

    const { segments, map } = playlist;
    if (segments.length === 0) throw new Error('Playlist içinde parça bulunamadı');

    const drm = segments.find((s) => s.key && s.key.method !== 'AES-128');
    if (drm) {
        throw new Error(`Bu yayın DRM korumalı (${drm.key.method}). DRM korumalı içerikler indirilemez.`);
    }

    const encrypted = segments.some((s) => s.key);
    const isFmp4 = Boolean(map);
    const ext = isFmp4 ? 'mp4' : 'ts';
    const mime = isFmp4 ? 'video/mp4' : 'video/mp2t';
    const base = name || fileNameFromUrl(url, ext);
    const fileName = base.endsWith('.' + ext) ? base : `${base}.${ext}`;

    // Şifresiz ve makul uzunluktaki yayınlar service worker'a devredilebilir:
    // parçalar sırasıyla indirilir, birleştirme kullanıcı döndüğünde yapılır.
    if (background && canBackgroundFetch && !toDisk && !encrypted && !playlist.isLive
        && segments.length <= MAX_BG_SEGMENTS) {
        const urls = (map ? [map.url] : []).concat(segments.map((s) => s.url));
        const job = await startBackgroundDownload({ urls, name: fileName });
        if (job) {
            onStage('Arka planda indiriliyor — uygulamayı kapatabilirsiniz.');
            return { type: 'background', fileName };
        }
    }

    const sink = await createSink(fileName, { toDisk, mime });
    const job = createJob(fileName, { onCancel: () => controller.abort() });
    const keyCache = new Map();
    const started = Date.now();

    let downloaded = 0;
    let bytes = 0;
    let nextToWrite = 0;
    const buffered = new Map();

    const report = () => {
        job.progress(downloaded, segments.length);
        job.setDetail(`${downloaded}/${segments.length} parça • ${formatSize(bytes)}`);
        onProgress(downloaded, segments.length, bytes, formatSpeed(bytes, started));
    };

    try {
        if (playlist.isLive) onStage('Canlı yayın: playlist anındaki parçalar indiriliyor.');

        if (map) {
            const initPart = await fetchSegment({ url: map.url, range: map.range, key: null });
            await sink.write(initPart);
            bytes += initPart.length;
        }

        let cursor = 0;
        const worker = async () => {
            for (;;) {
                const index = cursor++;
                if (index >= segments.length) return;
                const data = await fetchSegment(segments[index]);
                bytes += data.length;
                buffered.set(index, data);

                // Paralel indiriyoruz ama dosyaya sırayla yazıyoruz.
                while (buffered.has(nextToWrite)) {
                    const chunk = buffered.get(nextToWrite);
                    buffered.delete(nextToWrite);
                    await sink.write(chunk);
                    nextToWrite++;
                }

                downloaded++;
                report();
            }
        };

        await Promise.all(Array.from({ length: Math.min(MAX_PARALLEL, segments.length) }, worker));
        await sink.close();

        job.done(`${segments.length} parça • ${formatSize(bytes)}`);
        return {
            type: 'done',
            fileName: sink.name || fileName,
            segments: segments.length,
            bytes,
            container: ext,
            sinkMode: sink.mode
        };
    } catch (err) {
        await sink.abort();
        if (err.name === 'AbortError') job.cancel(); else job.fail(err.message);
        throw err;
    }

    async function fetchSegment(segment) {
        let lastError;
        for (let attempt = 1; attempt <= SEGMENT_RETRY; attempt++) {
            if (controller.signal.aborted) throw new DOMException('Aborted', 'AbortError');
            try {
                const init = { signal: controller.signal };
                if (segment.range) {
                    init.headers = {
                        Range: `bytes=${segment.range.offset}-${segment.range.offset + segment.range.length - 1}`
                    };
                }
                const res = await smartFetch(segment.url, { mode, init });
                const buffer = new Uint8Array(await res.arrayBuffer());
                return segment.key ? decryptSegment(buffer, segment) : buffer;
            } catch (err) {
                if (err.name === 'AbortError') throw err;
                lastError = err;
                await new Promise((r) => setTimeout(r, 400 * attempt));
            }
        }
        throw new Error(`Parça indirilemedi: ${lastError ? lastError.message : 'bilinmeyen hata'}`);
    }

    async function decryptSegment(buffer, segment) {
        const { key } = segment;
        if (!key.uri) throw new Error('Şifreleme anahtarı adresi bulunamadı');

        if (!keyCache.has(key.uri)) {
            const res = await smartFetch(key.uri, { mode, init: { signal: controller.signal } });
            const raw = new Uint8Array(await res.arrayBuffer());
            if (raw.length !== 16) throw new Error('Geçersiz AES-128 anahtarı');
            keyCache.set(key.uri, await crypto.subtle.importKey('raw', raw, 'AES-CBC', false, ['decrypt']));
        }

        const iv = key.iv ? hexToBytes(key.iv) : ivFromSequence(segment.seq);
        const plain = await crypto.subtle.decrypt({ name: 'AES-CBC', iv }, keyCache.get(key.uri), buffer);
        return new Uint8Array(plain);
    }
}

export function initHlsTab() {
    const urlInput = $('hlsUrl');
    const nameInput = $('hlsName');
    const modeSelect = $('hlsMode');
    const diskCheck = $('hlsToDisk');
    const bgCheck = $('hlsBackground');
    const loadBtn = $('hlsLoadBtn');
    const variantBox = $('hlsVariants');
    const progress = createProgress('hlsProgress');

    loadBtn.addEventListener('click', () => run(urlInput.value.trim()));
    urlInput.addEventListener('keydown', (e) => {
        if (e.key === 'Enter') run(urlInput.value.trim());
    });
    variantBox.addEventListener('click', (e) => {
        const btn = e.target.closest('button[data-url]');
        if (btn) run(btn.dataset.url);
    });

    async function run(url) {
        if (!isHttpUrl(url)) {
            progress.show('HLS');
            progress.setDetail('Geçerli bir .m3u8 adresi girin.', true);
            return;
        }

        loadBtn.disabled = true;
        variantBox.innerHTML = '';
        progress.show('Playlist okunuyor...');
        progress.set(null);

        try {
            const result = await downloadHls({
                url,
                name: nameInput.value.trim() || undefined,
                mode: modeSelect.value,
                toDisk: diskCheck.checked,
                background: bgCheck.checked,
                onStage: (text) => progress.setDetail(text),
                onProgress: (done, total, bytes, speed) => {
                    progress.setTitle(`Parçalar indiriliyor (${done}/${total})`);
                    progress.set(done / total);
                    progress.setDetail(`${formatSize(bytes)} • ${speed}`);
                }
            });

            if (result.type === 'master') {
                progress.setTitle('Kalite seçin');
                progress.set(1);
                progress.setDetail(`${result.variants.length} farklı kalite bulundu.`);
                variantBox.innerHTML = result.variants.map((v) => {
                    const label = v.resolution || 'bilinmeyen çözünürlük';
                    const mbps = v.bandwidth ? (v.bandwidth / 1000000).toFixed(2) + ' Mbps' : '';
                    return `<button class="variant" data-url="${escapeHtml(v.url)}">
                        <span><strong>${escapeHtml(label)}</strong>${mbps ? ' • ' + mbps : ''}</span>
                        <span>⬇️</span>
                    </button>`;
                }).join('');
            } else if (result.type === 'background') {
                progress.setTitle('📥 Arka planda');
                progress.set(1);
                progress.setDetail('Parçalar arka planda iniyor; bitince alt çubuktan kaydedin.');
            } else {
                progress.setTitle('✅ Tamamlandı');
                progress.set(1);
                progress.setDetail(
                    `${result.segments} parça • ${formatSize(result.bytes)}` +
                    (result.container === 'ts' ? ' • .ts dosyası VLC ve çoğu oynatıcıda açılır' : '') +
                    (result.sinkMode === 'disk' ? ' • diske yazıldı' : '')
                );
            }
        } catch (err) {
            if (err.name === 'AbortError') {
                progress.setTitle('İptal edildi');
                progress.setDetail('İndirme durduruldu.');
            } else {
                console.error(err);
                progress.setTitle('❌ Başarısız');
                progress.set(0);
                progress.setDetail(err.message || 'Bilinmeyen hata', true);
            }
        } finally {
            loadBtn.disabled = false;
        }
    }
}
