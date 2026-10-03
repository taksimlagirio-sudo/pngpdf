// "Son algılananlar": Algıla ekranında boşken gösterilen kısa geçmiş (bu cihazda, localStorage).
const KEY = 'indirici.recent';
const MAX = 8;

function load() {
    try {
        const list = JSON.parse(localStorage.getItem(KEY) || '[]');
        return Array.isArray(list) ? list : [];
    } catch (_) {
        return [];
    }
}

function save(list) {
    try {
        localStorage.setItem(KEY, JSON.stringify(list.slice(0, MAX)));
    } catch (_) { /* depolama dolu/kapalı: geçmiş tutulmaz */ }
}

export function recentList() {
    return load();
}

/** Algılanan sonucu başa ekler (aynı adres varsa günceller). */
export function addRecent(entry) {
    if (!entry || !entry.url) return;
    const list = load().filter((e) => e.url !== entry.url);
    list.unshift({ at: Date.now(), ...entry });
    save(list);
}

/** Var olan kaydı günceller (ör. küçük resim sonradan gelince). */
export function updateRecent(url, patch) {
    const list = load();
    const item = list.find((e) => e.url === url);
    if (!item) return;
    Object.assign(item, patch);
    save(list);
}

export function clearRecent() {
    save([]);
}

/** Geçici (blob:) küçük resmi kalıcı, küçük bir data: adresine çevirir. */
export async function persistThumb(src, maxWidth = 168) {
    if (!src) return '';
    if (src.startsWith('data:') && src.length < 40000) return src;
    try {
        const img = new Image();
        img.decoding = 'async';
        img.src = src;
        await img.decode();
        const scale = Math.min(1, maxWidth / (img.naturalWidth || maxWidth));
        const canvas = document.createElement('canvas');
        canvas.width = Math.max(1, Math.round(img.naturalWidth * scale));
        canvas.height = Math.max(1, Math.round(img.naturalHeight * scale));
        canvas.getContext('2d').drawImage(img, 0, 0, canvas.width, canvas.height);
        return canvas.toDataURL('image/jpeg', 0.6);
    } catch (_) {
        return ''; // CORS ya da bozuk görüntü: küçük resimsiz kalır
    }
}
