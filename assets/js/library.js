// Kitaplık: indirilen dosyaların uygulama içindeki kopyası (IndexedDB). Dosyalar ayrıca seçilen yere
// (İndirilenler/Galeri) kaydedilir; buradaki kopya izlemek, düzenlemek ve yeniden paylaşmak içindir.
// İstenirse dışarı kaydedilenler 7 gün sonra kitaplıktan kaldırılır.
import { getPrefs } from './prefs.js';

const DB_NAME = 'indirici-lib';
const DAY = 24 * 60 * 60 * 1000;
const CLEAN_AFTER = 7 * DAY;

let dbPromise = null;
const listeners = new Set();
let cache = null; // bellekteki üst veri listesi

function openDb() {
    if (!dbPromise) {
        dbPromise = new Promise((resolve, reject) => {
            const req = indexedDB.open(DB_NAME, 1);
            req.onupgradeneeded = () => {
                const db = req.result;
                if (!db.objectStoreNames.contains('items')) db.createObjectStore('items', { keyPath: 'id' });
                if (!db.objectStoreNames.contains('files')) db.createObjectStore('files');
            };
            req.onsuccess = () => resolve(req.result);
            req.onerror = () => reject(req.error);
        });
    }
    return dbPromise;
}

function tx(stores, mode, fn) {
    return openDb().then((db) => new Promise((resolve, reject) => {
        const t = db.transaction(stores, mode);
        let result;
        Promise.resolve(fn(t)).then((r) => { result = r; });
        t.oncomplete = () => resolve(result);
        t.onerror = () => reject(t.error);
        t.onabort = () => reject(t.error || new Error('İşlem iptal edildi'));
    }));
}

const reqP = (req) => new Promise((resolve, reject) => {
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
});

function emit() {
    const list = cache ? [...cache] : [];
    listeners.forEach((fn) => fn(list));
}

export function onLibrary(fn) {
    listeners.add(fn);
    return () => listeners.delete(fn);
}

/** Tüm öğeler, en yeni başta. */
export async function libList() {
    if (!cache) {
        try {
            cache = await tx(['items'], 'readonly', (t) => reqP(t.objectStore('items').getAll()));
        } catch (_) {
            cache = [];
        }
        cache.sort((a, b) => b.createdAt - a.createdAt);
    }
    return [...cache];
}

export async function libGet(id) {
    const list = await libList();
    return list.find((i) => i.id === id) || null;
}

/** Öğenin dosyası (Blob). */
export async function libFile(id) {
    const blob = await tx(['files'], 'readonly', (t) => reqP(t.objectStore('files').get(id)));
    if (!blob) throw new Error('Dosya kitaplıkta bulunamadı');
    return blob;
}

export function kindOf(mime = '', name = '') {
    const ext = (name.split('.').pop() || '').toLowerCase();
    if (mime.startsWith('image/') || /^(jpe?g|png|gif|webp|avif|bmp|heic)$/.test(ext)) return 'photo';
    if (mime.startsWith('audio/') || /^(mp3|m4a|aac|opus|ogg|wav|flac)$/.test(ext)) return 'audio';
    if (mime.startsWith('video/') || /^(mp4|webm|mkv|mov|ts|m4v)$/.test(ext)) return 'video';
    return 'file';
}

function hostOf(url) {
    try {
        return new URL(url).host.replace(/^www\./, '');
    } catch (_) {
        return '';
    }
}

/**
 * Dosyayı kitaplığa ekler. Küçük resim, süre ve ölçüler arkadan çıkarılır.
 * @returns {Promise<object|null>} eklenen öğe (kitaplık kapalıysa null)
 */
export async function libAdd(blob, { name, rec = false, page = '', media = '', exported = false, edited = false, from = '' } = {}) {
    if (!blob || !blob.size || getPrefs().libKeep === false || !('indexedDB' in window)) return null;
    const id = 'l' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
    const mime = blob.type || '';
    const item = {
        id, name: name || 'dosya', mime, size: blob.size, kind: kindOf(mime, name), rec: Boolean(rec),
        page, media, site: hostOf(page || media), createdAt: Date.now(), exportedAt: exported ? Date.now() : 0,
        edited: Boolean(edited), from, duration: 0, width: 0, height: 0, thumb: ''
    };
    try {
        await tx(['items', 'files'], 'readwrite', (t) => {
            t.objectStore('files').put(blob, id);
            t.objectStore('items').put(item);
        });
    } catch (err) {
        console.warn('Kitaplığa eklenemedi:', err);
        return null;
    }
    if (cache) cache.unshift(item);
    emit();
    describe(item, blob).catch(() => {});
    return item;
}

export async function libUpdate(id, patch) {
    const list = await libList();
    const item = list.find((i) => i.id === id);
    if (!item) return null;
    Object.assign(item, patch);
    const index = cache.findIndex((i) => i.id === id);
    if (index >= 0) cache[index] = item;
    await tx(['items'], 'readwrite', (t) => t.objectStore('items').put(item)).catch(() => {});
    emit();
    return item;
}

export async function libRemove(ids) {
    const list = Array.isArray(ids) ? ids : [ids];
    await tx(['items', 'files'], 'readwrite', (t) => {
        for (const id of list) {
            t.objectStore('items').delete(id);
            t.objectStore('files').delete(id);
        }
    });
    if (cache) cache = cache.filter((i) => !list.includes(i.id));
    emit();
}

/** Kullanım: türlere göre toplam ve cihazdaki boş yer. */
export async function libUsage() {
    const list = await libList();
    const by = { video: 0, photo: 0, rec: 0, other: 0 };
    for (const i of list) {
        const key = i.rec ? 'rec' : i.kind === 'video' ? 'video' : i.kind === 'photo' ? 'photo' : 'other';
        by[key] += i.size;
    }
    const total = list.reduce((n, i) => n + i.size, 0);
    let free = 0;
    let persisted = false;
    try {
        const est = await navigator.storage.estimate();
        free = Math.max(0, (est.quota || 0) - (est.usage || 0));
        persisted = navigator.storage.persisted ? await navigator.storage.persisted() : false;
    } catch (_) { /* desteklenmiyor */ }
    return { total, by, free, persisted, count: list.length };
}

/** Tarayıcıdan dosyaları yer açarken silmemesini ister (ana ekrana eklenince genelde verilir). */
export async function libPersist() {
    try {
        if (navigator.storage && navigator.storage.persist) return await navigator.storage.persist();
    } catch (_) { /* desteklenmiyor */ }
    return false;
}

/** "Galeriye kaydedilenleri 7 gün sonra kaldır" açıksa eskileri siler. */
export async function libClean() {
    if (!getPrefs().libAutoClean) return 0;
    const now = Date.now();
    const old = (await libList()).filter((i) => i.exportedAt && now - i.exportedAt > CLEAN_AFTER);
    if (old.length) await libRemove(old.map((i) => i.id));
    return old.length;
}

/* ---- Küçük resim, süre, ölçü ---- */

async function describe(item, blob) {
    const patch = {};
    if (item.kind === 'photo') {
        const bitmap = await createImageBitmap(blob);
        patch.width = bitmap.width;
        patch.height = bitmap.height;
        patch.thumb = drawThumb(bitmap, bitmap.width, bitmap.height);
        bitmap.close();
    } else if (item.kind === 'video' || item.kind === 'audio') {
        const info = await probeMedia(blob, item.kind === 'video');
        Object.assign(patch, info);
    }
    if (Object.keys(patch).length) await libUpdate(item.id, patch);
}

function drawThumb(source, w, h, max = 360) {
    const scale = Math.min(1, max / Math.max(w, h));
    const canvas = document.createElement('canvas');
    canvas.width = Math.max(1, Math.round(w * scale));
    canvas.height = Math.max(1, Math.round(h * scale));
    canvas.getContext('2d').drawImage(source, 0, 0, canvas.width, canvas.height);
    return canvas.toDataURL('image/jpeg', 0.7);
}

/** Videonun süresi, ölçüleri ve bir karesi. */
export function probeMedia(blob, wantFrame = true) {
    return new Promise((resolve) => {
        const url = URL.createObjectURL(blob);
        const el = document.createElement(wantFrame ? 'video' : 'audio');
        el.muted = true;
        el.preload = 'metadata';
        el.playsInline = true;
        let done = false;
        const finish = (patch) => {
            if (done) return;
            done = true;
            clearTimeout(timer);
            el.removeAttribute('src');
            el.load();
            URL.revokeObjectURL(url);
            resolve(patch);
        };
        const timer = setTimeout(() => finish({ duration: isFinite(el.duration) ? el.duration : 0 }), 15000);
        el.addEventListener('error', () => finish({}), { once: true });
        el.addEventListener('loadedmetadata', () => {
            const base = { duration: isFinite(el.duration) ? el.duration : 0, width: el.videoWidth || 0, height: el.videoHeight || 0 };
            if (!wantFrame || !el.videoWidth) return finish(base);
            el.addEventListener('seeked', () => {
                try {
                    base.thumb = drawThumb(el, el.videoWidth, el.videoHeight);
                } catch (_) { /* kare çizilemedi */ }
                finish(base);
            }, { once: true });
            el.currentTime = Math.min(base.duration ? base.duration / 3 : 1, 3);
        }, { once: true });
        el.src = url;
    });
}
