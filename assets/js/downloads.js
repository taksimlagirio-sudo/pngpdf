// İndirme yöneticisi: iş kuyruğu (aynı anda en fazla N iş), canlı kayıtlar, hedefe yazma
// (İndirilenler / Galeri / Konum seç), arka plan indirme ve İndirmeler ekranı + sağ sütun + şerit.
import { $, formatSize, escapeHtml, saveBlob, hms, formatLeft, waitForNetwork } from './util.js';
import { getPrefs, setPref, onPrefs } from './prefs.js';
import { openRemoteOverlay } from './remote.js';
import { libAdd, libUpdate } from './library.js';
import { siteSettingFor } from './sitesettings.js';
import { icon } from './icons.js';

const BG_CACHE = 'bg-downloads';
const META_PREFIX = '/__bg-meta__/';
const MAX_HISTORY = 30;
const SPEED_WINDOW_MS = 5000;
const INTERRUPTED_KEY = 'indirici.interrupted';
const INTERRUPTED_MAX_AGE_MS = 24 * 60 * 60 * 1000;

const jobs = new Map();
const listeners = new Set();
let filter = 'running';
let wakeLock = null;
let renderQueued = false;
let ticker = null;
let currentView = 'detect';
let floatOpen = false;
let interrupted = []; // önceki açılışta telefonda inerken yarıda kalan işler
let lastPersisted = '';
let resumeHandler = async () => {};

export const canSaveToDisk = typeof window.showSaveFilePicker === 'function';
export const canShareFiles = typeof navigator.canShare === 'function' && typeof navigator.share === 'function';
export const canBackgroundFetch = 'serviceWorker' in navigator && 'BackgroundFetchManager' in self;

/** İndirme durumu her değiştiğinde çağrılır (yüzen pencere bunu kullanır). */
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
        kind: job.kind,
        speed: job.speed,
        bytes: job.bytes,
        rec: job.rec ? { ...job.rec, elapsed: recElapsed(job) } : null
    }));
}

export function getJobs() {
    return [...jobs.values()];
}

/* ---------------- Hedefe yazma ---------------- */

/** Kaydetme yöntemi bu tarayıcıda yoksa çalışan bir sonrakine düşer. */
export function effectiveSaveMode(mode = getPrefs().save) {
    if (mode === 'disk' && !canSaveToDisk) return 'downloads';
    if (mode === 'gallery' && !canShareFiles) return 'downloads';
    return mode;
}

/**
 * Veriyi parça parça alan bir "sink" döner.
 * - disk: dosya konumu sorulur, veri doğrudan diske yazılır (bellek şişmez). Kullanıcı hareketi
 *   gerektirdiği için tıklama işleyicisinden, başka bir await'ten önce çağrılmalı.
 * - downloads: bellekte biriktirilir, bitince İndirilenler'e kaydedilir.
 * - gallery: downloads gibi kendiliğinden İndirilenler'e kaydedilir (telefonun galerisi bu klasörü
 *   gösterir); ayrıca "Galeriye" ile paylaşım sayfasından başka bir uygulamaya da gönderilebilir.
 * Bellekte biriken parçalar belirli aralıklarla Blob'a katlanır: tarayıcı büyük Blob'ları diske
 * taşıyabildiği için uzun kayıtlarda JS belleği dolmaz.
 */
export async function createSink(name, { mode = effectiveSaveMode(), mime = 'application/octet-stream' } = {}) {
    if (mode === 'disk' && canSaveToDisk) {
        try {
            const ext = name.split('.').pop() || 'bin';
            const handle = await window.showSaveFilePicker({
                suggestedName: name,
                types: [{ description: 'Dosya', accept: { [mime]: ['.' + ext] } }]
            });
            const writable = await handle.createWritable();
            let size = 0;
            return {
                mode: 'disk',
                name: handle.name || name,
                async write(chunk) {
                    await writable.write({ type: 'write', position: size, data: chunk });
                    size += chunk.byteLength || chunk.size || 0;
                },
                /** Daha önce yazılmış bir konumu düzeltir (MP4 başlığındaki boyut gibi). */
                async patch(position, bytes) { await writable.write({ type: 'write', position, data: bytes }); },
                async close() { await writable.close(); return null; },
                async abort() { try { await writable.abort(); } catch (_) { /* zaten kapalı */ } }
            };
        } catch (err) {
            if (err && err.name === 'AbortError') throw err; // kullanıcı konum seçmedi
            console.warn('Diske yazma kullanılamadı, belleğe düşülüyor:', err);
            mode = 'downloads';
        }
    }

    const FOLD_BYTES = 32 * 1024 * 1024;
    let head = null; // ilk parça ayrı tutulur: sonradan yamanabilsin (MP4 başlığı)
    let parts = [];
    let pending = [];
    let pendingBytes = 0;
    const fold = () => {
        if (!pending.length) return;
        parts.push(new Blob(pending, { type: mime }));
        pending = [];
        pendingBytes = 0;
    };
    return {
        mode: mode === 'gallery' ? 'gallery' : mode === 'memory' ? 'memory' : 'downloads',
        name,
        async write(chunk) {
            if (!head) {
                head = chunk instanceof Uint8Array ? chunk : new Uint8Array(await new Blob([chunk]).arrayBuffer());
                return;
            }
            pending.push(chunk);
            pendingBytes += chunk.byteLength || chunk.size || 0;
            if (pendingBytes >= FOLD_BYTES) fold();
        },
        async patch(position, bytes) {
            if (!head || position + bytes.length > head.length) throw new Error('Dosya başlığı düzeltilemedi');
            head.set(bytes, position);
        },
        async close() {
            fold();
            const blob = new Blob(head ? [head, ...parts] : parts, { type: mime });
            parts = [];
            head = null;
            // Galeri seçiliyken de dokunmayı beklemeden kaydedilir; "memory" yalnızca bellekte tutar
            // (ara dosyalar: altyazı gömme, sesi ayırma).
            if (mode !== 'memory') saveBlob(blob, name);
            return blob;
        },
        async abort() {
            parts = [];
            pending = [];
            head = null;
        }
    };
}

/* ---------------- İşler ---------------- */

/**
 * Yeni bir iş kaydeder. `run(job)` verilirse iş kuyruğa girer ve sırası gelince çalışır;
 * `now: true` sınırı beklemeden hemen başlatır. `run` olmadan çağrılırsa iş hemen "aktif" sayılır.
 */
export function addJob({ name, kind = 'file', thumb = null, run = null, now = false, saveMode = null, source = null, resume = null } = {}) {
    const id = 'j' + Math.random().toString(36).slice(2, 10);
    const controller = new AbortController();
    const job = {
        id,
        name,
        kind,
        thumb,
        run,
        now,
        source, // { media, page }: hata kartında "Yeniden algıla" / "Dene" için
        resume, // sayfa yeniden yüklenirse işi yeniden kurma tarifi (detect-tab resumeRecipe)
        pageInput: '',
        saveMode: saveMode || effectiveSaveMode(),
        status: run ? 'queued' : 'active',
        detail: '',
        received: 0,
        total: 0,
        bytes: 0,
        speed: 0,
        samples: [],
        blob: null,
        saved: false,
        rec: null,
        canStop: false,
        stopRequested: false,
        bgId: null,
        fallback: null,
        fallbackUsed: false,
        stalled: false,
        createdAt: Date.now(),
        startedAt: run ? 0 : Date.now(),
        finishedAt: 0,
        lastProgressAt: Date.now(),
        controller,
        signal: controller.signal,
        hooks: {},

        /** İptal: yazılanlar atılır. */
        cancel() {
            if (!['active', 'queued'].includes(job.status)) return;
            if (job.hooks.cancel) job.hooks.cancel();
            job.controller.abort();
            setStatus(job, 'cancelled', 'İptal edildi');
        },
        /** Durdur ve kaydet: o ana kadar inenler dosyaya yazılır (kayıt ve HLS). */
        stop() {
            if (job.status !== 'active' || !job.canStop) return;
            job.stopRequested = true;
            job.detail = 'Durduruluyor, kaydediliyor...';
            if (job.hooks.stop) job.hooks.stop();
            render();
        },
        /** Bağlantı koptu: iş "duraklatıldı" görünür, bağlantı gelince (ya da Devam et ile) sürer. */
        async waitNetwork() {
            job.netPaused = true;
            render();
            try {
                await waitForNetwork(job.signal, { kick: (fn) => { job.resumeNow = fn; } });
            } finally {
                job.netPaused = false;
                job.resumeNow = null;
                render();
            }
        },
        progress(received, total) {
            if (received !== job.received) job.lastProgressAt = Date.now();
            job.received = received;
            if (total) job.total = total;
            job.stalled = false;
            render();
        },
        addBytes(n) {
            job.bytes += n;
            const now = Date.now();
            job.samples.push([now, job.bytes]);
            while (job.samples.length > 2 && now - job.samples[0][0] > SPEED_WINDOW_MS) job.samples.shift();
            job.lastProgressAt = now;
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
        attachResult(blob) {
            job.blob = blob || null;
            render();
        },
        done(detail) {
            setStatus(job, 'done', detail || 'Tamamlandı');
            notifyFinished(job);
            keepInLibrary(job);
        },
        fail(detail) {
            setStatus(job, 'error', detail || 'Başarısız');
            notifyFinished(job);
        }
    };
    jobs.set(id, job);
    if (run) pump(); else render();
    return job;
}

function setStatus(job, status, detail) {
    const wasRunning = job.status === 'active';
    job.status = status;
    if (detail !== undefined) job.detail = detail;
    if (['done', 'error', 'cancelled'].includes(status)) {
        job.finishedAt = Date.now();
        trimHistory();
    }
    render();
    if (wasRunning || status === 'cancelled') pump();
}

/** Kuyruk: sınır dolmadıkça sıradaki işi başlatır. Arka plan (sistem) indirmeleri ve sunucudaki kayıtlar sayılmaz. */
function pump() {
    const limit = getPrefs().concurrency || 3;
    const running = () => [...jobs.values()].filter((j) => j.status === 'active' && !j.bgId && !j.serverRec && !j.serverDl).length;
    const queued = [...jobs.values()].filter((j) => j.status === 'queued')
        .sort((a, b) => (b.now - a.now) || (a.createdAt - b.createdAt));
    for (const job of queued) {
        if (!job.now && running() >= limit) break;
        start(job);
    }
    render();
}

function start(job) {
    job.status = 'active';
    job.startedAt = Date.now();
    job.lastProgressAt = Date.now();
    Promise.resolve()
        .then(() => job.run(job))
        .catch((err) => {
            if (job.status !== 'active') return;
            if (err && err.name === 'AbortError') setStatus(job, 'cancelled', 'İptal edildi');
            else job.fail((err && err.message) || 'Başarısız');
        });
}

/** Sıradaki işi sınırı beklemeden başlatır. */
function startNow(job) {
    if (job.status !== 'queued') return;
    job.now = true;
    start(job);
    render();
}

function retry(job) {
    if (!job.run || !['error', 'cancelled'].includes(job.status)) return;
    jobs.delete(job.id);
    addJob({ name: job.name, kind: job.kind, thumb: job.thumb, run: job.run, now: true, saveMode: job.saveMode, source: job.source, resume: job.resume });
}

function removeJob(job) {
    if (job.hooks.remove) job.hooks.remove();
    jobs.delete(job.id);
    render();
}

function trimHistory() {
    const finished = [...jobs.values()].filter((j) => ['done', 'cancelled', 'error'].includes(j.status));
    while (finished.length > MAX_HISTORY) {
        const oldest = finished.shift();
        jobs.delete(oldest.id);
    }
}

function jobSpeed(job) {
    if (job.status !== 'active' || job.samples.length < 2) return 0;
    const [t0, b0] = job.samples[0];
    const [t1, b1] = job.samples[job.samples.length - 1];
    if (Date.now() - t1 > SPEED_WINDOW_MS) return 0; // uzun süredir veri gelmiyor
    return t1 > t0 ? ((b1 - b0) * 1000) / (t1 - t0) : 0;
}

function recElapsed(job) {
    if (!job.rec) return 0;
    // Sunucuda hızlandırılmış kayıtta sayaç, kaydedilen video süresidir (gerçek zamandan hızlı akar).
    if (job.rec.mode === 'capture') return job.rec.mediaSec || 0;
    const end = job.rec.endedAt || Date.now();
    return Math.max(0, (end - job.rec.startedAt) / 1000);
}

/* ---------------- Paylaşma / kaydetme ---------------- */

async function shareJob(job) {
    if (!job.blob) return;
    try {
        // Toplu resim işi: hepsi tek seferde paylaşılır (galeriye tek dokunuşla).
        const files = job.files
            ? job.files.map((f) => new File([f.blob], f.name, { type: f.blob.type || 'application/octet-stream' }))
            : [new File([job.blob], job.name, { type: job.blob.type || 'application/octet-stream' })];
        if (!navigator.canShare({ files })) {
            job.detail = 'Bu dosya türü paylaşılamıyor; "Kaydet" ile İndirilenler\'e alın.';
            render();
            return;
        }
        await navigator.share({ files, title: job.name });
        job.saved = true;
        job.detail = 'Paylaşıldı';
        markExported(job);
    } catch (err) {
        if (err.name !== 'AbortError') job.detail = 'Paylaşılamadı: ' + err.message;
    }
    render();
}

function saveJob(job) {
    if (job.hooks.save) return job.hooks.save();
    if (job.status === 'pending-save') return savePending(job);
    if (job.files) {
        job.files.forEach((f) => saveBlob(f.blob, f.name));
        job.saved = true;
        markExported(job);
        render();
    } else if (job.blob) {
        saveBlob(job.blob, job.name);
        job.saved = true;
        markExported(job);
        render();
    }
}

/** Biten dosyanın uygulama içi kopyası (Kitaplık). Galeriye/İndirilenler'e ayrıca kaydedilir. */
async function keepInLibrary(job) {
    const files = job.files || (job.blob ? [{ blob: job.blob, name: job.name }] : []);
    if (!files.length) return;
    const src = job.source || {};
    // İndirilenler'e kaydedilen hemen dışarıda da var sayılır; galeride paylaşılınca işaretlenir.
    const exported = job.saveMode === 'downloads';
    job.libIds = [];
    for (const f of files) {
        const site = siteSettingFor(src.page || src.media || f.url || '');
        const item = await libAdd(f.blob, {
            name: f.name, rec: job.kind === 'rec' || Boolean(job.serverRec), page: src.page || '', media: src.media || f.url || '', exported,
            extra: site && site.folder ? { collections: [site.folder] } : {}
        }).catch(() => null);
        if (item) job.libIds.push(item.id);
    }
}

function markExported(job) {
    for (const id of job.libIds || []) libUpdate(id, { exportedAt: Date.now() }).catch(() => {});
}

function notifyFinished(job) {
    if (document.visibilityState === 'visible') return;
    if (window.IndiriciAndroid && window.IndiriciAndroid.notify) {
        window.IndiriciAndroid.notify(job.status === 'done' ? `Bitti: ${job.name}` : `Başarısız: ${job.name}`, job.detail || '', job.id, '#downloads');
        return;
    }
    if (!('Notification' in window) || Notification.permission !== 'granted') return;
    const title = job.status === 'done' ? `Bitti: ${job.name}` : `Başarısız: ${job.name}`;
    navigator.serviceWorker?.ready.then((reg) => reg.showNotification(title, {
        body: job.detail || '',
        icon: 'assets/icons/icon-192.png',
        tag: job.id
    })).catch(() => {});
}

/** Kayıt başlatılırken (kullanıcı dokunuşuyla) bildirim izni istenir: bitince haber verelim. */
export function askNotificationPermission() {
    if ('Notification' in window && Notification.permission === 'default') {
        Notification.requestPermission().catch(() => {});
    }
}

/* ---------------- Ekran kilidi ---------------- */

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

/**
 * Dosyayı service worker üzerinden indirir: uygulama kapansa bile sürer ve Android'de sistem
 * indirme çubuğunda görünür. Kaydetme, kullanıcı döndüğünde yapılır.
 */
export async function startBackgroundDownload({ urls, name, total = 0, thumb = null, kind = 'file', fallback = null, job = null }) {
    if (!canBackgroundFetch) return null;
    const registration = await navigator.serviceWorker.ready;
    if (!registration.backgroundFetch) return null;

    const bgId = `dl-${Date.now()}::${name}`;
    job = job || addJob({ name, kind, thumb });
    job.bgId = bgId;
    job.fallback = fallback;
    job.setDetail('Arka planda indiriliyor...');

    try {
        const bgFetch = await registration.backgroundFetch.fetch(bgId, urls, {
            // Toplam boyut verilmez: tahmin gerçek boyuttan küçükse tarayıcı indirmeyi durdurur.
            title: name,
            icons: [{ src: 'assets/icons/icon-192.png', sizes: '192x192', type: 'image/png' }]
        });
        job.hooks.cancel = () => {
            try { bgFetch.abort(); } catch (_) { /* zaten bitmiş olabilir */ }
        };
        bgFetch.addEventListener('progress', () => {
            if (job.status !== 'active') return;
            job.addBytes(bgFetch.downloaded - job.bytes);
            job.progress(bgFetch.downloaded, bgFetch.downloadTotal);
        });
        pump(); // arka plan işi kuyruk sınırına sayılmaz; sıradaki başlasın
        return job;
    } catch (err) {
        job.bgId = null;
        job.fail(err.message || 'Arka plan indirmesi başlatılamadı');
        return null;
    }
}

/** Arka plan takılırsa/başarısız olursa aynı indirmeyi normal yoldan tekrar dener. */
function runFallback(job) {
    if (!job.fallback || job.fallbackUsed) return;
    job.fallbackUsed = true;
    if (job.hooks.cancel) {
        try { job.hooks.cancel(); } catch (_) { /* arka plan zaten bitmiş olabilir */ }
    }
    setStatus(job, 'cancelled', 'Arka plan başarısız — normal indirmeye geçildi');
    Promise.resolve(job.fallback()).catch((err) => {
        job.status = 'error';
        job.detail = err && err.message ? err.message : 'İndirilemedi';
        render();
    });
}

const STALL_MS = 25000;
function checkStalls() {
    for (const job of jobs.values()) {
        if (job.status !== 'active' || !job.bgId || job.stalled) continue;
        if (Date.now() - job.lastProgressAt > STALL_MS) {
            job.stalled = true;
            // Hiç başlamadıysa (tarayıcı izin vermedi, ağ türü vb.) kendiliğinden normal indirmeye geçilir.
            if (!job.bytes && job.fallback) runFallback(job);
            else job.detail = 'Arka planda ilerleme yok — "Normal indir" ile deneyebilirsiniz.';
        }
    }
}

function addPendingSave(meta) {
    let job = [...jobs.values()].find((j) => j.bgId === meta.id);
    if (!job) job = addJob({ name: meta.name, kind: 'file' });
    job.bgId = meta.id;
    job.meta = meta;
    job.status = 'pending-save';
    job.finishedAt = Date.now();
    job.detail = `Hazır · ${formatSize(meta.size || 0)} — kaydetmek için dokunun`;
    render();
    pump();
}

async function restorePendingSaves() {
    try {
        const cache = await caches.open(BG_CACHE);
        for (const request of await cache.keys()) {
            const { pathname } = new URL(request.url);
            if (!pathname.startsWith(META_PREFIX)) continue;
            addPendingSave(await (await cache.match(request)).json());
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
        job.blob = blob;
        job.saved = true;
        await Promise.all(meta.urls.map((url) => cache.delete(url)));
        await cache.delete(META_PREFIX + encodeURIComponent(meta.id));
        setStatus(job, 'done', `Kaydedildi · ${formatSize(blob.size)}`);
    } catch (err) {
        setStatus(job, 'error', err.message || 'Kaydedilemedi');
    }
}

/* ---------------- Arayüz ---------------- */

let navigate = () => {};
let detect = () => {};

/* ---------------- Yarıda kalanlar ----------------
 * Telefonda (sunucusuz) inen iş sayfayla birlikte yaşar: paylaşımla gelen bağlantı, güncelleme ya da
 * Android'in uygulamayı kapatması sayfayı yeniden yüklerse iş kaybolur. Süren işlerin tarifi sürekli
 * saklanır; sonraki açılışta "N indirme yarıda kaldı · Yeniden başlat" çıkar. Sunucudaki indirme ve
 * kayıtlar, arka plan (sistem) indirmeleri kendileri sürdüğünden saklanmaz. */
function persistRunning() {
    const list = [...jobs.values()]
        .filter((j) => ['active', 'queued'].includes(j.status) && j.resume && !j.bgId && !j.serverRec && !j.serverDl && !j.captureId)
        .map((j) => ({ name: j.name, kind: j.kind, resume: j.resume, since: j.createdAt }));
    const text = JSON.stringify(list);
    if (text === lastPersisted) return;
    lastPersisted = text;
    try {
        if (list.length) localStorage.setItem(INTERRUPTED_KEY, text);
        else localStorage.removeItem(INTERRUPTED_KEY);
    } catch (_) { /* depolama kapalı */ }
}

function loadInterrupted() {
    try {
        const list = JSON.parse(localStorage.getItem(INTERRUPTED_KEY) || '[]');
        localStorage.removeItem(INTERRUPTED_KEY);
        interrupted = (Array.isArray(list) ? list : [])
            .filter((x) => x && x.resume && Date.now() - (x.since || 0) < INTERRUPTED_MAX_AGE_MS);
    } catch (_) {
        interrupted = [];
    }
}

/** Önceki açılışta yarıda kalan indirme sayısı (açılışta bildirmek için). */
export function interruptedCount() {
    return interrupted.length;
}

async function resumeInterrupted() {
    const list = interrupted;
    interrupted = [];
    render();
    const failed = [];
    for (const item of list) {
        try {
            await resumeHandler(item.resume);
        } catch (err) {
            failed.push({ ...item, error: (err && err.message) || 'bulunamadı' });
        }
    }
    // Bulunamayanlar kartta kalır (yeniden denenebilir ya da vazgeçilir).
    interrupted = failed;
    render();
}

function renderInterrupted() {
    if (!interrupted.length) return '';
    const names = interrupted.slice(0, 3).map((x) => `<li>${escapeHtml(x.name)}${x.error ? ` <span class="muted">· ${escapeHtml(x.error)}</span>` : ''}</li>`).join('');
    const more = interrupted.length > 3 ? `<li class="muted">ve ${interrupted.length - 3} tane daha</li>` : '';
    return `<div class="dl-interrupted">
        <div class="dli-head">${icon('alert')}<span><b>${interrupted.some((x) => x.error) ? `${interrupted.length} indirme yeniden başlatılamadı` : `${interrupted.length} indirme yarıda kaldı`}</b>
            <small>Uygulama yeniden açıldı (paylaşım, güncelleme ya da telefon kapattı). Telefona inenler baştan indirilir.</small></span></div>
        <ul>${names}${more}</ul>
        <div class="dli-btns"><button class="btn-ac" data-job-act="resume-interrupted">Yeniden başlat</button>
            <button class="btn-ghost" data-job-act="dismiss-interrupted">Vazgeç</button></div>
    </div>`;
}

export function initDownloads({ onNavigate, onDetect, onResume } = {}) {
    navigate = onNavigate || navigate;
    detect = onDetect || detect;
    resumeHandler = onResume || resumeHandler;
    loadInterrupted();
    window.addEventListener('pagehide', persistRunning);

    // Hata kartındaki sayfa adresi: yazılanı iş üzerinde tut (yeniden çizimde kaybolmasın).
    document.addEventListener('input', (e) => {
        const el = e.target.closest('[data-job-input]');
        const job = el && jobs.get(el.dataset.jobInput);
        if (job) job.pageInput = el.value;
    });
    document.addEventListener('focusout', (e) => {
        if (e.target.closest('[data-job-input]')) render();
    });

    document.addEventListener('click', (e) => {
        const btn = e.target.closest('[data-job-act]');
        if (!btn) return;
        const job = jobs.get(btn.dataset.job);
        const act = btn.dataset.jobAct;
        if (act === 'filter') {
            filter = btn.dataset.value;
            if (currentView !== 'downloads') navigate('downloads');
            return render();
        }
        if (act === 'conc') {
            setPref('concurrency', Number(btn.dataset.value));
            return pump();
        }
        if (act === 'resume-interrupted') {
            btn.disabled = true;
            btn.textContent = 'Bulunuyor...';
            resumeInterrupted();
            return;
        }
        if (act === 'dismiss-interrupted') {
            interrupted = [];
            return render();
        }
        if (!job) return;
        if (act === 'cancel') job.cancel();
        if (act === 'resume' && job.resumeNow) job.resumeNow();
        if (act === 'stop') job.stop();
        if (act === 'now') startNow(job);
        if (act === 'save') saveJob(job);
        if (act === 'share') shareJob(job);
        if (act === 'fallback') runFallback(job);
        if (act === 'retry') retry(job);
        if (act === 'dismiss') removeJob(job);
        if (act === 'touch' && job.captureId) openTouch(job);
        if (act === 'open' && job.openUrl) window.open(job.openUrl, '_blank', 'noopener');
        if (act === 'redetect') {
            const url = (job.source && (job.source.page || job.source.media)) || job.openUrl;
            if (url) {
                removeJob(job);
                detect(url);
            }
        }
        if (act === 'try-page') {
            const url = (job.pageInput || '').trim();
            if (!/^https?:\/\//i.test(url)) {
                const input = document.querySelector(`[data-job-input="${job.id}"]`);
                if (input) input.focus();
                return;
            }
            removeJob(job);
            detect(url);
        }
    });

    if ('serviceWorker' in navigator) {
        navigator.serviceWorker.addEventListener('message', (event) => {
            const data = event.data || {};
            if (data.type === 'bg-download-ready') addPendingSave(data.meta);
            if (data.type === 'bg-download-failed' || data.type === 'bg-download-aborted') {
                const job = [...jobs.values()].find((j) => j.bgId === data.id);
                if (!job || job.status !== 'active') return;
                if (data.type === 'bg-download-aborted') return setStatus(job, 'cancelled', 'İptal edildi');
                setStatus(job, 'error', 'Arka plan indirmesi başarısız');
                runFallback(job);
            }
        });
        restorePendingSaves();
    }

    document.addEventListener('visibilitychange', () => {
        if (document.visibilityState === 'visible') render();
    });
    window.addEventListener('online', render);
    window.addEventListener('offline', render);

    // Süren kayıt/indirme varken sayfa yanlışlıkla kapatılmasın.
    // Sayfadan çıkarken "emin misin" sorulmaz: paylaşımla gelen bağlantı açık uygulamayı yeniden
    // yüklerken bu soru gezinmeyi durdurup uygulamanın hiç açılmamasına yol açabiliyordu. Yarıda kalan
    // indirmeler zaten saklanıyor ve açılışta "Yeniden başlat" ile sürdürülebiliyor.

    onPrefs((_, key) => {
        if (key === 'concurrency') pump();
        render();
    });
    render();
}

export function setFloatOpen(open) {
    floatOpen = open;
    document.querySelectorAll('[data-float-toggle]').forEach((el) => {
        el.textContent = open ? 'Pencereyi kapat' : 'Üstte göster';
    });
    render();
}

export function setCurrentView(view) {
    currentView = view;
    render();
}

export function render() {
    if (renderQueued) return;
    renderQueued = true;
    requestAnimationFrame(() => {
        renderQueued = false;
        renderNow();
    });
}

function renderNow() {
    persistRunning();
    const list = [...jobs.values()];
    for (const job of list) job.speed = jobSpeed(job);
    checkStalls();

    const active = list.filter((j) => j.status === 'active');
    const queued = list.filter((j) => j.status === 'queued');
    const pending = list.filter((j) => j.status === 'pending-save');
    const count = active.length + queued.length + pending.length;

    document.querySelectorAll('[data-count]').forEach((el) => {
        el.textContent = count;
        el.classList.toggle('hidden', count === 0);
    });
    document.querySelectorAll('[data-count-inline]').forEach((el) => {
        el.textContent = count ? ` · ${count}` : '';
    });

    const view = $('downloadsView');
    const typing = document.activeElement && document.activeElement.closest && document.activeElement.closest('[data-job-input]');
    if (view && currentView === 'downloads' && !typing) setHtml(view, renderFull(list));
    const aside = $('downloadsAside');
    if (aside && getComputedStyle(aside).display !== 'none') setHtml(aside, renderAside(list));
    renderStrip(active, queued);

    const keepAwake = getPrefs().keepAwake && active.some((j) => !j.bgId && !j.serverRec && !j.serverDl);
    updateWakeLock(keepAwake);

    // Kayıt süreleri ve hızlar her saniye tazelensin.
    const needsTick = active.length > 0;
    if (needsTick && !ticker) ticker = setInterval(render, 1000);
    if (!needsTick && ticker) {
        clearInterval(ticker);
        ticker = null;
    }

    // Video başladıysa (ya da iş bittiyse) dokunma penceresi kendiliğinden kapanır.
    if (sheet) {
        const job = jobs.get(sheet.jobId);
        // Kayıt başlayınca ekran açık kalır (üstte kaydın durumu); iş bitince/silinince kapanır.
        if (!job || !['active', 'queued'].includes(job.status)) sheet.view.close();
    }

    const state = snapshot();
    listeners.forEach((listener) => listener(state));
}

// Değişmeyen içerik yeniden yazılmasın (dokunuşlar kaybolmasın, gereksiz çizim olmasın).
function setHtml(el, html) {
    if (el._html === html) return;
    el._html = html;
    el.innerHTML = html;
}

function totalSpeed(active) {
    return active.reduce((sum, j) => sum + (j.speed || 0), 0);
}

function speedText(bytesPerSec) {
    return bytesPerSec > 0 ? `${formatSize(bytesPerSec)}/sn` : '';
}

function ratioOf(job) {
    return job.total ? Math.min(1, job.received / job.total) : null;
}

function renderStrip(active, queued) {
    const strip = $('dlStrip');
    if (!strip) return;
    const show = (active.length || queued.length) && currentView !== 'downloads';
    strip.classList.toggle('hidden', !show);
    document.body.classList.toggle('has-strip', Boolean(show));
    if (!show) return;

    const rec = active.find((j) => j.rec);
    const others = active.filter((j) => j !== rec);
    let text;
    if (rec) {
        text = `<span class="rec-dot"></span><span class="strip-text">Kayıt ${hms(recElapsed(rec))}${others.length ? ` · +${others.length} indirme` : ''}</span>`;
    } else {
        text = `<span class="strip-text">${active.length === 1 ? escapeHtml(active[0].name)
            : active.length ? `${active.length} indirme sürüyor` : `${queued.length} indirme sırada`}</span>`;
    }
    const ratios = others.map(ratioOf).filter((r) => r !== null);
    const pct = ratios.length ? Math.round((ratios.reduce((a, b) => a + b, 0) / ratios.length) * 100) + '%' : '';
    strip.innerHTML = `${text}<span class="strip-speed">${speedText(totalSpeed(active))}</span><span class="strip-pct">${pct}</span>`;
}

function thumbHtml(job, size = '') {
    if (job.thumb) return `<span class="thumb ${size}"><img src="${escapeHtml(job.thumb)}" alt=""></span>`;
    const label = { hls: 'HLS', video: 'VID', audio: 'SES', image: 'IMG', rec: 'REC', zip: 'ZIP' }[job.kind] || '';
    return `<span class="thumb ${size}"><span class="thumb-icon">${label}</span></span>`;
}

function btn(job, act, label, cls = '') {
    return `<button class="dl-btn ${cls}" data-job="${job.id}" data-job-act="${act}">${label}</button>`;
}

function renderFull(list) {
    const active = list.filter((j) => j.status === 'active');
    const queued = list.filter((j) => j.status === 'queued').sort((a, b) => a.createdAt - b.createdAt);
    const finished = list.filter((j) => ['done', 'error', 'cancelled', 'pending-save'].includes(j.status))
        .sort((a, b) => (b.finishedAt || b.createdAt) - (a.finishedAt || a.createdAt));
    const conc = getPrefs().concurrency || 3;

    const failed = finished.filter((j) => j.status === 'error');
    const history = finished.filter((j) => j.status !== 'error' && j.status !== 'pending-save');
    const pending = finished.filter((j) => j.status === 'pending-save');
    const summaryParts = [`${active.length} iş sürüyor`];
    if (queued.length) summaryParts.push(`${queued.length} sırada`);

    let html = `${downloadsTabs(filter === 'done' ? 'done' : 'running')}
        ${active.length || queued.length ? `<div class="dl-summary"><span>${summaryParts.join(' · ')}</span><span class="mono">${speedText(totalSpeed(active))}</span></div>` : ''}
        <div class="dl-list">`;

    const paused = active.filter((j) => j.netPaused);
    if (filter !== 'done' && (paused.length || navigator.onLine === false)) {
        const waiting = paused.length + queued.length;
        html = html.replace('<div class="dl-list">', `<div class="net-banner"><i></i>İnternet yok${waiting ? ` · ${waiting} indirme bekliyor` : ''}</div><div class="dl-list">`);
    }
    if (filter !== 'done') {
        html += renderInterrupted();
        html += active.map(renderActive).join('');
        html += queued.map((job, i) => renderQueuedJob(job, active.length + i + 1)).join('');
        html += pending.map(renderFinished).join('');
        if (failed.length) {
            html += `<div class="dl-group">İnmeyenler · ${failed.length}</div>`;
            html += failed.map(renderFailed).join('');
        }
        if (paused.length) html += '<p class="net-note">İnen parçalar saklanır. Bağlantı gelince kaldığı parçadan sürer; baştan inmez.</p>';
        if (!active.length && !queued.length && !failed.length && !pending.length && !interrupted.length) {
            html += `<div class="empty">Süren indirme yok.<br>Algıla'ya bir bağlantı yapıştırın; videolar, yayınlar ve canlı kayıtlar burada görünür.</div>`;
        }
    } else {
        html += history.map(renderFinished).join('');
        if (!history.length) html += '<div class="empty">Biten indirme yok.</div>';
    }
    html += `</div>${concRow(conc)}`;
    return html;
}

/** İndirmeler'in üst sekmeleri: İşler · Takip · Geçmiş (Takip ayrı ekrandır). */
let followCount = 0;
export function setFollowCount(n) {
    if (n === followCount) return;
    followCount = n;
    render();
}

export function downloadsTabs(active) {
    return `<div class="seg dl-tabs">
        <button class="${active === 'running' ? 'on' : ''}" data-job-act="filter" data-value="running">İşler</button>
        <button class="${active === 'follow' ? 'on' : ''}" data-view="follow">Takip${followCount ? ` · ${followCount}` : ''}</button>
        <button class="${active === 'done' ? 'on' : ''}" data-job-act="filter" data-value="done">Geçmiş</button></div>`;
}

function concRow(conc) {
    return `<div class="conc-row"><span>Aynı anda en fazla</span><div class="seg seg-sm">${[1, 2, 3, 5].map((n) =>
        `<button class="${conc === n ? 'on' : ''}" data-job-act="conc" data-value="${n}">${n}</button>`).join('')}</div></div>`;
}

/** "Açıp kaydet"in hangi aşamada olduğu: rozet, renk ve açıklama. */
function captureStage(job) {
    const rec = job.rec;
    if (job.needsUser) return { key: 'wait', badge: 'BAŞLATMANI BEKLİYOR' };
    if (!rec.mediaSec && job.total > 0) return { key: 'file', badge: 'DOSYA ALINIYOR' };
    if (rec.mediaSec > 0 || rec.speed > 0.5) {
        const x = rec.speed > 1.5 ? `${Math.round(rec.speed)}× ` : '';
        return { key: 'play', badge: `${x}OYNATILIYOR` };
    }
    return { key: 'open', badge: 'SUNUCUDA AÇILIYOR' };
}

function stageHead(job, stage, right = '') {
    return `<div class="stage-head"><span class="stage-badge">${stage}</span>
        <span class="dl-name">${escapeHtml(job.name)}</span>${right}</div>`;
}

function renderCapture(job) {
    const rec = job.rec;
    const stage = captureStage(job);
    const stopping = job.stopRequested;
    const why = rec.why ? `<div class="stage-why">${escapeHtml(rec.why)} — video sunucunda açılıp kaydediliyor</div>` : '';
    const note = !job.needsUser && job.detail && (stopping || rec.warning) ? `<div class="hint">${escapeHtml(job.detail)}</div>` : '';
    let body = '';
    if (stage.key === 'wait') {
        body = `<div class="stage-text">Video kendiliğinden başlamadı. Sayfanın görüntüsünde oynat'a dokun; başladığı an kayıt başlar.</div>
            <div class="stage-btns">${btn(job, 'touch', 'Videoyu başlat', 'primary')}${btn(job, 'cancel', 'İptal')}</div>`;
    } else if (stage.key === 'file') {
        const done = Math.min(1, job.received / job.total);
        return `<div class="stage-card stage-file">${why}
            ${stageHead(job, stage.badge, `<span class="stage-pct">${Math.round(done * 100)}%</span>`)}
            <div class="stage-bar"><div style="width:${done * 100}%"></div></div>
            <div class="stage-sub"><span>${formatSize(job.received)} / ${formatSize(job.total)}</span><span>${speedText(job.speed)}</span></div>
            ${note}<div class="stage-btns">${stopping ? '' : btn(job, 'cancel', 'İptal', 'text')}</div></div>`;
    } else if (stage.key === 'play') {
        const done = rec.duration > 0 ? Math.min(1, rec.mediaSec / rec.duration) : null;
        const left = done !== null && rec.speed > 0.5 ? formatLeft((rec.duration - rec.mediaSec) / rec.speed) + ' kaldı' : '';
        body = `<div class="stage-time"><span>${hms(rec.mediaSec)}</span>${rec.duration ? `<small>/ ${hms(rec.duration)}</small>` : ''}</div>
            <div class="stage-bar${done === null ? ' indeterminate' : ''}"><div style="width:${done === null ? 35 : done * 100}%"></div></div>
            <div class="stage-sub"><span>${[left, formatSize(job.bytes)].filter(Boolean).join(' · ')}</span><span>orijinal kalite · sesli</span></div>
            ${note}
            <div class="stage-foot"><span>${rec.blockedAds ? `${rec.blockedAds} reklam atlandı` : escapeHtml(rec.phase || '')}</span>
                <div class="dl-btns">${stopping ? '' : btn(job, 'cancel', 'İptal', 'text') + btn(job, 'stop', 'Durdur ve kaydet', 'danger')}</div></div>`;
    } else {
        body = `<div class="stage-bar idle"><div style="width:22%"></div></div>
            <div class="stage-text">${escapeHtml(rec.phase && !/hazırlan/i.test(rec.phase) ? rec.phase : 'Önce sayfa açılıyor ki giriş/çerez otursun')}</div>
            ${note}<div class="stage-btns">${stopping ? '' : btn(job, 'cancel', 'İptal', 'text')}</div>`;
    }
    return `<div class="stage-card stage-${stage.key}">${why}${stageHead(job, stage.badge)}${body}</div>`;
}

/** Sunucuda kaydedilen dosya telefona aktarılırken. */
function renderTransfer(job) {
    const ratio = ratioOf(job);
    const pct = ratio === null ? '' : Math.round(ratio * 100) + '%';
    const saved = job.transfer.mediaSec ? `Kaydedildi ${hms(job.transfer.mediaSec)} · ` : '';
    return `<div class="stage-card stage-file">
        ${stageHead(job, 'DOSYA ALINIYOR', `<span class="stage-pct">${pct}</span>`)}
        <div class="stage-bar${ratio === null ? ' indeterminate' : ''}"><div style="width:${ratio === null ? 35 : ratio * 100}%"></div></div>
        <div class="stage-sub"><span>${saved}telefona aktarılıyor</span><span>${speedText(job.speed)}</span></div>
        <div class="stage-btns">${btn(job, 'cancel', 'İptal', 'text')}</div></div>`;
}

/** Hatanın türü: kullanıcıya neden ve ne yapılacağı buna göre söylenir. */
function failureOf(job) {
    const text = job.detail || '';
    if (/DRM|Widevine|şifreli|korumalı/i.test(text)) {
        return { key: 'drm', title: 'Korumalı yayın', code: 'DRM',
            text: 'Widevine ile şifreli. Bu içerik indirilemez; başka bir şey denemenin anlamı yok.' };
    }
    if (/\b(404|410)\b|süresi dol|expired|bulunamadı/i.test(text)) {
        return { key: 'expired', title: 'Bağlantının süresi doldu', code: (text.match(/\b(404|410)\b/) || ['404'])[0],
            text: 'Süreli/imzalı bağlantı. Sayfayı yeniden algılamak yeni bir bağlantı alır.' };
    }
    if (/\b(401|403)\b|reddet|erişim|yetki|oturum/i.test(text)) {
        return { key: 'denied', title: 'Site erişimi reddetti', code: (text.match(/\b(401|403)\b/) || ['403'])[0],
            text: 'Bağlantı oturuma ya da IP’ye bağlı. Videonun bulunduğu sayfayı verirsen o sayfanın çerezleriyle yeniden denenir.' };
    }
    return { key: 'other', title: 'İnmedi', code: '', text };
}

function renderFailed(job) {
    const f = failureOf(job);
    const canRedetect = Boolean((job.source && (job.source.page || job.source.media)) || job.openUrl);
    let actions = '';
    if (f.key === 'denied') {
        actions = `<div class="fail-input"><input class="input" type="url" placeholder="Bulunduğu sayfa adresi"
                data-job-input="${job.id}" value="${escapeHtml(job.pageInput || (job.source && job.source.page) || '')}">
                ${btn(job, 'try-page', 'Dene', 'primary')}</div>
            <div class="fail-alt"><span>Olmazsa kendi oturumunla aç</span>${job.openUrl ? btn(job, 'open', 'Telefonda aç ›', 'text') : ''}</div>
            <div class="fail-btns">${btn(job, 'dismiss', 'Kapat', 'text')}</div>`;
    } else if (f.key === 'expired') {
        actions = `<div class="fail-btns">${canRedetect ? btn(job, 'redetect', 'Yeniden algıla', 'primary') : ''}${btn(job, 'dismiss', 'Kapat')}</div>`;
    } else if (f.key === 'drm') {
        actions = `<div class="fail-btns">${btn(job, 'dismiss', 'Kapat')}</div>`;
    } else {
        const btns = [];
        if (job.openUrl) btns.push(btn(job, 'open', 'Telefonda aç', 'primary'));
        if (job.fallback && !job.fallbackUsed) btns.push(btn(job, 'fallback', 'Normal indir', 'primary'));
        else if (job.run) btns.push(btn(job, 'retry', 'Tekrar dene'));
        if (canRedetect) btns.push(btn(job, 'redetect', 'Yeniden algıla'));
        btns.push(btn(job, 'dismiss', 'Kapat', 'text'));
        actions = `<div class="fail-btns">${btns.join('')}</div>`;
    }
    return `<div class="fail-card fail-${f.key}">
        <div class="fail-top"><span class="fail-ic">!</span><div class="fail-main">
            <div class="fail-title"><span>${escapeHtml(f.title)}</span>${f.code ? `<span class="fail-code">${f.code}</span>` : ''}</div>
            <span class="dl-name fail-name">${escapeHtml(job.name)}</span>
            ${f.key === 'other' ? `<span class="fail-text">${escapeHtml(f.text || 'Başarısız')}</span>`
                : `<span class="fail-text">${escapeHtml(f.text)}</span>`}
        </div></div>${actions}</div>`;
}

/* "Videoyu başlat": kaydın beklediği sayfanın görüntüsü açılır, kullanıcı oynata dokunur. */
let sheet = null;
function openTouch(job) {
    if (sheet) sheet.view.close();
    const view = openRemoteOverlay(null, {
        captureId: job.captureId,
        onClose: () => {
            sheet = null;
        }
    });
    sheet = { jobId: job.id, view };
}

function renderRec(job) {
    if (job.rec.mode === 'capture') return renderCapture(job);
    const rec = job.rec;
    const elapsed = recElapsed(job);
    const limit = rec.limitSec || 0;
    const bitrate = rec.mediaSec > 1 ? ((job.bytes * 8) / rec.mediaSec / 1e6) : 0;
    const notes = [];
    if (bitrate) notes.push(`${bitrate.toLocaleString('tr-TR', { maximumFractionDigits: 1 })} Mbps`);
    notes.push(rec.server ? 'sunucunda kaydediliyor' : 'şu andan itibaren');
    if (rec.missed) notes.push(`${rec.missed} parça kaçtı`);
    const limitHtml = limit ? `
        <div class="sec">
            <div class="progress rec"><div style="width:${Math.min(100, (elapsed / limit) * 100)}%"></div></div>
            <div class="dl-sub"><span>Sınır ${escapeHtml(rec.limitLabel || hms(limit))}</span><span>${hms(limit - elapsed)} kaldı</span></div>
        </div>` : '';
    const stopping = job.stopRequested;
    return `
        <div class="rec-card">
            <div class="rec-head"><span class="rec-tag"><span class="rec-dot"></span>KAYIT</span>
                <span class="dl-name">${escapeHtml(job.name)}${rec.quality ? ' · ' + escapeHtml(rec.quality) : ''}</span></div>
            <div class="rec-time-row"><span class="rec-time">${hms(elapsed)}</span><span class="rec-size">${formatSize(job.bytes)}</span></div>
            ${limitHtml}
            ${job.detail && (stopping || rec.warning) ? `<div class="hint">${escapeHtml(job.detail)}</div>` : ''}
            <div class="rec-foot"><span>${notes.join(' · ')}</span>
                <div class="dl-btns">${stopping ? '' : btn(job, 'cancel', 'İptal', 'text') + btn(job, 'stop', 'Durdur ve kaydet', 'danger')}</div></div>
        </div>`;
}

function renderActive(job) {
    if (job.netPaused) return renderNetPaused(job);
    if (job.rec) return renderRec(job);
    if (job.transfer) return renderTransfer(job);
    const ratio = ratioOf(job);
    const pct = ratio === null ? '' : Math.round(ratio * 100) + '%';
    const speed = job.speed;
    let left = '';
    if (ratio !== null && speed > 0 && job.kind !== 'hls') left = formatLeft((job.total - job.received) / speed) + ' kaldı';
    if (ratio !== null && job.kind === 'hls' && ratio > 0.02) {
        const elapsed = (Date.now() - job.startedAt) / 1000;
        left = formatLeft(elapsed / ratio - elapsed) + ' kaldı';
    }
    const subLeft = job.detail || (job.total ? `${formatSize(job.received)} / ${formatSize(job.total)}` : formatSize(job.bytes));
    const subRight = [speedText(speed), left].filter(Boolean).join(' · ');
    const btns = [];
    if (job.stalled && job.fallback && !job.fallbackUsed) btns.push(btn(job, 'fallback', 'Normal indir', 'primary'));
    if (job.canStop && !job.stopRequested) btns.push(btn(job, 'stop', 'Durdur ve kaydet'));
    if (!job.stopRequested) btns.push(btn(job, 'cancel', 'İptal', 'text'));
    return `
        <div class="dl-card">
            ${thumbHtml(job)}
            <div class="dl-main">
                <div class="dl-top"><span class="dl-name">${escapeHtml(job.name)}</span><span class="dl-pct">${pct}</span></div>
                <div class="progress${ratio === null ? ' indeterminate' : ''}"><div style="width:${ratio === null ? 35 : ratio * 100}%"></div></div>
                <div class="dl-sub"><span>${escapeHtml(subLeft)}</span><span>${subRight}</span></div>
                ${job.bgId ? '<span class="dl-note"><span class="dot"></span>Arka planda · uygulama kapansa da sürer</span>' : ''}
                <div class="dl-btns">${btns.join('')}</div>
            </div>
        </div>`;
}

/** Bağlantı koptu: iş duraklatıldı, bağlantı gelince kaldığı yerden sürer. */
function renderNetPaused(job) {
    const ratio = ratioOf(job);
    const pct = ratio === null ? '' : Math.round(ratio * 100) + '%';
    return `
        <div class="dl-card net">
            ${thumbHtml(job)}
            <div class="dl-main">
                <div class="dl-top"><span class="dl-name">${escapeHtml(job.name)}</span><span class="dl-pct">${pct}</span></div>
                <span class="net-sub">Bağlantı koptu${pct ? ` · %${Math.round(ratio * 100)}'de duraklatıldı` : ''} · bağlanınca sürecek</span>
                <div class="progress net-bar"><div style="width:${ratio === null ? 35 : ratio * 100}%"></div></div>
                <div class="dl-sub"><span class="mono">${job.kind === 'hls' ? `${job.received} / ${job.total} parça · ${formatSize(job.bytes)}` : job.total ? `${formatSize(job.received)} / ${formatSize(job.total)}` : formatSize(job.bytes)}</span>
                </div>
                <div class="dl-btns">${btn(job, 'resume', 'Devam et', 'primary')}${btn(job, 'cancel', 'İptal')}</div>
            </div>
        </div>`;
}

function renderQueuedJob(job, n) {
    return `
        <div class="dl-card queued">
            <span class="queue-num">#${n}</span>
            <div class="dl-main" style="gap:3px">
                <span class="dl-name">${escapeHtml(job.name)}</span>
                <span class="hint">Sırada · bir indirme bitince başlar</span>
            </div>
            ${btn(job, 'now', 'Şimdi başlat', 'text" style="color:var(--act)')}
            ${btn(job, 'cancel', icon('close'), 'text')}
        </div>`;
}

function renderFinished(job) {
    const btns = [];
    let sub = escapeHtml(job.detail || '');
    let subCls = '';
    if (job.status === 'pending-save') {
        subCls = 'ok';
        btns.push(btn(job, 'save', 'Kaydet', 'primary'));
    } else if (job.status === 'done') {
        if (job.hooks.save && !job.saved) {
            subCls = 'ok';
            if (job.blob && canShareFiles) btns.push(btn(job, 'share', 'Galeriye', 'primary'));
            btns.push(btn(job, 'save', 'Kaydet', job.blob && canShareFiles ? '' : 'primary'));
        } else if (job.blob && canShareFiles) {
            btns.push(btn(job, 'share', 'Galeriye'));
        }
    } else if (job.status === 'error') {
        subCls = 'err';
        // Bağlantı sunucudan da inmediyse telefonun kendi tarayıcısı (kendi IP'si, oturumu) dener.
        if (job.openUrl) btns.push(btn(job, 'open', 'Telefonda aç', 'primary'));
        if (job.fallback && !job.fallbackUsed) btns.push(btn(job, 'fallback', 'Normal indir', 'primary'));
        else if (job.run) btns.push(btn(job, 'retry', 'Tekrar dene'));
    } else if (job.status === 'cancelled' && job.run) {
        btns.push(btn(job, 'retry', 'Tekrar dene'));
    }
    btns.push(btn(job, 'dismiss', icon('close'), 'text'));
    const thumb = job.status === 'error'
        ? '<span class="thumb err" style="width:52px;height:52px;border-radius:11px">!</span>'
        : thumbHtml(job);
    return `
        <div class="dl-card hist">
            ${thumb}
            <div class="dl-main" style="gap:4px">
                <span class="dl-name">${escapeHtml(job.name)}</span>
                <span class="hist-sub ${subCls}">${sub}</span>
            </div>
            <div class="dl-btns" style="flex:none">${btns.join('')}</div>
        </div>`;
}

function renderAside(list) {
    const active = list.filter((j) => j.status === 'active' || j.status === 'queued');
    const finished = list.filter((j) => ['done', 'error', 'cancelled', 'pending-save'].includes(j.status))
        .sort((a, b) => (b.finishedAt || 0) - (a.finishedAt || 0)).slice(0, 8);
    let html = `<div class="aside-head"><span class="aside-title">İndirmeler</span>
        <button class="link-btn float-only" data-float-toggle>${floatOpen ? 'Pencereyi kapat' : 'Üstte göster'}</button></div>`;
    if (!list.length) html += '<div class="hint">İndirme yok. Başlattıklarınız burada görünür.</div>';

    html += active.map((job) => {
        if (job.status === 'queued') {
            return `<div class="mini-card"><div class="mini-top"><span>${escapeHtml(job.name)}</span></div>
                <span class="mini-sub">Sırada</span></div>`;
        }
        if (job.rec) {
            const elapsed = recElapsed(job);
            return `<button class="mini-card rec" data-view="downloads"><div class="mini-top"><span>${icon('record')} ${escapeHtml(job.name)}</span>
                <span class="mono" style="color:var(--er)">${hms(elapsed)}</span></div>
                <span class="mini-sub">${formatSize(job.bytes)}${job.rec.limitSec ? ' · ' + hms(job.rec.limitSec - elapsed) + ' kaldı' : ''}</span></button>`;
        }
        const ratio = ratioOf(job);
        return `<button class="mini-card" data-view="downloads"><div class="mini-top"><span>${escapeHtml(job.name)}</span>
            <span class="mono" style="color:var(--act)">${ratio === null ? '' : Math.round(ratio * 100) + '%'}</span></div>
            <div class="progress${ratio === null ? ' indeterminate' : ''}"><div style="width:${ratio === null ? 35 : ratio * 100}%"></div></div>
            <span class="mini-sub">${job.bgId ? 'Arka planda' : speedText(job.speed) || escapeHtml(job.detail || '')}</span></button>`;
    }).join('');

    if (finished.length) {
        html += '<div class="sec-label" style="padding-top:8px">Geçmiş</div>';
        html += finished.map((job) => {
            let right;
            if (job.status === 'pending-save' || (job.status === 'done' && job.hooks.save && !job.saved)) {
                right = btn(job, job.blob && canShareFiles && !job.hooks.save ? 'share' : 'save', job.blob && canShareFiles && !job.hooks.save ? 'Galeriye' : 'Kaydet', 'primary');
            } else if (job.status === 'done') {
                right = `<span style="font-size:12px;font-weight:600;color:var(--ok)">${job.bytes ? formatSize(job.bytes) + ' ' : ''}✓</span>`;
            } else if (job.status === 'error') {
                right = '<span style="font-size:12px;font-weight:600;color:var(--er)">Hata</span>';
            } else {
                right = '<span class="mini-sub">İptal</span>';
            }
            return `<div class="mini-hist"><span>${escapeHtml(job.name)}</span>${right}</div>`;
        }).join('');
    }
    return html;
}
