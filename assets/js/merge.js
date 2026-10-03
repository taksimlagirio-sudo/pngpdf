// Ayrı gelen görüntü ve ses dosyalarını (DASH/YouTube biçimi: parçalı MP4) tek, ileri-geri
// sarılabilir MP4'te birleştirir. Veri yeniden kodlanmaz; dosyalar akarken işlenir, bellek dolmaz.
import { formatSize, smartFetch, hms } from './util.js';
import { Mp4Builder } from './mp4mux.mjs';

/** Akıştan üst düzey MP4 kutularını sırayla verir ({type, bytes}); `bytes` bir sonraki kutuda geçersizleşir. */
async function* boxes(response, signal, onBytes) {
    const reader = response.body.getReader();
    let store = new Uint8Array(1 << 20);
    let start = 0;
    let end = 0;
    const append = (chunk) => {
        if (end + chunk.length > store.length) {
            const used = end - start;
            const next = store.length >= used + chunk.length && start > 0
                ? store
                : new Uint8Array(Math.max(store.length * 2, used + chunk.length));
            if (next === store) store.copyWithin(0, start, end);
            else next.set(store.subarray(start, end));
            store = next;
            start = 0;
            end = used;
        }
        store.set(chunk, end);
        end += chunk.length;
    };
    // Tampondaki ilk kutunun boyutu (bilinmiyorsa 0).
    const boxSize = () => {
        if (end - start < 8) return 0;
        const dv = new DataView(store.buffer, start, end - start);
        let size = dv.getUint32(0);
        if (size === 1) {
            if (end - start < 16) return 0;
            size = Number(dv.getBigUint64(8));
        }
        if (size !== 0 && size < 8) throw new Error('Dosya MP4 değil');
        return size;
    };
    let ended = false;
    try {
        for (;;) {
            let size = boxSize();
            while (!ended && (!size || end - start < size)) {
                if (signal.aborted) throw new DOMException('Aborted', 'AbortError');
                const { done, value } = await reader.read();
                if (done) ended = true;
                else {
                    onBytes(value.length);
                    append(value);
                }
                size = boxSize();
            }
            if (end - start < 8) return;
            if (size === 0) size = end - start; // "dosya sonuna kadar"
            if (end - start < size) return; // yarım kalan son kutu
            const type = String.fromCharCode(store[start + 4], store[start + 5], store[start + 6], store[start + 7]);
            yield { type, bytes: store.subarray(start, start + size) };
            start += size;
        }
    } finally {
        reader.cancel().catch(() => {});
    }
}

/**
 * @param {{job: any, videoUrl: string, audioUrl: string, name: string, mode?: string, size?: number,
 *   createSinkFor: (name: string, mime: string) => Promise<any>}} options
 */
export async function downloadMerged({ job, videoUrl, audioUrl, name, mode = 'auto', size = 0, createSinkFor }) {
    const local = new AbortController();
    job.signal.addEventListener('abort', () => local.abort(), { once: true });
    const signal = local.signal;

    job.setDetail('Bağlanılıyor...');
    const [video, audio] = await Promise.all([videoUrl, audioUrl].map((url) => smartFetch(url, { mode, init: { signal } })));
    const total = (Number(video.headers.get('content-length')) || 0) + (Number(audio.headers.get('content-length')) || 0) || size;

    const sink = await createSinkFor(`${name}.mp4`, 'video/mp4');
    job.name = sink.name || `${name}.mp4`;
    const builder = new Mp4Builder({ write: (bytes) => sink.write(bytes) });
    let received = 0;
    const onBytes = (n) => {
        received += n;
        job.addBytes(n);
        job.progress(received, total);
    };

    try {
        await builder.start();
        for (const [id, res] of [['v', video], ['a', audio]]) {
            job.setDetail(id === 'v' ? 'Görüntü indiriliyor' : 'Ses indiriliyor ve birleştiriliyor');
            let fragments = 0;
            let moof = null;
            for await (const box of boxes(res, signal, onBytes)) {
                if (box.type === 'moov') builder.addInit(id, box.bytes.slice());
                else if (box.type === 'moof') moof = box.bytes.slice();
                else if (box.type === 'mdat' && moof) {
                    const both = new Uint8Array(moof.length + box.bytes.length);
                    both.set(moof);
                    both.set(box.bytes, moof.length);
                    await builder.addFragment(id, both);
                    moof = null;
                    fragments++;
                    if (id === 'v' && fragments % 20 === 0) job.setDetail(`Görüntü indiriliyor · ${hms(builder.duration)}`);
                }
            }
            if (!fragments) throw new Error('Görüntü ve ses bu biçimde birleştirilemiyor (parçalı MP4 değil)');
        }
        const result = await builder.finish();
        await sink.patch(result.patch.position, result.patch.bytes);
        const blob = await sink.close();
        if (blob) job.attachResult(blob);
        job.done([hms(result.duration), formatSize(blob ? blob.size : received), 'ses birleştirildi'].join(' · '));
    } catch (err) {
        local.abort();
        await sink.abort();
        throw err;
    }
}
