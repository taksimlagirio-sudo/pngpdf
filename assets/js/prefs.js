// Kullanıcı tercihleri (tema, varsayılan indirme ayarları) — localStorage'da tek kayıt.
const KEY = 'indirici.prefs';

const DEFAULTS = {
    theme: 'dark',        // 'dark' | 'light'
    save: 'downloads',    // 'downloads' (İndirilenler) | 'gallery' (Paylaş → Galeri) | 'disk' (Konum seç)
    conn: 'auto',         // 'auto' | 'direct' | 'proxy'
    background: false,    // Background Fetch ile arka planda indir
    concurrency: 3,       // aynı anda en fazla iş
    keepAwake: true,      // kayıt/indirme sürerken ekranı açık tut (wake lock)
    recWhere: 'server',   // canlı kayıt: 'server' (kendi sunucum) | 'device'
    useYtdlp: false,      // büyük platformlar dışındaki sitelerde de önce yt-dlp'ye sor (sunucuda kuruluysa)
    fullGalleries: true,  // Resimler: bilinen sitelerde galerinin tamamı ve tam boyut (sunucuda gallery-dl)
    bigSites: 'ask',      // TikTok, Instagram, YouTube…: 'ask' (sor) | 'ytdlp' | 'ours' (kendi yöntemimiz)
    siteMethods: {}       // "bu site için hatırla": { 'tiktok.com': 'ytdlp' | 'ours' }
};

let prefs = { ...DEFAULTS };
try {
    prefs = { ...DEFAULTS, ...JSON.parse(localStorage.getItem(KEY) || '{}') };
} catch (_) { /* depolama kapalı veya bozuk */ }

const listeners = new Set();

export function getPrefs() {
    return prefs;
}

export function setPref(key, value) {
    if (prefs[key] === value) return;
    prefs = { ...prefs, [key]: value };
    try {
        localStorage.setItem(KEY, JSON.stringify(prefs));
    } catch (_) { /* depolama kapalı: tercih bu oturumla sınırlı */ }
    listeners.forEach((fn) => fn(prefs, key));
}

export function onPrefs(fn) {
    listeners.add(fn);
    return () => listeners.delete(fn);
}

export const SAVE_LABELS = { downloads: 'İndirilenler', gallery: 'Galeri', disk: 'Konum seç' };
export const CONN_LABELS = { auto: 'Otomatik', direct: 'Doğrudan', proxy: 'Sunucum' };
