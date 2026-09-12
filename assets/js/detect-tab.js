// "Algıla" sekmesi: adresteki içeriği tanır ve uygun indirme yolunu sunar.
import { $, escapeHtml, isHttpUrl, formatSize, createProgress } from './util.js';
import { analyzeUrl, formatDuration } from './detect.js';
import { downloadFile } from './video.js';
import { downloadHls } from './hls.js';
import { canSaveToDisk, canBackgroundFetch, isThumbInUse } from './downloads.js';

const KIND_LABELS = {
    video: { icon: '🎬', label: 'Video' },
    audio: { icon: '🎵', label: 'Ses' },
    image: { icon: '🖼️', label: 'Resim' },
    hls: { icon: '📡', label: 'HLS yayını' },
    dash: { icon: '📡', label: 'DASH yayını' },
    document: { icon: '📄', label: 'Belge' },
    archive: { icon: '🗜️', label: 'Arşiv' },
    page: { icon: '🌐', label: 'Web sayfası' },
    unknown: { icon: '❓', label: 'Bilinmeyen tür' }
};

export function initDetectTab() {
    const urlInput = $('detectUrl');
    const modeSelect = $('detectMode');
    const diskCheck = $('detectToDisk');
    const bgCheck = $('detectBackground');
    const analyzeBtn = $('detectBtn');
    const pasteBtn = $('detectPasteBtn');
    const resultBox = $('detectResult');
    const progress = createProgress('detectProgress');

    let current = null;
    let previewUrl = null;

    if (!canSaveToDisk) {
        const row = $('detectDiskRow');
        row.classList.add('unsupported');
        row.title = 'Bu tarayıcı doğrudan diske yazmayı desteklemiyor; dosya indirilenler klasörüne kaydedilir.';
        diskCheck.disabled = true;
    }
    if (!canBackgroundFetch) {
        const row = $('detectBgRow');
        row.classList.add('unsupported');
        row.title = 'Bu tarayıcı arka plan indirmeyi desteklemiyor; indirme uygulama açıkken sürer.';
        bgCheck.disabled = true;
    }

    analyzeBtn.addEventListener('click', () => analyze(urlInput.value.trim()));
    urlInput.addEventListener('keydown', (e) => {
        if (e.key === 'Enter') analyze(urlInput.value.trim());
    });

    pasteBtn.addEventListener('click', async () => {
        try {
            const text = await navigator.clipboard.readText();
            if (text) {
                urlInput.value = text.trim();
                analyze(urlInput.value);
            }
        } catch (_) {
            progress.show('Algılama');
            progress.setDetail('Pano okunamadı; adresi elle yapıştırın.', true);
        }
    });

    resultBox.addEventListener('click', async (e) => {
        const btn = e.target.closest('button[data-act]');
        if (!btn) return;
        const { act } = btn.dataset;

        if (act === 'analyze-link') return analyze(btn.dataset.url);
        if (act === 'to-image') {
            $('imgUrlInput').value = current.url;
            location.hash = '#image';
            $('imgUrlBtn').click();
            return;
        }
        if (act === 'download') return startDownload(current, btn.dataset.url || current.url);
    });

    /** Adresi analiz eder ve sonucu kartta gösterir. */
    async function analyze(url) {
        if (!isHttpUrl(url)) {
            progress.show('Algılama');
            progress.setDetail('Geçerli bir http(s) adresi girin.', true);
            return;
        }

        analyzeBtn.disabled = true;
        resultBox.innerHTML = '';
        progress.show('Algılanıyor...');
        progress.set(null);

        try {
            const info = await analyzeUrl(url, {
                mode: modeSelect.value,
                onStage: (text) => progress.setDetail(text)
            });
            // Önizleme indirme çubuğunda küçük resim olarak kullanılıyorsa serbest bırakma.
            if (previewUrl && !isThumbInUse(previewUrl)) URL.revokeObjectURL(previewUrl);
            previewUrl = info.previewUrl || null;
            current = info;
            progress.hide();
            renderResult(info);
        } catch (err) {
            console.error(err);
            progress.setTitle('❌ Algılanamadı');
            progress.set(0);
            progress.setDetail(
                `${err.message}. Site doğrudan erişime kapalıysa "Proxy" modunu deneyin.`,
                true
            );
        } finally {
            analyzeBtn.disabled = false;
        }
    }

    function renderResult(info) {
        const meta = KIND_LABELS[info.kind] || KIND_LABELS.unknown;
        const rows = [];

        rows.push(['Format', info.format + (info.headerType ? ` (${info.headerType})` : '')]);
        // HLS'te content-length yalnızca playlist metnini gösterir; yanıltmamak için atlanır.
        if (info.target !== 'hls') rows.push(['Boyut', info.sizeText]);
        if (info.details.width) rows.push(['Çözünürlük', `${info.details.width}x${info.details.height}`]);
        if (info.details.duration) rows.push(['Süre', formatDuration(info.details.duration)]);
        if (info.details.segments) rows.push(['Parça sayısı', String(info.details.segments)]);
        if (info.details.container) rows.push(['Kapsayıcı', info.details.container]);
        if (info.details.encryption) rows.push(['Şifreleme', info.details.encryption]);
        if (info.details.live) rows.push(['Yayın tipi', 'Canlı']);
        if (info.kind !== 'hls') rows.push(['Parçalı indirme', info.resumable ? 'destekleniyor' : 'bilinmiyor']);
        rows.push(['Kaydedilecek ad', info.suggestedName]);

        const preview = info.previewUrl
            ? `<img src="${info.previewUrl}" alt="önizleme" class="detect-preview">`
            : `<div class="detect-preview placeholder">${meta.icon}</div>`;

        const warnings = info.warnings.map((w) => `<div class="notice">⚠️ ${escapeHtml(w)}</div>`).join('');

        let actions = '';
        if (info.downloadable) {
            actions = `<button class="btn btn-primary" data-act="download">⬇️ ${escapeHtml(info.suggestedName)} indir</button>`;
            if (info.kind === 'image') {
                actions += `<button class="btn btn-secondary" data-act="to-image">🎨 Formatını değiştir</button>`;
            }
        }

        let variants = '';
        if (info.details.variants && info.details.variants.length) {
            variants = `<div class="variant-list">${info.details.variants.map((v) => `
                <button class="variant" data-act="download" data-url="${escapeHtml(v.url)}">
                    <span><strong>${escapeHtml(v.resolution || 'bilinmeyen çözünürlük')}</strong>${
                        v.bandwidth ? ' • ' + (v.bandwidth / 1000000).toFixed(2) + ' Mbps' : ''
                    }</span><span>⬇️</span>
                </button>`).join('')}</div>`;
        }

        let links = '';
        if (info.details.links) {
            links = info.details.links.length
                ? `<p class="hint">Sayfada bulunan medya bağlantıları:</p><div class="variant-list">${
                    info.details.links.map((l) => `
                        <button class="variant" data-act="analyze-link" data-url="${escapeHtml(l.url)}">
                            <span>${l.kind === 'hls' ? '📡' : '🎬'} ${escapeHtml(l.url.slice(0, 80))}</span><span>🔎</span>
                        </button>`).join('')
                }</div>`
                : '<p class="hint">Sayfa kaynağında doğrudan medya bağlantısı bulunamadı.</p>';
        }

        resultBox.innerHTML = `
            <div class="detect-card">
                ${preview}
                <div class="detect-body">
                    <div class="detect-kind">${info.previewUrl ? meta.icon + ' ' : ''}${meta.label}${info.details.summary ? ` • ${escapeHtml(info.details.summary)}` : ''}</div>
                    <div class="detect-url">${escapeHtml(info.url)}</div>
                    <dl class="detect-rows">
                        ${rows.map(([k, v]) => `<div><dt>${escapeHtml(k)}</dt><dd>${escapeHtml(String(v))}</dd></div>`).join('')}
                    </dl>
                </div>
            </div>
            ${warnings}
            ${variants}
            ${links}
            <div class="actions">${actions}</div>`;
    }

    /** Algılanan türe göre doğru indiriciye yönlendirir. */
    async function startDownload(info, url) {
        const isHls = info.target === 'hls';
        progress.show('İndiriliyor...');
        progress.set(null);

        try {
            if (isHls) {
                const result = await downloadHls({
                    url,
                    name: info.suggestedName,
                    thumb: info.previewUrl || null,
                    mode: modeSelect.value,
                    toDisk: diskCheck.checked,
                    background: bgCheck.checked,
                    onStage: (text) => progress.setDetail(text),
                    onProgress: (done, total, bytes, speed) => {
                        progress.setTitle(`Parçalar indiriliyor (${done}/${total})`);
                        progress.set(done / total);
                        progress.setDetail(`${formatSize(bytes)} • ${speed}`);
                    }
                });

                if (result.type === 'master') {
                    progress.setTitle('Kalite seçin');
                    progress.set(1);
                    progress.setDetail('Aşağıdan bir kalite seçin.');
                    current = { ...info, details: { ...info.details, variants: result.variants } };
                    renderResult(current);
                    return;
                }
                finish(result.type === 'background'
                    ? 'Arka planda iniyor; bitince alt çubuktan kaydedin.'
                    : `${result.segments} parça • ${formatSize(result.bytes)}`);
            } else {
                const result = await downloadFile({
                    url,
                    name: info.suggestedName,
                    mime: info.mime,
                    size: info.size,
                    thumb: info.previewUrl || null,
                    kind: info.kind,
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
                            progress.setDetail(`${formatSize(got)} • ${speed}`);
                        }
                    }
                });
                finish(result.mode === 'background'
                    ? 'Arka planda iniyor; bitince alt çubuktan kaydedin.'
                    : result.detail);
            }
        } catch (err) {
            if (err.name === 'AbortError') {
                progress.setTitle('İptal edildi');
                progress.setDetail('İndirme durduruldu.');
            } else {
                console.error(err);
                progress.setTitle('❌ Başarısız');
                progress.set(0);
                progress.setDetail(err.message, true);
            }
        }
    }

    function finish(detail) {
        progress.setTitle('✅ Tamamlandı');
        progress.set(1);
        progress.setDetail(detail || '');
    }

    /** Paylaşım hedefi (?url=) veya kısayolla gelen adresi doldurur. */
    return {
        prefill(url, autoStart) {
            urlInput.value = url;
            if (autoStart) analyze(url);
        }
    };
}
