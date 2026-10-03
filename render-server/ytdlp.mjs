// yt-dlp yalnızca veri katmanı olarak kullanılır: "bu sayfadaki video nerede, hangi kaliteler var,
// hangi başlık/çerezlerle istenir" sorusunu yanıtlar (`yt-dlp -J`). İndirme, birleştirme ve ekranlar
// tamamen bizim sistemimizde kalır; yt-dlp hiçbir dosya indirmez.
//
// Kurulum (isteğe bağlı): Termux'ta `pkg install python && pip install "yt-dlp[default]"`. Kurulu değilse
// sunucu eskisi gibi çalışır. Başka bir konum için YTDLP_PATH, kapatmak için YTDLP=0.
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { randomBytes } from 'node:crypto';

const EXTRACT_TIMEOUT_MS = 45000;
const MAX_OUTPUT = 64 * 1024 * 1024;

let found = null; // Promise<{cmd, args, version} | null>

export function run(cmd, args, { timeoutMs = 10000, maxOutput = 1024 * 1024 } = {}) {
    return new Promise((resolve) => {
        let out = '';
        let err = '';
        let child;
        try {
            child = spawn(cmd, args, { stdio: ['ignore', 'pipe', 'pipe'] });
        } catch (e) {
            resolve({ code: -1, out: '', err: e.message });
            return;
        }
        const timer = setTimeout(() => child.kill('SIGKILL'), timeoutMs);
        child.stdout.on('data', (d) => {
            if (out.length < maxOutput) out += d;
        });
        child.stderr.on('data', (d) => {
            if (err.length < 64 * 1024) err += d;
        });
        child.on('error', (e) => {
            clearTimeout(timer);
            resolve({ code: -1, out, err: e.message });
        });
        child.on('close', (code, signal) => {
            clearTimeout(timer);
            resolve({ code: signal ? -1 : code, out, err: signal === 'SIGKILL' ? 'zaman aşımı' : err });
        });
    });
}

/** yt-dlp kurulu mu? Sonuç önbelleğe alınır; bulunamazsa her çağrıda yeniden denenmez. */
export function findYtdlp() {
    if (process.env.YTDLP === '0') return Promise.resolve(null);
    if (!found) {
        found = (async () => {
            const candidates = [];
            if (process.env.YTDLP_PATH) candidates.push([process.env.YTDLP_PATH, []]);
            candidates.push(['yt-dlp', []], ['python3', ['-m', 'yt_dlp']], ['python', ['-m', 'yt_dlp']]);
            for (const [cmd, args] of candidates) {
                const r = await run(cmd, [...args, '--version']);
                if (r.code === 0 && /^\d{4}\.\d/.test(r.out.trim())) return { cmd, args, version: r.out.trim() };
            }
            return null;
        })();
    }
    return found;
}

/** Kayıtlı girişler (Playwright çerezleri) → yt-dlp/gallery-dl.in okuduğu Netscape çerez dosyası. */
export function writeCookieFile(cookies) {
    if (!cookies || !cookies.length) return null;
    const file = path.join(os.tmpdir(), `indirici-cookies-${randomBytes(8).toString('hex')}.txt`);
    const lines = ['# Netscape HTTP Cookie File'];
    for (const c of cookies) {
        if (!c.name || /[\t\n]/.test(c.name + c.value)) continue;
        const domain = c.domain || '';
        lines.push([
            c.httpOnly ? `#HttpOnly_${domain}` : domain,
            domain.startsWith('.') ? 'TRUE' : 'FALSE',
            c.path || '/',
            c.secure ? 'TRUE' : 'FALSE',
            c.expires > 0 ? Math.floor(c.expires) : 0,
            c.name,
            c.value
        ].join('\t'));
    }
    fs.writeFileSync(file, lines.join('\n') + '\n', { mode: 0o600 });
    return file;
}

/**
 * Sayfanın video bilgisini yt-dlp'ye sorar.
 * @returns {Promise<{ok: true, info: object} | {ok: false, reason: string, unsupported?: boolean}>}
 */
export async function extractInfo(url, { cookies = [] } = {}) {
    const tool = await findYtdlp();
    if (!tool) return { ok: false, reason: 'yt-dlp kurulu değil', missing: true };
    const cookieFile = writeCookieFile(cookies);
    try {
        const args = [
            ...tool.args, '-J', '--no-playlist', '--ignore-config', '--no-warnings',
            '--socket-timeout', '20', '--no-cache-dir',
            // Yalnızca siteye özel çıkarıcılar: tanınmayan (genel) sitede yt-dlp ağa hiç çıkmaz,
            // sayfa doğrudan bizim sunucudaki tarayıcıda açılır.
            '--ies', 'default,-generic'
        ];
        if (cookieFile) args.push('--cookies', cookieFile);
        // YouTube'un imza/hız sınırı çözümü bir JS çalıştırıcısı ister; sunucunun kendi Node.js'i verilir
        // (ayrıca deno kurmak gerekmez). Seçenek 2025.11'den eski sürümlerde yok.
        if (tool.version >= '2025.11') args.push('--js-runtimes', `node:${process.execPath}`);
        args.push('--', url);
        const r = await run(tool.cmd, args, { timeoutMs: EXTRACT_TIMEOUT_MS, maxOutput: MAX_OUTPUT });
        if (r.code !== 0 || !r.out.trim()) {
            const line = (r.err.match(/ERROR:[^\n]*/) || [r.err.trim().split('\n').pop() || 'bilinmeyen hata'])[0];
            return {
                ok: false,
                reason: line.replace(/^ERROR:\s*/, '').slice(0, 300),
                unsupported: /Unsupported URL|No video formats found|no suitable/i.test(r.err)
            };
        }
        let info = JSON.parse(r.out);
        if (!info) return { ok: false, reason: 'Site tanınmadı', unsupported: true };
        // Oynatma listesi döndüyse (--no-playlist'e rağmen) ilk videoyu al.
        if (info._type === 'playlist' && Array.isArray(info.entries)) {
            const first = info.entries.find((e) => e && (e.formats || e.url));
            if (!first) return { ok: false, reason: 'Listede video yok', unsupported: true };
            info = { ...first, title: first.title || info.title };
        }
        return { ok: true, info };
    } catch (err) {
        return { ok: false, reason: err.message };
    } finally {
        if (cookieFile) fs.rm(cookieFile, { force: true }, () => {});
    }
}

// Kodek bilinmiyorsa (genel çıkarıcı, sayfadaki <video>) var sayılır; yt-dlp olmayanı 'none' diye yazar.
const AUDIO_EXT = /^(m4a|mp3|aac|opus|ogg|oga|wav|flac|weba)$/i;
// (video_ext/audio_ext alanları kodek bilinmediğinde de "none" olabilir; o zaman uzantıya bakılır.)
const hasVideo = (f) => (f.vcodec == null ? !AUDIO_EXT.test(f.ext || '') : f.vcodec !== 'none');
const hasAudio = (f) => (f.acodec == null ? true : f.acodec !== 'none');

/** yt-dlp'nin `cookies` alanı ("ad=değer; Domain=…; Path=…; …") → Cookie başlığı. */
function cookieHeader(field) {
    if (!field) return '';
    const attrs = /^(domain|path|secure|expires|version|httponly|max-age|samesite)$/i;
    return field.split(/;\s*/)
        .filter((part) => part.includes('=') && !attrs.test(part.split('=')[0].trim()))
        .join('; ');
}

/** Formatın isteği: yt-dlp'nin verdiği başlıklar + çerezler. */
function requestOf(f) {
    const headers = {};
    for (const [k, v] of Object.entries(f.http_headers || {})) {
        // yt-dlp'nin her isteğe koyduğu genel "sayfa gezintisi" başlıkları medya isteğinde 403'e yol açabilir.
        if (typeof v === 'string' && v && !/^(cookie|host|content-length|accept|accept-language|sec-fetch-[a-z]+)$/i.test(k)) headers[k.toLowerCase()] = v;
    }
    const cookie = cookieHeader(f.cookies);
    if (cookie) headers.cookie = cookie;
    return {
        protocol: f.protocol || 'https',
        url: f.url || '',
        headers,
        fragments: Array.isArray(f.fragments) ? f.fragments.map((x) => x.url || (x.path ? new URL(x.path, f.fragment_base_url || f.url).href : '')).filter(Boolean) : null,
        chunk: (f.downloader_options && f.downloader_options.http_chunk_size) || 0,
        size: f.filesize || f.filesize_approx || 0
    };
}

/** Telefonda tek dosyaya birleştirilebilir mi (parçalı MP4 = bizim birleştiricinin anladığı). */
function mergeable(f) {
    const container = String(f.container || '');
    return /_dash$/.test(container) && /^(mp4|m4a)/.test(container) ||
        (f.protocol === 'http_dash_segments' && /^(mp4|m4a)$/.test(f.ext || ''));
}

/**
 * yt-dlp çıktısını uygulamanın anladığı listeye çevirir. Yalnızca görüntülü sonuçlar:
 * - HLS: master playlist (kalite seçimi uygulamada)
 * - tek dosya (görüntü + ses birlikte)
 * - ayrı görüntü + ses (DASH/YouTube): telefonda tek MP4'te birleştirilir
 * `register(request)` her akışı sunucuda tek bir adres olarak yayınlar ve o adresi döner.
 */
export function normalizeInfo(info, register) {
    const formats = (info.formats && info.formats.length ? info.formats : [info]).filter((f) => f && (f.url || f.fragments));
    const items = [];
    const seenHls = new Set();
    const heightOf = (f) => f.height || (f.resolution && Number((f.resolution.match(/x(\d+)/) || [])[1])) || 0;
    const score = (f) => (f.tbr || 0) + (/avc1|h264/.test(f.vcodec || '') ? 1e6 : 0); // telefonlarda en uyumlu: H.264

    // HLS
    const hls = formats.filter((f) => /^m3u8/.test(f.protocol || ''));
    for (const f of hls) {
        const url = f.manifest_url || f.url;
        if (seenHls.has(url)) continue;
        seenHls.add(url);
        const variants = hls.filter((x) => (x.manifest_url || x.url) === url && hasVideo(x));
        if (!variants.length) continue; // yalnızca sesi olan liste
        const best = variants.sort((a, b) => heightOf(b) - heightOf(a))[0] || f;
        items.push({
            kind: 'hls', url: register(requestOf({ ...f, url }), { hls: true }),
            height: heightOf(best), variants: variants.length, live: Boolean(info.is_live)
        });
    }

    // Tek dosya: görüntü + ses birlikte
    const plain = formats.filter((f) => /^https?$/.test(f.protocol || 'https') || f.protocol === 'http_dash_segments');
    const combined = plain.filter((f) => hasVideo(f) && hasAudio(f) && !(f.protocol === 'http_dash_segments' && !mergeable(f)));
    const byHeight = new Map();
    for (const f of combined) {
        const h = heightOf(f);
        if (!byHeight.has(h) || score(f) > score(byHeight.get(h))) byHeight.set(h, f);
    }

    // Ayrı görüntü + ses
    const videoOnly = plain.filter((f) => hasVideo(f) && !hasAudio(f) && mergeable(f));
    const audioOnly = plain.filter((f) => !hasVideo(f) && hasAudio(f) && mergeable(f))
        .sort((a, b) => (/mp4a/.test(b.acodec || '') - /mp4a/.test(a.acodec || '')) || ((b.abr || b.tbr || 0) - (a.abr || a.tbr || 0)));
    const audio = audioOnly[0] || null;
    const pairs = new Map();
    if (audio) {
        for (const f of videoOnly) {
            const h = heightOf(f);
            if (!pairs.has(h) || score(f) > score(pairs.get(h))) pairs.set(h, f);
        }
    }

    const heights = [...new Set([...byHeight.keys(), ...pairs.keys()])].sort((a, b) => b - a);
    let audioUrl = null;
    for (const h of heights) {
        // Aynı yükseklikte tek dosya varsa o yeğlenir (birleştirme gerekmez).
        const single = byHeight.get(h);
        if (single) {
            items.push({ kind: 'video', url: register(requestOf(single)), source: single.url || '', height: h, size: single.filesize || single.filesize_approx || 0, ext: single.ext || 'mp4' });
            continue;
        }
        const video = pairs.get(h);
        audioUrl = audioUrl || register(requestOf(audio));
        const size = (video.filesize || video.filesize_approx || 0) + (audio.filesize || audio.filesize_approx || 0);
        items.push({ kind: 'video', url: register(requestOf(video)), source: video.url || '', audioUrl, height: h, size, ext: 'mp4' });
    }

    return {
        // Genel çıkarıcı başlığa sıra numarası ekler ("Başlık (1)").
        title: String(info.title || '').replace(/\s+\(\d+\)$/, ''),
        duration: info.duration || 0,
        thumbnail: info.thumbnail || '',
        extractor: info.extractor_key || info.extractor || '',
        live: Boolean(info.is_live),
        items: items.slice(0, 10)
    };
}
