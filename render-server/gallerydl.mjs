// gallery-dl yalnızca veri katmanı olarak kullanılır: bilinen görsel sitelerinde (Instagram, X,
// Pinterest, Reddit, Tumblr…) sayfadaki resimlerin tam boyutlu adreslerini verir (`gallery-dl -J`).
// Resimleri göstermek, seçmek ve indirmek uygulamanın Resimler ekranında kalır; gallery-dl hiçbir
// dosya indirmez. Kurulum (isteğe bağlı): `pip install gallery-dl`. Kapatmak için GALLERYDL=0.
import fs from 'node:fs';
import { run, writeCookieFile } from './ytdlp.mjs';

const EXTRACT_TIMEOUT_MS = 45000;
const MAX_IMAGES = 500;
const IMAGE_EXT = /^(jpe?g|png|webp|gif|avif|bmp|heic|heif|jfif|tiff?)$/i;

let found = null;

export function findGalleryDl() {
    if (process.env.GALLERYDL === '0') return Promise.resolve(null);
    if (!found) {
        found = (async () => {
            const candidates = [];
            if (process.env.GALLERYDL_PATH) candidates.push([process.env.GALLERYDL_PATH, []]);
            candidates.push(['gallery-dl', []], ['python3', ['-m', 'gallery_dl']], ['python', ['-m', 'gallery_dl']]);
            for (const [cmd, args] of candidates) {
                const r = await run(cmd, [...args, '--version']);
                if (r.code === 0 && /^\d+\.\d+/.test(r.out.trim())) return { cmd, args, version: r.out.trim() };
            }
            return null;
        })();
    }
    return found;
}

/**
 * Sayfadaki resimleri gallery-dl'e sorar.
 * @returns {Promise<{available: boolean, ok: boolean, reason?: string, title?: string, site?: string,
 *   items?: {url: string, name: string, width: number, height: number}[]}>}
 */
export async function extractImages(url, { cookies = [] } = {}) {
    const tool = await findGalleryDl();
    if (!tool) return { available: false, ok: false, reason: 'gallery-dl kurulu değil' };
    const cookieFile = writeCookieFile(cookies);
    try {
        // -J: dosya indirmeden bilgi; profil/koleksiyon gibi ara sayfalar da çözülür.
        const args = [...tool.args, '-J', '--config-ignore', '--range', `1-${MAX_IMAGES}`, '--child-range', '1-40'];
        if (cookieFile) args.push('-C', cookieFile);
        args.push('--', url);
        const r = await run(tool.cmd, args, { timeoutMs: EXTRACT_TIMEOUT_MS, maxOutput: 32 * 1024 * 1024 });
        if (/Unsupported URL/i.test(r.err)) return { available: true, ok: false, unsupported: true, reason: 'Site tanınmadı' };
        let messages;
        try {
            messages = JSON.parse(r.out);
        } catch (_) {
            const line = r.err.trim().split('\n').pop() || 'gallery-dl yanıt vermedi';
            return { available: true, ok: false, reason: line.replace(/^\[[^\]]*\]\[\w+\]\s*/, '').slice(0, 300) };
        }
        const items = [];
        const seen = new Set();
        let title = '';
        let site = '';
        let error = '';
        for (const m of Array.isArray(messages) ? messages : []) {
            const meta = m[m.length - 1] || {};
            if (m[0] === -1) error = error || meta.message || meta.error || '';
            if (m[0] === 2 && !title) {
                site = meta.category || site;
                title = String(meta.title || meta.description || meta.content || meta.username || meta.user?.name || '').split('\n')[0].slice(0, 120);
            }
            if (m[0] !== 3 || typeof m[1] !== 'string' || !/^https?:/i.test(m[1])) continue;
            const ext = String(meta.extension || '').toLowerCase();
            if (ext && !IMAGE_EXT.test(ext)) continue; // video vb. Resimler'e girmez
            if (seen.has(m[1])) continue;
            seen.add(m[1]);
            site = site || meta.category || '';
            const base = String(meta.filename || '').replace(/[\\/:*?"<>|]+/g, '_').slice(0, 100);
            items.push({
                url: m[1],
                name: base ? `${base}.${ext || 'jpg'}` : '',
                width: Number(meta.width) || 0,
                height: Number(meta.height) || 0
            });
        }
        if (!items.length) return { available: true, ok: false, reason: error || 'Resim bulunamadı' };
        return { available: true, ok: true, title, site, items };
    } finally {
        if (cookieFile) fs.rm(cookieFile, { force: true }, () => {});
    }
}
