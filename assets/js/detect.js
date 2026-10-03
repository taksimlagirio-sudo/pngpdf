// Bir adresin arkasında ne olduğunu anlar: tür, format, boyut, çözünürlük/süre.
import { smartFetch, formatSize, fileNameFromUrl, proxyUrl, getRenderServer, renderSniff, renderExtract } from './util.js';
import { parsePlaylist, loadPlaylist, findDrm, audioFor, playlistHasVideo } from './hls.js';
import { parseMpd } from './dash.js';

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

    const head = text(b, 0, Math.min(b.length, 4096)).trim();
    if (head.startsWith('#EXTM3U')) return { kind: 'hls', format: 'm3u8', mime: 'application/vnd.apple.mpegurl', ext: 'm3u8' };
    // DASH bildirimi de "<?xml" ile başlar: sayfa sanılmasın diye önce bakılır.
    if (/<MPD[\s>]/.test(head)) return { kind: 'dash', format: 'mpd', mime: 'application/dash+xml', ext: 'mpd' };
    if (/^<(!doctype html|html|\?xml)/i.test(head)) return { kind: 'page', format: 'html', mime: 'text/html', ext: 'html' };
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

const IMAGE_EXT = 'jpe?g|png|webp|gif|avif|bmp|svg';

/**
 * Sayfadaki resim adreslerini toplar: <img src/srcset/data-*>, <source srcset>, og:image,
 * CSS background-image ve JSON içindeki resim adresleri. srcset'te en büyük aday alınır.
 */
export function findImages(html, baseUrl, { limit = 300 } = {}) {
    const flat = html.replace(/\\u002[fF]/g, '/').replace(/\\\//g, '/').replace(/&amp;/g, '&');
    const found = [];
    const seen = new Set();
    const add = (raw) => {
        if (!raw || found.length >= limit) return;
        const cleaned = raw.trim().replace(/^['"]|['"]$/g, '');
        if (!cleaned || cleaned.startsWith('data:') || cleaned.startsWith('blob:') || cleaned.includes('\\')) return;
        try {
            const url = new URL(cleaned, baseUrl).href;
            if (!/^https?:/.test(url) || seen.has(url)) return;
            seen.add(url);
            found.push(url);
        } catch (_) { /* bozuk adres */ }
    };
    const largestFromSrcset = (value) => {
        let best = null;
        let bestW = -1;
        for (const part of value.split(/,\s+/)) {
            const [u, d] = part.trim().split(/\s+/);
            const w = d ? parseFloat(d) * (d.endsWith('x') ? 1000 : 1) : 0;
            if (u && w >= bestW) {
                best = u;
                bestW = w;
            }
        }
        return best;
    };

    let m;
    const srcsetRe = /(?:data-srcset|srcset)=["']([^"']+)["']/gi;
    while ((m = srcsetRe.exec(flat)) !== null) add(largestFromSrcset(m[1]));
    const imgRe = /<img\b[^>]*?\s(?:data-src|data-original|data-lazy-src|data-full|src)=["']([^"']+)["']/gi;
    while ((m = imgRe.exec(flat)) !== null) add(m[1]);
    const metaRe = /<meta[^>]+(?:property|name)=["'](?:og:image(?::url)?|twitter:image(?::src)?)["'][^>]*content=["']([^"']+)["']/gi;
    while ((m = metaRe.exec(flat)) !== null) add(m[1]);
    const bgRe = /background(?:-image)?\s*:\s*url\(\s*['"]?([^'")]+)['"]?\s*\)/gi;
    while ((m = bgRe.exec(flat)) !== null) add(m[1]);
    const plainRe = new RegExp(`https?://[^"'\\s<>()]+?\\.(?:${IMAGE_EXT})(?:\\?[^"'\\s<>()]*)?`, 'gi');
    while ((m = plainRe.exec(flat)) !== null) add(m[0]);
    return found;
}

export function mergeImages(a, b) {
    return [...new Set([...a, ...b])];
}

/**
 * Adresi analiz eder. Küçük bir parça indirip başlıklar + magic number ile karar verir.
 * HLS ise playlist ayrıştırılır, resim/video ise boyut ve süre okunmaya çalışılır.
 */
// Sunucudaki tarayıcının aldığı liste içerikleri (adres → metin). Ana listenin adresi çoğu zaman tek
// kullanımlık anahtar taşır; yeniden istemek 403 verir. İçerik buradan okunur, kaliteler kaybolmaz.
const manifestTexts = new Map();

/** Sunucunun saklayıp gönderdiği liste içeriklerini önbelleğe alır ("Kendim dokunayım" vb.). */
export function rememberManifests(items) {
    for (const item of items || []) if (item && item.text && item.url) manifestTexts.set(item.url, item.text);
}

/** Saklanan liste içeriği (yoksa null). */
export function cachedManifest(url) {
    return manifestTexts.has(url) ? manifestTexts.get(url) : null;
}

/** Önbellekteki liste içeriği varsa onu, yoksa ağdan metni döner. */
async function manifestText(url, mode, signal) {
    if (manifestTexts.has(url)) return manifestTexts.get(url);
    const res = await smartFetch(url, { mode, init: { signal } });
    return res.text();
}

export async function analyzeUrl(url, { mode = 'auto', signal, onStage = () => {}, noExtract = false } = {}) {
    onStage('Bağlanılıyor...');

    // Sayfada görülen ve içeriği saklanan liste: yeniden istenmeden açılır.
    if (manifestTexts.has(url)) {
        const text = manifestTexts.get(url);
        const isDash = /<MPD[\s>]/.test(text);
        const result = {
            url, kind: isDash ? 'dash' : 'hls', format: isDash ? 'mpd' : 'm3u8',
            mime: isDash ? 'application/dash+xml' : 'application/vnd.apple.mpegurl', ext: isDash ? 'mpd' : 'm3u8',
            size: 0, sizeText: 'bilinmiyor', resumable: false, headerType: '', suggestedName: fileNameFromUrl(url),
            // Sayfada sunucu üzerinden bulundu: alt listeler/parçalar da (CORS'a takılmasın diye) sunucudan.
            access: getRenderServer() ? 'proxy' : 'direct', downloadable: true, target: 'file', warnings: [], details: {}
        };
        onStage(isDash ? 'DASH bildirimi ayrıştırılıyor...' : 'Playlist ayrıştırılıyor...');
        if (isDash) await describeDash(result, url, mode, signal);
        else await describeHls(result, url, mode, signal);
        return result;
    }

    let access = 'direct';
    let res;
    try {
        res = await smartFetch(url, {
            mode,
            init: { signal, headers: { Range: `bytes=0-${SNIFF_BYTES - 1}` } },
            onFallback: () => onStage('Doğrudan erişilemedi (CORS), kendi sunucun deneniyor...'),
            onAccess: (which) => { access = which; }
        });
    } catch (err) {
        // Site dışarıdan çekilmeyi reddediyorsa (bot koruması vb.) sayfayı kendi sunucunda gerçek
        // bir tarayıcıyla açmayı dene; o da yoksa hatayı olduğu gibi göster.
        // Video/yayın adresiyse sayfa gibi taranmaz: hata yukarı iletilir, Algıla ekranı "bağlantı
        // açılmıyor" kartını gösterir ve indirirken video açılıp kaydedilir.
        if (/\.(m3u8|mpd|mp4|m4v|webm|mov|mkv|ts|mp3|m4a|aac)(\?|$)/i.test(url)) {
            err.mediaLike = true;
            err.mediaKind = /\.m3u8(\?|$)/i.test(url) ? 'hls' : 'video';
        }
        if (!getRenderServer() || err.mediaLike) throw err;
        onStage('Bağlantı doğrudan okunamadı, kendi sunucunda açılıyor...');
        const result = basePageResult(url);
        await sniffOnServer(result, url, signal, onStage, { noExtract });
        // Uzantısız video bağlantıları (…/videoplayback?…) ve erişimi kapalı bağlantılar: sunucudaki
        // tarayıcıya göre video ya da hata döndüyse sayfa değil, açılmayan video bağlantısı sayılır.
        const main = result.details.main;
        if (main && (main.download || main.status >= 400 || /^(video|audio)\/|mpegurl|dash\+xml/.test(main.contentType))) {
            err.mediaLike = true;
            err.mediaKind = /mpegurl/.test(main.contentType) || /m3u8/i.test(url) ? 'hls' : 'video';
            if (main.status >= 400) err.message = `HTTP ${main.status}`;
            throw err;
        }
        return result;
    }

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
        await scanPage(result, url, mode, signal, onStage, { noExtract });
    } else if (info.kind === 'dash') {
        onStage('DASH bildirimi ayrıştırılıyor...');
        await describeDash(result, url, mode, signal);
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
async function scanPage(result, url, mode, signal, onStage, { noExtract = false } = {}) {
    const res = await smartFetch(url, { mode, init: { signal } });
    const html = await res.text();

    const title = (html.match(/<title[^>]*>([^<]{0,160})/i) || [])[1];
    if (title) result.details.title = title.trim();

    let links = findMediaLinks(html, url);
    const embeds = findEmbeds(html, url);
    result.details.images = findImages(html, url);
    result.details.embeds = embeds;

    // Kendi sunucun varsa sayfayı orada gerçekten çalıştır: JS ile oynatma anında üretilen
    // adresleri ancak böyle görebiliriz. Statik taramanın bulduklarıyla birleştirilir.
    if (getRenderServer()) {
        result.details.links = links;
        await sniffOnServer(result, url, signal, onStage, { noExtract });
        return;
    }

    // Sayfada bulunamadıysa sayfanın yüklediği script dosyalarına bak.
    if (links.length === 0) {
        onStage('Sayfanın script dosyaları taranıyor...');
        links = await scanScripts(html, url, mode, signal);
        if (links.length) result.details.fromScripts = true;
    }

    result.details.links = links.filter((l) => l.url !== url);
    await verifyPageLinks(result, mode, signal, onStage);
    links = result.details.links;

    if (links.length === 0) {
        const known = embeds.find((e) => ['YouTube', 'Vimeo', 'Dailymotion'].includes(e.host));
        result.warnings.push(known
            ? `Sayfada ${known.host} oynatıcısı var; bu platformlar doğrudan dosya adresi vermez.`
            : 'Sayfa kaynağında medya adresi bulunamadı. Medya büyük ihtimalle oynatma sırasında ' +
              'JavaScript ile yükleniyor: videoyu başlatıp tarayıcının geliştirici araçlarındaki Ağ ' +
              'sekmesinden .m3u8 veya .mp4 adresini kopyalayıp buraya yapıştırın.');
    }
}

async function verifyPageLinks(result, mode, signal, onStage) {
    if (!result.details.links || !result.details.links.length) return;
    onStage('Bulunan bağlantılar yoklanıyor (yalnızca video olanlar)...');
    const { links, hidden } = await verifyLinks(result.details.links, { mode, signal });
    result.details.links = links;
    result.details.hiddenLinks = hidden;
}

function basePageResult(url) {
    return {
        url,
        kind: 'page',
        format: 'html',
        mime: 'text/html',
        ext: 'html',
        size: 0,
        sizeText: 'bilinmiyor',
        resumable: false,
        headerType: '',
        suggestedName: fileNameFromUrl(url, 'html'),
        access: 'render',
        downloadable: false,
        target: 'page',
        warnings: [],
        details: { links: [], embeds: [] }
    };
}

// yt-dlp yalnızca kendine özel çıkarıcısı olan sitelerde kullanılır (sunucu genel çıkarıcıyı kapalı
// çalıştırır); genel sitelerde sayfa doğrudan bizim sunucudaki tarayıcıda açılır.
const GENERIC_EXTRACTOR = /^(generic|html5mediaembed)$/i;

async function sniffOnServer(result, url, signal, onStage, { noExtract = false } = {}) {
    // Önce yt-dlp (sunucuda kuruluysa): bilinen sitelerde gerçek kalite listesini verir.
    if (!noExtract) {
        const extracted = await extractOnServer(url, signal, onStage);
        if (extracted && !GENERIC_EXTRACTOR.test(extracted.extractor || '')) {
            applyExtracted(result, extracted);
            return;
        }
    }
    onStage('Sayfa kendi sunucunda çalıştırılıyor (oynatıcının istekleri bekleniyor)...');
    try {
        const sniffed = await renderSniff(url, { signal });
        if (sniffed.title && !result.details.title) result.details.title = sniffed.title;
        if (sniffed.main) result.details.main = sniffed.main;

        // Sunucunun gördükleri önce (gerçekten istenen adresler), statik taramadan gelenler sonra.
        const merged = new Map();
        for (const item of sniffed.items) {
            if (item.kind === 'image') continue; // sayfa ikonları/görselleri listeyi boğmasın
            if (item.text) manifestTexts.set(item.url, item.text);
            merged.set(item.url, { url: item.url, kind: item.kind, size: item.size || 0, fromRender: true,
                master: Boolean(item.master), failed: Boolean(item.failed) });
        }
        for (const item of result.details.links || []) {
            if (!merged.has(item.url)) merged.set(item.url, item);
        }
        merged.delete(url); // sayfanın kendisi medya değil; listede olursa aynı ekrana döner
        result.details.links = [...merged.values()];
        await verifyPageLinks(result, 'auto', signal, onStage);
        result.details.fromRender = sniffed.items.length > 0;
        result.details.images = mergeImages(result.details.images || [], sniffed.items.filter((i) => i.kind === 'image').map((i) => i.url));

        if (result.details.links.length === 0) {
            result.warnings.push('Sayfa kendi sunucunda çalıştırıldı, oynat düğmesine de basıldı ama medya isteği ' +
                'görülmedi. Sayfa birkaç tıklama ya da onay istiyorsa aşağıdaki "👆 Sayfayı aç, kendim dokunayım" ' +
                'ile kendin geç. Yayın kapalıysa, giriş gerekiyorsa, WebRTC ile geliyorsa veya DRM korumalıysa bulunamaz.');
        }
    } catch (err) {
        result.warnings.push(`Kendi sunucuna ulaşılamadı: ${err.message}`);
    }
}

/** yt-dlp ile çözümleme; video bulunduysa sonucu döner, yoksa null. */
async function extractOnServer(url, signal, onStage) {
    onStage('Sayfa çözümleniyor (yt-dlp)...');
    let extracted;
    try {
        extracted = await renderExtract(url, { signal });
    } catch (err) {
        if (err.name === 'AbortError') throw err;
        return null; // eski sunucu ya da hata: tarayıcıyla açma yolu sürer
    }
    return extracted && extracted.ok && extracted.items.length ? extracted : null;
}

function extractedLinks(extracted) {
    return extracted.items.map((item) => ({
        url: item.url, source: item.source || '', kind: item.kind, size: item.size || 0, height: item.height || 0, audioUrl: item.audioUrl || null,
        variants: item.variants || 0, live: Boolean(item.live), duration: extracted.duration || 0, fromYtdlp: true
    }));
}

function applyExtracted(result, extracted) {
    if (extracted.title) result.details.title = extracted.title;
    result.details.thumbnail = extracted.thumbnail || '';
    result.details.extractor = extracted.extractor || '';
    result.details.fromYtdlp = true;
    result.details.links = extractedLinks(extracted);
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

async function describeDash(result, url, mode, signal) {
    const mpd = parseMpd(await manifestText(url, mode, signal), url);
    result.target = 'dash';
    result.suggestedName = fileNameFromUrl(url).replace(/\.mpd$/i, '');
    Object.assign(result.details, {
        mpd, variants: mpd.variants, duration: mpd.duration, live: mpd.live, drm: mpd.drm,
        hasAudio: mpd.audios.length > 0
    });
    if (mpd.drm) {
        result.downloadable = false;
        result.warnings.push(`Yayın DRM korumalı (${mpd.drm}); indirilemez.`);
    } else if (mpd.live) {
        result.downloadable = false;
        result.warnings.push('Canlı DASH yayınlarının kaydı henüz desteklenmiyor; yayının HLS (.m3u8) adresi varsa onu kullanın.');
    } else if (!mpd.variants.length) {
        result.downloadable = false;
        result.warnings.push(mpd.webmOnly
            ? 'Bu DASH yayını yalnızca WebM biçiminde; şimdilik yalnızca MP4 biçimli DASH indirilebiliyor.'
            : 'DASH bildiriminde video bulunamadı.');
    }
}

async function describeHls(result, url, mode, signal) {
    let playlist = parsePlaylist(await manifestText(url, mode, signal), url);
    result.target = 'hls';
    result.suggestedName = fileNameFromUrl(url).replace(/\.m3u8$/i, '');

    if (playlist.type === 'master') {
        const master = playlist;
        result.details.master = master;
        result.details.variants = master.variants;
        result.details.audioUrl = audioFor(master, master.variants[0]);
        result.details.audioOnly = master.audioOnly;
        // Yayının canlı mı, kaç saniye mi olduğunu görmek için en iyi kaliteyi de okuyoruz.
        try {
            playlist = await loadPlaylist(master.variants[0].url, { mode, signal });
        } catch (_) {
            result.details.summary = `${master.variants.length} kalite seçeneği`;
            return;
        }
    } else {
        // Tek kalite: içinde görüntü var mı? (Ayrı ses playlist'i gibi yalnızca ses olabilir.)
        const hasVideo = await playlistHasVideo(playlist, { mode, signal });
        result.details.audioOnly = hasVideo === false;
    }
    Object.assign(result.details, describeMediaPlaylist(playlist));
    if (result.details.drm) {
        result.downloadable = false;
        result.warnings.push(`Yayın DRM korumalı (${result.details.drm}); indirilemez.`);
    }
}

/**
 * Sayfada bulunan bağlantıları ayıklar: master playlist'in alt playlist'leri (kaliteler, ayrı ses)
 * ayrıca listelenmez, yalnızca ses olan playlist'ler ve ses dosyaları, DASH gizlenir. Master'sız
 * ayrı görüntü + ses playlist'leri bulunduysa ses, görüntü bağlantısına eşlenir (birleştirilir).
 */
// Bu boyuttan küçük video dosyaları (biliniyorsa) önizleme/reklam klibi sayılıp gizlenir.
const TINY_VIDEO = 300 * 1024;

export async function verifyLinks(links, { mode = 'auto', signal } = {}) {
    const pathKey = (u) => {
        try {
            const x = new URL(u);
            return x.origin + x.pathname;
        } catch (_) {
            return u;
        }
    };
    const timeout = (ms) => new Promise((_, reject) => setTimeout(() => reject(new Error('zaman aşımı')), ms));
    const checked = await Promise.all(links.map(async (link) => {
        if (link.kind === 'dash') {
            try {
                const mpd = parseMpd(await Promise.race([manifestText(link.url, mode, signal), timeout(10000)]), link.url);
                const usable = mpd.variants.length > 0 && !mpd.drm;
                return { ...link, ok: usable, hidden: !usable, variants: mpd.variants.length, live: mpd.live,
                    duration: mpd.duration, height: mpd.variants[0] ? mpd.variants[0].height : 0 };
            } catch (_) {
                return { ...link, ok: false, unreachable: true, hidden: false };
            }
        }
        if (link.kind !== 'hls') {
            const tiny = link.kind === 'video' && link.size > 0 && link.size < TINY_VIDEO;
            return { ...link, ok: link.kind === 'video', hidden: link.kind !== 'video' || tiny, tiny };
        }
        try {
            const playlist = manifestTexts.has(link.url)
                ? parsePlaylist(manifestTexts.get(link.url), link.url)
                : await Promise.race([loadPlaylist(link.url, { mode, signal }), timeout(10000)]);
            if (playlist.type === 'master') {
                const children = [...playlist.variants.map((v) => v.url),
                    ...Object.values(playlist.audio).flat().map((a) => a.url).filter(Boolean)];
                return { ...link, ok: !playlist.audioOnly, master: true, children,
                    variants: playlist.variants.length, hidden: playlist.audioOnly };
            }
            if (findDrm(playlist.segments)) return { ...link, ok: false, hidden: true, reason: 'DRM' };
            const hasVideo = await playlistHasVideo(playlist, { mode, signal });
            return { ...link, ok: hasVideo !== false, audioOnly: hasVideo === false, hidden: hasVideo === false,
                live: playlist.isLive, duration: playlist.totalDuration };
        } catch (_) {
            // Doğrudan açılmıyor (403, oturum...): listede kalır; indirilirken video açılıp kaydedilir.
            return { ...link, ok: false, unreachable: true, hidden: false };
        }
    }));

    // Ana listelerin alt listeleri (kaliteler, ayrı ses) ayrıca gösterilmez. Adresler tam ya da
    // (sorgu dizesi farklıysa) yol olarak eşleşir; ana listenin kendisi asla gizlenmez.
    const masters = checked.filter((l) => l.master);
    const childUrls = new Set(masters.flatMap((l) => l.children));
    const childPaths = new Set(masters.flatMap((l) => l.children.map(pathKey)));
    const masterPaths = new Set(masters.map((l) => pathKey(l.url)));
    const isChild = (l) => !l.master && (childUrls.has(l.url) || (childPaths.has(pathKey(l.url)) && !masterPaths.has(pathKey(l.url))) ||
        // Ana liste açıldıysa aynı yayının (aynı klasördeki) başka alt listeleri de gizlenir.
        (l.kind === 'hls' && masters.some((m) => m.ok && dirKey(m.url) === dirKey(l.url))));
    const hasGood = checked.some((l) => l.ok && !l.hidden && !l.failed && !isChild(l));
    const audios = checked.filter((l) => l.audioOnly);
    const visible = [];
    for (const link of checked) {
        if (link.hidden || isChild(link)) continue;
        // Sayfanın başarısız/yarıda kalan istekleri (iptal edilen önizleme vb.): çalışan bağlantı varsa gizlenir.
        if (link.failed && hasGood) continue;
        if (link.kind === 'hls' && !link.master && audios.length) {
            // Aynı sunucudaki ayrı ses playlist'i bu görüntüyle birleştirilsin.
            const host = (() => { try { return new URL(link.url).host; } catch (_) { return ''; } })();
            const pair = audios.find((a) => a.url.includes(host)) || audios[0];
            link.audioUrl = pair.url;
        }
        visible.push(link);
    }
    // Çalışan bağlantılar önce, açılmayanlar sonra.
    visible.sort((a, b) => (b.ok - a.ok) || ((b.variants || 0) - (a.variants || 0)));
    return { links: visible, hidden: checked.length - visible.length };
}

function dirKey(url) {
    try {
        const u = new URL(url);
        return u.origin + u.pathname.slice(0, u.pathname.lastIndexOf('/') + 1);
    } catch (_) {
        return url;
    }
}

/** Media playlist'ten kartta gösterilecek bilgiler. */
export function describeMediaPlaylist(playlist) {
    const encrypted = playlist.segments.find((s) => s.key);
    const drm = findDrm(playlist.segments);
    return {
        segments: playlist.segments.length,
        duration: playlist.totalDuration,
        live: playlist.isLive,
        fmp4: Boolean(playlist.map),
        container: playlist.map ? 'fMP4' : 'TS',
        targetDuration: playlist.targetDuration,
        drm: drm ? drm.key.method : '',
        encryption: drm ? drm.key.method : encrypted ? 'AES-128' : '',
        playlist
    };
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
// Doğrudan adres CORS'a takılırsa kendi sunucun üzerinden yeniden denenir; sunucu CORS
// başlığı gönderdiği için canvas okunabilir kalır.
async function describeMedia(result, url, mode) {
    const candidates = (mode === 'proxy'
        ? [proxyUrl(url)]
        : mode === 'direct' ? [url] : [url, proxyUrl(url)]).filter(Boolean);

    for (const src of candidates) {
        const ok = await probeMediaElement(result, src, src.startsWith('/'));
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
