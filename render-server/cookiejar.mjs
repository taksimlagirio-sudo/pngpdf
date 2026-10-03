// Sunucunun indirme isteklerinde (/fetch, /stream) tarayıcı gibi çerez göndermesi için kutu.
// Sayfayı açan sunucu tarayıcısının ve yt-dlp'nin çerezleri burada kısa süre tutulur; her istek
// (yönlendirmeler dahil) yalnızca alan adı ve yolu uyan çerezlerle gider. Bazı siteler (ör. TikTok)
// video dosyasını sayfanın verdiği çerez olmadan vermez.

const SESSION_TTL_MS = 2 * 60 * 60 * 1000; // oturum çerezleri (bitiş tarihi olmayan) bu kadar tutulur
const MAX_COOKIES = 3000;

/**
 * yt-dlp'nin `cookies` alanı ("ad=değer; Domain=…; Path=…; Secure; Expires=…; ad2=…") → çerez nesneleri.
 */
export function parseYtdlpCookies(field, fallbackHost = '') {
    if (!field) return [];
    const attrs = /^(domain|path|secure|expires|version|httponly|max-age|samesite)$/i;
    const out = [];
    for (const part of String(field).split(/;\s*/)) {
        const eq = part.indexOf('=');
        const name = (eq < 0 ? part : part.slice(0, eq)).trim();
        const value = eq < 0 ? '' : part.slice(eq + 1);
        if (!name) continue;
        if (!attrs.test(name)) {
            out.push({ name, value, domain: fallbackHost, path: '/', expires: -1, secure: false });
            continue;
        }
        const last = out[out.length - 1];
        if (!last) continue;
        const key = name.toLowerCase();
        if (key === 'domain') last.domain = value;
        else if (key === 'path') last.path = value || '/';
        else if (key === 'secure') last.secure = true;
        else if (key === 'expires') last.expires = Number(value) || -1;
    }
    return out;
}

export function createCookieJar({ extra = () => [] } = {}) {
    const jar = new Map(); // ad|alan|yol → {cookie, addedAt}

    const domainMatches = (host, domain) => {
        if (!domain) return false;
        const d = domain.toLowerCase();
        if (d.startsWith('.')) return host === d.slice(1) || host.endsWith(d);
        return host === d || host.endsWith('.' + d);
    };
    const alive = (c, addedAt, now) => (c.expires > 0 ? c.expires * 1000 > now : now - addedAt < SESSION_TTL_MS);

    return {
        /** Playwright/yt-dlp çerezlerini ekler (aynı ad/alan/yol olan güncellenir). */
        add(cookies) {
            const now = Date.now();
            for (const c of cookies || []) {
                if (!c || !c.name || !c.domain) continue;
                jar.set(`${c.name}|${c.domain}|${c.path || '/'}`, { cookie: { ...c, path: c.path || '/' }, addedAt: now });
            }
            if (jar.size > MAX_COOKIES) {
                const oldest = [...jar.entries()].sort((a, b) => a[1].addedAt - b[1].addedAt).slice(0, jar.size - MAX_COOKIES);
                for (const [key] of oldest) jar.delete(key);
            }
        },

        /** Adrese gönderilecek Cookie başlığı (uyan çerez yoksa ''). */
        header(url) {
            let u;
            try {
                u = new URL(url);
            } catch (_) {
                return '';
            }
            const host = u.hostname.toLowerCase();
            const now = Date.now();
            const picked = new Map();
            const consider = (c, addedAt) => {
                if (!domainMatches(host, c.domain)) return;
                if (c.secure && u.protocol !== 'https:') return;
                if (!u.pathname.startsWith(c.path || '/')) return;
                if (!alive(c, addedAt, now)) return;
                // Aynı ad için en özel yol kazanır.
                const prev = picked.get(c.name);
                if (!prev || (c.path || '/').length > (prev.path || '/').length) picked.set(c.name, c);
            };
            for (const c of extra()) consider(c, now);
            for (const { cookie, addedAt } of jar.values()) consider(cookie, addedAt);
            return [...picked.values()].map((c) => `${c.name}=${c.value}`).join('; ');
        }
    };
}
