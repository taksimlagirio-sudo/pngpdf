// Sekme 4: HLS (m3u8) indirici — parçaları indirip tek dosyada birleştirir.
import {
    $, formatSize, isHttpUrl, smartFetch, saveBlob, fileNameFromUrl,
    createProgress, escapeHtml
} from './util.js';

const MAX_PARALLEL = 4;
const SEGMENT_RETRY = 3;

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
    let isLive = !lines.includes('#EXT-X-ENDLIST');

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
            const url = resolve(line);
            segments.push({
                url,
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
    const view = new DataView(iv.buffer);
    view.setUint32(12, seq >>> 0);
    return iv;
}

export function initHlsTab() {
    const urlInput = $('hlsUrl');
    const nameInput = $('hlsName');
    const modeSelect = $('hlsMode');
    const loadBtn = $('hlsLoadBtn');
    const cancelBtn = $('hlsCancelBtn');
    const variantBox = $('hlsVariants');
    const progress = createProgress('hlsProgress');

    let controller = null;
    const keyCache = new Map();

    loadBtn.addEventListener('click', () => load());
    urlInput.addEventListener('keydown', (e) => {
        if (e.key === 'Enter') load();
    });
    cancelBtn.addEventListener('click', () => {
        if (controller) controller.abort();
    });

    variantBox.addEventListener('click', (e) => {
        const btn = e.target.closest('button[data-url]');
        if (btn) downloadMedia(btn.dataset.url);
    });

    async function fetchText(url) {
        const res = await smartFetch(url, {
            mode: modeSelect.value,
            init: { signal: controller.signal },
            onFallback: () => progress.setDetail('Doğrudan erişilemedi (CORS), proxy deneniyor...')
        });
        return res.text();
    }

    async function load() {
        const url = urlInput.value.trim();
        if (!isHttpUrl(url)) {
            progress.show('HLS');
            progress.setDetail('Geçerli bir .m3u8 adresi girin.', true);
            return;
        }

        controller = new AbortController();
        setBusy(true);
        variantBox.innerHTML = '';
        progress.show('Playlist okunuyor...');
        progress.set(null);

        try {
            const text = await fetchText(url);
            if (!text.includes('#EXTM3U')) {
                throw new Error('Bu adres bir m3u8 playlist gibi görünmüyor');
            }

            const playlist = parsePlaylist(text, url);

            if (playlist.type === 'master') {
                progress.setTitle('Kalite seçin');
                progress.set(1);
                progress.setDetail(`${playlist.variants.length} farklı kalite bulundu.`);
                variantBox.innerHTML = playlist.variants.map((v) => {
                    const label = v.resolution || 'bilinmeyen çözünürlük';
                    const mbps = v.bandwidth ? (v.bandwidth / 1000000).toFixed(2) + ' Mbps' : '';
                    return `<button class="variant" data-url="${escapeHtml(v.url)}">
                        <span><strong>${escapeHtml(label)}</strong>${mbps ? ' • ' + mbps : ''}</span>
                        <span>⬇️</span>
                    </button>`;
                }).join('');
                setBusy(false);
                return;
            }

            await runDownload(playlist, url);
        } catch (err) {
            reportError(err);
            setBusy(false);
        }
    }

    async function downloadMedia(mediaUrl) {
        controller = new AbortController();
        setBusy(true);
        variantBox.innerHTML = '';
        progress.show('Playlist okunuyor...');
        progress.set(null);

        try {
            const text = await fetchText(mediaUrl);
            const playlist = parsePlaylist(text, mediaUrl);
            if (playlist.type !== 'media') throw new Error('Seçilen adres parça listesi içermiyor');
            await runDownload(playlist, mediaUrl);
        } catch (err) {
            reportError(err);
            setBusy(false);
        }
    }

    async function runDownload(playlist, sourceUrl) {
        const { segments, map } = playlist;
        if (segments.length === 0) throw new Error('Playlist içinde parça bulunamadı');

        const drmSegment = segments.find((s) => s.key && s.key.method !== 'AES-128');
        if (drmSegment) {
            throw new Error(
                `Bu yayın DRM korumalı (${drmSegment.key.method}). DRM korumalı içerikler indirilemez.`
            );
        }

        if (playlist.isLive) {
            progress.setDetail('Canlı yayın algılandı: playlist anındaki parçalar indirilecek.');
        }

        const parts = new Array(segments.length);
        let done = 0;
        let bytes = 0;
        const started = Date.now();

        progress.setTitle(`Parçalar indiriliyor (0/${segments.length})`);
        progress.set(0);

        const initPart = map ? await fetchSegment({ url: map.url, range: map.range, key: null }) : null;
        if (initPart) bytes += initPart.length;

        let cursor = 0;
        const worker = async () => {
            for (;;) {
                const index = cursor++;
                if (index >= segments.length) return;
                const data = await fetchSegment(segments[index]);
                parts[index] = data;
                bytes += data.length;
                done++;

                const seconds = (Date.now() - started) / 1000;
                const speed = seconds > 0 ? formatSize(bytes / seconds) + '/sn' : '';
                progress.setTitle(`Parçalar indiriliyor (${done}/${segments.length})`);
                progress.set(done / segments.length);
                progress.setDetail(`${formatSize(bytes)} • ${speed}`);
            }
        };

        await Promise.all(
            Array.from({ length: Math.min(MAX_PARALLEL, segments.length) }, worker)
        );

        const isFmp4 = Boolean(map);
        const ext = isFmp4 ? 'mp4' : 'ts';
        const mime = isFmp4 ? 'video/mp4' : 'video/mp2t';
        const blobParts = initPart ? [initPart, ...parts] : parts;

        const name = nameInput.value.trim() || fileNameFromUrl(sourceUrl, ext);
        saveBlob(new Blob(blobParts, { type: mime }), name.endsWith('.' + ext) ? name : `${name}.${ext}`);

        progress.setTitle('✅ Tamamlandı');
        progress.set(1);
        progress.setDetail(
            `${segments.length} parça • ${formatSize(bytes)}` +
            (isFmp4 ? '' : ' • .ts dosyası VLC ve çoğu oynatıcıda açılır')
        );
        setBusy(false);
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
                const res = await smartFetch(segment.url, { mode: modeSelect.value, init });
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
            const res = await smartFetch(key.uri, {
                mode: modeSelect.value,
                init: { signal: controller.signal }
            });
            const raw = new Uint8Array(await res.arrayBuffer());
            if (raw.length !== 16) throw new Error('Geçersiz AES-128 anahtarı');
            keyCache.set(key.uri, await crypto.subtle.importKey('raw', raw, 'AES-CBC', false, ['decrypt']));
        }

        const iv = key.iv ? hexToBytes(key.iv) : ivFromSequence(segment.seq);
        const plain = await crypto.subtle.decrypt({ name: 'AES-CBC', iv }, keyCache.get(key.uri), buffer);
        return new Uint8Array(plain);
    }

    function reportError(err) {
        if (err.name === 'AbortError') {
            progress.setTitle('İptal edildi');
            progress.setDetail('İndirme durduruldu.');
            return;
        }
        console.error(err);
        progress.setTitle('❌ Başarısız');
        progress.set(0);
        progress.setDetail(err.message || 'Bilinmeyen hata', true);
    }

    function setBusy(busy) {
        loadBtn.disabled = busy;
        cancelBtn.style.display = busy ? 'flex' : 'none';
        if (!busy) controller = null;
    }

    setBusy(false);
}
