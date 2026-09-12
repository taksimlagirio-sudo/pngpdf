// Doğrudan dosya (MP4 vb.) indirme — hem "MP4" sekmesi hem algılama sekmesi kullanır.
import {
    $, formatSize, isHttpUrl, smartFetch, fileNameFromUrl,
    createProgress, pumpToSink, formatSpeed, formatEta, proxyUrl, probeAccess
} from './util.js';
import { createJob, createSink, startBackgroundDownload, canBackgroundFetch } from './downloads.js';

/**
 * Tek bir dosyayı indirir.
 * `background` seçiliyse ve tarayıcı destekliyorsa indirme service worker'a devredilir:
 * uygulama kapansa bile sürer, bitince alt çubukta "Kaydet" olarak belirir.
 * Diske doğrudan yazma (toDisk) kullanıcı hareketi gerektirdiği için ilk iş olarak yapılır.
 */
export async function downloadFile({
    url, name, mode = 'auto', toDisk = false, background = false, thumb = null, kind = 'file',
    mime = 'application/octet-stream', size = 0, onProgress = () => {}, onStage = () => {}
}) {
    if (!isHttpUrl(url)) throw new Error('Geçerli bir http(s) adresi girin.');
    const fileName = name || fileNameFromUrl(url);

    if (background && canBackgroundFetch && !toDisk) {
        // Arka plan indirmesi service worker'dan yapılır; CORS'a kapalı kaynaklar proxy üzerinden verilir.
        onStage('Kaynak yoklanıyor...');
        const access = await probeAccess(url, mode);
        const job = await startBackgroundDownload({
            urls: [access === 'proxy' ? proxyUrl(url) : url],
            name: fileName,
            total: size,
            thumb,
            kind
        });
        if (job) {
            if (access === 'proxy') {
                job.setDetail('Arka planda (proxy üzerinden) indiriliyor — çok büyük dosyalarda zaman aşımı olabilir.');
            }
            onStage('Arka planda indiriliyor — uygulamayı kapatabilirsiniz.');
            return { mode: 'background', access };
        }
    }

    const sink = await createSink(fileName, { toDisk, mime });
    const controller = new AbortController();
    const job = createJob(fileName, { onCancel: () => controller.abort(), thumb, kind });
    const started = Date.now();

    try {
        onStage('Bağlanılıyor...');
        const res = await smartFetch(url, {
            mode,
            init: { signal: controller.signal },
            onFallback: () => onStage('Doğrudan erişilemedi (CORS), proxy deneniyor...')
        });

        const received = await pumpToSink(res, sink, (got, total) => {
            job.progress(got, total);
            job.setDetail(total
                ? `${formatSize(got)} / ${formatSize(total)} • ${formatSpeed(got, started)} ${formatEta(got, total, started)}`
                : `${formatSize(got)} • ${formatSpeed(got, started)}`);
            onProgress(got, total, formatSpeed(got, started));
        }, controller.signal);

        const blob = await sink.close();
        if (blob) job.attachResult(blob);
        const detail = `${formatSize(received)}${sink.mode === 'disk' ? ' • diske yazıldı' : ''}`;
        job.done(detail);
        return { mode: sink.mode, size: received, name: sink.name, detail, blob };
    } catch (err) {
        await sink.abort();
        if (err.name === 'AbortError') {
            job.cancel();
            throw err;
        }
        job.fail(err.message);
        throw err;
    }
}

export function initVideoTab() {
    const urlInput = $('mp4Url');
    const nameInput = $('mp4Name');
    const modeSelect = $('mp4Mode');
    const diskCheck = $('mp4ToDisk');
    const bgCheck = $('mp4Background');
    const startBtn = $('mp4StartBtn');
    const openBtn = $('mp4OpenBtn');
    const progress = createProgress('mp4Progress');

    openBtn.addEventListener('click', () => {
        const url = urlInput.value.trim();
        if (!isHttpUrl(url)) {
            progress.show('İndirme');
            progress.setDetail('Geçerli bir http(s) adresi girin.', true);
            return;
        }
        window.open(modeSelect.value === 'proxy' ? proxyUrl(url) : url, '_blank', 'noopener');
    });

    startBtn.addEventListener('click', () => start());
    urlInput.addEventListener('keydown', (e) => {
        if (e.key === 'Enter') start();
    });

    async function start() {
        const url = urlInput.value.trim();
        if (!isHttpUrl(url)) {
            progress.show('İndirme');
            progress.setDetail('Geçerli bir http(s) adresi girin.', true);
            return;
        }

        startBtn.disabled = true;
        progress.show('İndiriliyor...');
        progress.set(null);

        try {
            const result = await downloadFile({
                url,
                name: nameInput.value.trim() || undefined,
                mode: modeSelect.value,
                toDisk: diskCheck.checked,
                background: bgCheck.checked,
                onStage: (text) => progress.setDetail(text),
                onProgress: (got, total, speed) => {
                    if (total > 0) {
                        progress.set(got / total);
                        progress.setDetail(`${formatSize(got)} / ${formatSize(total)} • ${speed}`);
                    } else {
                        progress.set(null);
                        progress.setDetail(`${formatSize(got)} indirildi • ${speed}`);
                    }
                }
            });

            progress.set(1);
            if (result.mode === 'background') {
                progress.setTitle('📥 Arka planda');
                progress.setDetail('İndirme arka planda sürüyor; bitince alt çubuktan kaydedin.');
            } else {
                progress.setTitle('✅ Tamamlandı');
                progress.setDetail(result.detail);
            }
        } catch (err) {
            if (err.name === 'AbortError') {
                progress.setTitle('İptal edildi');
                progress.setDetail('İndirme durduruldu.');
            } else {
                console.error(err);
                progress.setTitle('❌ Başarısız');
                progress.set(0);
                progress.setDetail(
                    `${err.message}. Kaynak site izin vermiyorsa "Proxy" modunu veya "Tarayıcıda aç" seçeneğini deneyin.`,
                    true
                );
            }
        } finally {
            startBtn.disabled = false;
        }
    }
}
