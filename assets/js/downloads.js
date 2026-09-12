// İndirme yöneticisi: alt çubuk (mini görev çubuğu), diske kayıt ve arka plan indirme.
import { $, formatSize, escapeHtml, saveBlob } from './util.js';

const BG_CACHE = 'bg-downloads';
const META_PREFIX = '/__bg-meta__/';

let bar, barText, barPercent, barFill, barList, barToggle;
const jobs = new Map();
let expanded = false;
let wakeLock = null;

/* ---------------- Hedefe yazma (disk veya bellek) ---------------- */

export const canSaveToDisk = typeof window.showSaveFilePicker === 'function';

/**
 * Veriyi parça parça alan bir "sink" döner.
 * Disk desteği varsa doğrudan dosyaya yazar (bellek şişmez), yoksa bellekte biriktirip indirir.
 * showSaveFilePicker kullanıcı hareketi gerektirdiği için tıklama işleyicisinden çağrılmalı.
 */
export async function createSink(name, { toDisk = false, mime = 'application/octet-stream' } = {}) {
    if (toDisk && canSaveToDisk) {
        try {
            const handle = await window.showSaveFilePicker({
                suggestedName: name,
                types: [{ description: 'Dosya', accept: { [mime]: ['.' + (name.split('.').pop() || 'bin')] } }]
            });
            const writable = await handle.createWritable();
            return {
                mode: 'disk',
                name: handle.name || name,
                async write(chunk) { await writable.write(chunk); },
                async close() { await writable.close(); return null; },
                async abort() { try { await writable.abort(); } catch (_) { /* zaten kapalı */ } }
            };
        } catch (err) {
            if (err && err.name === 'AbortError') throw err; // kullanıcı iptal etti
            console.warn('Diske yazma kullanılamadı, belleğe düşülüyor:', err);
        }
    }

    const chunks = [];
    return {
        mode: 'memory',
        name,
        async write(chunk) { chunks.push(chunk); },
        async close() {
            const blob = new Blob(chunks, { type: mime });
            saveBlob(blob, name);
            chunks.length = 0;
            return blob;
        },
        async abort() { chunks.length = 0; }
    };
}

/* ---------------- Mini görev çubuğu ---------------- */

export function initDownloadBar() {
    bar = $('taskbar');
    barText = $('taskbarText');
    barPercent = $('taskbarPercent');
    barFill = $('taskbarFill');
    barList = $('taskbarList');
    barToggle = $('taskbarToggle');

    barToggle.addEventListener('click', () => {
        expanded = !expanded;
        render();
    });

    barList.addEventListener('click', (e) => {
        const btn = e.target.closest('button[data-job]');
        if (!btn) return;
        const job = jobs.get(btn.dataset.job);
        if (!job) return;
        if (btn.dataset.act === 'cancel') job.cancel();
        if (btn.dataset.act === 'save') savePending(job);
        if (btn.dataset.act === 'dismiss') { jobs.delete(job.id); render(); }
    });

    if ('serviceWorker' in navigator) {
        navigator.serviceWorker.addEventListener('message', (event) => {
            const data = event.data || {};
            if (data.type === 'bg-download-ready') addPendingSave(data.meta);
            if (data.type === 'bg-download-failed' || data.type === 'bg-download-aborted') {
                const job = [...jobs.values()].find((j) => j.bgId === data.id);
                if (job) {
                    job.status = data.type === 'bg-download-aborted' ? 'cancelled' : 'error';
                    job.detail = data.type === 'bg-download-aborted' ? 'İptal edildi' : 'Arka plan indirmesi başarısız';
                    render();
                }
            }
        });
        restorePendingSaves();
    }

    render();
}

/** Yeni bir indirme işi kaydeder; modüller ilerlemeyi bu nesne üzerinden bildirir. */
export function createJob(name, { onCancel } = {}) {
    const id = 'j' + Math.random().toString(36).slice(2);
    const job = {
        id,
        name,
        received: 0,
        total: 0,
        status: 'active',
        detail: '',
        started: Date.now(),
        cancel() {
            if (job.status !== 'active') return;
            job.status = 'cancelled';
            job.detail = 'İptal edildi';
            if (onCancel) onCancel();
            render();
        },
        progress(received, total) {
            job.received = received;
            job.total = total || job.total;
            render();
        },
        setDetail(text) {
            job.detail = text;
            render();
        },
        done(detail) {
            job.status = 'done';
            job.detail = detail || 'Tamamlandı';
            render();
            autoClear(job.id);
        },
        fail(detail) {
            job.status = 'error';
            job.detail = detail || 'Başarısız';
            render();
        }
    };
    jobs.set(id, job);
    render();
    return job;
}

function autoClear(id) {
    setTimeout(() => {
        const job = jobs.get(id);
        if (job && job.status === 'done') {
            jobs.delete(id);
            render();
        }
    }, 12000);
}

function render() {
    if (!bar) return;
    const list = [...jobs.values()];
    if (list.length === 0) {
        bar.classList.add('hidden');
        document.body.classList.remove('has-taskbar');
        return;
    }

    bar.classList.remove('hidden');
    document.body.classList.add('has-taskbar');

    const active = list.filter((j) => j.status === 'active');
    const pending = list.filter((j) => j.status === 'pending-save');
    const ratio = active.length
        ? active.reduce((sum, j) => sum + (j.total ? j.received / j.total : 0), 0) / active.length
        : 1;

    if (active.length) {
        barText.textContent = active.length === 1
            ? active[0].name
            : `${active.length} indirme sürüyor`;
        barPercent.textContent = active.some((j) => !j.total) ? '' : Math.round(ratio * 100) + '%';
        barFill.style.width = active.some((j) => !j.total) ? '100%' : Math.round(ratio * 100) + '%';
        barFill.classList.toggle('indeterminate', active.some((j) => !j.total));
        barFill.classList.remove('complete');
    } else if (pending.length) {
        barText.textContent = `${pending.length} dosya kaydedilmeyi bekliyor`;
        barPercent.textContent = '';
        barFill.style.width = '100%';
        barFill.classList.remove('indeterminate');
        barFill.classList.add('complete');
    } else {
        const last = list[list.length - 1];
        barText.textContent = last.name;
        barPercent.textContent = last.status === 'done' ? '✓' : '!';
        barFill.style.width = '100%';
        barFill.classList.remove('indeterminate');
        barFill.classList.toggle('complete', last.status === 'done');
    }

    barToggle.textContent = expanded ? '▾' : '▴';
    barList.classList.toggle('hidden', !expanded);
    barList.innerHTML = list.map(renderJob).join('');
    updateWakeLock(active.length > 0);
}

function renderJob(job) {
    const pct = job.total ? Math.round((job.received / job.total) * 100) : null;
    const sizeText = job.total
        ? `${formatSize(job.received)} / ${formatSize(job.total)}`
        : formatSize(job.received);

    let action = '';
    if (job.status === 'active') {
        action = `<button class="taskbar-act" data-job="${job.id}" data-act="cancel">İptal</button>`;
    } else if (job.status === 'pending-save') {
        action = `<button class="taskbar-act primary" data-job="${job.id}" data-act="save">💾 Kaydet</button>`;
    } else {
        action = `<button class="taskbar-act" data-job="${job.id}" data-act="dismiss">Kapat</button>`;
    }

    const icon = { active: '⬇️', done: '✅', error: '❌', cancelled: '⏹️', 'pending-save': '📦' }[job.status];

    return `
        <div class="taskbar-item">
            <div class="taskbar-item-main">
                <div class="taskbar-item-name">${icon} ${escapeHtml(job.name)}</div>
                <div class="taskbar-item-detail">${escapeHtml(job.detail || sizeText)}${pct !== null && job.status === 'active' ? ` • ${pct}%` : ''}</div>
            </div>
            ${action}
        </div>`;
}

// Uzun indirmelerde ekran kilidi indirmeyi kesmesin (destekleyen cihazlarda).
async function updateWakeLock(shouldHold) {
    if (!('wakeLock' in navigator)) return;
    try {
        if (shouldHold && !wakeLock && document.visibilityState === 'visible') {
            wakeLock = await navigator.wakeLock.request('screen');
            wakeLock.addEventListener('release', () => { wakeLock = null; });
        } else if (!shouldHold && wakeLock) {
            await wakeLock.release();
            wakeLock = null;
        }
    } catch (_) { /* kilit alınamadıysa indirme yine de sürer */ }
}

/* ---------------- Arka plan indirme (Background Fetch) ---------------- */

export const canBackgroundFetch = 'serviceWorker' in navigator && 'BackgroundFetchManager' in self;

/**
 * Dosyayı service worker üzerinden indirir: uygulama kapansa bile sürer ve
 * Android'de sistem indirme çubuğunda görünür. Kaydetme, kullanıcı döndüğünde yapılır.
 */
export async function startBackgroundDownload({ urls, name, total = 0 }) {
    if (!canBackgroundFetch) return null;

    const registration = await navigator.serviceWorker.ready;
    if (!registration.backgroundFetch) return null;

    const bgId = `dl-${Date.now()}::${name}`;
    const job = createJob(name);
    job.bgId = bgId;
    job.setDetail('Arka planda indiriliyor...');

    try {
        const bgFetch = await registration.backgroundFetch.fetch(bgId, urls, {
            title: name,
            downloadTotal: total || undefined,
            icons: [{ src: 'assets/icons/icon-192.png', sizes: '192x192', type: 'image/png' }]
        });

        job.cancel = () => {
            try { bgFetch.abort(); } catch (_) { /* zaten bitmiş olabilir */ }
            job.status = 'cancelled';
            job.detail = 'İptal edildi';
            render();
        };
        bgFetch.addEventListener('progress', () => {
            if (job.status !== 'active') return;
            job.progress(bgFetch.downloaded, bgFetch.downloadTotal);
        });
        return job;
    } catch (err) {
        job.fail(err.message || 'Arka plan indirmesi başlatılamadı');
        return null;
    }
}

function addPendingSave(meta) {
    const job = [...jobs.values()].find((j) => j.bgId === meta.id) || createJob(meta.name);
    job.bgId = meta.id;
    job.meta = meta;
    job.status = 'pending-save';
    job.detail = `Hazır • ${formatSize(meta.size || 0)} — kaydetmek için dokunun`;
    expanded = true;
    render();
}

// Uygulama kapalıyken biten indirmeler yeniden açılışta çubukta görünür.
async function restorePendingSaves() {
    try {
        const cache = await caches.open(BG_CACHE);
        const keys = await cache.keys();
        for (const request of keys) {
            const { pathname } = new URL(request.url);
            if (!pathname.startsWith(META_PREFIX)) continue;
            const meta = await (await cache.match(request)).json();
            addPendingSave(meta);
        }
    } catch (_) { /* önbellek yoksa yapacak bir şey yok */ }
}

async function savePending(job) {
    const meta = job.meta;
    if (!meta) return;
    try {
        const cache = await caches.open(BG_CACHE);
        const parts = [];
        let mime = 'application/octet-stream';
        for (const url of meta.urls) {
            const response = await cache.match(url);
            if (!response) throw new Error('Önbellekteki veri bulunamadı');
            mime = response.headers.get('content-type') || mime;
            parts.push(await response.blob());
        }

        saveBlob(new Blob(parts, { type: mime }), meta.name);

        await Promise.all(meta.urls.map((url) => cache.delete(url)));
        await cache.delete(META_PREFIX + encodeURIComponent(meta.id));

        job.status = 'done';
        job.detail = 'Kaydedildi';
        render();
        autoClear(job.id);
    } catch (err) {
        job.status = 'error';
        job.detail = err.message || 'Kaydedilemedi';
        render();
    }
}
