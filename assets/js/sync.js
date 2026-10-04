// Cihazlar arası kitaplık: bu cihazdaki öğeler kendi sunucuna yüklenir, öbür cihazdakiler listelenir;
// istenen öğe "Bu cihaza al" ile indirilir. Asıl dosyalar cihazlarda, ortak kopya sunucunda durur.
import { getRenderServer, renderApi } from './util.js';
import { libList, libFile, libAdd } from './library.js';

const DEVICE_KEY = 'indirici.device';
const STATE_KEY = 'indirici.syncState';

export function deviceInfo() {
    try {
        const saved = JSON.parse(localStorage.getItem(DEVICE_KEY) || 'null');
        if (saved && saved.id) return saved;
    } catch (_) { /* ilk kez */ }
    const ua = navigator.userAgent;
    const phone = /Android|iPhone|iPod/i.test(ua) && !/Tablet|iPad/i.test(ua);
    const tablet = /iPad|Tablet/i.test(ua) || (/Android/i.test(ua) && !/Mobile/i.test(ua));
    const device = {
        id: Array.from(crypto.getRandomValues(new Uint8Array(8)), (b) => b.toString(16).padStart(2, '0')).join(''),
        kind: phone || tablet ? 'phone' : 'desktop',
        name: phone ? 'Telefon' : tablet ? 'Tablet' : 'Bilgisayar'
    };
    try {
        localStorage.setItem(DEVICE_KEY, JSON.stringify(device));
    } catch (_) { /* depolama kapalı */ }
    return device;
}

export function lastSyncState() {
    try {
        return JSON.parse(localStorage.getItem(STATE_KEY) || 'null');
    } catch (_) {
        return null;
    }
}

function remember(state) {
    const slim = { at: Date.now(), devices: state.devices, items: state.items.map((i) => ({ ...i, thumb: i.thumb && i.thumb.length < 20000 ? i.thumb : '' })) };
    try {
        localStorage.setItem(STATE_KEY, JSON.stringify(slim));
    } catch (_) {
        try { localStorage.setItem(STATE_KEY, JSON.stringify({ ...slim, items: slim.items.map((i) => ({ ...i, thumb: '' })) })); } catch (__) { /* dolu */ }
    }
    return slim;
}

const b64 = (s) => btoa(unescape(encodeURIComponent(s)));

/** Tek bir öğeyi sunucuya yükler (TV'de oynatmak ya da eşitlemek için). */
export async function uploadItem(item, { onProgress = () => {} } = {}) {
    const server = getRenderServer();
    if (!server) throw new Error('Kendi sunucun ayarlı değil');
    const blob = await libFile(item.id);
    const meta = {
        name: item.name, mime: item.mime || blob.type, kind: item.kind, rec: item.rec, page: item.page, site: item.site,
        createdAt: item.createdAt, duration: item.duration, width: item.width, height: item.height,
        thumb: item.thumb && item.thumb.length < 60000 ? item.thumb : '', collections: item.collections || [], tags: item.tags || []
    };
    onProgress(0);
    const res = await fetch(`${server.url}/library/item/${encodeURIComponent(item.id)}`, {
        method: 'PUT',
        headers: { authorization: `Bearer ${server.token}`, 'x-meta': b64(JSON.stringify(meta)), 'x-device': deviceInfo().id, 'content-type': 'application/octet-stream' },
        body: blob
    });
    if (!res.ok) throw new Error(`Yüklenemedi (HTTP ${res.status})`);
    onProgress(1);
    return res.json();
}

/**
 * Eşitle: elimdekileri bildir, sunucuda olmayanları yükle.
 * @param {(done: number, total: number) => void} onProgress
 */
export async function syncNow({ onProgress = () => {}, upload = true } = {}) {
    if (!getRenderServer()) throw new Error('Kendi sunucun ayarlı değil');
    const device = deviceInfo();
    const local = await libList();
    let state = await renderApi('/library/sync', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ device, have: local.map((i) => i.id) }) }, 30000);
    if (upload) {
        const uploaded = new Set(state.items.filter((i) => i.uploaded).map((i) => i.id));
        const missing = local.filter((i) => !uploaded.has(i.id));
        let done = 0;
        for (const item of missing) {
            onProgress(done, missing.length);
            try {
                await uploadItem(item);
            } catch (err) {
                console.warn('Eşitleme: yüklenemedi', item.name, err);
            }
            done++;
        }
        onProgress(done, missing.length);
        if (missing.length) state = await renderApi('/library/sync', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ device, have: local.map((i) => i.id) }) }, 30000);
    }
    return remember(state);
}

/** Sunucudaki (öbür cihazdan gelen) öğeler, kitaplık listesine katılacak biçimde. */
export function syncedItems(state, localIds) {
    const server = getRenderServer();
    if (!state || !server) return [];
    return state.items.filter((i) => i.uploaded && !localIds.has(i.id)).map((i) => ({
        ...i, server: true, synced: true, serverKind: 'library', serverId: i.id,
        url: `${server.url}/library/item/${encodeURIComponent(i.id)}/file?token=${encodeURIComponent(server.token)}`
    }));
}

/** Öbür cihazdaki öğeyi bu cihazın kitaplığına indirir. */
export async function fetchToDevice(item, { onProgress = () => {} } = {}) {
    const res = await fetch(item.url);
    if (!res.ok) throw new Error(`İndirilemedi (HTTP ${res.status})`);
    const total = Number(res.headers.get('content-length')) || item.size || 0;
    const reader = res.body.getReader();
    const parts = [];
    let got = 0;
    for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        parts.push(value);
        got += value.length;
        onProgress(total ? got / total : 0);
    }
    const blob = new Blob(parts, { type: item.mime || 'application/octet-stream' });
    return libAdd(blob, {
        id: item.id, name: item.name, rec: item.rec, page: item.page,
        extra: { collections: item.collections || [], tags: item.tags || [], createdAt: item.createdAt || Date.now(), thumb: item.thumb || '', duration: item.duration || 0, width: item.width || 0, height: item.height || 0 }
    });
}
