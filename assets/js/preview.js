// Yayın önizlemesi: HLS hls.js ile (ayrı ses izi dahil) oynatılır, düz dosyalar doğrudan.
// Kaynak tarayıcıdan doğrudan okunamıyorsa (CORS) istekler kendi sunucun üzerinden gider.
// Ayrıca listelerde gösterilecek küçük kareyi (önizleme resmi) ve süreyi üretir.
import { proxyUrl } from './util.js';

let hlsPromise = null;
function loadHls() {
    if (window.Hls) return Promise.resolve(window.Hls);
    if (!hlsPromise) {
        hlsPromise = new Promise((resolve, reject) => {
            const script = document.createElement('script');
            script.src = new URL('../vendor/hls.min.js', import.meta.url).href;
            script.onload = () => (window.Hls ? resolve(window.Hls) : reject(new Error('hls.js yüklenemedi')));
            script.onerror = () => {
                hlsPromise = null;
                reject(new Error('Önizleyici yüklenemedi'));
            };
            document.head.appendChild(script);
        });
    }
    return hlsPromise;
}

/** Tüm istekleri kendi sunucun üzerinden yapan hls.js yükleyicisi (göreli adresler bozulmadan). */
function proxyLoader(Hls) {
    const Base = Hls.DefaultConfig.loader;
    return class extends Base {
        load(context, config, callbacks) {
            const original = context.url;
            const viaServer = proxyUrl(original);
            if (viaServer) context.url = viaServer;
            const onSuccess = callbacks.onSuccess;
            super.load(context, config, {
                ...callbacks,
                onSuccess(response, stats, ctx, details) {
                    // Playlist içindeki göreli adresler özgün adrese göre çözülsün.
                    response.url = original;
                    ctx.url = original;
                    onSuccess(response, stats, ctx, details);
                }
            });
        }
    };
}

const isHlsUrl = (url, kind) => kind === 'hls' || /\.m3u8(\?|$)/i.test(url);

/**
 * `video` öğesinde kaynağı oynatır. `proxied`: istekler kendi sunucun üzerinden gitsin.
 * Dönen nesne: destroy(), selectQuality(url) ve hata bildirimi için onError.
 */
export async function attachPreview(video, url, { kind = '', proxied = false, onError = () => {}, startLow = false } = {}) {
    video.playsInline = true;
    if (!isHlsUrl(url, kind)) {
        video.crossOrigin = proxied ? 'anonymous' : null;
        video.src = proxied && proxyUrl(url) ? proxyUrl(url) : url;
        video.addEventListener('error', () => onError(new Error('Video oynatılamadı')), { once: true });
        return { destroy() { video.removeAttribute('src'); video.load(); }, selectQuality() {} };
    }

    const native = !window.MediaSource && video.canPlayType('application/vnd.apple.mpegurl');
    if (native) {
        video.src = url; // iOS Safari: yerleşik HLS (sunucu üzerinden geçirme yapılamaz)
        video.addEventListener('error', () => onError(new Error('Yayın oynatılamadı')), { once: true });
        return { destroy() { video.removeAttribute('src'); video.load(); }, selectQuality() {} };
    }

    const Hls = await loadHls();
    if (!Hls.isSupported()) throw new Error('Bu tarayıcı yayın önizlemesini desteklemiyor');
    const config = { enableWorker: true, lowLatencyMode: false, capLevelToPlayerSize: !startLow, maxBufferLength: 20 };
    if (startLow) config.startLevel = 0;
    if (proxied) config.loader = proxyLoader(Hls);
    const hls = new Hls(config);
    hls.on(Hls.Events.ERROR, (_e, data) => {
        if (data.fatal) onError(new Error(data.details || 'Yayın oynatılamadı'));
    });
    hls.loadSource(url);
    hls.attachMedia(video);
    return {
        hls,
        destroy() {
            hls.destroy();
        },
        /** Seçilen kaliteyi önizlemede de göster. */
        selectQuality(variantUrl) {
            const index = hls.levels.findIndex((l) => (l.url || []).includes(variantUrl) || l.uri === variantUrl);
            if (index >= 0) hls.currentLevel = index;
        }
    };
}

/** Oynayan videodan küçük bir JPEG kare alır (blob: adresi). Okunamazsa null. */
export function grabFrame(video, maxWidth = 480) {
    try {
        if (!video.videoWidth || video.readyState < 2) return Promise.resolve(null);
        const scale = Math.min(1, maxWidth / video.videoWidth);
        const canvas = document.createElement('canvas');
        canvas.width = Math.max(1, Math.round(video.videoWidth * scale));
        canvas.height = Math.max(1, Math.round(video.videoHeight * scale));
        canvas.getContext('2d').drawImage(video, 0, 0, canvas.width, canvas.height);
        return new Promise((resolve) => {
            try {
                canvas.toBlob((blob) => resolve(blob ? URL.createObjectURL(blob) : null), 'image/jpeg', 0.75);
            } catch (_) {
                resolve(null); // tuval CORS nedeniyle okunamıyor (toBlob burada fırlatır)
            }
        });
    } catch (_) {
        return Promise.resolve(null); // tuval CORS nedeniyle okunamıyor
    }
}

/**
 * Listede göstermek için kaynağı gizli bir oynatıcıda açıp bir kare, süre ve çözünürlük alır.
 * Oynatılamazsa `{ ok: false }` döner — böyle bağlantılar listede öne çıkarılmaz.
 */
export async function probePreview(url, { kind = '', proxied = false, timeoutMs = 15000 } = {}) {
    const video = document.createElement('video');
    video.muted = true;
    video.preload = 'auto';
    video.style.cssText = 'position:fixed;left:-9999px;top:0;width:320px;height:180px;opacity:0;pointer-events:none';
    document.body.appendChild(video);
    let player = null;
    try {
        return await new Promise((resolve) => {
            const timer = setTimeout(() => resolve({ ok: false }), timeoutMs);
            const done = async (ok) => {
                clearTimeout(timer);
                if (!ok) return resolve({ ok: false });
                const thumb = await grabFrame(video, 320);
                resolve({
                    ok: true,
                    thumb,
                    duration: isFinite(video.duration) ? video.duration : 0,
                    live: video.duration === Infinity,
                    width: video.videoWidth,
                    height: video.videoHeight
                });
            };
            video.addEventListener('loadeddata', () => {
                // Siyah ilk kare yerine biraz ileriden bir kare.
                if (isFinite(video.duration) && video.duration > 8) {
                    video.addEventListener('seeked', () => done(true), { once: true });
                    video.currentTime = Math.min(video.duration * 0.1, 20);
                } else {
                    setTimeout(() => done(true), 300);
                }
            }, { once: true });
            attachPreview(video, url, { kind, proxied, startLow: true, onError: () => done(false) })
                .then((p) => {
                    player = p;
                    video.play().catch(() => {});
                })
                .catch(() => done(false));
        });
    } finally {
        if (player) player.destroy();
        video.remove();
    }
}
