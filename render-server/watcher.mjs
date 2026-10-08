// Takip: sunucu sayfaları kendi başına yoklar.
//  - "live"     (Yayını bekle): sayfada canlı yayın açılınca kayda başlar, bitince kaydeder.
//  - "schedule" (Zamanla): belirli saatte başlatıp belirli saatte bitirir; günlük/haftalık tekrar.
//  - "channel"  (Kanalı takip et): kanal/profil/dizi sayfasındaki yeni videoları bulur, isterse indirir.
// Telefon kapalı ya da uygulama kapalıyken de çalışır; olaylar bildirim olarak gönderilir.
import fs from 'node:fs';
import { randomBytes } from 'node:crypto';

const TICK_MS = 15000;
const KEEP_MS = 7 * 24 * 60 * 60 * 1000; // takipten gelen kayıtlar 7 gün saklanır
const MAX_EVENTS = 100;
const DAY = 24 * 60 * 60 * 1000;

const clamp = (n, a, b) => Math.max(a, Math.min(b, n));
const clock = (sec) => {
    const t = Math.round(sec || 0);
    const h = Math.floor(t / 3600);
    const m = Math.floor(t / 60) % 60;
    const s = String(t % 60).padStart(2, '0');
    return h ? `${h}:${String(m).padStart(2, '0')}:${s}` : `${m}:${s}`;
};
const size = (b) => (b >= 1073741824 ? `${(b / 1073741824).toFixed(1)} GB` : `${Math.max(1, Math.round(b / 1048576))} MB`).replace('.', ',');
const QUALITY = { best: 0, 1080: 1080, 720: 720, 480: 480 };

function minutesOf(hhmm) {
    const [h, m] = String(hhmm || '0:0').split(':').map(Number);
    return (h || 0) * 60 + (m || 0);
}

/** Zaman penceresi içinde mi? (gün: 1=Pzt … 7=Paz; gece yarısını aşan aralık desteklenir) */
export function inWindow(win, now = new Date()) {
    if (!win || !win.on) return true;
    const day = ((now.getDay() + 6) % 7) + 1;
    const mins = now.getHours() * 60 + now.getMinutes();
    const from = minutesOf(win.from);
    const to = minutesOf(win.to);
    const days = win.days && win.days.length ? win.days : [1, 2, 3, 4, 5, 6, 7];
    if (from <= to) return days.includes(day) && mins >= from && mins < to;
    // 22:00–02:00 gibi: başlangıç günü akşamı ya da ertesi gün sabahı
    const prevDay = day === 1 ? 7 : day - 1;
    return (days.includes(day) && mins >= from) || (days.includes(prevDay) && mins < to);
}

/** Zamanlanmış kaydın şu anki ya da sıradaki oturumu: [başlangıç, bitiş] (ms). */
export function occurrence(w, now = Date.now()) {
    const len = w.end - w.start;
    let s = w.start;
    const fits = (t) => {
        const d = new Date(t).getDay();
        if (w.repeat === 'weekdays') return d >= 1 && d <= 5;
        return true;
    };
    const step = w.repeat === 'weekly' ? 7 * DAY : DAY;
    if (w.repeat && w.repeat !== 'once') {
        const late = (w.late || 0) * 60000;
        while (s + len + late < now || !fits(s)) s += step;
    }
    return [s, s + len];
}

export function createWatcher({ file, recorder, findLive, listEntries, downloadEntry, push, log = () => {} }) {
    let watches = [];
    let events = [];
    try {
        const data = JSON.parse(fs.readFileSync(file, 'utf8'));
        watches = data.watches || [];
        events = data.events || [];
    } catch (_) { /* ilk açılış */ }
    for (const w of watches) w.busy = false;

    /* Siteye nazik davranma: aralık ±%20 kaydırılır (makine düzeni olmasın), üst üste hatada aralık
     * 2–4 katına çıkar (site sınırlıyorsa üstüne gidilmez) ve aynı siteye takipler toplamda en fazla
     * SITE_GAP_MS'de bir gider. Kullanıcıya hem durumda hem bildirimle söylenir. */
    const SITE_GAP_MS = 2 * 60000;
    const siteLast = new Map();
    const hostOf = (u) => {
        try {
            return new URL(u).host.replace(/^www\./, '');
        } catch (_) {
            return '';
        }
    };
    const baseMin = (w) => (w.type === 'schedule' ? 1 : w.every || (w.type === 'channel' ? 30 : 5));
    function scheduleNext(w) {
        w.nextCheck = Date.now() + baseMin(w) * 60000 * (w.backoff || 1) * (0.8 + Math.random() * 0.4);
    }
    function markFailed(w) {
        w.fails = (w.fails || 0) + 1;
        const before = w.backoff || 1;
        w.backoff = w.fails >= 2 ? 4 : 2;
        if (before === 1) {
            emit(w, 'backoff', 'Site yanıt vermiyor, daha seyrek bakılacak',
                `${w.name} · ${w.error || 'sayfa açılmadı'} · artık ${Math.round(baseMin(w) * w.backoff)} dk'da bir bakılacak`, { quiet: true });
        }
        scheduleNext(w);
    }
    function markOk(w) {
        if ((w.backoff || 1) > 1) {
            emit(w, 'recovered', 'Site yeniden yanıt veriyor', `${w.name} · normal aralığa (${baseMin(w)} dk) dönüldü`, { quiet: true });
        }
        const was = w.backoff || 1;
        w.backoff = 1;
        w.fails = 0;
        w.error = '';
        if (was > 1) scheduleNext(w);
    }

    const save = () => {
        try {
            fs.writeFileSync(file, JSON.stringify({ watches: watches.map(({ busy, ...w }) => w), events }));
        } catch (_) { /* disk */ }
    };

    function emit(w, kind, title, body, extra = {}) {
        const ev = { id: randomBytes(6).toString('hex'), at: Date.now(), kind, title, body, watchId: w.id, ...extra };
        events.unshift(ev);
        events = events.slice(0, MAX_EVENTS);
        save();
        if (w.notify !== false && push) {
            push.send({ title, body, tag: `${w.id}-${kind}`, url: kind === 'new-videos' ? '#follow' : kind === 'rec-done' ? '#library' : '#follow', kind })
                .catch(() => {});
        }
    }

    const stamp = () => new Date().toLocaleString('tr-TR', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' });

    async function startRecording(w, live, limitSec) {
        const rec = await recorder.start({
            url: live.url, audioUrl: live.audioUrl || null, playlistText: live.text || '', name: `${w.name || 'yayin'} ${stamp()}`.replace(/[:]/g, '.'),
            limitSec, limitLabel: '', quality: '', maxHeight: QUALITY[w.quality] || 0, keepMs: KEEP_MS, source: w.url
        });
        w.recId = rec.id;
        w.state = 'recording';
        w.offlineSeen = false; // aynı yayın (sınır dolup bitse bile) kapanmadan yeniden kaydedilmez
        w.recStartedAt = Date.now();
        emit(w, 'live-start', 'Yayın başladı, kaydediliyor', `${w.name}${w.quality && w.quality !== 'best' ? ' · ' + w.quality + 'p' : ''}`, { recId: rec.id });
    }

    /** Kayıt sürüyorsa durumunu izler; bittiyse sonucu yazar. */
    function followRecording(w) {
        const rec = recorder.get(w.recId);
        if (!rec) {
            w.state = 'waiting';
            w.recId = '';
            return;
        }
        if (rec.state === 'recording' || rec.state === 'stopping') return;
        if (rec.state === 'done') {
            w.lastResult = { recId: rec.id, fileName: rec.fileName, mediaSec: rec.mediaSec, bytes: rec.bytes, endedAt: rec.endedAt };
            emit(w, 'rec-done', `Kayıt bitti · ${clock(rec.mediaSec)} · ${size(rec.bytes)}`, `${w.name} · Kitaplığa eklendi`, { recId: rec.id });
            w.state = 'done';
            if (w.type === 'live' && w.mode === 'next') w.enabled = false;
        } else {
            w.state = 'waiting';
            w.error = rec.error || '';
        }
        w.recId = '';
        scheduleNext(w);
    }

    async function checkLive(w) {
        w.lastCheck = Date.now();
        scheduleNext(w);
        let result;
        try {
            result = await findLive(w.url);
        } catch (err) {
            result = { reachable: false, error: err.message };
        }
        if (!result.reachable) {
            w.error = result.error || 'Sayfa açılmadı';
            markFailed(w);
            if (w.fails >= 3 && w.state !== 'unreachable') {
                w.state = 'unreachable';
                emit(w, 'unreachable', 'Sayfaya ulaşılamıyor', `${w.name} · son ${w.fails} bakışta açılmadı`);
            }
            return;
        }
        markOk(w);
        if (result.title && !w.nameSet) w.name = result.title.slice(0, 80);
        if (!result.live) {
            w.offlineSeen = true;
            w.note = '';
            if (w.state !== 'done' || Date.now() - (w.lastResult?.endedAt || 0) > 60000) w.state = 'waiting';
            return;
        }
        // Süre sınırıyla biten kayıttan sonra yayın hâlâ açıksa: yayın kapanıp yeniden açılınca kaydedilir.
        if (w.type === 'live' && w.offlineSeen === false) {
            w.note = 'Yayın sürüyor; süre sınırı doldu, sonraki yayın bekleniyor';
            return;
        }
        w.note = '';
        let limit = w.maxSec || 0;
        if (w.type === 'schedule') {
            const [, e] = occurrence(w);
            limit = Math.max(60, Math.round((e + (w.late || 0) * 60000 - Date.now()) / 1000));
        }
        await startRecording(w, result.live, limit);
    }

    async function checkChannel(w) {
        w.lastCheck = Date.now();
        scheduleNext(w);
        const r = await listEntries(w.url).catch((err) => ({ ok: false, reason: err.message }));
        if (!r.ok) {
            w.error = r.reason || 'Liste alınamadı';
            if (!r.missing && !r.login) markFailed(w);
            else w.fails = (w.fails || 0) + 1;
            if (r.missing) {
                w.error = 'Kanal takibi için sunucuda yt-dlp kurulu olmalı';
                w.state = 'error';
                return;
            }
            w.state = r.login ? 'login' : w.fails >= 3 ? 'error' : w.state || 'ok';
            return;
        }
        markOk(w);
        w.state = 'ok';
        if (r.title && !w.nameSet) w.name = r.title.slice(0, 80);
        const seen = new Set(w.seen || []);
        const first = !w.seen;
        const fresh = r.entries.filter((e) => !seen.has(e.id));
        w.seen = [...new Set([...r.entries.map((e) => e.id), ...(w.seen || [])])].slice(0, 500);
        if (first) {
            // İlk bakışta eskiler indirilmez; yalnızca "son gelenler" listesi dolar.
            w.recent = r.entries.slice(0, 6).map((e) => ({ ...e, state: 'old', at: Date.now() }));
            return;
        }
        if (!fresh.length) return;
        w.newCount = (w.newCount || 0) + fresh.length;
        w.lastNewAt = Date.now();
        for (const e of fresh.reverse()) {
            const entry = { ...e, state: w.auto ? 'queued' : 'new', at: Date.now() };
            w.recent = [entry, ...(w.recent || [])].slice(0, 12);
            if (w.auto) {
                try {
                    const rec = await downloadEntry(e, { maxHeight: QUALITY[w.quality] || 0, keepMs: KEEP_MS, source: w.url });
                    entry.recId = rec.id;
                    entry.state = 'downloading';
                } catch (err) {
                    entry.state = 'error';
                    entry.error = err.message.slice(0, 200);
                    if (/log ?in|sign in|cookies|private/i.test(err.message)) w.state = 'login';
                }
            }
        }
        emit(w, 'new-videos', `${fresh.length} yeni video${w.auto ? ' iniyor' : ''}`, `${w.name} · ${fresh.slice(0, 3).map((e) => e.title).join(', ')}`);
    }

    /** Kanal indirmelerinin durumunu günceller; "yalnızca son N" ayarına göre eskileri siler. */
    function followChannel(w) {
        let changed = false;
        for (const e of w.recent || []) {
            if (!e.recId || !['downloading', 'queued'].includes(e.state)) continue;
            const rec = recorder.get(e.recId);
            if (!rec) continue;
            if (rec.state === 'done') {
                e.state = 'done';
                e.bytes = rec.bytes;
                changed = true;
            } else if (rec.state === 'error') {
                e.state = 'error';
                e.error = rec.error;
                changed = true;
            } else {
                e.bytes = rec.bytes;
            }
        }
        if (w.keep > 0) {
            const done = (w.recent || []).filter((e) => e.state === 'done' && e.recId);
            for (const e of done.slice(w.keep)) {
                recorder.delete(e.recId);
                e.state = 'removed';
                changed = true;
            }
        }
        if (changed) save();
    }

    async function tick() {
        const now = Date.now();
        for (const w of watches) {
            if (w.recId) followRecording(w);
            if (w.type === 'channel') followChannel(w);
            if (!w.enabled || w.busy || w.state === 'recording') continue;
            let due = false;
            if (w.type === 'live') due = now >= (w.nextCheck || 0) && inWindow(w.window);
            if (w.type === 'channel') due = now >= (w.nextCheck || 0);
            if (w.type === 'schedule') {
                const [s, e] = occurrence(w, now);
                const from = s - (w.early || 0) * 60000;
                const to = e + (w.late || 0) * 60000;
                if (now > to && (!w.repeat || w.repeat === 'once')) {
                    w.enabled = false;
                    if (w.state !== 'done') w.state = 'missed';
                    continue;
                }
                due = now >= from && now < to && now >= (w.nextCheck || 0);
                if (!due && w.state !== 'done') w.state = now < from ? 'scheduled' : w.state;
            }
            if (!due) continue;
            // Aynı siteye başka bir takip az önce baktıysa bu bakış biraz ertelenir (zamanlı kayıt hariç).
            const host = hostOf(w.url);
            const last = siteLast.get(host) || 0;
            if (w.type !== 'schedule' && host && now - last < SITE_GAP_MS) {
                w.nextCheck = last + SITE_GAP_MS + Math.random() * 30000;
                w.siteWait = true;
                continue;
            }
            w.siteWait = false;
            if (host) siteLast.set(host, now);
            w.busy = true;
            const job = w.type === 'channel' ? checkChannel(w) : checkLive(w);
            job.catch((err) => { w.error = err.message; })
                .finally(() => {
                    w.busy = false;
                    if (w.type === 'schedule' && w.state !== 'recording') scheduleNext(w);
                    save();
                });
        }
    }
    const timer = setInterval(() => tick().catch((err) => log(`Takip: ${err.message}`)), TICK_MS);
    timer.unref();
    setTimeout(() => tick().catch(() => {}), 3000).unref();

    function publicWatch(w) {
        const { busy, seen, ...rest } = w;
        const rec = w.recId ? recorder.get(w.recId) : null;
        return { ...rest, checking: Boolean(busy), effectiveEvery: Math.round(baseMin(w) * (w.backoff || 1)), rec: rec ? { mediaSec: rec.mediaSec, bytes: rec.bytes, startedAt: rec.startedAt, limitSec: rec.limitSec, quality: rec.quality } : null };
    }

    const clean = (body, w = {}) => {
        const out = {};
        if (body.url !== undefined) {
            const u = new URL(String(body.url));
            if (!/^https?:$/.test(u.protocol)) throw new Error('Adres http/https olmalı');
            out.url = u.href;
        }
        if (body.name !== undefined) {
            out.name = String(body.name).slice(0, 80);
            out.nameSet = Boolean(out.name);
        }
        if (body.every !== undefined) out.every = clamp(Number(body.every) || 5, 1, 24 * 60);
        if (body.maxSec !== undefined) out.maxSec = clamp(Number(body.maxSec) || 0, 0, 24 * 3600);
        if (body.quality !== undefined) out.quality = Object.hasOwn(QUALITY, body.quality) ? String(body.quality) : 'best';
        if (body.mode !== undefined) out.mode = body.mode === 'next' ? 'next' : 'each';
        if (body.notify !== undefined) out.notify = Boolean(body.notify);
        if (body.enabled !== undefined) out.enabled = Boolean(body.enabled);
        if (body.auto !== undefined) out.auto = Boolean(body.auto);
        if (body.keep !== undefined) out.keep = clamp(Number(body.keep) || 0, 0, 500);
        if (body.kind !== undefined) out.kind = String(body.kind).slice(0, 20);
        if (body.window !== undefined) {
            const win = body.window || {};
            out.window = {
                on: Boolean(win.on),
                days: (win.days || []).map(Number).filter((d) => d >= 1 && d <= 7),
                from: /^\d{1,2}:\d{2}$/.test(win.from) ? win.from : '19:00',
                to: /^\d{1,2}:\d{2}$/.test(win.to) ? win.to : '23:00'
            };
        }
        if (body.start !== undefined) out.start = Number(body.start) || Date.now();
        if (body.end !== undefined) out.end = Number(body.end) || (out.start || w.start) + 3600000;
        if (body.repeat !== undefined) out.repeat = ['once', 'daily', 'weekdays', 'weekly'].includes(body.repeat) ? body.repeat : 'once';
        if (body.early !== undefined) out.early = clamp(Number(body.early) || 0, 0, 60);
        if (body.late !== undefined) out.late = clamp(Number(body.late) || 0, 0, 120);
        return out;
    };

    return {
        list: () => ({ items: watches.map(publicWatch), events: events.slice(0, 50), push: push ? push.count() : 0 }),
        add(body) {
            const type = ['live', 'schedule', 'channel'].includes(body.type) ? body.type : 'live';
            if (!body.url) throw new Error('Adres gerekli');
            if (watches.length >= 100) throw new Error('En fazla 100 takip olabilir');
            const defaults = type === 'channel'
                ? { every: 30, quality: '1080', auto: true, keep: 0, kind: 'kanal' }
                : type === 'schedule'
                    ? { quality: 'best', repeat: 'once', early: 5, late: 10, start: Date.now() + 3600000, end: Date.now() + 7200000 }
                    : { every: 5, maxSec: 4 * 3600, quality: 'best', mode: 'each', window: { on: false, days: [1, 2, 3, 4, 5], from: '19:00', to: '23:00' } };
            const w = {
                id: randomBytes(8).toString('hex'), type, name: '', enabled: true, notify: true, state: type === 'channel' ? 'ok' : 'waiting',
                createdAt: Date.now(), lastCheck: 0, nextCheck: 0, fails: 0, error: '', recId: '', newCount: 0, recent: [],
                ...defaults, ...clean(body)
            };
            if (!w.name) {
                try {
                    w.name = new URL(w.url).host.replace(/^www\./, '');
                } catch (_) { w.name = 'takip'; }
            }
            watches.unshift(w);
            save();
            setTimeout(() => tick().catch(() => {}), 500);
            return publicWatch(w);
        },
        update(id, body) {
            const w = watches.find((x) => x.id === id);
            if (!w) return null;
            Object.assign(w, clean(body, w));
            if (body.seenAll) w.newCount = 0;
            if (body.enabled === true && w.state === 'unreachable') {
                w.state = 'waiting';
                w.fails = 0;
            }
            save();
            return publicWatch(w);
        },
        /** "Şimdi bak": sıradaki bakışı hemen yapar. */
        checkNow(id) {
            const w = watches.find((x) => x.id === id);
            if (!w) return null;
            w.nextCheck = 0;
            if (w.state === 'unreachable') w.state = 'waiting';
            if (w.type === 'live' && w.window) w.window.forceOnce = true;
            setTimeout(() => {
                if (w.busy || w.state === 'recording') return;
                w.busy = true;
                (w.type === 'channel' ? checkChannel(w) : checkLive(w))
                    .catch((err) => { w.error = err.message; })
                    .finally(() => { w.busy = false; save(); });
            }, 10);
            return publicWatch(w);
        },
        /** Süren kaydı durdurur (o ana kadar olan kaydedilir). */
        stop(id) {
            const w = watches.find((x) => x.id === id);
            if (!w || !w.recId) return null;
            recorder.stop(w.recId);
            return publicWatch(w);
        },
        remove(id) {
            const w = watches.find((x) => x.id === id);
            if (!w) return false;
            if (w.recId) recorder.stop(w.recId);
            watches = watches.filter((x) => x !== w);
            save();
            return true;
        },
        seenEvents(ids) {
            events = events.filter((e) => !ids.includes(e.id));
            save();
        }
    };
}
