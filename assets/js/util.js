// Tüm sekmelerin ortak kullandığı yardımcılar.

export const $ = (id) => document.getElementById(id);

export function formatSize(bytes) {
    if (!bytes || bytes < 0) return '0 B';
    const k = 1024;
    const sizes = ['B', 'KB', 'MB', 'GB', 'TB'];
    const i = Math.min(Math.floor(Math.log(bytes) / Math.log(k)), sizes.length - 1);
    const value = bytes / Math.pow(k, i);
    const digits = i >= 3 ? 2 : value < 10 && i > 0 ? 1 : 0;
    return value.toLocaleString('tr-TR', { maximumFractionDigits: digits }) + ' ' + sizes[i];
}

/** Saniyeyi 00:12:03 biçiminde yazar. */
export function hms(seconds) {
    const total = Math.max(0, Math.floor(seconds || 0));
    return [Math.floor(total / 3600), Math.floor(total / 60) % 60, total % 60]
        .map((n) => String(n).padStart(2, '0')).join(':');
}

/** Kalan süreyi "3 dk 20 sn" biçiminde yazar. */
export function formatLeft(seconds) {
    if (!isFinite(seconds) || seconds <= 0) return '';
    const s = Math.ceil(seconds);
    if (s < 60) return `${s} sn`;
    if (s < 3600) return `${Math.floor(s / 60)} dk ${s % 60} sn`;
    return `${Math.floor(s / 3600)} sa ${Math.floor(s / 60) % 60} dk`;
}

export function sleep(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
}

export function escapeHtml(str) {
    return String(str).replace(/[&<>"']/g, (c) => (
        { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]
    ));
}

/** Android uygulaması (APK) içinde mi çalışıyor? Paylaşım, kaydetme ve geri tuşu kabuğa bırakılır. */
export const inApk = typeof window !== 'undefined' && Boolean(window.IndiriciAndroid);

/** Panodaki metin: APK'da Android'in panosundan (izin gerekmez), tarayıcıda Clipboard API ile. */
export async function readClipText() {
    if (typeof window !== 'undefined' && window.IndiriciAndroid && window.IndiriciAndroid.readClipboard) return window.IndiriciAndroid.readClipboard();
    if (!navigator.clipboard || !navigator.clipboard.readText) throw new Error('Bu tarayıcı panoyu okumaya izin vermiyor');
    return navigator.clipboard.readText();
}

/** APK: dosya parça parça kabuğa verilir, kabuk telefonun İndirilenler klasörüne yazar. */
export async function saveToAndroid(blob, filename) {
    const bridge = window.IndiriciAndroid;
    const id = bridge.begin(filename, blob.type || '');
    if (!id) return false;
    const CHUNK = 768 * 1024;
    for (let off = 0; off < blob.size; off += CHUNK) {
        const buf = new Uint8Array(await blob.slice(off, off + CHUNK).arrayBuffer());
        let bin = '';
        for (let i = 0; i < buf.length; i += 0x8000) bin += String.fromCharCode.apply(null, buf.subarray(i, i + 0x8000));
        if (!bridge.append(id, btoa(bin))) {
            bridge.abort(id);
            return false;
        }
    }
    return Boolean(bridge.finish(id));
}

// Blob'u kullanıcının diskine indirir.
export function saveBlob(blob, filename) {
    if (inApk) {
        saveToAndroid(blob, filename).catch(() => {});
        return;
    }
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
export function renderSniff(url, { signal, waitMs, traceId } = {}) {
    const config = getRenderServer();
    if (!config) return Promise.resolve(null);
    return renderRequest(config, '/sniff', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ url, waitMs, traceId }),
        signal
    });
}

/**
 * Sayfadaki videoları sunucudaki yt-dlp'ye çözdürür (yalnızca veri: adresler, kaliteler).
 * Sunucunun verdiği "/stream/…" adresleri token'lı tam adrese çevrilir. yt-dlp yoksa null.
 */
export async function renderExtract(url, { signal } = {}) {
    const config = getRenderServer();
    if (!config) return null;
    const result = await renderRequest(config, '/extract', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ url }),
        signal
    }, 90000);
    if (!result || !result.available) return null;
    const full = (u) => (u && u.startsWith('/stream/') ? `${config.url}${u}?token=${encodeURIComponent(config.token)}` : u);
    for (const item of result.items || []) {
        item.url = full(item.url);
        if (item.audioUrl) item.audioUrl = full(item.audioUrl);
    }
    for (const sub of result.subtitles || []) sub.url = full(sub.url);
    return result;
}

/** Sayfadaki resimleri sunucudaki gallery-dl'e buldurur (tam boyutlu adresler). Kurulu değilse null. */
export async function renderImages(url, { signal } = {}) {
    const config = getRenderServer();
    if (!config) return null;
    const result = await renderRequest(config, '/images', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ url }),
        signal
    }, 60000);
    return result && result.available ? result : null;
}

/** Adres kendi sunucumun yt-dlp akışı mı (doğrudan sunucudan iner, CORS sorunu yok)? */
export function isServerStream(url) {
    const config = getRenderServer();
    return Boolean(config && url && url.startsWith(`${config.url}/stream/`));
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
export function proxyUrl(target, referer = '') {
    const server = getRenderServer();
    if (!server) return null;
    return `${server.url}/fetch?url=${encodeURIComponent(target)}&token=${encodeURIComponent(server.token)}` +
        (referer ? `&referer=${encodeURIComponent(referer)}` : '');
}

const NO_SERVER_HINT = 'Bunu indirmek için Ayarlar → "Kendi sunucum" bölümünden sunucunu ayarla.';

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

/** Kısa süre: 0:38, 48:10, 2:14:08. */
export function clock(seconds) {
    const t = Math.max(0, Math.round(seconds || 0));
    const h = Math.floor(t / 3600);
    const m = Math.floor(t / 60) % 60;
    const s = String(t % 60).padStart(2, '0');
    return h ? `${h}:${String(m).padStart(2, '0')}:${s}` : `${m}:${s}`;
}

/** Ağ bağlantısı koptu mu (sunucu hatası değil)? */
export function isNetworkError(err) {
    if (!err || err.name === 'AbortError') return false;
    if (typeof navigator !== 'undefined' && navigator.onLine === false) return true;
    return err.name === 'TypeError' || /Failed to fetch|NetworkError|network error|ERR_INTERNET|ERR_NETWORK|Load failed|zaman aşımı|timed? ?out/i.test(err.message || '');
}

/**
 * Bağlantı gelene kadar bekler: tarayıcının "online" olayı, elle "Devam et" ya da 15 sn'de bir
 * yapılan kontrol. İptal edilirse AbortError fırlatır.
 */
export function waitForNetwork(signal, { kick } = {}) {
    return new Promise((resolve, reject) => {
        let timer = null;
        const done = (fn) => {
            window.removeEventListener('online', onOnline);
            if (signal) signal.removeEventListener('abort', onAbort);
            clearInterval(timer);
            fn();
        };
        const onOnline = () => setTimeout(() => done(resolve), 1000);
        const onAbort = () => done(() => reject(new DOMException('Aborted', 'AbortError')));
        window.addEventListener('online', onOnline);
        if (signal) signal.addEventListener('abort', onAbort);
        timer = setInterval(() => {
            if (navigator.onLine !== false) done(resolve);
        }, 15000);
        if (kick) kick(() => done(resolve));
    });
}
