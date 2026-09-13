// İndirme yöneticisi: alt çubuk (mini görev çubuğu), diske kayıt, paylaşma ve arka plan indirme.
import { $, formatSize, escapeHtml, saveBlob, formatEta } from './util.js';

const BG_CACHE = 'bg-downloads';
const META_PREFIX = '/__bg-meta__/';
const MAX_HISTORY = 12;

let bar, barText, barPercent, barFill, barList, barToggle;
const jobs = new Map();
let expanded = false;
let wakeLock = null;
const listeners = new Set();

/** İndirme durumu her değiştiğinde çağrılır; abonelikten çıkmak için dönen fonksiyonu çağırın. */
export function subscribeDownloads(listener) {
    listeners.add(listener);
    listener(snapshot());
    return () => listeners.delete(listener);
}

function snapshot() {
    return [...jobs.values()].map((job) => ({
        id: job.id,
        name: job.name,
        status: job.status,
        detail: job.detail,
        received: job.received,
        total: job.total,
        kind: job.kind
    }));
}

/* ---------------- Hedefe yazma (disk veya bellek) ---------------- */

export const canSaveToDisk = typeof window.showSaveFilePicker === 'function';
export const canShareFiles = typeof navigator.canShare === 'function' && typeof navigator.share === 'function';

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

    $('taskbarMain').addEventListener('click', () => {
        expanded = !expanded;
        render();
    });

    // Sabit çubuk sayfanın altını kapatmasın: yüksekliği ölçüp gövdeye boşluk bırakıyoruz.
    if ('ResizeObserver' in window) {
        new ResizeObserver(([entry]) => {
            document.body.style.setProperty('--taskbar-h', Math.round(entry.contentRect.height) + 'px');
        }).observe(bar);
    }

    barList.addEventListener('click', (e) => {
        const btn = e.target.closest('button[data-job]');
        if (!btn) return;
        const job = jobs.get(btn.dataset.job);
        if (!job) return;
        if (btn.dataset.act === 'cancel') job.cancel();
        if (btn.dataset.act === 'save') savePending(job);
        if (btn.dataset.act === 'share') shareJob(job);
        if (btn.dataset.act === 'fallback') runFallback(job);
        if (btn.dataset.act === 'dismiss') removeJob(job);
    });

    if ('serviceWorker' in navigator) {
        navigator.serviceWorker.addEventListener('message', (event) => {
            const data = event.data || {};
            if (data.type === 'bg-download-ready') addPendingSave(data.meta);
            if (data.type === 'bg-download-failed' || data.type === 'bg-download-aborted') {
                const job = [...jobs.values()].find((j) => j.bgId === data.id);
                if (!job) return;
                if (data.type === 'bg-download-aborted') {
                    job.status = 'cancelled';
                    job.detail = 'İptal edildi';
                    render();
                    return;
                }
                job.status = 'error';
                job.detail = 'Arka plan indirmesi başarısız';
                render();
                runFallback(job); // varsa normal indirmeyle tekrar dene
            }
        });
        restorePendingSaves();
    }

    startStallWatch();
    render();
}

/**
 * Yeni bir indirme/dönüştürme işi kaydeder.
 * `thumb` verilirse listede küçük önizleme gösterilir.
 */
export function createJob(name, { onCancel, thumb = null, kind = 'file', fallback = null } = {}) {
    const id = 'j' + Math.random().toString(36).slice(2);
    const job = {
        id,
        name,
        kind,
        thumb,
        received: 0,
        total: 0,
        status: 'active',
        detail: '',
        blob: null,
        fallback,
        fallbackUsed: false,
        stalled: false,
        started: Date.now(),
        lastProgressAt: Date.now(),
        cancel() {
            if (job.status !== 'active') return;
            job.status = 'cancelled';
            job.detail = 'İptal edildi';
            if (onCancel) onCancel();
            render();
        },
        progress(received, total) {
            if (received !== job.received) job.lastProgressAt = Date.now();
            job.received = received;
            job.total = total || job.total;
            job.stalled = false;
            render();
        },
        setThumb(url) {
            job.thumb = url;
            render();
        },
        setDetail(text) {
            job.detail = text;
            render();
        },
        /** Bellekte tutulan sonucu işe bağlar; "Paylaş / Galeriye kaydet" bunu kullanır. */
        attachResult(blob) {
            job.blob = blob || null;
            render();
        },
        done(detail) {
            job.status = 'done';
            job.detail = detail || 'Tamamlandı';
            trimHistory();
            render();
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

function removeJob(job) {
    if (job.thumb && job.ownsThumb) URL.revokeObjectURL(job.thumb);
    jobs.delete(job.id);
    render();
}

// Biten işler listede kalır (indirme geçmişi); liste çok uzarsa en eskiler düşer.
function trimHistory() {
    const finished = [...jobs.values()].filter((j) => j.status === 'done' || j.status === 'cancelled');
    while (finished.length > MAX_HISTORY) removeJob(finished.shift());
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

    barFill.classList.remove('complete');
    if (active.length) {
        barText.textContent = active.length === 1 ? active[0].name : `${active.length} indirme sürüyor`;
        const unknown = active.some((j) => !j.total);
        barPercent.textContent = unknown ? '' : Math.round(ratio * 100) + '%';
        barFill.style.width = unknown ? '100%' : Math.round(ratio * 100) + '%';
        barFill.classList.toggle('indeterminate', unknown);
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

    const state = snapshot();
    listeners.forEach((listener) => listener(state));
}

function renderJob(job) {
    const pct = job.total ? Math.round((job.received / job.total) * 100) : null;
    const icon = { active: '⬇️', done: '✅', error: '❌', cancelled: '⏹️', 'pending-save': '📦' }[job.status];
    const thumb = job.thumb
        ? `<img class="taskbar-thumb" src="${job.thumb}" alt="">`
        : `<div class="taskbar-thumb placeholder">${{ video: '🎬', image: '🖼️', audio: '🎵', hls: '📡' }[job.kind] || '📄'}</div>`;

    const actions = [];
    if (job.status === 'active') {
        if (job.stalled && job.fallback && !job.fallbackUsed) {
            actions.push(`<button class="taskbar-act primary" data-job="${job.id}" data-act="fallback">⚡ Normal indir</button>`);
        }
        actions.push(`<button class="taskbar-act" data-job="${job.id}" data-act="cancel">İptal</button>`);
    } else if (job.status === 'pending-save') {
        actions.push(`<button class="taskbar-act primary" data-job="${job.id}" data-act="save">💾 Kaydet</button>`);
    } else {
        if (job.status === 'error' && job.fallback && !job.fallbackUsed) {
            actions.push(`<button class="taskbar-act primary" data-job="${job.id}" data-act="fallback">⚡ Normal indir</button>`);
        }
        if (job.blob && canShareFiles) {
            actions.push(`<button class="taskbar-act primary" data-job="${job.id}" data-act="share">📤 Galeriye kaydet</button>`);
        }
        actions.push(`<button class="taskbar-act" data-job="${job.id}" data-act="dismiss">Kapat</button>`);
    }

    const progressRow = job.status === 'active'
        ? `<div class="taskbar-item-track"><div class="taskbar-item-fill${pct === null ? ' indeterminate' : ''}" style="width:${pct === null ? 35 : pct}%"></div></div>`
        : '';

    return `
        <div class="taskbar-item">
            ${thumb}
            <div class="taskbar-item-main">
                <div class="taskbar-item-name">${icon} ${escapeHtml(job.name)}</div>
                <div class="taskbar-item-detail">${escapeHtml(job.detail || formatSize(job.received))}${
                    pct !== null && job.status === 'active' ? ` • ${pct}%` : ''
                }</div>
                ${progressRow}
            </div>
            <div class="taskbar-item-actions">${actions.join('')}</div>
        </div>`;
}

/** Dosyayı sistem paylaşım sayfasına verir: Android/iOS'ta "Fotoğraflara/Galeriye kaydet" çıkar. */
async function shareJob(job) {
    if (!job.blob) return;
    try {
        const file = new File([job.blob], job.name, { type: job.blob.type || 'application/octet-stream' });
        if (!navigator.canShare({ files: [file] })) {
            job.detail = 'Bu dosya türü paylaşılamıyor; indirilenler klasöründen açabilirsiniz.';
            render();
            return;
        }
        await navigator.share({ files: [file], title: job.name });
        job.detail = 'Paylaşıldı';
    } catch (err) {
        if (err.name !== 'AbortError') job.detail = 'Paylaşılamadı: ' + err.message;
    }
    render();
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

/** Arka plan takılırsa/başarısız olursa aynı indirmeyi normal yoldan tekrar dener. */
function runFallback(job) {
    if (!job.fallback || job.fallbackUsed) return;
    job.fallbackUsed = true;
    try {
        job.cancel(); // arka plan işini durdur (detay metnini kendi yazar)
    } catch (_) { /* arka plan zaten bitmiş olabilir */ }
    job.status = 'cancelled';
    job.detail = 'Arka plan başarısız — normal indirmeye geçildi';
    render();
    Promise.resolve(job.fallback()).catch((err) => {
        job.status = 'error';
        job.detail = err && err.message ? err.message : 'İndirilemedi';
        render();
    });
}

// Arka planda uzun süre ilerleme olmazsa kullanıcıyı bekletmeyip uyarır.
const STALL_MS = 25000;
function startStallWatch() {
    setInterval(() => {
        let changed = false;
        for (const job of jobs.values()) {
            if (job.status !== 'active' || !job.bgId || job.stalled) continue;
            if (Date.now() - (job.lastProgressAt || job.started) > STALL_MS) {
                job.stalled = true;
                job.detail = job.fallback
                    ? 'Arka planda ilerleme yok — "Normal indir" ile deneyebilirsiniz.'
                    : 'Arka planda ilerleme yok.';
                changed = true;
            }
        }
        if (changed) render();
    }, 5000);
}

/** Bir önizleme adresi çubukta kullanılıyor mu? (erken revoke edilmesini önler) */
export function isThumbInUse(url) {
    return [...jobs.values()].some((job) => job.thumb === url);
}

/* ---------------- Arka plan indirme (Background Fetch) ---------------- */

export const canBackgroundFetch = 'serviceWorker' in navigator && 'BackgroundFetchManager' in self;

/**
 * Dosyayı service worker üzerinden indirir: uygulama kapansa bile sürer ve
 * Android'de sistem indirme çubuğunda görünür. Kaydetme, kullanıcı döndüğünde yapılır.
 */
export async function startBackgroundDownload({ urls, name, total = 0, thumb = null, kind = 'file', fallback = null }) {
    if (!canBackgroundFetch) return null;

    const registration = await navigator.serviceWorker.ready;
    if (!registration.backgroundFetch) return null;

    const bgId = `dl-${Date.now()}::${name}`;
    const job = createJob(name, { thumb, kind, fallback });
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
            job.detail = `Arka planda • ${formatSize(bgFetch.downloaded)}` +
                (bgFetch.downloadTotal ? ` / ${formatSize(bgFetch.downloadTotal)} ${formatEta(bgFetch.downloaded, bgFetch.downloadTotal, job.started)}` : '');
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
            const type = response.headers.get('content-type');
            if (type && !type.includes('mpegurl')) mime = type;
            parts.push(await response.blob());
        }

        const blob = new Blob(parts, { type: mime });
        saveBlob(blob, meta.name);
        job.attachResult(blob);

        await Promise.all(meta.urls.map((url) => cache.delete(url)));
        await cache.delete(META_PREFIX + encodeURIComponent(meta.id));

        job.status = 'done';
        job.detail = `Kaydedildi • ${formatSize(blob.size)}`;
        render();
    } catch (err) {
        job.status = 'error';
        job.detail = err.message || 'Kaydedilemedi';
        render();
    }
}
