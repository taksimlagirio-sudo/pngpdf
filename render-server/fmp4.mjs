// Oynatıcının MediaSource'a eklediği akışları (her SourceBuffer bir dosya) tek bir oynatılabilir
// dosyada birleştirir. Oynatıcılar görüntü ve sesi çoğu zaman ayrı SourceBuffer'lara parçalı MP4
// (fMP4) olarak ekler; burada iki iz tek moov altında toplanır, parçalar zamana göre sıralanıp
// araya katılır. Kalite değişiminde gelen farklı init segmentlerinden en uzun süreli olan seçilir,
// tekrar eklenen (aynı zamanlı) parçalar atılır. Veri yeniden kodlanmaz.
import fs from 'node:fs';

const HEADER_READ = 16;
const COPY_CHUNK = 4 * 1024 * 1024;

/* ---------------- Kutu okuma ---------------- */

function readAt(fd, offset, length) {
    const buf = Buffer.alloc(length);
    const n = fs.readSync(fd, buf, 0, length, offset);
    return n === length ? buf : buf.subarray(0, n);
}

/** Dosyadaki üst düzey kutuları (tür, konum, boyut) sırayla listeler; yarım kalan son kutu atlanır. */
function topLevelBoxes(fd, fileSize) {
    const list = [];
    let pos = 0;
    while (pos + 8 <= fileSize) {
        const head = readAt(fd, pos, HEADER_READ);
        let size = head.readUInt32BE(0);
        const type = head.toString('latin1', 4, 8);
        let hdr = 8;
        if (size === 1) {
            size = Number(head.readBigUInt64BE(8));
            hdr = 16;
        } else if (size === 0) {
            size = fileSize - pos;
        }
        if (size < hdr || pos + size > fileSize || !/^[\x20-\x7e]{4}$/.test(type)) break;
        list.push({ type, offset: pos, size, hdr });
        pos += size;
    }
    return list;
}

/** Bellekteki kutunun çocukları. */
function children(buf, start = 8, end = buf.length) {
    const out = [];
    let pos = start;
    while (pos + 8 <= end) {
        let size = buf.readUInt32BE(pos);
        const type = buf.toString('latin1', pos + 4, pos + 8);
        let hdr = 8;
        if (size === 1) {
            size = Number(buf.readBigUInt64BE(pos + 8));
            hdr = 16;
        } else if (size === 0) {
            size = end - pos;
        }
        if (size < hdr || pos + size > end) break;
        out.push({ type, start: pos, end: pos + size, hdr });
        pos += size;
    }
    return out;
}

const child = (buf, box, type) => children(buf, box.start + box.hdr, box.end).find((c) => c.type === type);
const rootBox = (buf) => ({ type: buf.toString('latin1', 4, 8), start: 0, end: buf.length, hdr: 8 });

function box(type, ...parts) {
    const size = 8 + parts.reduce((n, p) => n + p.length, 0);
    const head = Buffer.alloc(8);
    head.writeUInt32BE(size, 0);
    head.write(type, 4, 'latin1');
    return Buffer.concat([head, ...parts]);
}

/* ---------------- moov / moof çözümleme ---------------- */

function describeMoov(moov) {
    const root = rootBox(moov);
    const traks = children(moov, 8).filter((c) => c.type === 'trak');
    const mvex = child(moov, root, 'mvex');
    const trexes = mvex ? children(moov, mvex.start + 8, mvex.end).filter((c) => c.type === 'trex') : [];
    const tracks = traks.map((trak) => {
        const mdia = child(moov, trak, 'mdia');
        const mdhd = mdia && child(moov, mdia, 'mdhd');
        const hdlr = mdia && child(moov, mdia, 'hdlr');
        const tkhd = child(moov, trak, 'tkhd');
        const version = mdhd ? moov[mdhd.start + 8] : 0;
        const timescale = mdhd ? moov.readUInt32BE(mdhd.start + (version === 1 ? 28 : 20)) : 90000;
        const tkVersion = moov[tkhd.start + 8];
        return {
            trak,
            id: moov.readUInt32BE(tkhd.start + (tkVersion === 1 ? 28 : 20)),
            handler: hdlr ? moov.toString('latin1', hdlr.start + 16, hdlr.start + 20) : '',
            timescale
        };
    });
    const latin = moov.toString('latin1');
    return {
        mvhd: child(moov, root, 'mvhd'),
        tracks,
        trexes,
        encrypted: /encv|enca|pssh|tenc/.test(latin)
    };
}

/** moof içindeki her traf için konumlar ve ilk zaman damgası. */
function describeMoof(moof) {
    const root = rootBox(moof);
    const mfhd = child(moof, root, 'mfhd');
    const trafs = children(moof, 8).filter((c) => c.type === 'traf').map((traf) => {
        const tfhd = child(moof, traf, 'tfhd');
        const tfdt = child(moof, traf, 'tfdt');
        let time = null;
        if (tfdt) {
            time = moof[tfdt.start + 8] === 1
                ? Number(moof.readBigUInt64BE(tfdt.start + 12))
                : moof.readUInt32BE(tfdt.start + 12);
        }
        return { tfhd, tfdt, trackId: moof.readUInt32BE(tfhd.start + 12), time };
    });
    return { mfhd, trafs };
}

/** Bir SourceBuffer dosyasını init segmentlerine (dönemlere) ve parçalara ayırır. */
function parseStream(file) {
    const fd = fs.openSync(file, 'r');
    const size = fs.fstatSync(fd).size;
    const boxes = topLevelBoxes(fd, size);
    const periods = [];
    let current = null;
    let ftyp = null;
    for (let i = 0; i < boxes.length; i++) {
        const b = boxes[i];
        if (b.type === 'ftyp') {
            ftyp = ftyp || readAt(fd, b.offset, b.size);
        } else if (b.type === 'moov') {
            const moov = readAt(fd, b.offset, b.size);
            current = { moov, info: describeMoov(moov), fragments: [] };
            periods.push(current);
        } else if (b.type === 'moof' && current) {
            const next = boxes[i + 1];
            if (!next || next.type !== 'mdat') continue;
            const moof = readAt(fd, b.offset, b.size);
            const info = describeMoof(moof);
            if (!info.trafs.length || info.trafs.some((t) => t.time === null)) continue;
            current.fragments.push({ moof, info, mdat: { offset: next.offset, size: next.size }, fd });
            i++;
        }
    }
    return { fd, ftyp, periods };
}

/* ---------------- Birleştirme ---------------- */

/**
 * @param {{file: string, mime: string}[]} streams  SourceBuffer başına yakalanan dosyalar
 * @param {string} outFile
 * @returns {Promise<{ext: string, warning?: string}>}
 */
export async function mergeFmp4(streams, outFile) {
    const webm = streams.filter((s) => /webm/i.test(s.mime));
    if (webm.length) {
        // WebM akışları olduğu gibi yazılır; ayrı ses/görüntü WebM birleştirilmez.
        const video = webm.find((s) => /video/i.test(s.mime)) || webm[0];
        fs.copyFileSync(video.file, outFile);
        return {
            ext: /audio/i.test(video.mime) ? 'webm' : 'webm',
            warning: webm.length > 1 ? 'Ses ayrı bir WebM akışındaydı; yalnızca görüntü kaydedildi' : ''
        };
    }

    const parsed = streams.map((s) => ({ ...parseStream(s.file), mime: s.mime }));
    try {
        // Her akıştan iz(ler): en çok parçası olan dönem seçilir.
        const tracks = [];
        let ftyp = null;
        for (const stream of parsed) {
            if (!stream.periods.length) continue;
            const best = stream.periods.reduce((a, b) => (b.fragments.length > a.fragments.length ? b : a));
            if (!best.fragments.length) continue;
            if (best.info.encrypted) throw new Error('Yayın DRM ile şifreli; kaydedilemez');
            ftyp = ftyp || stream.ftyp;
            tracks.push({ period: best, info: best.info });
        }
        if (!tracks.length) throw new Error('Oynatılabilir video verisi yakalanamadı');

        // Tek akış: olduğu gibi (birden çok iz içerse bile) yazılır, yalnızca tekrarlar atılır.
        // Birden çok akış: her akışın tek izi yeni bir kimlikle (1, 2, ...) ortak moov'a girer.
        const single = tracks.length === 1;
        const out = [];
        const fragments = [];
        let nextId = 1;
        let hasVideo = false;

        for (const t of tracks) {
            const moov = t.period.moov;
            const idMap = new Map();
            const trakBufs = [];
            for (const tr of t.info.tracks) {
                const newId = single ? tr.id : nextId++;
                idMap.set(tr.id, { newId, timescale: tr.timescale });
                if (tr.handler === 'vide') hasVideo = true;
                const trak = Buffer.from(moov.subarray(tr.trak.start, tr.trak.end));
                if (!single) {
                    const tkhd = child(trak, rootBox(trak), 'tkhd');
                    trak.writeUInt32BE(newId, tkhd.start + (trak[tkhd.start + 8] === 1 ? 28 : 20));
                }
                trakBufs.push(trak);
            }
            const trexBufs = t.info.trexes.map((trex) => {
                const buf = Buffer.from(moov.subarray(trex.start, trex.end));
                const old = buf.readUInt32BE(12);
                if (idMap.has(old)) buf.writeUInt32BE(idMap.get(old).newId, 12);
                return buf;
            });
            t.trakBufs = trakBufs;
            t.trexBufs = trexBufs;
            t.mvhd = moov.subarray(t.info.mvhd.start, t.info.mvhd.end);

            // Aynı zamanlı tekrar parçaları at, zamana göre sırala.
            const seen = new Set();
            for (const f of t.period.fragments) {
                const first = f.info.trafs[0];
                const key = `${first.trackId}:${first.time}`;
                if (seen.has(key)) continue;
                seen.add(key);
                const ts = idMap.get(first.trackId)?.timescale || 90000;
                fragments.push({ ...f, idMap, sec: first.time / ts });
            }
        }

        // Zaman damgalarını sıfırdan başlat (yayın ortasından gelen büyük değerler oynatıcıları şaşırtmasın).
        const startSec = Math.min(...fragments.map((f) => f.sec));
        fragments.sort((a, b) => a.sec - b.sec);

        const mvhd = Buffer.from(tracks[0].mvhd);
        mvhd.writeUInt32BE(single ? mvhd.readUInt32BE(mvhd.length - 4) : nextId, mvhd.length - 4);
        const moovOut = box('moov', mvhd, ...tracks.flatMap((t) => t.trakBufs), box('mvex', ...tracks.flatMap((t) => t.trexBufs)));
        const ftypOut = ftyp || box('ftyp', Buffer.from('isom', 'latin1'), Buffer.from([0, 0, 2, 0]), Buffer.from('isomiso6mp41', 'latin1'));

        const ws = fs.createWriteStream(outFile);
        const write = (chunk) => new Promise((resolve, reject) => ws.write(chunk, (err) => (err ? reject(err) : resolve())));
        await write(ftypOut);
        await write(moovOut);

        let seq = 1;
        for (const f of fragments) {
            const moof = Buffer.from(f.moof);
            if (f.info.mfhd) moof.writeUInt32BE(seq++, f.info.mfhd.start + 12);
            for (const traf of f.info.trafs) {
                const mapped = f.idMap.get(traf.trackId);
                if (!mapped) continue;
                moof.writeUInt32BE(mapped.newId, traf.tfhd.start + 12);
                if (traf.tfdt) {
                    const shift = Math.round(startSec * mapped.timescale);
                    const value = Math.max(0, traf.time - shift);
                    if (moof[traf.tfdt.start + 8] === 1) moof.writeBigUInt64BE(BigInt(value), traf.tfdt.start + 12);
                    else moof.writeUInt32BE(value >>> 0, traf.tfdt.start + 12);
                }
            }
            await write(moof);
            // mdat olduğu gibi kopyalanır (büyük olabilir; parça parça).
            for (let pos = 0; pos < f.mdat.size; pos += COPY_CHUNK) {
                await write(readAt(f.fd, f.mdat.offset + pos, Math.min(COPY_CHUNK, f.mdat.size - pos)));
            }
        }
        await new Promise((resolve) => ws.end(resolve));
        return { ext: hasVideo ? 'mp4' : 'm4a' };
    } finally {
        for (const p of parsed) fs.closeSync(p.fd);
    }
}
