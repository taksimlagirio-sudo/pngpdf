// Sekme 1: Resim -> PDF (mevcut davranış korunur, indirme butonu eklendi)
import { $, formatSize, sleep, escapeHtml, loadImage, saveBlob, fileNameFromUrl } from './util.js';
import { createJob } from './downloads.js';

export function initPdfTab() {
    const dropZone = $('pdfDropZone');
    const fileInput = $('pdfFileInput');
    const fileList = $('pdfFileList');
    const qualityControl = $('pdfQualityControl');
    const qualitySlider = $('pdfQualitySlider');
    const qualityValue = $('pdfQualityValue');
    const qualityDesc = $('pdfQualityDesc');
    const actions = $('pdfActions');
    const clearBtn = $('pdfClearBtn');
    const convertAllBtn = $('pdfConvertAllBtn');

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

    qualitySlider.addEventListener('input', (e) => {
        const val = parseInt(e.target.value, 10);
        qualityValue.textContent = val + '%';
        if (val < 40) {
            qualityDesc.textContent = '📦 Küçük dosya (düşük kalite)';
        } else if (val < 70) {
            qualityDesc.textContent = '⚖️ Dengeli (orta kalite)';
        } else {
            qualityDesc.textContent = '🎨 Yüksek kalite (büyük dosya)';
        }
    });

    clearBtn.addEventListener('click', () => {
        files.forEach(releaseFile);
        files = [];
        render();
    });

    convertAllBtn.addEventListener('click', async () => {
        convertAllBtn.disabled = true;
        for (const item of files.slice()) {
            if (item.status !== 'success') {
                await convertToPdf(item.id, false);
                await sleep(200);
            }
        }
        convertAllBtn.disabled = false;
    });

    // Liste butonları dinamik üretildiği için olay delegasyonu kullanılıyor.
    fileList.addEventListener('click', (e) => {
        const btn = e.target.closest('button[data-action]');
        if (!btn) return;
        const { action, id } = btn.dataset;
        if (action === 'convert') convertToPdf(id, true);
        if (action === 'download') downloadPdf(id);
        if (action === 'remove') removeFile(id);
    });

    function addFiles(newFiles) {
        newFiles.forEach((file) => {
            files.push({
                id: Math.random().toString(36).substring(2),
                file,
                name: file.name,
                size: formatSize(file.size),
                preview: URL.createObjectURL(file),
                status: 'ready',
                pdfBlob: null,
                pdfUrl: null
            });
        });
        render();
    }

    function releaseFile(item) {
        URL.revokeObjectURL(item.preview);
        if (item.pdfUrl) URL.revokeObjectURL(item.pdfUrl);
    }

    function removeFile(id) {
        const item = files.find((f) => f.id === id);
        if (item) releaseFile(item);
        files = files.filter((f) => f.id !== id);
        render();
    }

    function downloadPdf(id) {
        const item = files.find((f) => f.id === id);
        if (!item || !item.pdfBlob) return;
        const outName = fileNameFromUrl(item.name, 'pdf');
        saveBlob(item.pdfBlob, outName);

        const job = createJob(outName, { thumb: item.preview, kind: 'file' });
        job.attachResult(item.pdfBlob);
        job.done(formatSize(item.pdfBlob.size));
    }

    function render() {
        if (files.length === 0) {
            fileList.innerHTML = '<div class="empty-state"><div class="empty-state-icon">🎨</div><p>Henüz resim eklenmedi</p></div>';
            qualityControl.classList.add('hidden');
            actions.style.display = 'none';
            return;
        }

        qualityControl.classList.remove('hidden');
        actions.style.display = 'flex';

        fileList.innerHTML = files.map((f) => {
            const converting = f.status === 'converting';
            const disabled = converting ? 'disabled' : '';
            let mainButtons;

            if (f.status === 'success') {
                mainButtons = `
                    <a href="${f.pdfUrl}" target="_blank" rel="noopener" class="btn btn-primary success" style="text-decoration:none;">🔗 Aç</a>
                    <button class="btn btn-secondary" data-action="download" data-id="${f.id}">⬇️ İndir</button>`;
            } else {
                mainButtons = `<button class="btn btn-primary" data-action="convert" data-id="${f.id}" ${disabled}>${converting ? '⏳...' : '📄 PDF'}</button>`;
            }

            return `
                <div class="file-item" data-id="${f.id}">
                    <div class="file-info">
                        <img src="${f.preview}" alt="${escapeHtml(f.name)}" class="file-preview">
                        <div class="file-details">
                            <div class="file-name">${escapeHtml(f.name)}</div>
                            <div class="file-size">${f.size}</div>
                        </div>
                    </div>
                    <div class="file-actions">
                        ${mainButtons}
                        <button class="btn btn-danger" data-action="remove" data-id="${f.id}" ${disabled}>✕</button>
                    </div>
                </div>`;
        }).join('');
    }

    async function convertToPdf(id, openTab) {
        const item = files.find((f) => f.id === id);
        if (!item || item.status === 'converting') return;

        item.status = 'converting';
        render();

        try {
            const { jsPDF } = window.jspdf;
            const img = await loadImage(item.file);
            const quality = parseInt(qualitySlider.value, 10) / 100;

            const canvas = document.createElement('canvas');
            canvas.width = img.naturalWidth;
            canvas.height = img.naturalHeight;
            const ctx = canvas.getContext('2d');
            // JPEG'in alfa kanalı yok; şeffaf PNG'ler siyah olmasın diye zemin beyaz.
            ctx.fillStyle = '#ffffff';
            ctx.fillRect(0, 0, canvas.width, canvas.height);
            ctx.drawImage(img, 0, 0);
            const compressed = canvas.toDataURL('image/jpeg', quality);

            // 96 DPI kabulüyle mm karşılığı
            const mmWidth = (canvas.width / 96) * 25.4;
            const mmHeight = (canvas.height / 96) * 25.4;

            const pdf = new jsPDF({
                orientation: mmHeight > mmWidth ? 'portrait' : 'landscape',
                unit: 'mm',
                format: [mmWidth, mmHeight],
                compress: true
            });
            pdf.addImage(compressed, 'JPEG', 0, 0, mmWidth, mmHeight);

            const blob = pdf.output('blob');
            item.pdfBlob = blob;
            item.pdfUrl = URL.createObjectURL(blob);
            item.status = 'success';

            if (openTab) window.open(item.pdfUrl, '_blank');
            render();
        } catch (error) {
            console.error('PDF hatası:', error);
            alert('Hata: ' + item.name);
            item.status = 'ready';
            render();
        }
    }

    render();
}
