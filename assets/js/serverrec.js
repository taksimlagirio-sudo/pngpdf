// Canlı yayını kendi sunucunda kaydetme. Telefonda ekran kapanınca tarayıcı sekmeyi dondurur ve
// tarayıcıdaki kayıt parça kaçırır; sunucu (bilgisayar veya Termux) ise uyumaz. Kayıt orada sürer,
// uygulama yalnızca durumu izler; bitince dosya sunucudan indirilir.
import { renderApi, getRenderServer, formatSize, hms } from './util.js';
import { addJob, getJobs } from './downloads.js';

const POLL_MS = 2000;

export function canServerRecord() {
    return Boolean(getRenderServer());
}

/** Sunucuda kaydı başlatır ve İndirmeler'e bir iş olarak ekler. */
export async function startServerRecording({ url, name, format, limitSec, limitLabel, quality, thumb }) {
    const state = await renderApi('/record', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ url, name, format, limitSec, limitLabel, quality })
    }, 20000);
    return track(state, thumb);
}

/** Uygulama yeniden açıldığında sunucuda süren veya biten kayıtları geri getirir. */
export async function restoreServerRecordings() {
    if (!canServerRecord()) return;
    try {
        const { items } = await renderApi('/record', {}, 8000);
        for (const state of items || []) {
            if (!getJobs().some((j) => j.serverRec === state.id)) track(state);
        }
    } catch (_) { /* sunucu kapalı veya eski sürüm: kayıt özelliği yok */ }
}

function fileUrl(id) {
    const server = getRenderServer();
    return `${server.url}/record/${id}/file?token=${encodeURIComponent(server.token)}`;
}

function track(state, thumb = null) {
    const job = addJob({ name: state.fileName, kind: 'rec', thumb });
    job.serverRec = state.id;
    job.canStop = true;
    job.rec = {
        startedAt: state.startedAt,
        endedAt: state.endedAt || 0,
        limitSec: state.limitSec || 0,
        limitLabel: state.limitLabel || '',
        mediaSec: state.mediaSec || 0,
        missed: state.missed || 0,
        quality: state.quality || '',
        server: true
    };

    job.hooks.stop = () => {
        renderApi(`/record/${state.id}/stop`, { method: 'POST' }, 10000).catch((err) => job.setDetail(err.message));
    };
    job.hooks.cancel = () => {
        renderApi(`/record/${state.id}`, { method: 'DELETE' }, 10000).catch(() => {});
    };
    // Kayıt sunucuda diske yazıldı; tarayıcı belleğine almadan doğrudan indirme olarak açılır.
    job.hooks.save = () => {
        const a = document.createElement('a');
        a.href = fileUrl(state.id);
        a.download = job.name;
        a.rel = 'noopener';
        document.body.appendChild(a);
        a.click();
        a.remove();
        job.saved = true;
        job.setDetail(`${baseDetail(job, job.lastState)} · indiriliyor`);
    };
    job.hooks.remove = () => {
        renderApi(`/record/${state.id}`, { method: 'DELETE' }, 10000).catch(() => {});
    };

    apply(job, state);
    if (state.state === 'recording' || state.state === 'stopping') poll(job);
    return job;
}

function baseDetail(job, state) {
    const parts = [hms(state.mediaSec || 0), formatSize(state.bytes || 0)];
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
            const state = await renderApi(`/record/${job.serverRec}`, {}, 10000);
            failures = 0;
            apply(job, state);
        } catch (err) {
            if (err.status === 404) return job.fail('Kayıt sunucuda bulunamadı');
            // Sunucuya geçici olarak ulaşılamıyor: kayıt orada sürüyor olabilir, izlemeye devam.
            if (++failures === 3) job.setDetail('Sunucuya ulaşılamıyor; kayıt orada sürüyor olabilir.');
        }
    }
}
