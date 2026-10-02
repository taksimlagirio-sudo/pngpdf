// Oynatıcının MediaSource'a eklediği akışları (her SourceBuffer bir dosya) tek, sarılabilir bir
// MP4'te birleştirir. Oynatıcılar görüntü ve sesi çoğu zaman ayrı SourceBuffer'lara parçalı MP4
// (fMP4) olarak ekler; her akışın init segmenti ve parçaları uygulamanın mp4mux.mjs kurucusuna
// verilir: tekrar eklenen parçalar atılır, zaman çizelgesi 0'dan başlar. Veri yeniden kodlanmaz.
import fs from 'node:fs';
import { Mp4Builder } from '../assets/js/mp4mux.mjs';

const HEADER_READ = 16;

function readAt(fd, offset, length) {
    const buf = Buffer.alloc(length);
    const n = fs.readSync(fd, buf, 0, length, offset);
    return n === length ? buf : buf.subarray(0, n);
}

/** Dosyadaki üst düzey kutular; yarım kalan son kutu atlanır. */
function topLevelBoxes(fd, fileSize) {
    const list = [];
    let pos = 0;
    while (pos + 8 <= fileSize) {
        const head = readAt(fd, pos, HEADER_READ);
        let size = head.readUInt32BE(0);
        const type = head.toString('latin1', 4, 8);
        if (size === 1) size = Number(head.readBigUInt64BE(8));
        else if (size === 0) size = fileSize - pos;
        if (size < 8 || pos + size > fileSize || !/^[\x20-\x7e]{4}$/.test(type)) break;
        list.push({ type, offset: pos, size });
        pos += size;
    }
    return list;
}

const u8 = (buf) => new Uint8Array(buf.buffer, buf.byteOffset, buf.byteLength);

/**
 * @param {{file: string, mime: string}[]} streams  SourceBuffer başına yakalanan dosyalar
 * @param {string} outFile
 * @returns {Promise<{ext: string, duration?: number, warning?: string}>}
 */
export async function mergeFmp4(streams, outFile) {
    const webm = streams.filter((s) => /webm/i.test(s.mime));
    if (webm.length) {
        // WebM akışları olduğu gibi yazılır; ayrı ses/görüntü WebM birleştirilmez.
        const video = webm.find((s) => /video/i.test(s.mime)) || webm[0];
        fs.copyFileSync(video.file, outFile);
        return { ext: 'webm', warning: webm.length > 1 ? 'Ses ayrı bir WebM akışındaydı; yalnızca görüntü kaydedildi' : '' };
    }

    const out = fs.openSync(outFile, 'w');
    let pos = 0;
    const builder = new Mp4Builder({
        write: async (bytes) => {
            fs.writeSync(out, bytes, 0, bytes.length, pos);
            pos += bytes.length;
        }
    });
    try {
        await builder.start();
        for (const [index, stream] of streams.entries()) {
            const fd = fs.openSync(stream.file, 'r');
            try {
                const boxes = topLevelBoxes(fd, fs.fstatSync(fd).size);
                const id = `sb${index}`;
                for (let i = 0; i < boxes.length; i++) {
                    const b = boxes[i];
                    if (b.type === 'moov') {
                        builder.addInit(id, u8(readAt(fd, b.offset, b.size)));
                    } else if (b.type === 'moof') {
                        const next = boxes[i + 1];
                        if (!next || next.type !== 'mdat') continue;
                        // moof + mdat birlikte verilir (örnek konumları moof'a göredir).
                        await builder.addFragment(id, u8(readAt(fd, b.offset, b.size + next.size)));
                        i++;
                    }
                }
            } finally {
                fs.closeSync(fd);
            }
        }
        const result = await builder.finish();
        fs.writeSync(out, result.patch.bytes, 0, result.patch.bytes.length, result.patch.position);
        return { ext: result.hasVideo ? 'mp4' : 'm4a', duration: result.duration };
    } finally {
        fs.closeSync(out);
    }
}
