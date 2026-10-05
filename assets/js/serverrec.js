// Canlı yayını kendi sunucunda kaydetme. Telefonda ekran kapanınca tarayıcı sekmeyi dondurur ve
// tarayıcıdaki kayıt parça kaçırır; sunucu (bilgisayar veya Termux) ise uyumaz. Kayıt orada sürer,
// uygulama yalnızca durumu izler; bitince dosya sunucudan indirilir.
import { renderApi, getRenderServer, formatSize, hms, pumpToSink, sleep } from './util.js';
import { addJob, getJobs, createSink, effectiveSaveMode } from './downloads.js';
import { getPrefs } from './prefs.js';

const POLL_MS = 2000;

export function canServerRecord() {
    return Boolean(getRenderServer());
}

/** Sunucuda kaydı başlatır ve İndirmeler'e bir iş olarak ekler. */
export async function startServerRecording({ url, audioUrl, name, limitSec, limitLabel, quality, thumb }) {
    const state = await renderApi('/record', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ url, audioUrl, name, limitSec, limitLabel, quality })
    }, 20000);
    return track(state, thumb, 'record');
}

/**
 * İnmeyen videoyu sunucuda hızlandırılmış oynatıp kaydeder: sayfa sunucudaki tarayıcıda açılır,
 * oynatıcının yüklediği video yakalanır, sonuç normal hızda oynayan tek dosyadır.
 */
export async function startServerCapture({ url, name, thumb }) {
    const state = await renderApi('/capture', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ url, name })
    }, 30000);
    return track(state, thumb, 'capture');
}

/* Telefon tarayıcısı uygulama alta alınınca sayfayı dondurabilir ya da kapatabilir; kayıt sunucuda
 * sürer. Bitince telefona aktarılacak kayıtlar burada tutulur: uygulama yeniden açılınca (ya da öne
 * gelince) iş kaldığı yerden izlenir ve dosya yine kendiliğinden iner. */
const TRANSFER_KEY = 'indirici.pendingCaptures';

function pendingTransfers() {
    try {
        return JSON.parse(localStorage.getItem(TRANSFER_KEY) || '{}');
    } catch (_) {
        return {};
    }
}

function setPendingTransfer(id, value) {
    const all = pendingTransfers();
    if (value) all[id] = value; else delete all[id];
    try {
        localStorage.setItem(TRANSFER_KEY, JSON.stringify(all));
    } catch (_) { /* depolama kapalı: yeniden açılışta "Kaydet" ile alınır */ }
}

/**
 * Bağlantısı inmeyen videoyu, verilen indirme işinin içinde "açıp kaydeder": video sunucudaki
 * tarayıcıda hızlandırılmış oynatılır, bitince dosya bu cihaza normal bir indirme gibi alınır
 * (İndirilenler / Galeri / seçilen konum). Video başlamazsa iş "dokunup başlat" durumuna geçer.
 * Olmazsa nedeniyle birlikte hata fırlatır.
 */
export async function captureIntoJob(job, { pageUrl = '', mediaUrl = '', kind = '', name, createSinkFor, why = '' }) {
    if (!canServerRecord()) {
        throw new Error(`${why ? why + ' · ' : ''}Videoyu açıp kaydetmek için Ayarlar → Kendi sunucum ayarlı olmalı.`);
    }
    const prefix = why ? `${why} · ` : '';
    job.setDetail(`${prefix}video açılıp kaydediliyor`);
    const start = await renderApi('/capture', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ pageUrl, mediaUrl, kind, name })
    }, 30000);
    setPendingTransfer(start.id, { saveMode: job.saveMode === 'disk' ? 'downloads' : job.saveMode, why, at: Date.now() });
    return followCapture(job, start, { createSinkFor, why });
}

/** Sunucudaki kaydı izler; bitince dosyayı bu cihaza alır. Yeniden açılışta da kullanılır. */
async function followCapture(job, start, { createSinkFor, why = '' }) {
    const id = start.id;
    job.captureId = id;
    // Kayıt sunucuda sürer: kuyruk sınırına sayılmaz, sayfa kapanırken uyarı verilmez.
    job.serverRec = id;
    job.serverKind = 'capture';
    job.kind = 'rec';
    job.canStop = true;
    job.stopRequested = false;
    job.rec = { mode: 'capture', startedAt: start.startedAt || Date.now(), mediaSec: start.mediaSec || 0,
        duration: start.duration || 0, speed: 0, phase: start.phase, server: true, why };
    job.hooks.stop = () => renderApi(`/capture/${id}/stop`, { method: 'POST' }, 10000).catch(() => {});
    job.hooks.cancel = () => {
        setPendingTransfer(id, null);
        renderApi(`/capture/${id}`, { method: 'DELETE' }, 10000).catch(() => {});
    };

    // Durum izlenir. Sayfa arka planda dondurulduysa ya da sunucuya kısa süre ulaşılamadıysa
    // vazgeçilmez: kayıt sunucuda sürüyor, ulaşılınca kaldığı yerden izlenir.
    let state = start;
    let failures = 0;
    while (state.state === 'capturing' || state.state === 'waiting') {
        await sleep(1500);
        if (job.status !== 'active') return;
        try {
            state = await renderApi(`/capture/${id}`, {}, 10000);
            failures = 0;
        } catch (err) {
            if (err.status === 404) {
                setPendingTransfer(id, null);
                throw new Error('Kayıt sunucuda bulunamadı');
            }
            if (document.visibilityState === 'visible' && ++failures >= 40) {
                throw new Error('Sunucuya ulaşılamıyor; kayıt sunucuda sürüyor olabilir, uygulamayı yeniden açınca görünür');
            }
            continue;
        }
        Object.assign(job.rec, {
            mediaSec: state.mediaSec || 0, duration: state.duration || 0, speed: state.speed || 0,
            phase: state.phase || '', blockedAds: state.blockedAds || 0
        });
        job.needsUser = Boolean(state.needsUser);
        job.rec.warning = Boolean(state.warning);
        job.detail = state.warning || '';
        if (state.bytes > job.bytes) job.addBytes(state.bytes - job.bytes);
        if (state.total) job.progress(state.bytes, state.total); else job.progress(state.bytes, 0);
    }
    job.needsUser = false;
    if (state.state === 'error') {
        setPendingTransfer(id, null);
        throw new Error(state.error || 'Video kaydedilemedi');
    }
    if (state.state !== 'done') {
        setPendingTransfer(id, null);
        throw new Error('Kayıt iptal edildi');
    }

    // Dosyayı bu cihaza al (normal indirme gibi).
    job.transfer = { mediaSec: state.mediaSec || 0 };
    job.rec = null;
    job.canStop = false;
    job.kind = 'video';
    job.bytes = 0;
    job.samples = [];
    job.setDetail('Dosya alınıyor');
    const server = getRenderServer();
    const res = await fetch(`${server.url}/capture/${id}/file?token=${encodeURIComponent(server.token)}`, { signal: job.signal });
    if (!res.ok) throw new Error(`Dosya alınamadı (HTTP ${res.status})`);
    const sink = await createSinkFor(state.fileName, res.headers.get('content-type') || 'video/mp4');
    job.name = sink.name || state.fileName;
    let last = 0;
    try {
        const received = await pumpToSink(res, sink, (got, total) => {
            job.addBytes(got - last);
            last = got;
            job.progress(got, total);
        }, job.signal);
        const blob = await sink.close();
        if (blob) job.attachResult(blob);
        setPendingTransfer(id, null);
        renderApi(`/capture/${id}`, { method: 'DELETE' }, 10000).catch(() => {});
        const parts = [state.mediaSec ? hms(state.mediaSec) : '', formatSize(received), 'video açılıp kaydedildi'].filter(Boolean);
        if (state.blockedAds) parts.push(`${state.blockedAds} reklam engellendi`);
        job.done(parts.join(' · '));
    } catch (err) {
        await sink.abort();
        throw err;
    }
}

/* ---------------- Sunucuda indir ("arka planda indir") ---------------- */

/**
 * Dosya kendi sunucuna indirilir: uygulama kapansa, geri tuşuna basılsa ya da telefon kilitlense de
 * sürer. Bitince bu cihaza normal bir indirme gibi alınır; uygulama o sırada kapalıysa yeniden
 * açılınca kendiliğinden alınır.
 */
export async function serverDownloadIntoJob(job, { url, audioUrl = '', name, hls = false, page = '', createSinkFor }) {
    job.setDetail('Sunucuna devrediliyor');
    const start = await renderApi('/record/import', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ url, audioUrl, name, hls, page })
    }, 30000);
    setPendingTransfer(start.id, { kind: 'record', saveMode: job.saveMode === 'disk' ? 'downloads' : job.saveMode, at: Date.now() });
    return followDownload(job, start, { createSinkFor });
}

async function followDownload(job, start, { createSinkFor }) {
    const id = start.id;
    job.serverDl = id;
    job.captureId = id;
    job.hooks.cancel = () => {
        setPendingTransfer(id, null);
        renderApi(`/record/${id}`, { method: 'DELETE' }, 10000).catch(() => {});
    };
    const hint = 'sunucunda iniyor · uygulamayı kapatabilirsin';
    job.setDetail(hint);
    let state = start;
    let failures = 0;
    while (state.state === 'recording' || state.state === 'stopping') {
        await sleep(1500);
        if (job.status !== 'active') return;
        try {
            state = await renderApi(`/record/${id}`, {}, 10000);
            failures = 0;
        } catch (err) {
            if (err.status === 404) {
                setPendingTransfer(id, null);
                throw new Error('İndirme sunucuda bulunamadı');
            }
            if (document.visibilityState === 'visible' && ++failures >= 40) {
                throw new Error('Sunucuya ulaşılamıyor; indirme orada sürüyor olabilir, uygulamayı yeniden açınca görünür');
            }
            continue;
        }
        if (state.bytes > job.bytes) job.addBytes(state.bytes - job.bytes);
        job.progress(state.bytes, state.total || 0);
        job.detail = hint;
    }
    if (state.state !== 'done') {
        setPendingTransfer(id, null);
        throw new Error(state.error || 'İndirme iptal edildi');
    }

    // Dosyayı bu cihaza al.
    job.bytes = 0;
    job.samples = [];
    job.setDetail('Sunucudan telefona alınıyor');
    const server = getRenderServer();
    const res = await fetch(`${server.url}/record/${id}/file?token=${encodeURIComponent(server.token)}`, { signal: job.signal });
    if (!res.ok) throw new Error(`Dosya alınamadı (HTTP ${res.status})`);
    const sink = await createSinkFor(state.fileName, res.headers.get('content-type') || 'video/mp4');
    job.name = sink.name || state.fileName;
    let last = 0;
    try {
        const received = await pumpToSink(res, sink, (got, total) => {
            job.addBytes(got - last);
            last = got;
            job.progress(got, total);
        }, job.signal);
        const blob = await sink.close();
        if (blob) job.attachResult(blob);
        setPendingTransfer(id, null);
        renderApi(`/record/${id}`, { method: 'DELETE' }, 10000).catch(() => {});
        job.done(`${formatSize(received)} · sunucunda indi`);
    } catch (err) {
        await sink.abort();
        throw err;
    }
}

/**
 * Sunucuda süren veya biten kayıtları uygulamaya bağlar: uygulama yeniden açıldığında ve alttan
 * öne geldiğinde çağrılır. Zaten izlenenler atlanır; telefona aktarılacak "açıp kaydet" işleri
 * kaldığı yerden izlenir ve bitince dosya kendiliğinden iner.
 */
let restoring = null;
export function restoreServerRecordings() {
    // Açılış ve öne gelme aynı anda tetiklenebilir; aynı iş iki kez eklenmesin.
    if (!restoring) restoring = doRestore().finally(() => { restoring = null; });
    return restoring;
}

async function doRestore() {
    if (!canServerRecord()) return;
    const pending = pendingTransfers();
    const lists = {};
    for (const kind of ['record', 'capture']) {
        try {
            lists[kind] = (await renderApi(`/${kind}`, {}, 8000)).items || [];
        } catch (_) {
            lists[kind] = null; // sunucu kapalı veya eski sürüm
        }
    }
    if (lists.record && lists.capture) seedAutoSaved([...lists.record, ...lists.capture]);
    for (const kind of ['record', 'capture']) {
        const items = lists[kind];
        if (!items) continue;
        for (const state of items) {
            if (getJobs().some((j) => j.serverRec === state.id || j.captureId === state.id)) continue;
            // Sunucuda indirme: bitince (ya da sürüyorsa bitince) telefona alınır.
            if (state.download) {
                const transfer = pending[state.id];
                if (!transfer || !['recording', 'stopping', 'done'].includes(state.state)) continue;
                const saveMode = transfer.saveMode || 'downloads';
                addJob({
                    name: state.fileName,
                    kind: 'video',
                    now: true,
                    saveMode,
                    run: (job) => followDownload(job, state, { createSinkFor: (n, t) => createSink(n, { mode: saveMode, mime: t }) })
                }).captureId = state.id;
                continue;
            }
            const transfer = kind === 'capture' && pending[state.id];
            if (transfer && ['capturing', 'waiting', 'done'].includes(state.state)) {
                const saveMode = transfer.saveMode || 'downloads';
                const job = addJob({
                    name: state.fileName,
                    kind: 'rec',
                    now: true,
                    saveMode,
                    run: (job) => followCapture(job, state, {
                        why: transfer.why || '',
                        createSinkFor: (n, t) => createSink(n, { mode: saveMode, mime: t })
                    })
                });
                job.captureId = state.id;
            } else {
                if (transfer) setPendingTransfer(state.id, null);
                track(state, null, kind);
            }
        }
    }
    // Sunucuda artık olmayan bekleyen aktarımlar unutulur.
    try {
        const [caps, recs] = await Promise.all([renderApi('/capture', {}, 8000), renderApi('/record', {}, 8000)]);
        const items = [...(caps.items || []), ...(recs.items || [])];
        for (const id of Object.keys(pendingTransfers())) {
            if (!items.some((i) => i.id === id)) setPendingTransfer(id, null);
        }
    } catch (_) { /* sunucu kapalı */ }
}

/* ---- Biten sunucu kaydı kendiliğinden telefona ----
 * Canlı yayın kaydı ya da "aç ve kaydet" sunucuda bitince dosya hemen bu cihaza alınır (İndirilenler'e
 * kaydedilir, galeride görünür; Kitaplık'a eklenir). Uygulama o an kapalıysa açılınca alınır.
 * Hangi kayıtların alındığı saklanır ki her açılışta yeniden inmesin; özellik ilk açıldığında
 * sunucuda zaten bitmiş olanlar "alınmış" sayılır (eski kayıtlar topluca inmesin). */
const AUTO_KEY = 'indirici.autoSaved';
let autoSaved = null;
function loadAutoSaved() {
    if (autoSaved) return autoSaved;
    try {
        const raw = localStorage.getItem(AUTO_KEY);
        autoSaved = raw ? new Set(JSON.parse(raw)) : null;
    } catch (_) {
        autoSaved = new Set();
    }
    return autoSaved;
}
function markAutoSaved(id) {
    const set = loadAutoSaved() || new Set();
    autoSaved = set;
    set.add(id);
    try {
        localStorage.setItem(AUTO_KEY, JSON.stringify([...set].slice(-400)));
    } catch (_) { /* depolama kapalı */ }
}
/** İlk kez: sunucuda zaten bitmiş kayıtlar alınmış sayılır. */
function seedAutoSaved(items) {
    if (loadAutoSaved()) return;
    autoSaved = new Set();
    for (const it of items) if (it.state === 'done') autoSaved.add(it.id);
    try {
        localStorage.setItem(AUTO_KEY, JSON.stringify([...autoSaved]));
    } catch (_) { /* depolama kapalı */ }
}

async function transferToDevice(job, kind, state) {
    job.transferring = true;
    job.bytes = 0;
    job.samples = [];
    job.setDetail('Sunucudan telefona alınıyor');
    const mode = effectiveSaveMode(getPrefs().save);
    let sink = null;
    try {
        const res = await fetch(fileUrl(kind, state.id), { signal: job.signal });
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        // Konum seçme ekranı kullanıcı dokunuşu ister; kendiliğinden alınırken İndirilenler'e kaydedilir.
        sink = await createSink(state.fileName || job.name, { mode: mode === 'disk' ? 'downloads' : mode, mime: res.headers.get('content-type') || 'video/mp4' });
        let last = 0;
        const received = await pumpToSink(res, sink, (got, total) => {
            job.addBytes(got - last);
            last = got;
            job.progress(got, total);
        }, job.signal);
        const blob = await sink.close();
        if (blob) job.attachResult(blob);
        job.saved = true;
        markAutoSaved(state.id);
        job.done(`${baseDetail(job, state) || formatSize(received)} · telefona kaydedildi`);
    } catch (err) {
        if (sink) await sink.abort().catch(() => {});
        if (job.status !== 'active') return;
        // Alınamadıysa "Kaydet" ile elle alınabilir; bir sonraki açılışta yeniden denenir.
        job.done(`${baseDetail(job, state)} · sunucuda hazır (telefona alınamadı: ${err.message})`);
    } finally {
        job.transferring = false;
    }
}

function fileUrl(kind, id) {
    const server = getRenderServer();
    return `${server.url}/${kind}/${id}/file?token=${encodeURIComponent(server.token)}`;
}

function track(state, thumb = null, kind = 'record') {
    const job = addJob({ name: state.fileName, kind: 'rec', thumb });
    job.serverRec = state.id;
    job.serverKind = kind;
    job.canStop = true;
    job.rec = {
        startedAt: state.startedAt,
        endedAt: state.endedAt || 0,
        limitSec: state.limitSec || 0,
        limitLabel: state.limitLabel || '',
        mediaSec: state.mediaSec || 0,
        missed: state.missed || 0,
        quality: state.quality || '',
        server: true,
        mode: kind === 'capture' ? 'capture' : 'live',
        duration: state.duration || 0,
        speed: state.speed || 0,
        phase: state.phase || ''
    };

    job.hooks.stop = () => {
        renderApi(`/${kind}/${state.id}/stop`, { method: 'POST' }, 10000).catch((err) => job.setDetail(err.message));
    };
    job.hooks.cancel = () => {
        renderApi(`/${kind}/${state.id}`, { method: 'DELETE' }, 10000).catch(() => {});
    };
    // Kayıt sunucuda diske yazıldı; tarayıcı belleğine almadan doğrudan indirme olarak açılır.
    job.hooks.save = () => {
        const a = document.createElement('a');
        a.href = fileUrl(kind, state.id);
        a.download = job.name;
        a.rel = 'noopener';
        document.body.appendChild(a);
        a.click();
        a.remove();
        job.saved = true;
        job.setDetail(`${baseDetail(job, job.lastState)} · indiriliyor`);
    };
    job.hooks.remove = () => {
        renderApi(`/${kind}/${state.id}`, { method: 'DELETE' }, 10000).catch(() => {});
    };

    apply(job, state);
    if (state.state === 'recording' || state.state === 'stopping') poll(job);
    return job;
}

function baseDetail(job, state) {
    const parts = [state.mediaSec ? hms(state.mediaSec) : '', formatSize(state.bytes || 0)].filter(Boolean);
    if (state.reason) parts.push(state.reason);
    if (state.missed) parts.push(`${state.missed} parça kaçtı`);
    return parts.join(' · ');
}

function apply(job, state) {
    job.lastState = state;
    job.name = state.fileName || job.name;
    if (state.bytes > job.bytes) job.addBytes(state.bytes - job.bytes);
    job.rec.mediaSec = state.mediaSec || 0;
    job.rec.missed = state.missed || 0;
    job.rec.duration = state.duration || 0;
    job.rec.speed = state.speed || 0;
    job.rec.phase = state.phase || '';
    if (state.state === 'stopping') job.stopRequested = true;
    if (state.warning) {
        job.rec.warning = true;
        job.detail = state.warning;
    } else if (job.rec.warning) {
        job.rec.warning = false;
        job.detail = '';
    }
    if (state.state === 'done') {
        job.rec.endedAt = state.endedAt || Date.now();
        if (job.transferring) return;
        const saved = loadAutoSaved();
        if (saved && !saved.has(state.id) && job.status === 'active') {
            transferToDevice(job, job.serverKind || 'record', state);
            return;
        }
        job.done(baseDetail(job, state) + ' · sunucuda hazır');
    } else if (state.state === 'error') {
        job.rec.endedAt = state.endedAt || Date.now();
        job.fail(state.error || 'Kayıt başarısız');
    }
}

async function poll(job) {
    let failures = 0;
    while (job.status === 'active') {
        await new Promise((r) => setTimeout(r, POLL_MS));
        if (job.status !== 'active') return;
        try {
            const state = await renderApi(`/${job.serverKind}/${job.serverRec}`, {}, 10000);
            failures = 0;
            apply(job, state);
        } catch (err) {
            if (err.status === 404) return job.fail('Kayıt sunucuda bulunamadı');
            // Sunucuya geçici olarak ulaşılamıyor: kayıt orada sürüyor olabilir, izlemeye devam.
            if (++failures === 3) job.setDetail('Sunucuya ulaşılamıyor; kayıt orada sürüyor olabilir.');
        }
    }
}
