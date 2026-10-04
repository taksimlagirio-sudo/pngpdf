// Cihazlar arası kitaplık: telefon ve bilgisayar kitaplıklarındaki dosyalar sunucuda bir kopya olarak
// tutulur; her cihaz hangi öğelerin kendisinde olduğunu bildirir. Öbür cihazdaki bir öğe buradan
// akıtılarak izlenir ya da "Bu cihaza al" ile indirilir.
import fs from 'node:fs';
import path from 'node:path';
import { pipeline } from 'node:stream/promises';

const MAX_THUMB = 60000;
const clean = (s, n = 200) => String(s || '').slice(0, n);

export function createLibStore({ dir }) {
    fs.mkdirSync(dir, { recursive: true });
    const indexFile = path.join(dir, 'index.json');
    let data = { items: {}, devices: {} };
    try {
        data = JSON.parse(fs.readFileSync(indexFile, 'utf8'));
    } catch (_) { /* ilk açılış */ }
    let saveTimer = null;
    const save = () => {
        clearTimeout(saveTimer);
        saveTimer = setTimeout(() => {
            try {
                fs.writeFileSync(indexFile, JSON.stringify(data));
            } catch (_) { /* disk */ }
        }, 300);
    };
    const fileOf = (id) => path.join(dir, `${id.replace(/[^a-z0-9]/gi, '')}.bin`);

    function touchDevice(device) {
        if (!device || !/^[a-z0-9]{6,40}$/i.test(device.id || '')) throw new Error('Cihaz kimliği geçersiz');
        data.devices[device.id] = {
            name: clean(device.name, 60) || 'Cihaz', kind: device.kind === 'desktop' ? 'desktop' : 'phone', lastSync: Date.now()
        };
        return device.id;
    }

    function publicItem(it) {
        return { ...it, file: undefined, uploaded: fs.existsSync(fileOf(it.id)) };
    }

    return {
        list() {
            return { items: Object.values(data.items).map(publicItem).sort((a, b) => b.createdAt - a.createdAt), devices: data.devices };
        },
        /** Cihaz elindekileri bildirir; sunucudaki tüm öğeler döner. */
        sync({ device, have = [] }) {
            const id = touchDevice(device);
            const set = new Set(have.map(String));
            for (const it of Object.values(data.items)) {
                it.devices = it.devices || {};
                if (set.has(it.id)) it.devices[id] = Date.now();
                else delete it.devices[id];
            }
            save();
            return this.list();
        },
        has(id) {
            return Boolean(data.items[id]) && fs.existsSync(fileOf(id));
        },
        /** Dosyayı (istek gövdesinden) kaydeder. */
        async put(id, meta, stream, deviceId) {
            if (!/^[a-z0-9]{4,40}$/i.test(id)) throw new Error('Geçersiz kimlik');
            const tmp = `${fileOf(id)}.part`;
            await pipeline(stream, fs.createWriteStream(tmp));
            fs.renameSync(tmp, fileOf(id));
            const size = fs.statSync(fileOf(id)).size;
            const thumb = typeof meta.thumb === 'string' && meta.thumb.length < MAX_THUMB && meta.thumb.startsWith('data:image/') ? meta.thumb : '';
            data.items[id] = {
                id, name: clean(meta.name) || 'dosya', mime: clean(meta.mime, 80), size, kind: clean(meta.kind, 10) || 'file',
                rec: Boolean(meta.rec), page: clean(meta.page, 2000), site: clean(meta.site, 100), createdAt: Number(meta.createdAt) || Date.now(),
                duration: Number(meta.duration) || 0, width: Number(meta.width) || 0, height: Number(meta.height) || 0, thumb,
                collections: Array.isArray(meta.collections) ? meta.collections.map((c) => clean(c, 60)).slice(0, 20) : [],
                tags: Array.isArray(meta.tags) ? meta.tags.map((c) => clean(c, 40)).slice(0, 30) : [],
                devices: { ...(data.items[id] ? data.items[id].devices : {}), ...(deviceId ? { [deviceId]: Date.now() } : {}) }
            };
            save();
            return publicItem(data.items[id]);
        },
        file(id) {
            const it = data.items[id];
            const full = fileOf(id);
            if (!it || !fs.existsSync(full)) return null;
            return { path: full, name: it.name, mime: it.mime || 'application/octet-stream', size: fs.statSync(full).size };
        },
        remove(id) {
            if (!data.items[id]) return false;
            delete data.items[id];
            fs.rm(fileOf(id), { force: true }, () => {});
            save();
            return true;
        },
        usage() {
            return Object.values(data.items).reduce((n, it) => n + (it.size || 0), 0);
        }
    };
}
