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

/* ---------------- Kendi render sunucusu (render-server/) ---------------- */

const RENDER_KEY = 'indirici.renderServer';

/** Kullanıcının kendi cihazında çalışan render sunucusu ayarı ({url, token}) ya da null. */
export function getRenderServer() {
    try {
        const value = JSON.parse(localStorage.getItem(RENDER_KEY) || 'null');
        if (value && value.url && value.token) return value;
    } catch (_) { /* depolama kapalı veya bozuk */ }
    return null;
}

export function setRenderServer(config) {
    try {
        if (config) {
            localStorage.setItem(RENDER_KEY, JSON.stringify({
                url: config.url.trim().replace(/\/+$/, ''),
                token: config.token.trim()
            }));
        } else {
            localStorage.removeItem(RENDER_KEY);
        }
    } catch (_) { /* depolama kapalı: ayar bu oturumla sınırlı kalmaz */ }
}

async function renderRequest(config, path, init = {}, timeoutMs = 0) {
    // Sunucu hiç yanıt vermezse (kapalı tünel, izin bekleyen istek vb.) sonsuza kadar beklemeyelim.
    const controller = new AbortController();
    const timer = timeoutMs ? setTimeout(() => controller.abort(), timeoutMs) : null;
    if (init.signal) init.signal.addEventListener('abort', () => controller.abort(), { once: true });
    let res;
    try {
        res = await fetch(`${config.url}${path}`, {
            ...init,
            signal: controller.signal,
            headers: { authorization: `Bearer ${config.token}`, ...(init.headers || {}) }
        });
    } catch (err) {
        if (controller.signal.aborted && timer) throw new Error(`${Math.round(timeoutMs / 1000)} saniyede yanıt gelmedi`);
        throw new Error('Sunucuya ulaşılamadı (' + (err.message || 'ağ hatası') + ')');
    } finally {
        if (timer) clearTimeout(timer);
    }
    const body = await res.json().catch(() => ({}));
    if (!res.ok) {
        const err = new Error(body.error || `Sunucu ${res.status} döndü`);
        err.status = res.status;
        throw err;
    }
    return body;
}

/**
 * Uygulama kendi sunucundan açıldıysa (sunucu <html data-local-server="1"> ekler) token'ı
 * sunucudan alıp ayarı kendiliğinden kaydeder; kullanıcının hiçbir şey girmesi gerekmez.
 */
export async function autoConfigureLocalServer() {
    if (document.documentElement.dataset.localServer !== '1') return false;
    try {
        const res = await fetch('local-config', { cache: 'no-store' });
        if (!res.ok) return false;
        const { token } = await res.json();
        if (!token) return false;
        setRenderServer({ url: location.origin, token });
        return true;
    } catch (_) {
        return false; // sunucu kapalı: önbellekten açılmış uygulama, önceki ayar kalır
    }
}

/** Sunucuya erişilebiliyor ve token doğru mu? */
export function checkRenderServer(config) {
    return renderRequest(config, '/health', {}, 8000);
}

/** Sayfayı kendi sunucunda gerçek tarayıcıyla çalıştırıp attığı medya isteklerini döner. */
export function renderSniff(url, { signal, waitMs } = {}) {
    const config = getRenderServer();
    if (!config) return Promise.resolve(null);
    return renderRequest(config, '/sniff', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ url, waitMs }),
        signal
    });
}

/** Kayıtlı sunucuya JSON isteği (etkileşimli oturum vb. için). */
export function renderApi(path, init = {}, timeoutMs = 30000) {
    const config = getRenderServer();
    if (!config) return Promise.reject(new Error('Kendi sunucun ayarlı değil'));
    return renderRequest(config, path, init, timeoutMs);
}

/** Sunucudan ikili yanıt (ör. ekran görüntüsü) alır; hata mesajı JSON'dan okunur. */
export async function renderBlob(path, timeoutMs = 15000) {
    const config = getRenderServer();
    if (!config) throw new Error('Kendi sunucun ayarlı değil');
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
        const res = await fetch(`${config.url}${path}`, {
            headers: { authorization: `Bearer ${config.token}` },
            signal: controller.signal,
            cache: 'no-store'
        });
        if (!res.ok) {
            const body = await res.json().catch(() => ({}));
            const err = new Error(body.error || `Sunucu ${res.status} döndü`);
            err.status = res.status;
            throw err;
        }
        return await res.blob();
    } finally {
        clearTimeout(timer);
    }
}

// CORS engelini aşmak için tek proxy kullanıcının kendi sunucusu; ayarlı değilse null.
// (Netlify yalnızca siteyi barındırıyor, indirmeler oradan geçmiyor.) <video src> gibi başlık
// eklenemeyen yerlerde de çalışsın diye token sorgu parametresiyle gönderilir.
export function proxyUrl(target) {
    const server = getRenderServer();
    if (!server) return null;
    return `${server.url}/fetch?url=${encodeURIComponent(target)}&token=${encodeURIComponent(server.token)}`;
}

const NO_SERVER_HINT = 'Bunu indirmek için Algıla → "Kendi sunucum" bölümünden sunucunu ayarla.';

/**
 * Önce doğrudan, CORS hatası alırsa kendi sunucun üzerinden dener.
 * `mode` "direct" | "proxy" (yalnızca kendi sunucum) | "auto" olabilir.
 */
export async function smartFetch(url, { mode = 'auto', init = {}, onFallback, onAccess } = {}) {
    if (mode !== 'proxy') {
        try {
            const res = await fetch(url, init);
            if (res.ok || res.status === 206) {
                if (onAccess) onAccess('direct');
                return res;
            }
            if (mode === 'direct' || !proxyUrl(url)) {
                throw new Error(`Sunucu ${res.status} döndü`);
            }
        } catch (err) {
            if (mode === 'direct') throw err;
            if (!proxyUrl(url)) {
                throw new Error(`Site doğrudan indirmeye izin vermiyor. ${NO_SERVER_HINT}`);
            }
            if (onFallback) onFallback(err);
        }
    }

    const viaServer = proxyUrl(url);
    if (!viaServer) throw new Error(`Kendi sunucun ayarlı değil. ${NO_SERVER_HINT}`);
    const res = await fetch(viaServer, init);
    if (onAccess && (res.ok || res.status === 206)) onAccess('proxy');
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


/**
 * Adresin tarayıcıdan doğrudan okunup okunamadığını yoklar.
 * Arka plan indirmesinde hangi adresin (doğrudan mı proxy mi) verileceğini belirler.
 */
export async function probeAccess(url, mode = 'auto') {
    const hasServer = Boolean(getRenderServer());
    if (mode === 'proxy' && hasServer) return 'proxy';
    try {
        const res = await fetch(url, { headers: { Range: 'bytes=0-0' } });
        if (res.ok || res.status === 206) return 'direct';
    } catch (_) { /* CORS veya ağ hatası */ }
    // Sunucu yoksa doğrudan dene; başarısız olursa normal indirmeye düşüp anlaşılır hata verir.
    return mode !== 'direct' && hasServer ? 'proxy' : 'direct';
}

export function formatEta(received, total, startedAt) {
    if (!total || received <= 0) return '';
    const elapsed = (Date.now() - startedAt) / 1000;
    if (elapsed < 1) return '';
    const speed = received / elapsed;
    const remaining = Math.round((total - received) / speed);
    if (!isFinite(remaining) || remaining <= 0) return '';
    if (remaining < 60) return `~${remaining} sn`;
    if (remaining < 3600) return `~${Math.round(remaining / 60)} dk`;
    return `~${(remaining / 3600).toFixed(1)} sa`;
}
