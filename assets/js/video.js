// Doğrudan dosya (MP4, MP3, resim...) indirme.
import { formatSize, smartFetch, pumpToSink, proxyUrl, probeAccess, isNetworkError } from './util.js';
import { startBackgroundDownload, canBackgroundFetch } from './downloads.js';

/**
 * Tek bir dosyayı `job` içinde indirir.
 * `background` seçiliyse ve tarayıcı destekliyorsa indirme service worker'a devredilir:
 * uygulama kapansa bile sürer, bitince İndirmeler'de "Kaydet" olarak belirir.
 */
export async function downloadFile({
    job, url, name, mode = 'auto', background = false, mime = 'application/octet-stream', size = 0,
    createSinkFor
}) {
    if (background && canBackgroundFetch && job.saveMode !== 'disk') {
        // CORS'a kapalı kaynaklar arka planda kendi sunucun üzerinden verilir.
        job.setDetail('Kaynak yoklanıyor...');
        const access = await probeAccess(url, mode);
        const started = await startBackgroundDownload({
            urls: [access === 'proxy' ? proxyUrl(url) : url],
            name,
            total: size,
            job,
            // Arka plan takılır veya başarısız olursa indirme normal yoldan sürdürülür.
            fallback: () => downloadFile({ job, url, name, mode, background: false, mime, size, createSinkFor })
        });
        if (started) return;
    }

    const sink = await createSinkFor(name, mime);
    job.name = sink.name || name;
    try {
        job.setDetail('Bağlanılıyor...');
        const res = await smartFetch(url, {
            mode,
            init: { signal: job.signal },
            onFallback: () => job.setDetail('Doğrudan erişilemedi (CORS), kendi sunucun deneniyor...')
        });
        job.setDetail('');
        let base = 0;    // önceki bağlantılarda inen bayt (kaldığı yerden sürdürmede)
        let last = 0;
        let total = Number(res.headers.get('content-length')) || size;
        const resumable = /bytes/i.test(res.headers.get('accept-ranges') || '');
        let current = res;
        let received = 0;
        for (;;) {
            try {
                received = base + await pumpToSink(current, sink, (got, t) => {
                    job.addBytes(base + got - last);
                    last = base + got;
                    job.progress(base + got, total || (t ? base + t : 0) || size);
                }, job.signal);
                break;
            } catch (err) {
                if (!isNetworkError(err) || !resumable || last === 0) throw err;
                // Bağlantı koptu: inen kısım duruyor; bağlantı gelince kalan bayttan istenir.
                base = last;
                await job.waitNetwork();
                const again = await smartFetch(url, { mode, init: { signal: job.signal, headers: { Range: `bytes=${base}-` } } });
                if (again.status !== 206) throw new Error('Kaynak kaldığı yerden vermiyor; yeniden indirilmesi gerekiyor');
                total = total || base + (Number(again.headers.get('content-length')) || 0);
                current = again;
            }
        }

        const blob = await sink.close();
        if (blob) job.attachResult(blob);
        job.done(`${formatSize(received)}${sink.mode === 'disk' ? ' · diske yazıldı' : ''}`);
    } catch (err) {
        await sink.abort();
        throw err;
    }
}
