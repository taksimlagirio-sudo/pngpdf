// assets/js/util.js'teki DOM-bağımsız yardımcıların uzantı içi kopyası.
// Chrome uzantıları paket kökünün dışındaki dosyaları yükleyemediği için
// (chrome-extension://.../../assets/... engellenir) burada kendi kopyamız duruyor.

export function formatSize(bytes) {
    if (!bytes || bytes < 0) return '0 B';
    const k = 1024;
    const sizes = ['B', 'KB', 'MB', 'GB'];
    const i = Math.min(Math.floor(Math.log(bytes) / Math.log(k)), sizes.length - 1);
    return Math.round(bytes / Math.pow(k, i) * 100) / 100 + ' ' + sizes[i];
}

export function escapeHtml(str) {
    return String(str).replace(/[&<>"']/g, (c) => (
        { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]
    ));
}

export function fileNameFromUrl(rawUrl, forcedExt) {
    let name = 'download';
    try {
        const path = new URL(rawUrl, location.href).pathname;
        const last = decodeURIComponent(path.split('/').filter(Boolean).pop() || '');
        if (last) name = last;
    } catch (_) { /* geçersiz URL: varsayılan ad */ }

    name = name.replace(/[\\/:*?"<>|]+/g, '_').slice(0, 120) || 'download';

    if (forcedExt) {
        name = name.replace(/\.[a-z0-9]{1,5}$/i, '');
        name = `${name}.${forcedExt}`;
    }
    return name;
}

export function isHttpUrl(value) {
    try {
        const u = new URL(value);
        return u.protocol === 'http:' || u.protocol === 'https:';
    } catch (_) {
        return false;
    }
}

export function loadImage(blob) {
    return new Promise((resolve, reject) => {
        const url = URL.createObjectURL(blob);
        const img = new Image();
        img.onload = () => { URL.revokeObjectURL(url); resolve(img); };
        img.onerror = () => { URL.revokeObjectURL(url); reject(new Error('Resim okunamadı')); };
        img.src = url;
    });
}

export function drawToCanvas(img, maxWidth = 0) {
    let { width, height } = img;
    if (maxWidth > 0 && width > maxWidth) {
        height = Math.round(height * (maxWidth / width));
        width = maxWidth;
    }
    const canvas = document.createElement('canvas');
    canvas.width = width;
    canvas.height = height;
    canvas.getContext('2d').drawImage(img, 0, 0, width, height);
    return canvas;
}

export function canvasToBlob(canvas, type, quality) {
    return new Promise((resolve, reject) => {
        canvas.toBlob((blob) => (blob ? resolve(blob) : reject(new Error('Dönüştürme başarısız'))), type, quality);
    });
}
