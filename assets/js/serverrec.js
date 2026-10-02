// Canlı yayını kendi sunucunda kaydetme. Telefonda ekran kapanınca tarayıcı sekmeyi dondurur ve
// tarayıcıdaki kayıt parça kaçırır; sunucu (bilgisayar veya Termux) ise uyumaz. Kayıt orada sürer,
// uygulama yalnızca durumu izler; bitince dosya sunucudan indirilir.
import { renderApi, getRenderServer, formatSize, hms, pumpToSink, sleep } from './util.js';
import { addJob, getJobs } from './downloads.js';

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
    const id = start.id;
    job.captureId = id;
    job.kind = 'rec';
    job.canStop = true;
    job.stopRequested = false;
    job.rec = { mode: 'capture', startedAt: Date.now(), mediaSec: 0, duration: 0, speed: 0, phase: start.phase, server: true, why };
    job.hooks.stop = () => renderApi(`/capture/${id}/stop`, { method: 'POST' }, 10000).catch(() => {});
    job.hooks.cancel = () => renderApi(`/capture/${id}`, { method: 'DELETE' }, 10000).catch(() => {});

    // Durum izlenir; sunucuya kısa süre ulaşılamazsa beklenir.
    let state = start;
    let failures = 0;
    while (state.state === 'capturing' || state.state === 'waiting') {
        await sleep(1500);
        if (job.status !== 'active') return;
        try {
            state = await renderApi(`/capture/${id}`, {}, 10000);
            failures = 0;
        } catch (err) {
            if (err.status === 404) throw new Error('Kayıt sunucuda bulunamadı');
            if (++failures >= 20) throw new Error('Sunucuya ulaşılamıyor');
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
    if (state.state === 'error') throw new Error(state.error || 'Video kaydedilemedi');
    if (state.state !== 'done') throw new Error('Kayıt iptal edildi');

    // Dosyayı bu cihaza al (normal indirme gibi).
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
        renderApi(`/capture/${id}`, { method: 'DELETE' }, 10000).catch(() => {});
        const parts = [state.mediaSec ? hms(state.mediaSec) : '', formatSize(received), 'video açılıp kaydedildi'].filter(Boolean);
        if (state.blockedAds) parts.push(`${state.blockedAds} reklam engellendi`);
        job.done(parts.join(' · '));
    } catch (err) {
        await sink.abort();
        throw err;
    }
}

/** Uygulama yeniden açıldığında sunucuda süren veya biten kayıtları geri getirir. */
export async function restoreServerRecordings() {
    if (!canServerRecord()) return;
    try {
        for (const kind of ['record', 'capture']) {
            const { items } = await renderApi(`/${kind}`, {}, 8000).catch(() => ({ items: [] }));
            for (const state of items || []) {
                if (!getJobs().some((j) => j.serverRec === state.id)) track(state, null, kind);
            }
        }
    } catch (_) { /* sunucu kapalı veya eski sürüm: kayıt özelliği yok */ }
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
