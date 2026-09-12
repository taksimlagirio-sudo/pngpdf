// Sekme 3: Doğrudan dosya (MP4 vb.) indirici
import {
    $, formatSize, isHttpUrl, smartFetch, saveBlob, fileNameFromUrl,
    createProgress, readWithProgress, proxyUrl
} from './util.js';

export function initVideoTab() {
    const urlInput = $('mp4Url');
    const nameInput = $('mp4Name');
    const modeSelect = $('mp4Mode');
    const startBtn = $('mp4StartBtn');
    const cancelBtn = $('mp4CancelBtn');
    const openBtn = $('mp4OpenBtn');
    const progress = createProgress('mp4Progress');

    let controller = null;

    startBtn.addEventListener('click', () => start());
    urlInput.addEventListener('keydown', (e) => {
        if (e.key === 'Enter') start();
    });

    cancelBtn.addEventListener('click', () => {
        if (controller) controller.abort();
    });

    // Tarayıcıya devretme: CORS'un tamamen kapalı olduğu adresler için kaçış yolu.
    openBtn.addEventListener('click', () => {
        const url = urlInput.value.trim();
        if (!isHttpUrl(url)) {
            progress.show('İndirme');
            progress.setDetail('Geçerli bir http(s) adresi girin.', true);
            return;
        }
        window.open(modeSelect.value === 'proxy' ? proxyUrl(url) : url, '_blank', 'noopener');
    });

    async function start() {
        const url = urlInput.value.trim();
        if (!isHttpUrl(url)) {
            progress.show('İndirme');
            progress.setDetail('Geçerli bir http(s) adresi girin.', true);
            return;
        }

        controller = new AbortController();
        setBusy(true);
        progress.show('İndiriliyor...');
        progress.set(null);
        progress.setDetail('Bağlanılıyor...');

        const started = Date.now();

        try {
            const res = await smartFetch(url, {
                mode: modeSelect.value,
                init: { signal: controller.signal },
                onFallback: () => progress.setDetail('Doğrudan erişilemedi (CORS), proxy deneniyor...')
            });

            const data = await readWithProgress(res, (received, total) => {
                const seconds = (Date.now() - started) / 1000;
                const speed = seconds > 0 ? formatSize(received / seconds) + '/sn' : '';
                if (total > 0) {
                    progress.set(received / total);
                    progress.setDetail(`${formatSize(received)} / ${formatSize(total)} • ${speed}`);
                } else {
                    progress.set(null);
                    progress.setDetail(`${formatSize(received)} indirildi • ${speed}`);
                }
            }, controller.signal);

            const type = res.headers.get('content-type') || 'application/octet-stream';
            const customName = nameInput.value.trim();
            const fileName = customName || fileNameFromUrl(url);

            saveBlob(new Blob([data], { type }), fileName);
            progress.set(1);
            progress.setTitle('✅ Tamamlandı');
            progress.setDetail(`${fileName} • ${formatSize(data.length)}`);
        } catch (err) {
            if (err.name === 'AbortError') {
                progress.setTitle('İptal edildi');
                progress.setDetail('İndirme kullanıcı tarafından durduruldu.');
            } else {
                console.error(err);
                progress.setTitle('❌ Başarısız');
                progress.setDetail(
                    `${err.message}. Kaynak site indirmeye izin vermiyorsa "Proxy" modunu veya "Tarayıcıda aç" seçeneğini deneyin.`,
                    true
                );
            }
        } finally {
            controller = null;
            setBusy(false);
        }
    }

    function setBusy(busy) {
        startBtn.disabled = busy;
        cancelBtn.style.display = busy ? 'flex' : 'none';
    }

    setBusy(false);
}
