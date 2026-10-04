// Animasyonlu görüntü kodlayıcıları (harici kütüphane yok):
//  - GIF89a: kareler ortak 256 renkli paletle (ağırlıklı medyan kesme), LZW sıkıştırma.
//  - Animasyonlu WebP: her kare tarayıcının WebP kodlayıcısıyla, RIFF ANIM/ANMF kutularında birleşir.

/* ---------------- GIF ---------------- */

/** Örnek piksellerden 256 renk (medyan kesme). */
function buildPalette(samples, size = 256) {
    let boxes = [samples];
    while (boxes.length < size) {
        // En geniş aralıklı kutuyu en uzun kanalından ikiye böl.
        let best = -1;
        let bestRange = -1;
        let bestCh = 0;
        boxes.forEach((box, i) => {
            if (box.length < 2) return;
            for (let ch = 0; ch < 3; ch++) {
                let lo = 255;
                let hi = 0;
                for (const p of box) {
                    if (p[ch] < lo) lo = p[ch];
                    if (p[ch] > hi) hi = p[ch];
                }
                if (hi - lo > bestRange) {
                    bestRange = hi - lo;
                    best = i;
                    bestCh = ch;
                }
            }
        });
        if (best < 0 || bestRange <= 0) break;
        const box = boxes[best].sort((a, b) => a[bestCh] - b[bestCh]);
        const mid = box.length >> 1;
        boxes.splice(best, 1, box.slice(0, mid), box.slice(mid));
    }
    const pal = boxes.map((box) => {
        const s = [0, 0, 0];
        for (const p of box) { s[0] += p[0]; s[1] += p[1]; s[2] += p[2]; }
        return s.map((v) => Math.round(v / Math.max(1, box.length)));
    });
    while (pal.length < size) pal.push([0, 0, 0]);
    return pal;
}

function nearestMapper(pal) {
    const cache = new Map();
    return (r, g, b) => {
        const key = ((r >> 3) << 10) | ((g >> 3) << 5) | (b >> 3);
        let idx = cache.get(key);
        if (idx !== undefined) return idx;
        let bestD = Infinity;
        for (let i = 0; i < pal.length; i++) {
            const p = pal[i];
            const d = (p[0] - r) ** 2 * 3 + (p[1] - g) ** 2 * 4 + (p[2] - b) ** 2 * 2;
            if (d < bestD) {
                bestD = d;
                idx = i;
            }
        }
        cache.set(key, idx);
        return idx;
    };
}

/** GIF LZW sıkıştırma (8 bit renk). */
function lzw(indices) {
    const minCode = 8;
    const clear = 1 << minCode;
    const eoi = clear + 1;
    const out = [];
    let cur = 0;
    let bits = 0;
    let size = minCode + 1;
    const emit = (code) => {
        cur |= code << bits;
        bits += size;
        while (bits >= 8) {
            out.push(cur & 255);
            cur >>= 8;
            bits -= 8;
        }
    };
    let dict = new Map();
    let next = eoi + 1;
    emit(clear);
    let prefix = indices[0];
    for (let i = 1; i < indices.length; i++) {
        const k = indices[i];
        const key = prefix * 256 + k;
        const found = dict.get(key);
        if (found !== undefined) {
            prefix = found;
            continue;
        }
        emit(prefix);
        if (next < 4096) {
            dict.set(key, next++);
            if (next > (1 << size) && size < 12) size++;
        } else {
            emit(clear);
            dict = new Map();
            next = eoi + 1;
            size = minCode + 1;
        }
        prefix = k;
    }
    emit(prefix);
    emit(eoi);
    if (bits > 0) out.push(cur & 255);
    // 255 baytlık alt bloklara böl
    const n = Math.ceil(out.length / 255);
    const blocks = new Uint8Array(1 + out.length + n + 1);
    blocks[0] = minCode;
    let p = 1;
    for (let i = 0; i < out.length; i += 255) {
        const len = Math.min(255, out.length - i);
        blocks[p++] = len;
        for (let j = 0; j < len; j++) blocks[p++] = out[i + j];
    }
    blocks[p] = 0;
    return blocks;
}

/**
 * @param {ImageData[]} frames aynı boyutta kareler
 * @param {number} delayMs her karenin süresi
 * @returns {Blob}
 */
export function encodeGif(frames, delayMs, { loop = true, onProgress = () => {} } = {}) {
    const { width: w, height: h } = frames[0];
    // Palet: karelerden eşit aralıklı örnekler
    const samples = [];
    const stepFrames = Math.max(1, Math.floor(frames.length / 12));
    for (let f = 0; f < frames.length; f += stepFrames) {
        const d = frames[f].data;
        const step = Math.max(4, Math.floor(d.length / 4 / 4000)) * 4;
        for (let i = 0; i < d.length; i += step) samples.push([d[i], d[i + 1], d[i + 2]]);
    }
    const pal = buildPalette(samples);
    const map = nearestMapper(pal);
    const parts = [];
    let bytes = [];
    const str = (s) => { for (const c of s) bytes.push(c.charCodeAt(0)); };
    const u16 = (v) => bytes.push(v & 255, (v >> 8) & 255);
    str('GIF89a');
    u16(w); u16(h);
    bytes.push(0xf7, 0, 0); // genel palet: 256 renk
    for (const p of pal) bytes.push(p[0], p[1], p[2]);
    if (loop) bytes.push(0x21, 0xff, 11, ...[...'NETSCAPE2.0'].map((c) => c.charCodeAt(0)), 3, 1, 0, 0, 0);
    const delay = Math.max(2, Math.round(delayMs / 10));
    frames.forEach((frame, n) => {
        const d = frame.data;
        const idx = new Uint8Array(w * h);
        for (let i = 0, j = 0; i < idx.length; i++, j += 4) idx[i] = map(d[j], d[j + 1], d[j + 2]);
        bytes.push(0x21, 0xf9, 4, 0x04, delay & 255, (delay >> 8) & 255, 0, 0);
        bytes.push(0x2c); u16(0); u16(0); u16(w); u16(h); bytes.push(0);
        parts.push(new Uint8Array(bytes), lzw(idx));
        bytes = [];
        onProgress((n + 1) / frames.length);
    });
    bytes.push(0x3b);
    parts.push(new Uint8Array(bytes));
    return new Blob(parts, { type: 'image/gif' });
}

/* ---------------- Animasyonlu WebP ---------------- */

const enc = new TextEncoder();
const le32 = (v) => [v & 255, (v >> 8) & 255, (v >> 16) & 255, (v >>> 24) & 255];
const le24 = (v) => [v & 255, (v >> 8) & 255, (v >> 16) & 255];

/** Tek karelik WebP'den görüntü kutularını (VP8/VP8L/ALPH) çıkarır. */
async function frameData(blob) {
    const b = new Uint8Array(await blob.arrayBuffer());
    const parts = [];
    let p = 12;
    while (p + 8 <= b.length) {
        const type = String.fromCharCode(b[p], b[p + 1], b[p + 2], b[p + 3]);
        const size = b[p + 4] | (b[p + 5] << 8) | (b[p + 6] << 16) | (b[p + 7] << 24);
        if (/^(VP8 |VP8L|ALPH)$/.test(type)) parts.push(b.subarray(p, p + 8 + size + (size & 1)));
        p += 8 + size + (size & 1);
    }
    return parts;
}

/** Kareleri (her biri tarayıcının ürettiği WebP Blob'u) animasyonlu WebP'de birleştirir. */
export async function encodeWebp(frameBlobs, width, height, delayMs, { onProgress = () => {} } = {}) {
    const parts = [];
    let bodySize = 0;
    for (let i = 0; i < frameBlobs.length; i++) {
        const data = await frameData(frameBlobs[i]);
        const dataSize = data.reduce((n, d) => n + d.length, 0);
        const payload = 16 + dataSize;
        const head = new Uint8Array([...enc.encode('ANMF'), ...le32(payload), ...le24(0), ...le24(0), ...le24(width - 1), ...le24(height - 1), ...le24(Math.round(delayMs)), 0]);
        parts.push(head, ...data);
        bodySize += head.length + dataSize;
        if (payload & 1) {
            parts.push(new Uint8Array(1));
            bodySize += 1;
        }
        onProgress((i + 1) / frameBlobs.length);
    }
    const vp8x = new Uint8Array([...enc.encode('VP8X'), ...le32(10), 0x02, 0, 0, 0, ...le24(width - 1), ...le24(height - 1)]);
    const anim = new Uint8Array([...enc.encode('ANIM'), ...le32(6), 0, 0, 0, 0, 0, 0]);
    const total = 4 + vp8x.length + anim.length + bodySize;
    const header = new Uint8Array([...enc.encode('RIFF'), ...le32(total), ...enc.encode('WEBP')]);
    return new Blob([header, vp8x, anim, ...parts], { type: 'image/webp' });
}
