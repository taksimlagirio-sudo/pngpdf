// Bir adresin arkasında ne olduğunu anlar: tür, format, boyut, çözünürlük/süre.
import { smartFetch, formatSize, fileNameFromUrl, proxyUrl } from './util.js';
import { parsePlaylist } from './hls.js';

const SNIFF_BYTES = 65536;

const text = (bytes, start, length) =>
    String.fromCharCode(...bytes.slice(start, start + length));

/** Baştaki baytlardan (magic number) formatı çıkarır. */
export function sniffFormat(bytes) {
    const b = bytes;
    if (b.length >= 8 && b[0] === 0x89 && text(b, 1, 3) === 'PNG') return { kind: 'image', format: 'png', mime: 'image/png', ext: 'png' };
    if (b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) return { kind: 'image', format: 'jpeg', mime: 'image/jpeg', ext: 'jpg' };
    if (text(b, 0, 4) === 'GIF8') return { kind: 'image', format: 'gif', mime: 'image/gif', ext: 'gif' };
    if (text(b, 0, 4) === 'RIFF' && text(b, 8, 4) === 'WEBP') return { kind: 'image', format: 'webp', mime: 'image/webp', ext: 'webp' };
    if (text(b, 0, 4) === 'RIFF' && text(b, 8, 4) === 'WAVE') return { kind: 'audio', format: 'wav', mime: 'audio/wav', ext: 'wav' };
    if (b[0] === 0x00 && text(b, 4, 4) === 'ftyp') {
        const brand = text(b, 8, 4).trim();
        if (brand === 'qt') return { kind: 'video', format: 'mov', mime: 'video/quicktime', ext: 'mov' };
        if (brand === 'M4A') return { kind: 'audio', format: 'm4a', mime: 'audio/mp4', ext: 'm4a' };
        return { kind: 'video', format: 'mp4', mime: 'video/mp4', ext: 'mp4' };
    }
    if (b[0] === 0x1a && b[1] === 0x45 && b[2] === 0xdf && b[3] === 0xa3) return { kind: 'video', format: 'webm/mkv', mime: 'video/webm', ext: 'webm' };
    if (text(b, 0, 3) === 'ID3' || (b[0] === 0xff && (b[1] & 0xe0) === 0xe0)) return { kind: 'audio', format: 'mp3', mime: 'audio/mpeg', ext: 'mp3' };
    if (text(b, 0, 4) === 'OggS') return { kind: 'audio', format: 'ogg', mime: 'audio/ogg', ext: 'ogg' };
    if (text(b, 0, 4) === 'fLaC') return { kind: 'audio', format: 'flac', mime: 'audio/flac', ext: 'flac' };
    if (text(b, 0, 4) === '%PDF') return { kind: 'document', format: 'pdf', mime: 'application/pdf', ext: 'pdf' };
    if (b[0] === 0x47 && b[188] === 0x47) return { kind: 'video', format: 'mpeg-ts', mime: 'video/mp2t', ext: 'ts' };
    if (b[0] === 0x50 && b[1] === 0x4b && b[2] === 0x03 && b[3] === 0x04) return { kind: 'archive', format: 'zip', mime: 'application/zip', ext: 'zip' };

    const head = text(b, 0, Math.min(b.length, 1024)).trim();
    if (head.startsWith('#EXTM3U')) return { kind: 'hls', format: 'm3u8', mime: 'application/vnd.apple.mpegurl', ext: 'm3u8' };
    if (/^<(!doctype html|html|\?xml)/i.test(head)) return { kind: 'page', format: 'html', mime: 'text/html', ext: 'html' };
    if (head.startsWith('<MPD') || head.includes('<MPD ')) return { kind: 'dash', format: 'mpd', mime: 'application/dash+xml', ext: 'mpd' };
    return null;
}

const MEDIA_EXT = 'm3u8|mpd|mp4|m4v|webm|mov|mkv|mp3|m4a|aac|ogg|wav|flac';

const EMBED_HOSTS = [
    { test: /youtube\.com|youtu\.be/i, name: 'YouTube' },
    { test: /vimeo\.com/i, name: 'Vimeo' },
    { test: /dailymotion\.com/i, name: 'Dailymotion' }
];

function kindForUrl(url) {
    if (/\.m3u8(\?|$)/i.test(url)) return 'hls';
    if (/\.mpd(\?|$)/i.test(url)) return 'dash';
    if (/\.(mp3|m4a|aac|ogg|wav|flac)(\?|$)/i.test(url)) return 'audio';
    return 'video';
}

const RANK = { hls: 0, video: 1, dash: 2, audio: 3 };

/**
 * Sayfa kaynağındaki medya adreslerini toplar.
 * Kaçışlı (\/ ve \u002F) JSON adresleri, meta etiketleri ve oynatıcı yapılandırmaları da taranır.
 */
export function findMediaLinks(html, baseUrl, { limit = 20 } = {}) {
    // JSON içine gömülü adresler kaçışlı yazılır; taramadan önce düzleştiriyoruz.
    const flat = html
        .replace(/\\u002[fF]/g, '/')
        .replace(/\\\//g, '/')
        .replace(/&amp;/g, '&');

    const found = new Map();
    const add = (raw) => {
        if (!raw || found.size >= limit) return;
        const cleaned = raw.trim().replace(/\\+$/, '').replace(/["'\s]+$/, '');
        if (!cleaned || cleaned.startsWith('data:') || cleaned.startsWith('blob:')) return;
        // Düzleştirmeden sonra kalan ters bölü bozuk adres demektir ("/\..." host sanılıyor).
        if (cleaned.includes('\\')) return;
        try {
            const url = new URL(cleaned, baseUrl).href;
            if (!/^https?:/.test(url)) return;
            if (!found.has(url)) found.set(url, kindForUrl(url));
        } catch (_) { /* bozuk adres */ }
    };

    const patterns = [
        // Düz metin/JSON içindeki tam adresler
        new RegExp(`https?://[^"'\\s<>\\\\)]+?\\.(?:${MEDIA_EXT})(?:\\?[^"'\\s<>\\\\)]*)?`, 'gi'),
        // src / href / content / data-* nitelikleri (göreli adresler dahil)
        new RegExp(`(?:src|href|content|data-src|data-video|data-url|data-file)=["']([^"']+?\\.(?:${MEDIA_EXT})(?:\\?[^"']*)?)["']`, 'gi'),
        // Oynatıcı yapılandırmalarındaki anahtarlar: "file": "...", "url": "...", hlsUrl, playbackUrl
        // JS/JSON anahtarları tırnaklı da olabilir tırnaksız da: {file:"..."} / {"file":"..."}
        new RegExp(`["']?(?:file|url|src|source|hlsUrl|hls|playbackUrl|contentUrl|videoUrl|streamUrl|manifestUrl|mediaUrl)["']?\\s*:\\s*["']([^"']+?\\.(?:${MEDIA_EXT})(?:\\?[^"']*)?)["']`, 'gi')
    ];

    for (const pattern of patterns) {
        let match;
        while ((match = pattern.exec(flat)) !== null && found.size < limit) {
            add(match[1] || match[0]);
        }
    }

    return [...found]
        .map(([url, kind]) => ({ url, kind }))
        .sort((a, b) => RANK[a.kind] - RANK[b.kind]);
}

/** Sayfadaki <iframe> gömülülerini (oynatıcı sayfaları) toplar. */
export function findEmbeds(html, baseUrl) {
    const embeds = [];
    const re = /<iframe[^>]+src=["']([^"']+)["']/gi;
    let match;
    while ((match = re.exec(html)) !== null && embeds.length < 6) {
        try {
            const url = new URL(match[1], baseUrl).href;
            if (/^https?:/.test(url)) {
                const known = EMBED_HOSTS.find((h) => h.test.test(url));
                embeds.push({ url, host: known ? known.name : new URL(url).hostname });
            }
        } catch (_) { /* bozuk adres */ }
    }
    return embeds;
}

/**
 * Adresi analiz eder. Küçük bir parça indirip başlıklar + magic number ile karar verir.
 * HLS ise playlist ayrıştırılır, resim/video ise boyut ve süre okunmaya çalışılır.
 */
export async function analyzeUrl(url, { mode = 'auto', signal, onStage = () => {} } = {}) {
    onStage('Bağlanılıyor...');

    let access = 'direct';
    const res = await smartFetch(url, {
        mode,
        init: { signal, headers: { Range: `bytes=0-${SNIFF_BYTES - 1}` } },
        onFallback: () => onStage('Doğrudan erişilemedi (CORS), proxy deneniyor...'),
        onAccess: (which) => { access = which; }
    });

    const headerType = (res.headers.get('content-type') || '').split(';')[0].trim().toLowerCase();
    const contentRange = res.headers.get('content-range');
    const totalSize = contentRange
        ? Number(contentRange.split('/')[1]) || 0
        : Number(res.headers.get('content-length')) || 0;
    const partial = res.status === 206;
    const disposition = res.headers.get('content-disposition') || '';
    const dispositionName = (disposition.match(/filename\*?=(?:UTF-8'')?"?([^";]+)"?/i) || [])[1];

    onStage('İçerik inceleniyor...');
    const head = new Uint8Array(await res.arrayBuffer());
    const sniffed = sniffFormat(head);
    const byHeader = fromMimeType(headerType);
    const info = sniffed || byHeader || fromExtension(url) ||
        { kind: 'unknown', format: headerType || 'bilinmiyor', mime: headerType || 'application/octet-stream', ext: 'bin' };

    const result = {
        url,
        kind: info.kind,
        format: info.format,
        mime: info.mime,
        ext: info.ext,
        size: totalSize,
        sizeText: totalSize ? formatSize(totalSize) : 'bilinmiyor',
        resumable: partial || (res.headers.get('accept-ranges') || '').includes('bytes'),
        headerType,
        suggestedName: (dispositionName && dispositionName.trim()) || fileNameFromUrl(url, info.ext),
        access,
        downloadable: true,
        target: 'file',
        warnings: [],
        details: {}
    };

    if (info.kind === 'hls') {
        onStage('Playlist ayrıştırılıyor...');
        await describeHls(result, url, mode, signal);
    } else if (info.kind === 'page') {
        result.downloadable = false;
        result.target = 'page';
        onStage('Sayfadaki medya aranıyor...');
        await scanPage(result, url, mode, signal, onStage);
    } else if (info.kind === 'dash') {
        result.downloadable = false;
        result.warnings.push('DASH (.mpd) yayınları bu araçta desteklenmiyor; HLS (.m3u8) adresi varsa onu kullanın.');
    } else if (info.kind === 'image') {
        onStage('Resim okunuyor...');
        await describeImage(result, url, mode, signal);
    } else if (info.kind === 'video' || info.kind === 'audio') {
        onStage('Önizleme karesi alınıyor...');
        await describeMedia(result, url, mode);
    }

    return result;
}

/** Sayfayı (ve gerekirse script dosyalarını) tarayıp medya adreslerini bulur. */
async function scanPage(result, url, mode, signal, onStage) {
    const res = await smartFetch(url, { mode, init: { signal } });
    const html = await res.text();

    const title = (html.match(/<title[^>]*>([^<]{0,160})/i) || [])[1];
    if (title) result.details.title = title.trim();

    let links = findMediaLinks(html, url);
    const embeds = findEmbeds(html, url);

    // Sayfada bulunamadıysa sayfanın yüklediği script dosyalarına bak.
    if (links.length === 0) {
        onStage('Sayfanın script dosyaları taranıyor...');
        links = await scanScripts(html, url, mode, signal);
        if (links.length) result.details.fromScripts = true;
    }

    result.details.links = links;
    result.details.embeds = embeds;

    if (links.length === 0) {
        const known = embeds.find((e) => ['YouTube', 'Vimeo', 'Dailymotion'].includes(e.host));
        result.warnings.push(known
            ? `Sayfada ${known.host} oynatıcısı var; bu platformlar doğrudan dosya adresi vermez.`
            : 'Sayfa kaynağında medya adresi bulunamadı. Medya büyük ihtimalle oynatma sırasında ' +
              'JavaScript ile yükleniyor: videoyu başlatıp tarayıcının geliştirici araçlarındaki Ağ ' +
              'sekmesinden .m3u8 veya .mp4 adresini kopyalayıp buraya yapıştırın.');
    }
}

const MAX_SCRIPTS = 4;
const MAX_SCRIPT_BYTES = 2 * 1024 * 1024;

async function scanScripts(html, baseUrl, mode, signal) {
    const sources = [];
    const re = /<script[^>]+src=["']([^"']+)["']/gi;
    let match;
    while ((match = re.exec(html)) !== null && sources.length < MAX_SCRIPTS) {
        try {
            sources.push(new URL(match[1], baseUrl).href);
        } catch (_) { /* bozuk adres */ }
    }

    const results = await Promise.all(sources.map(async (src) => {
        try {
            const res = await smartFetch(src, { mode, init: { signal } });
            const size = Number(res.headers.get('content-length')) || 0;
            if (size > MAX_SCRIPT_BYTES) return [];
            const text = await res.text();
            return findMediaLinks(text, baseUrl, { limit: 10 });
        } catch (_) {
            return [];
        }
    }));

    const merged = new Map();
    results.flat().forEach((item) => merged.set(item.url, item));
    return [...merged.values()];
}

function fromMimeType(type) {
    if (!type) return null;
    const map = {
        'application/vnd.apple.mpegurl': { kind: 'hls', format: 'm3u8', mime: type, ext: 'm3u8' },
        'application/x-mpegurl': { kind: 'hls', format: 'm3u8', mime: type, ext: 'm3u8' },
        'audio/mpegurl': { kind: 'hls', format: 'm3u8', mime: type, ext: 'm3u8' },
        'application/dash+xml': { kind: 'dash', format: 'mpd', mime: type, ext: 'mpd' },
        'text/html': { kind: 'page', format: 'html', mime: type, ext: 'html' }
    };
    if (map[type]) return map[type];

    const [group, sub] = type.split('/');
    if (['image', 'video', 'audio'].includes(group)) {
        return { kind: group, format: sub, mime: type, ext: sub === 'jpeg' ? 'jpg' : (sub || 'bin').split('+')[0] };
    }
    return null;
}

function fromExtension(url) {
    const ext = (url.split('?')[0].split('#')[0].match(/\.([a-z0-9]{2,5})$/i) || [])[1];
    if (!ext) return null;
    const table = {
        m3u8: { kind: 'hls', format: 'm3u8', mime: 'application/vnd.apple.mpegurl' },
        mp4: { kind: 'video', format: 'mp4', mime: 'video/mp4' },
        webm: { kind: 'video', format: 'webm', mime: 'video/webm' },
        mov: { kind: 'video', format: 'mov', mime: 'video/quicktime' },
        ts: { kind: 'video', format: 'mpeg-ts', mime: 'video/mp2t' },
        mp3: { kind: 'audio', format: 'mp3', mime: 'audio/mpeg' },
        jpg: { kind: 'image', format: 'jpeg', mime: 'image/jpeg' },
        jpeg: { kind: 'image', format: 'jpeg', mime: 'image/jpeg' },
        png: { kind: 'image', format: 'png', mime: 'image/png' },
        webp: { kind: 'image', format: 'webp', mime: 'image/webp' },
        pdf: { kind: 'document', format: 'pdf', mime: 'application/pdf' }
    };
    const hit = table[ext.toLowerCase()];
    return hit ? { ...hit, ext: ext.toLowerCase() } : null;
}

async function describeHls(result, url, mode, signal) {
    const res = await smartFetch(url, { mode, init: { signal } });
    const playlist = parsePlaylist(await res.text(), url);
    result.target = 'hls';

    if (playlist.type === 'master') {
        result.details.variants = playlist.variants;
        result.details.summary = `${playlist.variants.length} kalite seçeneği`;
        result.suggestedName = fileNameFromUrl(url, 'mp4').replace(/\.mp4$/, '');
        return;
    }

    const encrypted = playlist.segments.find((s) => s.key);
    const drm = playlist.segments.find((s) => s.key && s.key.method !== 'AES-128');

    result.details.segments = playlist.segments.length;
    result.details.duration = playlist.totalDuration;
    result.details.live = playlist.isLive;
    result.details.container = playlist.map ? 'fMP4 (.mp4)' : 'MPEG-TS (.ts)';
    result.details.encryption = drm ? drm.key.method : encrypted ? 'AES-128 (çözülebilir)' : 'yok';
    result.ext = playlist.map ? 'mp4' : 'ts';
    result.suggestedName = fileNameFromUrl(url, result.ext);
    result.details.summary = `${playlist.segments.length} parça • ${formatDuration(playlist.totalDuration)}`;

    if (drm) {
        result.downloadable = false;
        result.warnings.push(`Yayın DRM korumalı (${drm.key.method}); indirilemez.`);
    }
    if (playlist.isLive) {
        result.warnings.push('Canlı yayın: yalnızca playlist anındaki parçalar indirilir.');
    }
}

async function describeImage(result, url, mode, signal) {
    try {
        const res = await smartFetch(url, { mode, init: { signal } });
        const blob = await res.blob();
        if (!result.size) {
            result.size = blob.size;
            result.sizeText = formatSize(blob.size);
        }
        result.previewUrl = URL.createObjectURL(blob);
        const bitmap = await createImageBitmap(blob);
        result.details.width = bitmap.width;
        result.details.height = bitmap.height;
        result.details.summary = `${bitmap.width}x${bitmap.height} piksel`;
        bitmap.close();
    } catch (err) {
        result.warnings.push('Resim önizlemesi alınamadı: ' + err.message);
    }
}

// Video/ses süresini, çözünürlüğünü ve (videoda) bir önizleme karesini okur.
// Doğrudan adres CORS'a takılırsa proxy adresiyle yeniden denenir; proxy aynı kökenli
// olduğu için canvas "tainted" olmaz ve kare yakalanabilir.
async function describeMedia(result, url, mode) {
    const candidates = mode === 'proxy'
        ? [proxyUrl(url)]
        : mode === 'direct' ? [url] : [url, proxyUrl(url)];

    for (const src of candidates) {
        const ok = await probeMediaElement(result, src, src !== url);
        if (ok) return;
    }
}

function probeMediaElement(result, src, sameOrigin) {
    return new Promise((resolve) => {
        const isVideo = result.kind !== 'audio';
        const el = document.createElement(isVideo ? 'video' : 'audio');
        el.preload = 'metadata';
        el.muted = true;
        el.playsInline = true;
        if (!sameOrigin) el.crossOrigin = 'anonymous';
        el.src = src;

        let settled = false;
        const cleanup = () => {
            el.removeAttribute('src');
            el.load();
        };
        const finish = (ok) => {
            if (settled) return;
            settled = true;
            clearTimeout(timer);
            cleanup();
            resolve(ok);
        };

        const timer = setTimeout(() => finish(false), 8000);

        el.addEventListener('error', () => finish(false), { once: true });
        el.addEventListener('loadedmetadata', async () => {
            if (el.duration && isFinite(el.duration)) result.details.duration = el.duration;
            if (el.videoWidth) {
                result.details.width = el.videoWidth;
                result.details.height = el.videoHeight;
            }
            const bits = [];
            if (el.videoWidth) bits.push(`${el.videoWidth}x${el.videoHeight}`);
            if (result.details.duration) bits.push(formatDuration(result.details.duration));
            if (bits.length) result.details.summary = bits.join(' • ');

            if (!isVideo || !el.videoWidth) return finish(true);

            try {
                result.previewUrl = await captureFrame(el);
            } catch (_) {
                // CORS izni yoksa canvas okunamaz; önizlemesiz devam edilir.
            }
            finish(true);
        }, { once: true });
    });
}

// Videonun başından bir kare alıp küçük bir JPEG önizleme üretir.
function captureFrame(video) {
    return new Promise((resolve, reject) => {
        const target = Math.min(1.5, (video.duration || 2) / 3) || 0;
        const grab = () => {
            try {
                const scale = Math.min(1, 480 / video.videoWidth);
                const canvas = document.createElement('canvas');
                canvas.width = Math.max(1, Math.round(video.videoWidth * scale));
                canvas.height = Math.max(1, Math.round(video.videoHeight * scale));
                canvas.getContext('2d').drawImage(video, 0, 0, canvas.width, canvas.height);
                canvas.toBlob((blob) => {
                    if (blob) resolve(URL.createObjectURL(blob));
                    else reject(new Error('kare alınamadı'));
                }, 'image/jpeg', 0.8);
            } catch (err) {
                reject(err);
            }
        };

        const timer = setTimeout(() => reject(new Error('kare zaman aşımı')), 6000);
        video.addEventListener('seeked', () => { clearTimeout(timer); grab(); }, { once: true });
        video.addEventListener('error', () => { clearTimeout(timer); reject(new Error('oynatıcı hatası')); }, { once: true });
        try {
            video.currentTime = target;
        } catch (err) {
            clearTimeout(timer);
            reject(err);
        }
    });
}

export function formatDuration(seconds) {
    if (!seconds || !isFinite(seconds)) return 'bilinmiyor';
    const total = Math.round(seconds);
    const h = Math.floor(total / 3600);
    const m = Math.floor((total % 3600) / 60);
    const s = total % 60;
    return h > 0
        ? `${h}s ${String(m).padStart(2, '0')}dk`
        : `${m}dk ${String(s).padStart(2, '0')}sn`;
}
