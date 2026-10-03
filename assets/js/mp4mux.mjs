// Parçalı MP4 (fMP4) akışlarından tek, normal (sarılabilir) bir MP4 üretir.
//
// Neden: HLS/oynatıcı verisi fMP4 parçalarıdır. Parçaları uç uca eklemek dosyayı oynatır ama başta
// toplam süre olmaz, zaman damgaları yayının kendi saatinden (ör. 2 saattir yayında) gelir;
// telefonlar süreyi yanlış gösterir ve ileri-geri sarılamaz. Burada her örneğin (kare/ses paketi)
// verisi mdat'a yazılır, konumu/süresi tablolara (stts, stsz, stco, stss...) kaydedilir; en sonda
// sıfırdan başlayan zaman çizelgesiyle moov yazılır. Ayrı gelen ses ve görüntü izleri de böylece
// tek dosyada birleşir. Veri yeniden kodlanmaz.
//
// Tarayıcıda ve render-server'da (Node) aynı dosya kullanılır; DOM ya da Node API'si kullanmaz.

const TEXT = new TextEncoder();

/* ---------------- Okuma ---------------- */

const u32 = (b, o) => ((b[o] << 24) | (b[o + 1] << 16) | (b[o + 2] << 8) | b[o + 3]) >>> 0;
const u16 = (b, o) => (b[o] << 8) | b[o + 1];
const i32 = (b, o) => (b[o] << 24) | (b[o + 1] << 16) | (b[o + 2] << 8) | b[o + 3];
const u64 = (b, o) => u32(b, o) * 4294967296 + u32(b, o + 4);
const fourcc = (b, o) => String.fromCharCode(b[o], b[o + 1], b[o + 2], b[o + 3]);

/** b[start..end) içindeki kutular. Yarım kalan kutuda durur. */
export function boxesIn(b, start = 0, end = b.length) {
    const out = [];
    let p = start;
    while (p + 8 <= end) {
        let size = u32(b, p);
        const type = fourcc(b, p + 4);
        let hdr = 8;
        if (size === 1) {
            size = u64(b, p + 8);
            hdr = 16;
        } else if (size === 0) {
            size = end - p;
        }
        if (size < hdr || p + size > end) break;
        out.push({ type, start: p, end: p + size, hdr, body: p + hdr });
        p += size;
    }
    return out;
}

const childrenOf = (b, box, skip = 0) => boxesIn(b, box.body + skip, box.end);
const find = (b, box, type, skip = 0) => childrenOf(b, box, skip).find((c) => c.type === type);
const findAll = (b, box, type) => childrenOf(b, box).filter((c) => c.type === type);
const slice = (b, box) => b.slice(box.start, box.end);

/* ---------------- Yazma ---------------- */

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

function be(n, bytes) {
    const out = new Uint8Array(bytes);
    let v = n;
    for (let i = bytes - 1; i >= 0; i--) {
        out[i] = v % 256;
        v = Math.floor(v / 256);
    }
    return out;
}
const w8 = (n) => Uint8Array.of(n & 255);
const w16 = (n) => be(n, 2);
const w32 = (n) => be(n >>> 0, 4);
const w64 = (n) => be(n, 8);
const wi32 = (n) => be(n < 0 ? n + 4294967296 : n, 4);

function box(type, ...parts) {
    const body = concat(parts);
    return concat([w32(body.length + 8), TEXT.encode(type), body]);
}

function fullbox(type, version, flags, ...parts) {
    return box(type, w8(version), be(flags, 3), ...parts);
}

const MATRIX = concat([w32(0x10000), w32(0), w32(0), w32(0), w32(0x10000), w32(0), w32(0), w32(0), w32(0x40000000)]);

/** Büyüyebilen sayı dizisi (çok sayıda örnek için bellek dostu). */
class Grow {
    constructor(Type = Uint32Array) {
        this.Type = Type;
        this.a = new Type(1024);
        this.n = 0;
    }
    push(v) {
        if (this.n === this.a.length) {
            const next = new this.Type(this.a.length * 2);
            next.set(this.a);
            this.a = next;
        }
        this.a[this.n++] = v;
    }
}

/* ---------------- Birleştirici ---------------- */

const MOVIE_TIMESCALE = 1000;

/**
 * Kullanım:
 *   const mux = new Mp4Builder({ write: async (bytes) => ... });
 *   await mux.start();
 *   mux.addInit('video', initBytes); await mux.addFragment('video', segmentBytes); ...
 *   const { moov, patch } = await mux.finish();  // moov zaten yazıldı
 *   // patch: { position, bytes } — dosyanın başındaki mdat boyutu; hedefte o konuma yazılmalı.
 */
export class Mp4Builder {
    /**
     * @param {{write: (bytes: Uint8Array) => Promise<void>}} sink
     * @param {{alignStartsOver?: number}} [options]  izlerin başlangıçları bu kadar saniyeden fazla
     *   ayrıksa (zaman damgaları farklı tabanlardan) hepsi aynı anda başlatılır
     */
    constructor({ write }, { alignStartsOver = 0 } = {}) {
        this.alignStartsOver = alignStartsOver;
        this.writeOut = write;
        this.pos = 0;
        this.tracks = new Map(); // "akış:izNo" → iz
        this.order = [];
        this.mdatStart = 0;
        this.lock = Promise.resolve();
    }

    async write(bytes) {
        this.pos += bytes.length;
        await this.writeOut(bytes);
    }

    async start() {
        // ftyp ve mdat başlığı tek parça yazılır: hedef ilk parçayı sonradan yamayabilsin.
        // mdat boyutu en sonda belli olur; 64 bit "largesize" alanı ayrılır.
        const ftyp = box('ftyp', TEXT.encode('isom'), w32(512), TEXT.encode('isomiso2avc1mp41'));
        this.mdatStart = ftyp.length;
        await this.write(concat([ftyp, w32(1), TEXT.encode('mdat'), w64(0)]));
    }

    get hasSamples() {
        return this.order.some((t) => t.sizes.n > 0);
    }

    get hasVideo() {
        return this.order.some((t) => t.handler === 'vide' && t.sizes.n > 0);
    }

    /** Medya süresi (sn): örneği en uzun iz. */
    get duration() {
        let max = 0;
        for (const t of this.order) {
            if (t.sizes.n) max = Math.max(max, (t.nextDts - t.firstDts) / t.timescale);
        }
        return max;
    }

    /** Init segmenti (ftyp+moov) ekler; aynı akışta yeni init gelirse (kalite değişimi) sürdürür. */
    addInit(streamId, bytes) {
        const moov = boxesIn(bytes).find((x) => x.type === 'moov');
        if (!moov) return;
        const mvex = find(bytes, moov, 'mvex');
        const trex = new Map();
        if (mvex) {
            for (const t of findAll(bytes, mvex, 'trex')) {
                trex.set(u32(bytes, t.body + 4), {
                    desc: u32(bytes, t.body + 8),
                    dur: u32(bytes, t.body + 12),
                    size: u32(bytes, t.body + 16),
                    flags: u32(bytes, t.body + 20)
                });
            }
        }
        for (const trak of findAll(bytes, moov, 'trak')) {
            const tkhd = find(bytes, trak, 'tkhd');
            const v = bytes[tkhd.body];
            const id = u32(bytes, tkhd.body + (v === 1 ? 20 : 12));
            const mdia = find(bytes, trak, 'mdia');
            const mdhd = find(bytes, mdia, 'mdhd');
            const mv = bytes[mdhd.body];
            const timescale = u32(bytes, mdhd.body + (mv === 1 ? 20 : 12));
            const language = u16(bytes, mdhd.body + (mv === 1 ? 32 : 20));
            const hdlr = find(bytes, mdia, 'hdlr');
            const handler = fourcc(bytes, hdlr.body + 8);
            const minf = find(bytes, mdia, 'minf');
            const stbl = find(bytes, minf, 'stbl');
            const stsd = find(bytes, stbl, 'stsd');
            const entries = boxesIn(bytes, stsd.body + 8, stsd.end).map((e) => slice(bytes, e));
            if (entries.some((e) => /encv|enca/.test(fourcc(e, 4)))) {
                throw new Error('Yayın DRM ile şifreli; kaydedilemez');
            }
            const mediaHeader = childrenOf(bytes, minf).find((c) => /^(vmhd|smhd|hmhd|nmhd|sthd)$/.test(c.type));
            const key = `${streamId}:${id}`;
            let track = this.tracks.get(key);
            if (!track) {
                track = {
                    key, handler, timescale, language,
                    width: u32(bytes, tkhd.end - 8),
                    height: u32(bytes, tkhd.end - 4),
                    hdlr: slice(bytes, hdlr),
                    mediaHeader: mediaHeader ? slice(bytes, mediaHeader) : null,
                    entries: [],
                    desc: 1,
                    trex: null,
                    sizes: new Grow(), durs: new Grow(), ctts: new Grow(Int32Array), sync: new Grow(Uint8Array),
                    chunks: [], firstDts: null, nextDts: 0, rebase: 0, anyCtts: false, anyNonSync: false
                };
                this.tracks.set(key, track);
                this.order.push(track);
            }
            // Aynı örnek tanımı zaten varsa onu kullan, yoksa yeni tanım (ör. farklı çözünürlük) ekle.
            const entry = entries[0];
            let index = track.entries.findIndex((e) => e.length === entry.length && e.every((x, i) => x === entry[i]));
            if (index < 0) {
                track.entries.push(entry);
                index = track.entries.length - 1;
            }
            track.desc = index + 1;
            if (!track.width && u32(bytes, tkhd.end - 8)) {
                track.width = u32(bytes, tkhd.end - 8);
                track.height = u32(bytes, tkhd.end - 4);
            }
            track.trex = trex.get(id) || { desc: 1, dur: 0, size: 0, flags: 0 };
        }
    }

    /**
     * Bir ya da birden çok moof+mdat içeren segmenti ekler. Sıralı çağrılmalı.
     * `shiftSec`: oynatıcının bu parçaya uyguladığı timestampOffset (MSE'de olduğu gibi eklenir).
     */
    addFragment(streamId, bytes, shiftSec = 0) {
        this.lock = this.lock.then(() => this.processFragment(streamId, bytes, shiftSec));
        return this.lock;
    }

    async processFragment(streamId, b, shiftSec = 0) {
        for (const moof of boxesIn(b).filter((x) => x.type === 'moof')) {
            let prevEnd = moof.start;
            let first = true;
            for (const traf of findAll(b, moof, 'traf')) {
                const tfhd = find(b, traf, 'tfhd');
                const tf = u32(b, tfhd.body) & 0xffffff;
                const id = u32(b, tfhd.body + 4);
                const track = this.tracks.get(`${streamId}:${id}`);
                let p = tfhd.body + 8;
                let base = null;
                if (tf & 0x1) { base = u64(b, p); p += 8; }
                if (tf & 0x2) p += 4;
                const defDur = tf & 0x8 ? u32(b, (p += 4) - 4) : track?.trex.dur || 0;
                const defSize = tf & 0x10 ? u32(b, (p += 4) - 4) : track?.trex.size || 0;
                const defFlags = tf & 0x20 ? u32(b, (p += 4) - 4) : track?.trex.flags || 0;
                if (base === null) base = (tf & 0x20000) || first ? moof.start : prevEnd;
                first = false;
                if (!track) continue;

                const tfdt = find(b, traf, 'tfdt');
                let dts = tfdt ? (b[tfdt.body] === 1 ? u64(b, tfdt.body + 4) : u32(b, tfdt.body + 4)) : null;
                if (dts !== null && shiftSec) dts += Math.round(shiftSec * track.timescale);
                let dataPos = base;
                for (const trun of findAll(b, traf, 'trun')) {
                    const version = b[trun.body];
                    const rf = u32(b, trun.body) & 0xffffff;
                    const count = u32(b, trun.body + 4);
                    let q = trun.body + 8;
                    if (rf & 0x1) { dataPos = base + i32(b, q); q += 4; }
                    let firstFlags = null;
                    if (rf & 0x4) { firstFlags = u32(b, q); q += 4; }
                    const samples = [];
                    let runBytes = 0;
                    for (let i = 0; i < count; i++) {
                        const dur = rf & 0x100 ? u32(b, (q += 4) - 4) : defDur;
                        const size = rf & 0x200 ? u32(b, (q += 4) - 4) : defSize;
                        let flags = rf & 0x400 ? u32(b, (q += 4) - 4) : defFlags;
                        if (i === 0 && firstFlags !== null) flags = firstFlags;
                        let cto = 0;
                        if (rf & 0x800) {
                            cto = version === 0 ? u32(b, q) : i32(b, q);
                            q += 4;
                        }
                        samples.push({ dur, size, flags, cto });
                        runBytes += size;
                    }
                    if (dataPos + runBytes > b.length) break; // eksik veri: bu parçayı atla
                    dts = await this.appendRun(track, samples, b.subarray(dataPos, dataPos + runBytes), dts);
                    dataPos += runBytes;
                }
                prevEnd = dataPos;
            }
        }
    }

    /** Ardışık örnekleri zaman çizelgesine ekler ve verisini mdat'a yazar. Sonraki dts'yi döner. */
    async appendRun(track, samples, data, dts) {
        const ts = track.timescale;
        if (dts === null) dts = track.firstDts === null ? 0 : track.nextDts - track.rebase;
        let at = dts + track.rebase;

        if (track.firstDts !== null) {
            const gap = at - track.nextDts;
            if (gap < -10 * ts && at + 10 * ts < track.nextDts) {
                // Zaman damgası geri sıçradı (yayın sayacı sıfırlandı/kesinti): kaldığı yerden sürdür.
                track.rebase += track.nextDts - at;
                at = track.nextDts;
            } else if (gap > 0 && track.durs.n) {
                // Kaçan parça: önceki örneği uzatarak boşluğu kapat (ses-görüntü uyumu korunur).
                // Çok büyük sıçramada (kesinti) yalnızca 1 sn boşluk bırakılıp zaman kaydırılır.
                const fill = gap < 60 * ts ? gap : ts;
                track.durs.a[track.durs.n - 1] += fill;
                track.nextDts += fill;
                if (fill < gap) track.rebase -= gap - fill;
                at = track.nextDts;
            }
        }

        // Daha önce eklenmiş zamanı tekrar eden örnekleri at (oynatıcı aynı parçayı yeniden ekleyebilir).
        let skipBytes = 0;
        let start = 0;
        if (track.firstDts !== null) {
            let t = at;
            while (start < samples.length && t < track.nextDts - 1) {
                t += samples[start].dur;
                skipBytes += samples[start].size;
                start++;
            }
            if (start === samples.length) return dts + samples.reduce((n, s) => n + s.dur, 0);
            at = t;
        }
        if (track.firstDts === null) {
            track.firstDts = at;
            track.nextDts = at;
        }

        const kept = samples.slice(start);
        track.chunks.push({ offset: this.pos, count: kept.length, desc: track.desc });
        for (const s of kept) {
            track.sizes.push(s.size);
            track.durs.push(s.dur);
            track.ctts.push(s.cto);
            if (s.cto) track.anyCtts = true;
            const nonSync = (s.flags >> 16) & 1;
            track.sync.push(nonSync ? 0 : 1);
            if (nonSync) track.anyNonSync = true;
            track.nextDts += s.dur;
        }
        await this.write(skipBytes ? data.subarray(skipBytes) : data);
        return dts + samples.reduce((n, s) => n + s.dur, 0);
    }

    /** moov'u yazar; dosya başındaki mdat boyutu için yapılması gereken yamayı döner. */
    async finish() {
        await this.lock;
        const tracks = this.order.filter((t) => t.sizes.n > 0);
        if (!tracks.length) throw new Error('Kaydedilecek video verisi yok');
        const mdatEnd = this.pos;
        const starts = tracks.map((t) => t.firstDts / t.timescale);
        const startSec = Math.min(...starts);
        // Başlangıçlar çok ayrıksa (ör. görüntü ile sesin zaman tabanı farklı) boşluk bırakılmaz:
        // yoksa ses çalarken görüntü dakikalarca gri kalır.
        const align = this.alignStartsOver > 0 && Math.max(...starts) - startSec > this.alignStartsOver;
        const use64 = mdatEnd > 0xffffffff;

        let movieDur = 0;
        const traks = tracks.map((t, i) => {
            const mediaDur = t.nextDts - t.firstDts;
            const offsetMovie = align ? 0 : Math.round((t.firstDts / t.timescale - startSec) * MOVIE_TIMESCALE);
            const mediaMovie = Math.round((mediaDur / t.timescale) * MOVIE_TIMESCALE);
            const trackMovie = offsetMovie + mediaMovie;
            movieDur = Math.max(movieDur, trackMovie);
            return this.buildTrak(t, i + 1, { mediaDur, offsetMovie, mediaMovie, trackMovie, use64 });
        });

        const mvhd = fullbox('mvhd', 0, 0,
            w32(0), w32(0), w32(MOVIE_TIMESCALE), w32(movieDur), w32(0x10000), w16(0x100), w16(0),
            w32(0), w32(0), MATRIX, new Uint8Array(24), w32(tracks.length + 1));
        const moov = box('moov', mvhd, ...traks);
        await this.write(moov);
        return {
            duration: movieDur / MOVIE_TIMESCALE,
            hasVideo: tracks.some((t) => t.handler === 'vide'),
            patch: { position: this.mdatStart + 8, bytes: w64(mdatEnd - this.mdatStart) }
        };
    }

    buildTrak(t, id, { mediaDur, offsetMovie, mediaMovie, trackMovie, use64 }) {
        const n = t.sizes.n;
        const video = t.handler === 'vide';
        const audio = t.handler === 'soun';
        const tkhd = fullbox('tkhd', 0, 3,
            w32(0), w32(0), w32(id), w32(0), w32(trackMovie), new Uint8Array(8),
            w16(0), w16(0), w16(audio ? 0x100 : 0), w16(0), MATRIX,
            w32(video ? t.width : 0), w32(video ? t.height : 0));

        // B-kareli videoda ilk görüntü ctts kadar geç başlar; edit list ile sıfıra çekilir.
        const firstCto = t.anyCtts ? t.ctts.a[0] : 0;
        const elst = [];
        if (offsetMovie > 0) elst.push([offsetMovie, -1]);
        if (firstCto > 0 || offsetMovie > 0) elst.push([mediaMovie, firstCto]);
        const edts = elst.length
            ? box('edts', fullbox('elst', 0, 0, w32(elst.length),
                ...elst.flatMap(([dur, time]) => [w32(dur), wi32(time), w32(0x10000)])))
            : new Uint8Array(0);

        const mdhd = fullbox('mdhd', 0, 0, w32(0), w32(0), w32(t.timescale), w32(mediaDur), w16(t.language || 0x55c4), w16(0));

        // stts: ardışık eşit süreler tek kayıtta
        const stts = [];
        for (let i = 0; i < n; i++) {
            const d = t.durs.a[i];
            if (stts.length && stts[stts.length - 1][1] === d) stts[stts.length - 1][0]++;
            else stts.push([1, d]);
        }
        const parts = [
            fullbox('stsd', 0, 0, w32(t.entries.length), ...t.entries),
            fullbox('stts', 0, 0, w32(stts.length), ...stts.flatMap(([c, d]) => [w32(c), w32(d)]))
        ];
        if (t.anyCtts) {
            const ctts = [];
            for (let i = 0; i < n; i++) {
                const c = t.ctts.a[i];
                if (ctts.length && ctts[ctts.length - 1][1] === c) ctts[ctts.length - 1][0]++;
                else ctts.push([1, c]);
            }
            parts.push(fullbox('ctts', 1, 0, w32(ctts.length), ...ctts.flatMap(([c, o]) => [w32(c), wi32(o)])));
        }
        if (t.anyNonSync) {
            const sync = [];
            for (let i = 0; i < n; i++) if (t.sync.a[i]) sync.push(w32(i + 1));
            parts.push(fullbox('stss', 0, 0, w32(sync.length), ...sync));
        }
        const stsc = [];
        t.chunks.forEach((c, i) => {
            const last = stsc[stsc.length - 1];
            if (!last || last[1] !== c.count || last[2] !== c.desc) stsc.push([i + 1, c.count, c.desc]);
        });
        parts.push(fullbox('stsc', 0, 0, w32(stsc.length), ...stsc.flatMap((e) => e.map(w32))));
        const sizes = new Uint8Array(n * 4);
        for (let i = 0; i < n; i++) sizes.set(w32(t.sizes.a[i]), i * 4);
        parts.push(fullbox('stsz', 0, 0, w32(0), w32(n), sizes));
        parts.push(use64
            ? fullbox('co64', 0, 0, w32(t.chunks.length), ...t.chunks.map((c) => w64(c.offset)))
            : fullbox('stco', 0, 0, w32(t.chunks.length), ...t.chunks.map((c) => w32(c.offset))));

        const mediaHeader = t.mediaHeader || (video ? fullbox('vmhd', 0, 1, new Uint8Array(8)) : fullbox('smhd', 0, 0, new Uint8Array(4)));
        const dinf = box('dinf', fullbox('dref', 0, 0, w32(1), fullbox('url ', 0, 1)));
        const minf = box('minf', mediaHeader, dinf, box('stbl', ...parts));
        return box('trak', tkhd, edts, box('mdia', mdhd, t.hdlr, minf));
    }
}

/** Init segmentinde görüntü izi var mı? (yalnızca ses olan akışları ayıklamak için) */
export function initHasVideo(bytes) {
    const moov = boxesIn(bytes).find((x) => x.type === 'moov');
    if (!moov) return null;
    return findAll(bytes, moov, 'trak').some((trak) => {
        const mdia = find(bytes, trak, 'mdia');
        const hdlr = mdia && find(bytes, mdia, 'hdlr');
        return hdlr && fourcc(bytes, hdlr.body + 8) === 'vide';
    });
}

/** MPEG-TS parçasında görüntü akışı var mı? PAT → PMT okunur. null: anlaşılamadı. */
export function tsHasVideo(b) {
    const packet = (i) => i * 188;
    let pmtPid = -1;
    for (let i = 0; packet(i) + 188 <= b.length && i < 2000; i++) {
        const p = packet(i);
        if (b[p] !== 0x47) return null;
        const pid = ((b[p + 1] & 0x1f) << 8) | b[p + 2];
        const pusi = b[p + 1] & 0x40;
        const afc = (b[p + 3] >> 4) & 3;
        let o = p + 4;
        if (afc === 2) continue;
        if (afc === 3) o += 1 + b[o];
        if (!pusi) continue;
        o += 1 + b[o]; // pointer field
        if (pid === 0 && pmtPid < 0) {
            const sectionLen = ((b[o + 1] & 0x0f) << 8) | b[o + 2];
            for (let q = o + 8; q < o + 3 + sectionLen - 4; q += 4) {
                if (u16(b, q) !== 0) {
                    pmtPid = u16(b, q + 2) & 0x1fff;
                    break;
                }
            }
        } else if (pid === pmtPid) {
            const sectionLen = ((b[o + 1] & 0x0f) << 8) | b[o + 2];
            const infoLen = ((b[o + 10] & 0x0f) << 8) | b[o + 11];
            const end = o + 3 + sectionLen - 4;
            for (let q = o + 12 + infoLen; q + 5 <= end;) {
                const type = b[q];
                if ([0x01, 0x02, 0x10, 0x1b, 0x24, 0x42, 0xea].includes(type)) return true;
                q += 5 + (((b[q + 3] & 0x0f) << 8) | b[q + 4]);
            }
            return false;
        }
    }
    return null;
}
