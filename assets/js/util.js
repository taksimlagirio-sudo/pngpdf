// Tüm sekmelerin ortak kullandığı yardımcılar.

export const $ = (id) => document.getElementById(id);

export function formatSize(bytes) {
    if (!bytes || bytes < 0) return '0 B';
    const k = 1024;
    const sizes = ['B', 'KB', 'MB', 'GB'];
    const i = Math.min(Math.floor(Math.log(bytes) / Math.log(k)), sizes.length - 1);
    return Math.round(bytes / Math.pow(k, i) * 100) / 100 + ' ' + sizes[i];
}

export function sleep(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
}

export function escapeHtml(str) {
    return String(str).replace(/[&<>"']/g, (c) => (
        { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]
    ));
}

// Blob'u kullanıcının diskine indirir.
export function saveBlob(blob, filename) {
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = filename;
    a.style.display = 'none';
    document.body.appendChild(a);
    a.click();
    a.remove();
    // Safari indirmeyi başlatana kadar URL'nin yaşaması gerekiyor.
    setTimeout(() => URL.revokeObjectURL(url), 60000);
}

// URL'den dosya adı üretir; uzantı verilirse zorlar.
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

// Netlify function'ı üzerinden CORS engelini aşmak için proxy adresi.
export function proxyUrl(target) {
    return `/api/proxy?url=${encodeURIComponent(target)}`;
}

/**
 * Önce doğrudan, CORS hatası alırsa proxy üzerinden dener.
 * `mode` "direct" | "proxy" | "auto" olabilir.
 */
export async function smartFetch(url, { mode = 'auto', init = {}, onFallback } = {}) {
    if (mode !== 'proxy') {
        try {
            const res = await fetch(url, init);
            if (res.ok || res.status === 206) return res;
            if (mode === 'direct') {
                throw new Error(`Sunucu ${res.status} döndü`);
            }
        } catch (err) {
            if (mode === 'direct') throw err;
            if (onFallback) onFallback(err);
        }
    }

    const res = await fetch(proxyUrl(url), init);
    if (!res.ok && res.status !== 206) {
        let detail = '';
        try {
            const body = await res.clone().json();
            detail = body && body.error ? `: ${body.error}` : '';
        } catch (_) { /* gövde JSON değil */ }
        throw new Error(`İndirilemedi (HTTP ${res.status})${detail}`);
    }
    return res;
}

// Basit ilerleme kutusu denetleyicisi.
export function createProgress(boxId) {
    const box = $(boxId);
    const bar = box.querySelector('.progress-bar');
    const percent = box.querySelector('.progress-percent');
    const title = box.querySelector('.progress-title');
    const detail = box.querySelector('.progress-detail');

    return {
        box,
        show(titleText) {
            box.classList.remove('hidden');
            title.textContent = titleText || 'İşleniyor...';
            detail.textContent = '';
            detail.classList.remove('error');
            this.set(0);
        },
        hide() {
            box.classList.add('hidden');
        },
        set(ratio) {
            if (ratio === null) {
                bar.classList.add('indeterminate');
                percent.textContent = '';
                return;
            }
            bar.classList.remove('indeterminate');
            const pct = Math.max(0, Math.min(100, Math.round(ratio * 100)));
            bar.style.width = pct + '%';
            bar.classList.toggle('complete', pct === 100);
            percent.textContent = pct + '%';
        },
        setTitle(text) {
            title.textContent = text;
        },
        setDetail(text, isError = false) {
            detail.textContent = text;
            detail.classList.toggle('error', isError);
        }
    };
}

/**
 * Gövdeyi parça parça okuyup ilerleme bildirir.
 * Content-Length yoksa ilerleme belirsiz (null) olarak raporlanır.
 */
export async function readWithProgress(response, onProgress, signal) {
    const total = Number(response.headers.get('content-length')) || 0;

    if (!response.body || typeof response.body.getReader !== 'function') {
        const buf = await response.arrayBuffer();
        onProgress(buf.byteLength, total || buf.byteLength);
        return new Uint8Array(buf);
    }

    const reader = response.body.getReader();
    const chunks = [];
    let received = 0;

    try {
        for (;;) {
            if (signal && signal.aborted) throw new DOMException('Aborted', 'AbortError');
            const { done, value } = await reader.read();
            if (done) break;
            chunks.push(value);
            received += value.length;
            onProgress(received, total);
        }
    } catch (err) {
        try { await reader.cancel(); } catch (_) { /* akış zaten kapalı */ }
        throw err;
    }

    const out = new Uint8Array(received);
    let offset = 0;
    for (const chunk of chunks) {
        out.set(chunk, offset);
        offset += chunk.length;
    }
    return out;
}

// Blob/File -> HTMLImageElement
export function loadImage(blob) {
    return new Promise((resolve, reject) => {
        const url = URL.createObjectURL(blob);
        const img = new Image();
        img.onload = () => {
            URL.revokeObjectURL(url);
            resolve(img);
        };
        img.onerror = () => {
            URL.revokeObjectURL(url);
            reject(new Error('Resim okunamadı'));
        };
        img.src = url;
    });
}

// Resmi (gerekirse küçülterek) canvas'a çizer.
export function drawToCanvas(img, maxWidth = 0) {
    let { width, height } = img;
    if (maxWidth > 0 && width > maxWidth) {
        height = Math.round(height * (maxWidth / width));
        width = maxWidth;
    }
    const canvas = document.createElement('canvas');
    canvas.width = width;
    canvas.height = height;
    const ctx = canvas.getContext('2d');
    ctx.drawImage(img, 0, 0, width, height);
    return canvas;
}

export function canvasToBlob(canvas, type, quality) {
    return new Promise((resolve, reject) => {
        canvas.toBlob(
            (blob) => (blob ? resolve(blob) : reject(new Error('Dönüştürme başarısız'))),
            type,
            quality
        );
    });
}

/**
 * Yanıt gövdesini parça parça hedefe yazar (belleği doldurmadan).
 * Content-Length yoksa toplam 0 raporlanır.
 */
export async function pumpToSink(response, sink, onProgress = () => {}, signal) {
    const total = Number(response.headers.get('content-length')) || 0;
    let received = 0;

    if (!response.body || typeof response.body.getReader !== 'function') {
        const buf = new Uint8Array(await response.arrayBuffer());
        await sink.write(buf);
        onProgress(buf.length, total || buf.length);
        return buf.length;
    }

    const reader = response.body.getReader();
    try {
        for (;;) {
            if (signal && signal.aborted) throw new DOMException('Aborted', 'AbortError');
            const { done, value } = await reader.read();
            if (done) break;
            await sink.write(value);
            received += value.length;
            onProgress(received, total);
        }
    } catch (err) {
        try { await reader.cancel(); } catch (_) { /* akış zaten kapalı */ }
        throw err;
    }
    return received;
}

export function formatSpeed(bytes, startedAt) {
    const seconds = (Date.now() - startedAt) / 1000;
    return seconds > 0.2 ? formatSize(bytes / seconds) + '/sn' : '';
}
