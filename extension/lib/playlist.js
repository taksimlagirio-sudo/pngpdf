// HLS m3u8 ayrıştırıcı — assets/js/hls.js ile aynı mantık, DOM'suz (service worker + popup'ta kullanılır).
// Mimariyi tek yerde tutmak için iki yerde de bu dosya import ediliyor olsaydı daha iyi olurdu;
// service worker ve sayfa bağlamları farklı modül çözümleme köklerine sahip olduğundan burada kopyalandı.

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

    return { type: 'media', segments, map, totalDuration, isLive, mediaSequence: seq, targetDuration };
}

function parseAttributes(input) {
    const attrs = {};
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

export function hexToBytes(hex) {
    const clean = hex.replace(/^0x/i, '');
    const out = new Uint8Array(clean.length / 2);
    for (let i = 0; i < out.length; i++) {
        out[i] = parseInt(clean.substr(i * 2, 2), 16);
    }
    return out;
}

export function ivFromSequence(seq) {
    const iv = new Uint8Array(16);
    new DataView(iv.buffer).setUint32(12, seq >>> 0);
    return iv;
}

/** Segmentler arasında gerçek DRM (anahtar açık verilmeyen şema) var mı? */
export function findDrmSegment(segments) {
    return segments.find((s) => s.key && s.key.method !== 'AES-128');
}
