// Sekme 2: Resim -> JPG / PNG / WEBP dönüştürücü ve indirici
import {
    $, formatSize, escapeHtml, isHttpUrl, smartFetch, saveBlob,
    fileNameFromUrl, loadImage, drawToCanvas, canvasToBlob, createProgress, sleep
} from './util.js';

const FORMATS = {
    jpg: { mime: 'image/jpeg', ext: 'jpg', lossy: true },
    png: { mime: 'image/png', ext: 'png', lossy: false },
    webp: { mime: 'image/webp', ext: 'webp', lossy: true }
};

export function initImageTab() {
    const dropZone = $('imgDropZone');
    const fileInput = $('imgFileInput');
    const fileList = $('imgFileList');
    const formatSelect = $('imgFormat');
    const qualitySlider = $('imgQualitySlider');
    const qualityValue = $('imgQualityValue');
    const qualityField = $('imgQualityField');
    const maxWidthInput = $('imgMaxWidth');
    const urlInput = $('imgUrlInput');
    const urlBtn = $('imgUrlBtn');
    const actions = $('imgActions');
    const clearBtn = $('imgClearBtn');
    const convertAllBtn = $('imgConvertAllBtn');
    const settings = $('imgSettings');
    const progress = createProgress('imgProgress');

    let files = [];

    dropZone.addEventListener('click', () => fileInput.click());

    dropZone.addEventListener('dragover', (e) => {
        e.preventDefault();
        dropZone.classList.add('active');
    });

    dropZone.addEventListener('dragleave', () => dropZone.classList.remove('active'));

    dropZone.addEventListener('drop', (e) => {
        e.preventDefault();
        dropZone.classList.remove('active');
        addFiles(Array.from(e.dataTransfer.files).filter((f) => f.type.startsWith('image/')));
    });

    fileInput.addEventListener('change', (e) => {
        addFiles(Array.from(e.target.files).filter((f) => f.type.startsWith('image/')));
        fileInput.value = '';
    });

    formatSelect.addEventListener('change', () => {
        qualityField.style.display = FORMATS[formatSelect.value].lossy ? 'block' : 'none';
    });

    qualitySlider.addEventListener('input', () => {
        qualityValue.textContent = qualitySlider.value + '%';
    });

    clearBtn.addEventListener('click', () => {
        files.forEach((f) => URL.revokeObjectURL(f.preview));
        files = [];
        render();
    });

    convertAllBtn.addEventListener('click', async () => {
        convertAllBtn.disabled = true;
        for (const item of files.slice()) {
            await convertAndSave(item.id);
            await sleep(250); // tarayıcı çoklu indirmeyi engellemesin
        }
        convertAllBtn.disabled = false;
    });

    urlBtn.addEventListener('click', () => addFromUrl());
    urlInput.addEventListener('keydown', (e) => {
        if (e.key === 'Enter') addFromUrl();
    });

    fileList.addEventListener('click', (e) => {
        const btn = e.target.closest('button[data-action]');
        if (!btn) return;
        if (btn.dataset.action === 'convert') convertAndSave(btn.dataset.id);
        if (btn.dataset.action === 'remove') removeFile(btn.dataset.id);
    });

    async function addFromUrl() {
        const url = urlInput.value.trim();
        if (!isHttpUrl(url)) {
            progress.show('Resim indiriliyor');
            progress.setDetail('Geçerli bir http(s) adresi girin.', true);
            return;
        }

        progress.show('Resim indiriliyor');
        progress.set(null);
        urlBtn.disabled = true;

        try {
            const res = await smartFetch(url, {
                mode: 'auto',
                onFallback: () => progress.setDetail('Doğrudan erişilemedi, proxy deneniyor...')
            });
            const blob = await res.blob();
            if (blob.type && !blob.type.startsWith('image/')) {
                throw new Error(`Bu adres resim değil (${blob.type})`);
            }
            const name = fileNameFromUrl(url);
            addFiles([new File([blob], name, { type: blob.type || 'image/jpeg' })]);
            urlInput.value = '';
            progress.set(1);
            progress.setDetail('Resim listeye eklendi.');
        } catch (err) {
            progress.set(0);
            progress.setDetail(err.message || 'Resim indirilemedi.', true);
        } finally {
            urlBtn.disabled = false;
        }
    }

    function addFiles(newFiles) {
        newFiles.forEach((file) => {
            files.push({
                id: Math.random().toString(36).substring(2),
                file,
                name: file.name,
                size: formatSize(file.size),
                preview: URL.createObjectURL(file),
                status: 'ready',
                resultInfo: ''
            });
        });
        render();
    }

    function removeFile(id) {
        const item = files.find((f) => f.id === id);
        if (item) URL.revokeObjectURL(item.preview);
        files = files.filter((f) => f.id !== id);
        render();
    }

    function render() {
        if (files.length === 0) {
            fileList.innerHTML = '<div class="empty-state"><div class="empty-state-icon">🖼️</div><p>Henüz resim eklenmedi</p></div>';
            settings.classList.add('hidden');
            actions.style.display = 'none';
            return;
        }

        settings.classList.remove('hidden');
        actions.style.display = 'flex';

        const ext = FORMATS[formatSelect.value].ext.toUpperCase();
        fileList.innerHTML = files.map((f) => {
            const busy = f.status === 'converting';
            const label = busy ? '⏳...' : f.status === 'success' ? '✅ Tekrar' : `⬇️ ${ext}`;
            const cls = f.status === 'success' ? 'btn btn-primary success' : 'btn btn-primary';
            return `
                <div class="file-item">
                    <div class="file-info">
                        <img src="${f.preview}" alt="${escapeHtml(f.name)}" class="file-preview">
                        <div class="file-details">
                            <div class="file-name">${escapeHtml(f.name)}</div>
                            <div class="file-size">${f.size}${f.resultInfo ? ' → ' + escapeHtml(f.resultInfo) : ''}</div>
                        </div>
                    </div>
                    <div class="file-actions">
                        <button class="${cls}" data-action="convert" data-id="${f.id}" ${busy ? 'disabled' : ''}>${label}</button>
                        <button class="btn btn-danger" data-action="remove" data-id="${f.id}" ${busy ? 'disabled' : ''}>✕</button>
                    </div>
                </div>`;
        }).join('');
    }

    async function convertAndSave(id) {
        const item = files.find((f) => f.id === id);
        if (!item || item.status === 'converting') return;

        item.status = 'converting';
        render();

        try {
            const format = FORMATS[formatSelect.value];
            const maxWidth = parseInt(maxWidthInput.value, 10) || 0;
            const quality = parseInt(qualitySlider.value, 10) / 100;

            const img = await loadImage(item.file);
            const canvas = drawToCanvas(img, maxWidth);

            if (format.mime === 'image/jpeg') {
                // JPEG şeffaflığı desteklemiyor: zemini beyaza boyayıp resmi yeniden çiz.
                const ctx = canvas.getContext('2d');
                ctx.globalCompositeOperation = 'destination-over';
                ctx.fillStyle = '#ffffff';
                ctx.fillRect(0, 0, canvas.width, canvas.height);
                ctx.globalCompositeOperation = 'source-over';
            }

            const blob = await canvasToBlob(canvas, format.mime, format.lossy ? quality : undefined);
            if (!blob.type.includes(format.ext === 'jpg' ? 'jpeg' : format.ext)) {
                throw new Error(`Tarayıcınız ${format.ext.toUpperCase()} çıktısını desteklemiyor`);
            }

            saveBlob(blob, fileNameFromUrl(item.name, format.ext));
            item.resultInfo = `${formatSize(blob.size)} (${canvas.width}×${canvas.height})`;
            item.status = 'success';
        } catch (err) {
            console.error(err);
            item.status = 'ready';
            progress.show('Dönüştürme');
            progress.set(0);
            progress.setDetail(`${item.name}: ${err.message}`, true);
        }
        render();
    }

    render();
}
