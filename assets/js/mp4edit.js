// Kayıpsız MP4 düzenleme: kesme, ses/görüntü izini çıkarma, döndürme.
//
// Normal (parçalı olmayan) bir MP4'ün moov tablolarından her örneğin (kare/ses paketi) dosyadaki
// yeri, boyutu ve zamanı okunur; seçilen örnekler yeni bir MP4'e konur. Örnek verisi kopyalanmaz:
// çıktı Blob'u, kaynak Blob'un dilimlerinden oluşur (bellek şişmez, saniyeler sürer). Kesim
// başlangıcı, anahtar kareye (sync sample) denk gelecek şekilde geriye kayar.
//
// DOM kullanmaz; tarayıcıda ve Node'da (Blob olan sürümlerde) çalışır.

import { Mp4Builder } from './mp4mux.mjs';

const TEXT = new TextEncoder();

const u32 = (b, o) => ((b[o] << 24) | (b[o + 1] << 16) | (b[o + 2] << 8) | b[o + 3]) >>> 0;
const i32 = (b, o) => (b[o] << 24) | (b[o + 1] << 16) | (b[o + 2] << 8) | b[o + 3];
const u64 = (b, o) => u32(b, o) * 4294967296 + u32(b, o + 4);
const fourcc = (b, o) => String.fromCharCode(b[o], b[o + 1], b[o + 2], b[o + 3]);

function boxes(b, start = 0, end = b.length) {
    const out = [];
    let p = start;
    while (p + 8 <= end) {
        let size = u32(b, p);
        const type = fourcc(b, p + 4);
        let hdr = 8;
        if (size === 1) {
            size = u64(b, p + 8);
            hdr = 16;
        } else if (size === 0) size = end - p;
        if (size < hdr || p + size > end) break;
        out.push({ type, start: p, end: p + size, body: p + hdr });
        p += size;
    }
    return out;
}

const child = (b, box, type) => boxes(b, box.body, box.end).find((x) => x.type === type) || null;
const children = (b, box, type) => boxes(b, box.body, box.end).filter((x) => x.type === type);
const raw = (b, box) => b.subarray(box.start, box.end);

function w32(v) {
    const a = new Uint8Array(4);
    new DataView(a.buffer).setUint32(0, v >>> 0);
    return a;
}

function w64(v) {
    const a = new Uint8Array(8);
    const dv = new DataView(a.buffer);
    dv.setUint32(0, Math.floor(v / 4294967296));
    dv.setUint32(4, v >>> 0);
    return a;
}

function concat(parts) {
    const len = parts.reduce((n, p) => n + p.length, 0);
    const out = new Uint8Array(len);
    let o = 0;
    for (const p of parts) {
        out.set(p, o);
        o += p.length;
    }
    return out;
}

function box(type, ...parts) {
    const body = concat(parts);
    return concat([w32(body.length + 8), TEXT.encode(type), body]);
}

const fullBox = (type, version, flags, ...parts) => box(type, new Uint8Array([version, (flags >> 16) & 255, (flags >> 8) & 255, flags & 255]), ...parts);

async function readRange(blob, start, end) {
    return new Uint8Array(await blob.slice(start, end).arrayBuffer());
}

/** Dosyanın en üst kutuları (yalnızca başlıklar okunur). */
async function topBoxes(blob) {
    const out = [];
    let p = 0;
    while (p + 8 <= blob.size) {
        const h = await readRange(blob, p, Math.min(blob.size, p + 16));
        let size = u32(h, 0);
        const type = fourcc(h, 4);
        let hdr = 8;
        if (size === 1) {
            size = u64(h, 8);
            hdr = 16;
        } else if (size === 0) size = blob.size - p;
        if (size < hdr) break;
        out.push({ type, start: p, end: Math.min(blob.size, p + size), hdr });
        p += size;
    }
    return out;
}

/**
 * Parçalı MP4'ü (fMP4: moof+mdat) normal MP4'e çevirir; zaten normalse aynen döner.
 * Veri yeniden kodlanmaz (mp4mux örnekleri taşır).
 */
export async function toProgressive(blob) {
    const top = await topBoxes(blob);
    if (!top.some((x) => x.type === 'moof')) return blob;
    const moov = top.find((x) => x.type === 'moov');
    if (!moov) throw new Error('MP4 başlığı bulunamadı');
    const parts = [];
    const mux = new Mp4Builder({ write: async (bytes) => { parts.push(bytes); } });
    await mux.start();
    mux.addInit('a', await readRange(blob, moov.start, moov.end));
    for (let i = 0; i < top.length; i++) {
        if (top[i].type !== 'moof') continue;
        const end = top[i + 1] && top[i + 1].type === 'mdat' ? top[i + 1].end : top[i].end;
        await mux.addFragment('a', await readRange(blob, top[i].start, end));
    }
    const { patch } = await mux.finish();
    parts[0] = parts[0].slice();
    parts[0].set(patch.bytes, patch.position);
    return new Blob(parts, { type: blob.type || 'video/mp4' });
}

/** MP4'ün izleri ve örnek tabloları. Parçalı MP4 (moof) desteklenmez. */
export async function readMp4(blob) {
    const top = await topBoxes(blob);
    const moovBox = top.find((x) => x.type === 'moov');
    if (!moovBox) throw new Error('MP4 değil ya da dosya eksik');
    if (top.some((x) => x.type === 'moof')) throw new Error('Parçalı MP4 kayıpsız kesilemiyor');
    const b = await readRange(blob, moovBox.start, moovBox.end);
    const moov = { body: 8, end: b.length, start: 0 };
    const mvhd = child(b, moov, 'mvhd');
    const movieScale = u32(b, mvhd.body + (b[mvhd.body] === 1 ? 20 : 12));
    const tracks = [];
    for (const trak of children(b, moov, 'trak')) {
        const tkhd = child(b, trak, 'tkhd');
        const mdia = child(b, trak, 'mdia');
        const mdhd = child(b, mdia, 'mdhd');
        const hdlr = child(b, mdia, 'hdlr');
        const handler = fourcc(b, hdlr.body + 8);
        if (handler !== 'vide' && handler !== 'soun') continue;
        const minf = child(b, mdia, 'minf');
        const stbl = child(b, minf, 'stbl');
        const timescale = u32(b, mdhd.body + (b[mdhd.body] === 1 ? 20 : 12));
        const t = {
            handler, timescale,
            tkhd: raw(b, tkhd).slice(), mdhd: raw(b, mdhd).slice(), hdlr: raw(b, hdlr).slice(),
            mediaHeader: boxes(b, minf.body, minf.end).filter((x) => /^(vmhd|smhd)$/.test(x.type)).map((x) => raw(b, x).slice()),
            dinf: child(b, minf, 'dinf') ? raw(b, child(b, minf, 'dinf')).slice() : null,
            stsd: raw(b, child(b, stbl, 'stsd')).slice(),
            mediaTime: 0
        };
        // Düzenleme listesi: ilk "boş olmayan" girişin medya zamanı (B-kare gecikmesi) korunur.
        const edts = child(b, trak, 'edts');
        const elst = edts && child(b, edts, 'elst');
        if (elst) {
            const v = b[elst.body];
            const n = u32(b, elst.body + 4);
            let o = elst.body + 8;
            for (let k = 0; k < n; k++) {
                const mt = v === 1 ? u64(b, o + 8) : i32(b, o + 4);
                if (mt >= 0 && mt < 2 ** 52) {
                    t.mediaTime = mt;
                    break;
                }
                o += v === 1 ? 20 : 12;
            }
        }
        // Örnek tabloları
        const stsz = child(b, stbl, 'stsz') || child(b, stbl, 'stz2');
        const fixed = u32(b, stsz.body + 4);
        const count = u32(b, stsz.body + 8);
        const sizes = new Uint32Array(count);
        for (let k = 0; k < count; k++) sizes[k] = fixed || u32(b, stsz.body + 12 + k * 4);

        const dts = new Float64Array(count);
        const durs = new Uint32Array(count);
        const stts = child(b, stbl, 'stts');
        {
            let k = 0;
            let time = 0;
            const n = u32(b, stts.body + 4);
            for (let e = 0; e < n; e++) {
                const c = u32(b, stts.body + 8 + e * 8);
                const d = u32(b, stts.body + 12 + e * 8);
                for (let j = 0; j < c && k < count; j++, k++) {
                    dts[k] = time;
                    durs[k] = d;
                    time += d;
                }
            }
        }
        let ctts = null;
        let cttsVersion = 0;
        const cttsBox = child(b, stbl, 'ctts');
        if (cttsBox) {
            cttsVersion = b[cttsBox.body];
            ctts = new Int32Array(count);
            const n = u32(b, cttsBox.body + 4);
            let k = 0;
            for (let e = 0; e < n; e++) {
                const c = u32(b, cttsBox.body + 8 + e * 8);
                const off = i32(b, cttsBox.body + 12 + e * 8);
                for (let j = 0; j < c && k < count; j++) ctts[k++] = off;
            }
        }
        let sync = null;
        const stss = child(b, stbl, 'stss');
        if (stss) {
            sync = new Uint8Array(count);
            const n = u32(b, stss.body + 4);
            for (let e = 0; e < n; e++) {
                const idx = u32(b, stss.body + 8 + e * 4) - 1;
                if (idx < count) sync[idx] = 1;
            }
        }
        // Konumlar: stsc (öbek → örnek sayısı) + stco/co64 (öbek konumu)
        const offsets = new Float64Array(count);
        const stco = child(b, stbl, 'stco');
        const co64 = child(b, stbl, 'co64');
        const chunkCount = u32(b, (stco || co64).body + 4);
        const chunkOffset = (c) => (stco ? u32(b, stco.body + 8 + c * 4) : u64(b, co64.body + 8 + c * 8));
        const stsc = child(b, stbl, 'stsc');
        const runs = [];
        for (let e = 0, n = u32(b, stsc.body + 4); e < n; e++) {
            runs.push([u32(b, stsc.body + 8 + e * 12) - 1, u32(b, stsc.body + 12 + e * 12)]);
        }
        {
            let k = 0;
            for (let r = 0; r < runs.length; r++) {
                const [first, per] = runs[r];
                const last = r + 1 < runs.length ? runs[r + 1][0] : chunkCount;
                for (let c = first; c < last && k < count; c++) {
                    let o = chunkOffset(c);
                    for (let j = 0; j < per && k < count; j++, k++) {
                        offsets[k] = o;
                        o += sizes[k];
                    }
                }
            }
        }
        Object.assign(t, { count, sizes, dts, durs, ctts, cttsVersion, sync, offsets });
        const v = t.tkhd[8];
        t.width = u32(t.tkhd, 8 + 4 + (v === 1 ? 84 : 72)) / 65536;
        t.height = u32(t.tkhd, 8 + 4 + (v === 1 ? 88 : 76)) / 65536;
        t.duration = count ? (dts[count - 1] + durs[count - 1] - t.mediaTime) / timescale : 0;
        tracks.push(t);
    }
    if (!tracks.length) throw new Error('Dosyada video ya da ses izi yok');
    return { tracks, movieScale, duration: Math.max(...tracks.map((t) => t.duration)) };
}

/** Kesimin anahtar kareye oturmuş gerçek başlangıcı (sn). */
export function snapStart(info, start) {
    const v = info.tracks.find((t) => t.handler === 'vide' && t.sync);
    if (!v) return start;
    const target = start * v.timescale + v.mediaTime;
    // Gösterim zamanı (dts + ctts) ile karşılaştırılır.
    const pts = (k) => v.dts[k] + (v.ctts ? v.ctts[k] : 0);
    let best = 0;
    for (let k = 0; k < v.count; k++) {
        if (v.sync[k] && pts(k) <= target + 1) best = k;
        if (v.dts[k] > target) break;
    }
    return Math.max(0, (pts(best) - v.mediaTime) / v.timescale);
}

function rangeOf(t, from, to) {
    const a = from * t.timescale + t.mediaTime;
    const z = to * t.timescale + t.mediaTime;
    let first = 0;
    while (first < t.count && t.dts[first] + t.durs[first] <= a) first++;
    if (t.handler === 'vide' && t.sync) {
        while (first > 0 && !t.sync[first]) first--;
    }
    let last = first;
    while (last < t.count && t.dts[last] < z) last++;
    return [first, last]; // [first, last)
}

/** Seçimle çıkacak dosyanın boyutu (bayt). */
export function estimateSize(info, opts) {
    let n = 0;
    for (const t of pickTracks(info, opts)) {
        const [a, z] = rangeOf(t, opts.start || 0, opts.end ?? info.duration);
        for (let k = a; k < z; k++) n += t.sizes[k];
    }
    return n;
}

function pickTracks(info, { audioOnly = false, mute = false } = {}) {
    return info.tracks.filter((t) => (audioOnly ? t.handler === 'soun' : !(mute && t.handler === 'soun')));
}

const MATRIX = {
    0: [0x10000, 0, 0, 0, 0x10000, 0],
    90: [0, 0x10000, -0x10000, 0, 0, 0],
    180: [-0x10000, 0, 0, 0, -0x10000, 0],
    270: [0, -0x10000, 0x10000, 0, 0, 0]
};

/** tkhd'nin süresini ve (isteğe bağlı) döndürme matrisini yeniler. */
function patchTkhd(src, id, duration, rotate) {
    const b = src.slice();
    const v = b[8];
    const dv = new DataView(b.buffer);
    dv.setUint32(8 + (v === 1 ? 20 : 12), id);
    if (v === 1) {
        dv.setUint32(8 + 28, Math.floor(duration / 4294967296));
        dv.setUint32(8 + 32, duration >>> 0);
    } else dv.setUint32(8 + 20, duration >>> 0);
    if (rotate !== null) {
        const m = 8 + (v === 1 ? 52 : 40);
        const r = MATRIX[rotate] || MATRIX[0];
        dv.setInt32(m, r[0]);
        dv.setInt32(m + 4, r[1]);
        dv.setInt32(m + 12, r[2]);
        dv.setInt32(m + 16, r[3]);
    }
    return b;
}

/** Var olan döndürme (0/90/180/270). */
export function rotationOf(info) {
    const v = info.tracks.find((t) => t.handler === 'vide');
    if (!v) return 0;
    const ver = v.tkhd[8];
    const m = 8 + (ver === 1 ? 52 : 40);
    const a = i32(v.tkhd, m);
    const bq = i32(v.tkhd, m + 4);
    if (a === 0 && bq > 0) return 90;
    if (a < 0) return 180;
    if (a === 0 && bq < 0) return 270;
    return 0;
}

function patchMdhd(src, duration) {
    const b = src.slice();
    const v = b[8];
    const dv = new DataView(b.buffer);
    if (v === 1) {
        dv.setUint32(8 + 24, Math.floor(duration / 4294967296));
        dv.setUint32(8 + 28, duration >>> 0);
    } else dv.setUint32(8 + 16, duration >>> 0);
    return b;
}

function rle(values) {
    const out = [];
    for (const v of values) {
        const last = out[out.length - 1];
        if (last && last[1] === v) last[0]++;
        else out.push([1, v]);
    }
    return out;
}

/**
 * Düzenlenmiş MP4'ü üretir.
 * @param {Blob} blob kaynak MP4
 * @param {{start?: number, end?: number, audioOnly?: boolean, mute?: boolean, rotate?: number|null}} opts
 * @returns {Promise<{blob: Blob, start: number, end: number, duration: number}>}
 */
export async function editMp4(blob, opts = {}, info = null) {
    info = info || await readMp4(blob);
    const tracks = pickTracks(info, opts);
    if (!tracks.length) throw new Error(opts.audioOnly ? 'Dosyada ses yok' : 'Çıkacak iz kalmadı');
    const keepsVideo = tracks.some((t) => t.handler === 'vide');
    const start = keepsVideo ? snapStart(info, Math.max(0, opts.start || 0)) : Math.max(0, opts.start || 0);
    const end = Math.min(info.duration, opts.end ?? info.duration);
    if (end - start < 0.05) throw new Error('Aralık çok kısa');

    // Seçilen örnekler ve yeni zaman çizelgesi
    const sel = tracks.map((t) => {
        const [a, z] = rangeOf(t, start, end);
        return { t, a, z, base: t.dts[a] };
    }).filter((s) => s.z > s.a);
    if (!sel.length) throw new Error('Aralıkta örnek yok');

    // Öbekler: izler ~1 sn'lik öbeklerle iç içe yazılır (sarma kolay olsun).
    const chunks = []; // { s, a, z, time }
    for (const s of sel) {
        let k = s.a;
        while (k < s.z) {
            const time = (s.t.dts[k] - s.base) / s.t.timescale;
            const limit = s.t.dts[k] + s.t.timescale;
            let j = k;
            while (j < s.z && s.t.dts[j] < limit) j++;
            chunks.push({ s, a: k, z: j, time });
            k = j;
        }
    }
    chunks.sort((x, y) => x.time - y.time);
    // Gömülecek altyazılar (3GPP metin: her örnek 2 bayt uzunluk + UTF-8 metin; boşluklar boş örnek).
    const texts = (opts.textTracks || []).map((track) => buildTextSamples(track.cues || [], start, end)).map((t, i) => ({ ...t, track: opts.textTracks[i] }));
    const dataSize = chunks.reduce((n, c) => {
        for (let k = c.a; k < c.z; k++) n += c.s.t.sizes[k];
        return n;
    }, 0) + texts.reduce((n, t) => n + t.data.length, 0);

    const audioOnly = sel.every((s) => s.t.handler === 'soun');
    const ftyp = box('ftyp', TEXT.encode(audioOnly ? 'M4A ' : 'isom'), w32(512), TEXT.encode(audioOnly ? 'M4A mp42isom' : 'isomiso2avc1mp41'));
    const large = dataSize + 16 > 0xffffffff;
    const mdatHead = large ? concat([w32(1), TEXT.encode('mdat'), w64(dataSize + 16)]) : concat([w32(dataSize + 8), TEXT.encode('mdat')]);
    let pos = ftyp.length + mdatHead.length;
    const parts = [ftyp, mdatHead];
    const use64 = pos + dataSize > 0xffffffff;
    for (const c of chunks) {
        c.offset = pos;
        // Ardışık örnekler tek dilimde
        let k = c.a;
        while (k < c.z) {
            const from = c.s.t.offsets[k];
            let to = from + c.s.t.sizes[k];
            let j = k + 1;
            while (j < c.z && c.s.t.offsets[j] === to) to += c.s.t.sizes[j++];
            parts.push(blob.slice(from, to));
            pos += to - from;
            k = j;
        }
    }
    for (const t of texts) {
        t.offset = pos;
        parts.push(t.data);
        pos += t.data.length;
    }

    // moov
    const movieScale = 1000;
    let movieDur = 0;
    const traks = sel.map((s, i) => {
        const t = s.t;
        const id = i + 1;
        const my = chunks.filter((c) => c.s === s);
        const n = s.z - s.a;
        const durs = Array.from(t.durs.subarray(s.a, s.z));
        const mediaDur = durs.reduce((x, y) => x + y, 0);
        const shown = Math.max(0, mediaDur - (t.handler === 'vide' ? t.mediaTime : 0));
        const trackMovie = Math.round((shown / t.timescale) * movieScale);
        movieDur = Math.max(movieDur, trackMovie);

        const stts = rle(durs);
        const sttsBox = fullBox('stts', 0, 0, w32(stts.length), ...stts.flatMap(([c, d]) => [w32(c), w32(d)]));
        let cttsBox = new Uint8Array(0);
        if (t.ctts) {
            const c = rle(Array.from(t.ctts.subarray(s.a, s.z)));
            cttsBox = fullBox('ctts', t.cttsVersion, 0, w32(c.length), ...c.flatMap(([cnt, off]) => [w32(cnt), w32(off)]));
        }
        let stssBox = new Uint8Array(0);
        if (t.sync) {
            const idx = [];
            for (let k = s.a; k < s.z; k++) if (t.sync[k]) idx.push(k - s.a + 1);
            stssBox = fullBox('stss', 0, 0, w32(idx.length), ...idx.map(w32));
        }
        const stszBox = fullBox('stsz', 0, 0, w32(0), w32(n), ...Array.from(t.sizes.subarray(s.a, s.z), w32));
        const stscRuns = rle(my.map((c) => c.z - c.a));
        const stscEntries = [];
        let chunkNo = 1;
        for (const [cnt, per] of stscRuns) {
            stscEntries.push(w32(chunkNo), w32(per), w32(1));
            chunkNo += cnt;
        }
        const stscBox = fullBox('stsc', 0, 0, w32(stscRuns.length), ...stscEntries);
        const stcoBox = use64
            ? fullBox('co64', 0, 0, w32(my.length), ...my.map((c) => w64(c.offset)))
            : fullBox('stco', 0, 0, w32(my.length), ...my.map((c) => w32(c.offset)));
        const stbl = box('stbl', t.stsd, sttsBox, cttsBox, stssBox, stszBox, stscBox, stcoBox);
        const dinf = t.dinf || box('dinf', fullBox('dref', 0, 0, w32(1), fullBox('url ', 0, 1)));
        const minf = box('minf', ...t.mediaHeader, dinf, stbl);
        const mdia = box('mdia', patchMdhd(t.mdhd, mediaDur), t.hdlr, minf);
        const rotate = t.handler === 'vide' && opts.rotate != null ? opts.rotate : null;
        const tkhd = patchTkhd(t.tkhd, id, trackMovie, rotate);
        const edts = t.handler === 'vide' && t.mediaTime
            ? box('edts', fullBox('elst', 0, 0, w32(1), w32(trackMovie), w32(t.mediaTime), w32(0x10000)))
            : new Uint8Array(0);
        return box('trak', tkhd, edts, mdia);
    });
    const video = sel.find((s) => s.t.handler === 'vide');
    texts.forEach((t, i) => {
        if (!t.sizes.length) return;
        traks.push(textTrak(t, sel.length + i + 1, { width: video ? video.t.width : 640, height: video ? video.t.height : 360, use64 }));
    });
    const mvhd = fullBox('mvhd', 0, 0, w32(0), w32(0), w32(movieScale), w32(movieDur),
        w32(0x10000), new Uint8Array([1, 0]), new Uint8Array(10),
        w32(0x10000), w32(0), w32(0), w32(0), w32(0x10000), w32(0), w32(0), w32(0), w32(0x40000000),
        new Uint8Array(24), w32(sel.length + texts.length + 1));
    const moov = box('moov', mvhd, ...traks);
    parts.push(moov);
    return {
        blob: new Blob(parts, { type: audioOnly ? 'audio/mp4' : 'video/mp4' }),
        start, end, duration: movieDur / movieScale
    };
}

/* ---------------- Altyazı izi (tx3g) ---------------- */

const LANG3 = { tr: 'tur', en: 'eng', de: 'deu', fr: 'fra', es: 'spa', it: 'ita', ar: 'ara', ru: 'rus', ja: 'jpn', ko: 'kor', zh: 'zho', pt: 'por', nl: 'nld', fa: 'fas', az: 'aze', ku: 'kur', el: 'ell' };

function packLang(code) {
    const c3 = (LANG3[String(code || '').split('-')[0].toLowerCase()] || (/^[a-z]{3}$/.test(code) ? code : 'und'));
    const v = ((c3.charCodeAt(0) - 0x60) << 10) | ((c3.charCodeAt(1) - 0x60) << 5) | (c3.charCodeAt(2) - 0x60);
    return new Uint8Array([(v >> 8) & 0x7f, v & 0xff]);
}

/** İpuçlarını (sn) 1000'lik zaman ölçeğinde örneklere çevirir; aralık dışı atılır, başlangıç 0'a çekilir. */
function buildTextSamples(cues, start = 0, end = Infinity) {
    const sizes = [];
    const durs = [];
    const parts = [];
    let t = 0;
    const push = (bytes, dur) => {
        if (dur <= 0) return;
        parts.push(bytes);
        sizes.push(bytes.length);
        durs.push(dur);
    };
    for (const c of cues) {
        const a = Math.round((Math.max(c.start, start) - start) * 1000);
        const b = Math.round((Math.min(c.end, end) - start) * 1000);
        if (b <= a || b <= t) continue;
        const from = Math.max(a, t);
        if (from > t) push(new Uint8Array(2), from - t); // boşluk: metinsiz örnek
        const text = TEXT.encode(c.text);
        const sample = new Uint8Array(2 + text.length);
        sample[0] = text.length >> 8;
        sample[1] = text.length & 255;
        sample.set(text, 2);
        push(sample, b - from);
        t = b;
    }
    // Kapanış: son satır videonun sonuna kadar ekranda kalmasın.
    if (sizes.length) {
        push(new Uint8Array(2), 100);
        t += 100;
    }
    return { data: concat(parts), sizes, durs, duration: t };
}

function w16(v) {
    return new Uint8Array([(v >> 8) & 255, v & 255]);
}

function textTrak(t, id, { width, height, use64 }) {
    const ftab = box('ftab', w16(1), w16(1), new Uint8Array([5]), TEXT.encode('Serif'));
    const tx3g = box('tx3g', new Uint8Array(6), w16(1),
        w32(0),                          // görüntü bayrakları
        new Uint8Array([1, 0xff]),       // yatay: orta, dikey: alt
        new Uint8Array([0, 0, 0, 0]),    // arka plan rengi (saydam)
        new Uint8Array(8),               // metin kutusu
        w16(0), w16(0), w16(1), new Uint8Array([0, 18]), new Uint8Array([255, 255, 255, 255]), // stil
        ftab);
    const stsd = fullBox('stsd', 0, 0, w32(1), tx3g);
    const stts = rle(t.durs);
    const stbl = box('stbl', stsd,
        fullBox('stts', 0, 0, w32(stts.length), ...stts.flatMap(([c, d]) => [w32(c), w32(d)])),
        fullBox('stsz', 0, 0, w32(0), w32(t.sizes.length), ...t.sizes.map(w32)),
        fullBox('stsc', 0, 0, w32(1), w32(1), w32(t.sizes.length), w32(1)),
        use64 ? fullBox('co64', 0, 0, w32(1), w64(t.offset)) : fullBox('stco', 0, 0, w32(1), w32(t.offset)));
    const minf = box('minf', fullBox('nmhd', 0, 0), box('dinf', fullBox('dref', 0, 0, w32(1), fullBox('url ', 0, 1))), stbl);
    const hdlr = fullBox('hdlr', 0, 0, w32(0), TEXT.encode('sbtl'), new Uint8Array(12), TEXT.encode('Altyazi\0'));
    const mdhd = fullBox('mdhd', 0, 0, w32(0), w32(0), w32(1000), w32(t.duration), packLang(t.track.language), w16(0));
    const tkhd = fullBox('tkhd', 0, 3, w32(0), w32(0), w32(id), w32(0), w32(t.duration), new Uint8Array(8),
        w16(0), w16(2), w16(0), w16(0),
        w32(0x10000), w32(0), w32(0), w32(0), w32(0x10000), w32(0), w32(0), w32(0), w32(0x40000000),
        w32(Math.round(width) * 65536), w32(Math.round(Math.min(height, 120)) * 65536));
    return box('trak', tkhd, box('mdia', mdhd, hdlr, minf));
}

/**
 * MP4'e altyazı izleri gömer (video yeniden kodlanmaz).
 * @param {Blob} blob
 * @param {{language: string, cues: {start: number, end: number, text: string}[]}[]} tracks
 */
export async function embedSubtitles(blob, tracks) {
    const src = await toProgressive(blob);
    const info = await readMp4(src);
    const r = await editMp4(src, { start: 0, end: info.duration, textTracks: tracks }, info);
    return new Blob([r.blob], { type: blob.type || 'video/mp4' });
}

/* ---------------- Kayıpsız birleştirme ---------------- */

const sameBytes = (a, b) => a.length === b.length && a.every((v, i) => v === b[i]);

/**
 * Birleştirme için önemli kodek ayarları: görüntüde kodek yapılandırması (avcC/hvcC/vpcC/av1C:
 * SPS/PPS) ve ölçü, seste kodek + örnekleme hızı + kanal sayısı. Bit hızı gibi alanlar önemsiz.
 */
function codecKey(t) {
    const st = t.stsd;
    const entry = boxes(st, 16, st.length)[0];
    if (!entry) return '';
    if (t.handler === 'vide') {
        const config = boxes(st, entry.start + 8 + 78, entry.end).find((x) => /^(avcC|hvcC|vpcC|av1C)$/.test(x.type));
        return `${entry.type}|${Math.round(t.width)}x${Math.round(t.height)}|${config ? Array.from(st.subarray(config.body, config.end)).join(',') : ''}`;
    }
    const channels = (st[entry.start + 8 + 16] << 8) | st[entry.start + 8 + 17];
    const rate = u32(st, entry.start + 8 + 24) >>> 16;
    return `${entry.type}|${channels}|${rate}|${t.timescale}`;
}

/** Örnek açıklamasının kodek ve çözünürlük özeti ("avc1 640×360", "mp4a"). */
function codecOf(t) {
    const entry = t.stsd.subarray(16);
    const fourcc4 = String.fromCharCode(entry[4], entry[5], entry[6], entry[7]);
    return t.handler === 'vide' ? `${fourcc4} ${Math.round(t.width)}×${Math.round(t.height)}` : fourcc4;
}

/**
 * Parçalar kayıpsız birleştirilebilir mi? Aynı izler, aynı kodek ve ayarlar gerekir.
 * @returns {Promise<{ok: boolean, reason?: string, infos: object[], blobs: Blob[], duration: number}>}
 */
export async function checkConcat(sources) {
    const blobs = [];
    const infos = [];
    for (const b of sources) {
        const p = await toProgressive(b);
        blobs.push(p);
        infos.push(await readMp4(p));
    }
    const duration = infos.reduce((n, i) => n + i.duration, 0);
    const first = infos[0];
    for (let k = 1; k < infos.length; k++) {
        const info = infos[k];
        const handlers = (x) => x.tracks.map((t) => t.handler).sort().join(',');
        if (handlers(info) !== handlers(first)) return { ok: false, reason: `${k + 1}. parçada ses/görüntü izleri farklı`, infos, blobs, duration };
        for (const t of info.tracks) {
            const ref = first.tracks.find((x) => x.handler === t.handler);
            if (codecKey(t) !== codecKey(ref)) {
                return { ok: false, reason: `${k + 1}. parça farklı ayarlarla kaydedilmiş (${codecOf(t)} / ${codecOf(ref)})`, infos, blobs, duration };
            }
        }
    }
    return { ok: true, infos, blobs, duration };
}

/** Uygun parçaları tek MP4'te birleştirir (yeniden kodlamaz). */
export async function concatMp4(sources) {
    const check = await checkConcat(sources);
    if (!check.ok) throw new Error(check.reason);
    const { infos, blobs } = check;
    // Tek sanal dosya: parçalar art arda; konumlar her parçanın başlangıcı kadar kaydırılır.
    const combined = new Blob(blobs);
    const bases = [];
    let pos = 0;
    for (const b of blobs) {
        bases.push(pos);
        pos += b.size;
    }
    const tracks = infos[0].tracks.map((ref) => {
        const parts = infos.map((info, k) => ({ t: info.tracks.find((x) => x.handler === ref.handler), k }));
        const count = parts.reduce((n, p) => n + p.t.count, 0);
        const out = {
            ...ref, count,
            sizes: new Uint32Array(count), dts: new Float64Array(count), durs: new Uint32Array(count), offsets: new Float64Array(count),
            ctts: ref.ctts ? new Int32Array(count) : null, sync: ref.sync ? new Uint8Array(count) : null
        };
        let i = 0;
        let time = 0;
        for (const { t, k } of parts) {
            // Her parça, en uzun izi kadar yer kaplar: ses/görüntü kaymasın diye son örnek uzatılır.
            const fileDur = infos[k].duration * t.timescale;
            const scale = ref.timescale / t.timescale;
            for (let j = 0; j < t.count; j++, i++) {
                out.sizes[i] = t.sizes[j];
                out.offsets[i] = t.offsets[j] + bases[k];
                out.dts[i] = time;
                let d = Math.round(t.durs[j] * scale);
                if (j === t.count - 1) {
                    const used = t.dts[j] - t.dts[0] - (j === 0 ? 0 : 0);
                    const pad = Math.round((fileDur - (t.dts[j] + t.durs[j] - t.dts[0])) * scale);
                    if (pad > 0 && pad < ref.timescale * 2) d += pad;
                    void used;
                }
                out.durs[i] = d;
                time += d;
                if (out.ctts) out.ctts[i] = t.ctts ? Math.round(t.ctts[j] * scale) : 0;
                if (out.sync) out.sync[i] = t.sync ? t.sync[j] : 1;
            }
        }
        out.duration = time / ref.timescale;
        return out;
    });
    const info = { tracks, movieScale: 1000, duration: Math.max(...tracks.map((t) => t.duration)) };
    const r = await editMp4(combined, { start: 0, end: info.duration }, info);
    return r;
}
