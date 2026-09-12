// CORS proxy'si: tarayıcının doğrudan indiremediği kaynaklar için son çare.
// Netlify Functions v2 (ESM) — GET/HEAD, yönlendirme başına SSRF kontrolü yapar.

const MAX_REDIRECTS = 5;
const MAX_BYTES = 200 * 1024 * 1024; // content-length bildirilirse üst sınır

const BLOCKED_HOSTNAMES = new Set([
    'localhost', 'localhost.localdomain', 'ip6-localhost', 'ip6-loopback',
    'metadata', 'metadata.google.internal', 'instance-data'
]);

const CORS_HEADERS = {
    'access-control-allow-origin': '*',
    'access-control-allow-methods': 'GET, HEAD, OPTIONS',
    'access-control-allow-headers': 'range, content-type',
    'access-control-expose-headers': 'content-length, content-type, content-range, accept-ranges',
    'access-control-max-age': '86400'
};

function json(status, body) {
    return new Response(JSON.stringify(body), {
        status,
        headers: { 'content-type': 'application/json; charset=utf-8', ...CORS_HEADERS }
    });
}

function isPrivateIPv4(ip) {
    const parts = ip.split('.').map(Number);
    if (parts.length !== 4 || parts.some((n) => Number.isNaN(n) || n < 0 || n > 255)) return false;
    const [a, b] = parts;
    return (
        a === 0 || a === 10 || a === 127 ||
        (a === 169 && b === 254) ||            // link-local + bulut metadata
        (a === 172 && b >= 16 && b <= 31) ||
        (a === 192 && b === 168) ||
        (a === 100 && b >= 64 && b <= 127) ||  // CGNAT
        a >= 224                               // multicast / ayrılmış
    );
}

function isPrivateIPv6(ip) {
    const addr = ip.replace(/^\[|\]$/g, '').toLowerCase();
    if (addr === '::1' || addr === '::') return true;
    if (addr.startsWith('fe80') || addr.startsWith('fc') || addr.startsWith('fd')) return true;
    const mapped = addr.match(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/);
    return mapped ? isPrivateIPv4(mapped[1]) : false;
}

async function assertPublicTarget(url) {
    if (url.protocol !== 'http:' && url.protocol !== 'https:') {
        throw new Error('Sadece http/https adresleri desteklenir');
    }

    const host = url.hostname.toLowerCase();
    if (BLOCKED_HOSTNAMES.has(host) || host.endsWith('.local') || host.endsWith('.internal')) {
        throw new Error('Bu adrese erişim engellendi');
    }
    if (/^\d+\.\d+\.\d+\.\d+$/.test(host) && isPrivateIPv4(host)) {
        throw new Error('Özel IP adreslerine erişim engellendi');
    }
    if (host.includes(':') && isPrivateIPv6(host)) {
        throw new Error('Özel IP adreslerine erişim engellendi');
    }

    // Alan adı özel bir IP'ye çözülüyorsa (DNS rebinding) yine engelle.
    try {
        const dns = await import('node:dns/promises');
        const records = await dns.lookup(host, { all: true });
        for (const { address, family } of records) {
            if (family === 6 ? isPrivateIPv6(address) : isPrivateIPv4(address)) {
                throw new Error('Özel IP adreslerine erişim engellendi');
            }
        }
    } catch (err) {
        // Çözümleme yapılamadıysa isteği engellemiyoruz; upstream fetch zaten hata verecek.
        if (err.message && err.message.startsWith('Özel IP')) throw err;
    }
}

export default async function handler(request) {
    if (request.method === 'OPTIONS') {
        return new Response(null, { status: 204, headers: CORS_HEADERS });
    }
    if (request.method !== 'GET' && request.method !== 'HEAD') {
        return json(405, { error: 'Sadece GET ve HEAD desteklenir' });
    }

    const target = new URL(request.url).searchParams.get('url');
    if (!target) return json(400, { error: 'url parametresi gerekli' });

    let current;
    try {
        current = new URL(target);
    } catch (_) {
        return json(400, { error: 'Geçersiz url parametresi' });
    }

    const forwarded = new Headers();
    const range = request.headers.get('range');
    if (range) forwarded.set('range', range);
    forwarded.set('user-agent', request.headers.get('user-agent') || 'Mozilla/5.0');
    forwarded.set('accept', request.headers.get('accept') || '*/*');

    try {
        let response;
        for (let hop = 0; ; hop++) {
            await assertPublicTarget(current);

            response = await fetch(current, {
                method: request.method,
                headers: forwarded,
                redirect: 'manual'
            });

            const location = response.headers.get('location');
            if (!location || response.status < 300 || response.status >= 400) break;
            if (hop >= MAX_REDIRECTS) return json(502, { error: 'Çok fazla yönlendirme' });
            current = new URL(location, current);
        }

        const length = Number(response.headers.get('content-length'));
        if (length && length > MAX_BYTES) {
            return json(413, { error: `Dosya proxy sınırından büyük (${MAX_BYTES} bayt)` });
        }

        const headers = new Headers(CORS_HEADERS);
        for (const key of ['content-type', 'content-length', 'content-range', 'accept-ranges', 'last-modified', 'etag']) {
            const value = response.headers.get(key);
            if (value) headers.set(key, value);
        }
        headers.set('cache-control', 'no-store');

        return new Response(request.method === 'HEAD' ? null : response.body, {
            status: response.status,
            headers
        });
    } catch (err) {
        return json(502, { error: err.message || 'Kaynağa ulaşılamadı' });
    }
}

export const config = { path: '/api/proxy' };
