// "Takip": yayını bekle ve kaydet, zamanlanmış kayıt, kanal/profil takibi. Asıl iş kendi sunucunda
// yapılır (telefon kapalıyken de); burası listeyi, ayarları ve gelen uyarıları gösterir.
import { $, escapeHtml, formatSize, clock, getRenderServer, renderApi, isHttpUrl } from './util.js';
import { downloadsTabs, setFollowCount } from './downloads.js';
import { icon } from './icons.js';
import { confirmSheet } from './sheet.js';

const QUALITIES = [['best', 'En iyi'], ['1080', '1080p'], ['720', '720p']];
const EVERY_LIVE = [1, 5, 15, 30];
const EVERY_CHANNEL = [15, 30, 60, 180];
const MAX = [[3600, '1 sa'], [7200, '2 sa'], [14400, '4 sa'], [0, 'Sınırsız']];
const DAYS = ['Pzt', 'Sal', 'Çar', 'Per', 'Cum', 'Cmt', 'Paz'];
const REPEATS = [['once', 'Bir kez'], ['daily', 'Her gün'], ['weekdays', 'Hafta içi'], ['weekly', 'Her hafta']];
const COLORS = ['#2F5B3A', '#7A4030', '#2E4E7A', '#1F5F63', '#7A3A3A', '#4E3F7A', '#5C4A1F'];

const hash = (s) => [...String(s)].reduce((h, c) => (h * 31 + c.charCodeAt(0)) >>> 0, 7);
const avatar = (w) => `<span class="fw-av" style="background:${COLORS[hash(w.name || w.url) % COLORS.length]}">${escapeHtml((w.name || '?').trim()[0] || '?').toUpperCase()}</span>`;
const isStream = (w) => w.type === 'live' || w.type === 'schedule';
const hostPath = (url) => {
    try {
        const u = new URL(url);
        return (u.host.replace(/^www\./, '') + u.pathname).replace(/\/$/, '');
    } catch (_) {
        return url;
    }
};

function ago(ts) {
    if (!ts) return '';
    const m = Math.round((Date.now() - ts) / 60000);
    if (m < 1) return 'az önce';
    if (m < 60) return `${m} dk önce`;
    const h = Math.round(m / 60);
    if (h < 24) return `${h} sa önce`;
    const d = Math.round(h / 24);
    return d === 1 ? 'dün' : `${d} gün önce`;
}

const dayTime = (ts) => new Date(ts).toLocaleString('tr-TR', { weekday: 'short', day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' });
const hhmm = (ts) => new Date(ts).toLocaleTimeString('tr-TR', { hour: '2-digit', minute: '2-digit' });

/** Zamanlanmış kaydın sıradaki oturumları (sunucudaki hesapla aynı). */
function occurrences(w, n = 5) {
    const len = w.end - w.start;
    const out = [];
    let s = w.start;
    const step = w.repeat === 'weekly' ? 7 * 864e5 : 864e5;
    const fits = (t) => w.repeat !== 'weekdays' || [1, 2, 3, 4, 5].includes(new Date(t).getDay());
    if (!w.repeat || w.repeat === 'once') return [[s, s + len]];
    while (s + len < Date.now() || !fits(s)) s += step;
    while (out.length < n) {
        if (fits(s)) out.push([s, s + len]);
        s += step;
    }
    return out;
}

/** Satırdaki durum: [metin, renk sınıfı] */
function statusOf(w) {
    if (!w.enabled) return ['Kapalı · bakılmıyor', 'off'];
    if (w.state === 'recording') return ['Yayında · kaydediliyor', 'rec'];
    if ((w.backoff || 1) > 1 && w.state !== 'unreachable') return [`Site yanıt vermiyor · ${w.effectiveEvery || ''} dk'da bir bakılıyor`, 'warn'];
    if (w.type === 'channel') {
        if (w.state === 'login') return [`Giriş gerekiyor · son bakış ${ago(w.lastCheck) || '—'}`, 'warn'];
        if (w.state === 'error') return [w.error || 'Liste alınamadı', 'warn'];
        if (w.lastNewAt) return [`Son yeni içerik: ${ago(w.lastNewAt)}`, w.newCount ? 'ok' : 'idle'];
        return [w.lastCheck ? `Bakıldı · ${ago(w.lastCheck)}` : 'İlk bakış bekleniyor', 'idle'];
    }
    if (w.state === 'unreachable') return ['Sayfaya ulaşılamıyor', 'warn'];
    if (w.type === 'schedule') {
        const [s] = occurrences(w, 1)[0];
        if (w.state === 'missed') return ['Kaçırıldı · yayın bulunamadı', 'warn'];
        return [`${dayTime(s)} · ${REPEATS.find(([k]) => k === (w.repeat || 'once'))[1].toLowerCase()}`, 'idle'];
    }
    if (w.note) return [w.note, 'idle'];
    if (w.state === 'done' && w.lastResult) return [`Kaydedildi · ${ago(w.lastResult.endedAt)}`, 'ok'];
    return [`Bekliyor · her ${w.every || 5} dk`, 'idle'];
}

/** Bakış sıklığı: site yanıt vermiyorsa uzatılmış aralık, aynı siteye sıra bekleme. */
function intervalText(w) {
    const every = w.every || (w.type === 'channel' ? 30 : 5);
    let t = (w.backoff || 1) > 1
        ? `site yanıt vermediği için ${w.effectiveEvery || every * w.backoff} dk'da bir bakılıyor (normalde ${every} dk)`
        : `her ${every} dakikada bir bakılıyor`;
    if (w.siteWait) t += ' · aynı siteye başka takip de bakıyor, sırayla gidiliyor';
    return t;
}

/** Site yanıt vermiyorsa: nedeni, yeni aralık, "Şimdi dene". */
function backoffCard(w) {
    if ((w.backoff || 1) <= 1 || w.state === 'unreachable') return '';
    const every = w.every || (w.type === 'channel' ? 30 : 5);
    return `<div class="fw-warn">${icon('alert')}<div><b>Site yanıt vermiyor</b>
        <small>${w.error ? `${escapeHtml(w.error)}. ` : ''}Siteyi yormamak için ${w.effectiveEvery || every * w.backoff} dk’da bir bakılıyor (normalde ${every} dk). Düzelince kendiliğinden eski aralığa döner.</small>
        <button class="btn-ghost" data-f="check" data-id="${w.id}">Şimdi dene</button></div></div>`;
}

/** Sıklık seçiminin altındaki bilgi. */
function everyHint(w) {
    const every = w.every || (w.type === 'channel' ? 30 : 5);
    if (every <= 1) return `<div class="fw-hint warn">${icon('alert')}<small>1 dk siteyi yorar ve engellenme riskini artırır. Yayın saatini biliyorsan "Zamanla" daha iyi; bilmiyorsan 5 dk önerilir.</small></div>`;
    return `<div class="fw-hint">${icon('info')}<small>Her bakış sayfanın normal bir ziyaretidir; saat başına denk gelmesin diye biraz kaydırılır. Site yanıt vermezse aralık kendiliğinden uzar, düzelince geri döner.</small></div>`;
}

const kindTag = (w) => (w.type === 'channel' ? w.kind || 'kanal' : w.type === 'schedule' ? 'zamanlı' : 'yayın');

export function initFollow({ navigate, toast }) {
    const root = $('followView');
    const ui = { filter: 'all', selected: null, detail: null, adding: null, desk: 'streams' };
    let items = [];
    let events = [];
    let timer = null;
    let loading = false;
    let error = '';
    const desktop = () => window.matchMedia('(min-width: 960px)').matches;

    async function load() {
        if (!getRenderServer()) {
            items = [];
            error = '';
            return render();
        }
        if (loading) return;
        loading = true;
        try {
            const data = await renderApi('/watch', {}, 10000);
            items = data.items || [];
            events = data.events || [];
            error = '';
            showAlerts(events);
        } catch (err) {
            error = err.status === 404 ? 'Sunucun takip özelliğini içermeyen eski bir sürüm; güncelleyip yeniden başlat.' : err.message;
        } finally {
            loading = false;
        }
        updateBadges();
        if (document.body.dataset.view === 'follow') render();
    }

    function updateBadges() {
        const n = items.filter((w) => w.enabled).length;
        document.querySelectorAll('[data-follow-count]').forEach((el) => {
            el.textContent = n;
            el.classList.toggle('hidden', !n);
        });
        setFollowCount(n);
    }

    async function api(path, body, method = 'POST') {
        return renderApi(path, { method, headers: { 'content-type': 'application/json' }, body: body ? JSON.stringify(body) : undefined }, 30000);
    }

    /* ---------------- Liste ---------------- */

    function rowHtml(w) {
        const [text, cls] = statusOf(w);
        const badge = w.type === 'channel' && w.state === 'login'
            ? '<span class="fw-badge warn">Düzelt</span>'
            : w.newCount ? `<span class="fw-badge">${w.newCount} yeni</span>` : '';
        return `<div class="fw-row${w.enabled ? '' : ' off'}${ui.selected === w.id ? ' sel' : ''}" data-f="open" data-id="${w.id}">
            ${avatar(w)}
            <span class="fw-main"><span class="fw-name">${escapeHtml(w.name)} <small>${escapeHtml(kindTag(w))}</small></span>
                <span class="fw-st ${cls}"><i></i>${escapeHtml(text)}</span></span>
            ${badge}
            <button class="toggle${w.enabled ? ' on' : ''}" data-f="toggle" data-id="${w.id}" aria-label="Aç/kapat"></button>
        </div>`;
    }

    function streamCard(w) {
        const sel = ui.selected === w.id ? ' sel' : '';
        const name = `<div class="fw-card-n">${escapeHtml(w.name)}</div><div class="fw-card-u">${escapeHtml(hostPath(w.url))}</div>`;
        if (w.state === 'recording' && w.rec) {
            const limit = w.rec.limitSec;
            const elapsed = (Date.now() - w.rec.startedAt) / 1000;
            return `<div class="fw-card rec${sel}" data-f="open" data-id="${w.id}">
                <div class="fw-card-top"><span class="stage-badge fw-live"><i></i>YAYINDA · KAYDEDİLİYOR</span></div>${name}
                <div class="fw-card-time"><b>${clock(w.rec.mediaSec || elapsed)}</b><span>${formatSize(w.rec.bytes)}</span></div>
                <div class="stage-bar"><div style="width:${limit ? Math.min(100, (elapsed / limit) * 100) : 100}%;background:var(--er)"></div></div>
                <div class="fw-card-foot"><span>${limit ? `En fazla ${clock(limit)} · ${clock(Math.max(0, limit - elapsed))} kaldı` : 'Süre sınırı yok'}</span>
                    <button class="dl-btn danger" data-f="stop" data-id="${w.id}">Durdur ve kaydet</button></div></div>`;
        }
        if (w.state === 'unreachable' || w.state === 'missed') {
            return `<div class="fw-card warn${sel}" data-f="open" data-id="${w.id}">
                <div class="fw-card-top"><span class="stage-badge fw-warn">${w.state === 'missed' ? 'KAÇIRILDI' : 'SAYFAYA ULAŞILAMIYOR'}</span></div>${name}
                <p class="fw-card-t">${escapeHtml(w.error || 'Son bakışlarda sayfa açılmadı. Sunucun çevrimiçi — sorun sitede olabilir.')}</p>
                <span class="fw-card-mono">son deneme ${w.lastCheck ? hhmm(w.lastCheck) : '—'}</span>
                <div class="fw-card-btns"><button class="btn-ghost" data-f="check" data-id="${w.id}">Yeniden dene</button>
                    <button class="btn-ghost" data-f="open" data-id="${w.id}">Adresi düzenle</button></div></div>`;
        }
        if (w.state === 'done' && w.lastResult) {
            const r = w.lastResult;
            return `<div class="fw-card${sel}" data-f="open" data-id="${w.id}">
                <div class="fw-card-top"><span class="stage-badge fw-ok">BİTTİ · KAYDEDİLDİ</span><span class="fw-card-mono">${escapeHtml(dayTime(r.endedAt))}</span></div>${name}
                <div class="fw-card-res"><span class="fw-thumb"><span class="lib-dur">${clock(r.mediaSec)}</span></span>
                    <span><b class="mono">${clock(r.mediaSec)} · ${formatSize(r.bytes)}</b><small>${escapeHtml(w.note || (w.enabled && w.type === 'live' ? 'Sonraki yayın da kaydedilecek' : ''))}</small></span></div>
                <div class="fw-card-btns"><button class="btn-ac" data-f="library">Kitaplıkta aç</button></div></div>`;
        }
        const next = w.type === 'schedule' ? `başlar ${dayTime(occurrences(w, 1)[0][0])}` : w.nextCheck ? `sonraki ${hhmm(w.nextCheck)}` : '';
        const progress = w.type === 'live' && w.nextCheck && w.lastCheck
            ? Math.max(0, Math.min(100, ((Date.now() - w.lastCheck) / (w.nextCheck - w.lastCheck)) * 100)) : 0;
        return `<div class="fw-card${sel}${w.enabled ? '' : ' off'}" data-f="open" data-id="${w.id}">
            <div class="fw-card-top"><span class="stage-badge">${w.enabled ? (w.checking ? 'BAKILIYOR' : w.type === 'schedule' ? 'ZAMANLANDI' : 'BEKLİYOR') : 'KAPALI'}</span><span class="fw-card-mono">${escapeHtml(next)}</span></div>${name}
            <p class="fw-card-t">${w.type === 'schedule'
                ? `${hhmm(w.start)} – ${hhmm(w.end)} · ${REPEATS.find(([k]) => k === (w.repeat || 'once'))[1].toLowerCase()}`
                : `${w.lastCheck ? `Son bakış ${ago(w.lastCheck)}` : 'Henüz bakılmadı'} · ${intervalText(w)}`}${w.note ? `<br>${escapeHtml(w.note)}` : ''}</p>
            ${w.type === 'live' ? `<div class="stage-bar"><div style="width:${progress}%;background:var(--mt)"></div></div>` : ''}
            <div class="fw-card-btns"><button class="btn-ghost" data-f="check" data-id="${w.id}"${w.enabled ? '' : ' disabled'}>Şimdi bak</button>
                <button class="btn-ghost" data-f="toggle" data-id="${w.id}">${w.enabled ? 'Durdur' : 'Başlat'}</button></div></div>`;
    }

    function channelTable(list) {
        return `<div class="fw-table"><div class="fw-thead"><span>Ad</span><span>Son yeni içerik</span><span>Yeni</span><span>Kalite</span><span>Açık</span></div>
            ${list.map((w) => {
                const [text, cls] = statusOf(w);
                return `<div class="fw-tr${ui.selected === w.id ? ' sel' : ''}${w.enabled ? '' : ' off'}" data-f="open" data-id="${w.id}">
                    <span class="fw-tname">${avatar(w)}<span><b>${escapeHtml(w.name)}</b><small>${escapeHtml(kindTag(w))} · ${escapeHtml(hostPath(w.url).split('/')[0])}</small></span></span>
                    <span class="fw-st ${cls}">${escapeHtml(text)}</span>
                    <span>${w.state === 'login' ? '<span class="fw-badge warn">Düzelt</span>' : w.newCount ? `<span class="fw-badge">${w.newCount} yeni</span>` : ''}</span>
                    <span class="mono">${escapeHtml((QUALITIES.find(([k]) => k === w.quality) || QUALITIES[0])[1])}</span>
                    <span><button class="toggle${w.enabled ? ' on' : ''}" data-f="toggle" data-id="${w.id}"></button></span></div>`;
            }).join('')}</div>`;
    }

    function render() {
        if (!root) return;
        if (ui.adding) return renderAdd();
        if (ui.detail && !desktop()) return renderDetail(items.find((w) => w.id === ui.detail));
        if (!getRenderServer()) {
            root.innerHTML = `<div class="empty">Takip kendi sunucunda çalışır: telefon kapalıyken de yayını bekler, açılınca kaydeder.<br>
                <button class="btn-ac" data-f="setup" style="margin-top:12px">Kendi sunucunu kur</button></div>`;
            return;
        }
        const streams = items.filter(isStream);
        const channels = items.filter((w) => w.type === 'channel');
        if (desktop()) {
            const list = ui.desk === 'streams' ? streams : channels;
            if (!ui.selected || !list.some((w) => w.id === ui.selected)) ui.selected = list[0] ? list[0].id : null;
            const sel = items.find((w) => w.id === ui.selected);
            root.innerHTML = `<div class="fw-desk">
                <div class="fw-desk-main">
                    <div class="fw-desk-head"><div class="seg lib-seg"><button class="${ui.desk === 'streams' ? 'on' : ''}" data-f="desk" data-v="streams">Yayınlar · ${streams.length}</button>
                        <button class="${ui.desk === 'channels' ? 'on' : ''}" data-f="desk" data-v="channels">Kanallar · ${channels.length}</button></div>
                        <button class="btn-ac" data-f="add" data-v="${ui.desk === 'streams' ? 'live' : 'channel'}">${ui.desk === 'streams' ? '+ Yayın ekle' : '+ Takibe al'}</button></div>
                    <p class="fw-sub">${ui.desk === 'streams' ? 'Sunucun sayfaları yokluyor. Yayın açılınca kayıt kendiliğinden başlar, bitince Kitaplığa düşer.' : 'Kanallara düzenli aralıklarla bakılır; yeni video gelince seçtiğin kalitede kendiliğinden iner.'}</p>
                    ${error ? `<div class="notice">${escapeHtml(error)}</div>` : ''}
                    ${!list.length ? `<div class="empty">${ui.desk === 'streams' ? 'Bekleyen yayın yok. Bir yayın sayfasını ekle; açıldığı an kaydedilsin.' : 'Takip edilen kanal yok.'}</div>`
                        : ui.desk === 'streams' ? `<div class="fw-cards">${list.map(streamCard).join('')}</div>` : channelTable(list)}
                </div>
                <aside class="fw-panel">${sel ? panelHtml(sel) : ''}</aside></div>`;
            return;
        }
        const list = ui.filter === 'streams' ? streams : ui.filter === 'channels' ? channels : items;
        root.innerHTML = `${downloadsTabs('follow')}
            <div class="lib-chips">${[['all', 'Tümü', items.length], ['streams', 'Yayınlar', streams.length], ['channels', 'Kanallar', channels.length]].map(([k, l, n]) =>
                `<button class="lib-chip${ui.filter === k ? ' on' : ''}" data-f="filter" data-v="${k}">${l} <small>${n}</small></button>`).join('')}</div>
            ${error ? `<div class="notice">${escapeHtml(error)}</div>` : ''}
            ${list.length ? `<div class="fw-list">${list.map(rowHtml).join('')}</div>`
                : '<div class="empty">Henüz takip yok.<br>"+ Takibe al" ile bir yayın sayfası ya da kanal ekle.</div>'}
            <p class="fw-foot">Yayınlara seçtiğin sıklıkta, kanallara her ${EVERY_CHANNEL[1]} dakikada bir bakılır. Yeni video gelince ya da yayın başlayınca bildirim gelir.</p>`;
    }

    /* ---------------- Ayar alanları (form ve sağ panel ortak) ---------------- */

    function seg(key, options, value, labelFn = (o) => o[1]) {
        return `<div class="seg seg-fit">${options.map((o) => `<button class="${String(o[0]) === String(value) ? 'on' : ''}" data-set="${key}" data-v="${o[0]}">${labelFn(o)}</button>`).join('')}</div>`;
    }

    function settingsRows(w, compact = false) {
        if (w.type === 'channel') {
            return `<div class="rows filled">
                <button class="row" data-set="auto" data-v="${w.auto ? '' : '1'}"><span class="row-value" style="font-weight:400">Yeni videoları kendiliğinden indir</span><span class="toggle${w.auto ? ' on' : ''}"></span></button>
                <div class="row"><span class="row-value" style="font-weight:400">Kalite</span>${seg('quality', QUALITIES, w.quality)}</div>
                <div class="row"><span class="row-value" style="font-weight:400">Ne sıklıkla bakılsın</span>${seg('every', EVERY_CHANNEL.map((m) => [m, m < 60 ? `${m} dk` : `${m / 60} sa`]), w.every)}</div>
                ${everyHint(w)}
                <button class="row" data-set="keep" data-v="${w.keep ? 0 : 10}"><span class="row-value" style="font-weight:400">Yalnızca son 10 videoyu sakla<span class="muted row-sub">Eskiler sunucundan silinir</span></span><span class="toggle${w.keep ? ' on' : ''}"></span></button>
                <button class="row" data-set="notify" data-v="${w.notify === false ? '1' : ''}"><span class="row-value" style="font-weight:400">Bildirim gönder<span class="muted row-sub">Yeni video gelince</span></span><span class="toggle${w.notify !== false ? ' on' : ''}"></span></button>
            </div>`;
        }
        if (w.type === 'schedule') {
            return `<div class="rows filled">
                <div class="row"><span class="row-value" style="font-weight:400">Kalite</span>${seg('quality', QUALITIES, w.quality)}</div>
                <button class="row" data-set="notify" data-v="${w.notify === false ? '1' : ''}"><span class="row-value" style="font-weight:400">Bildirim gönder</span><span class="toggle${w.notify !== false ? ' on' : ''}"></span></button>
            </div>`;
        }
        const win = w.window || { on: false, days: [1, 2, 3, 4, 5], from: '19:00', to: '23:00' };
        return `<div class="rows filled fw-settings">
            <div class="row"><span class="row-value" style="font-weight:400">${compact ? 'Sıklık' : 'Ne sıklıkla bakılsın'}</span>${seg('every', EVERY_LIVE.map((m) => [m, `${m} dk`]), w.every)}</div>
            ${everyHint(w)}
            <div class="row"><span class="row-value" style="font-weight:400">${compact ? 'En fazla' : 'En fazla kayıt'}</span>${seg('maxSec', MAX, w.maxSec)}</div>
            <div class="row"><span class="row-value" style="font-weight:400">Kalite</span>${seg('quality', QUALITIES, w.quality)}</div>
            <div class="row"><span class="row-value" style="font-weight:400">${compact ? 'Kaydet' : 'Ne kaydedilsin'}</span>${seg('mode', [['each', 'Her yayını'], ['next', 'Yalnız sonrakini']], w.mode)}</div>
            <button class="row" data-set="window.on" data-v="${win.on ? '' : '1'}"><span class="row-value" style="font-weight:400">${compact ? 'Belirli gün/saat' : 'Yalnızca belirli gün ve saatlerde'}${compact && win.on ? `<span class="muted row-sub">${win.days.length === 5 && !win.days.includes(6) && !win.days.includes(7) ? 'Hafta içi' : win.days.map((d) => DAYS[d - 1]).join(', ')} · ${win.from}–${win.to}</span>` : ''}</span><span class="toggle${win.on ? ' on' : ''}"></span></button>
            ${win.on ? `<div class="fw-days">${DAYS.map((d, i) => `<button class="${win.days.includes(i + 1) ? 'on' : ''}" data-set="day" data-v="${i + 1}">${d}</button>`).join('')}</div>
                <div class="fw-hours"><span>Saat aralığı</span><input type="time" data-set-input="window.from" value="${win.from}"> – <input type="time" data-set-input="window.to" value="${win.to}"></div>` : ''}
            <button class="row" data-set="notify" data-v="${w.notify === false ? '1' : ''}"><span class="row-value" style="font-weight:400">Bildirim gönder<span class="muted row-sub">Yayın başlayınca ve kayıt bitince</span></span><span class="toggle${w.notify !== false ? ' on' : ''}"></span></button>
        </div>`;
    }

    /** Ayar düğmesinin değerini taslağa uygular. */
    function applySetting(draft, key, v) {
        const num = (x) => (x === '' ? 0 : Number(x));
        if (key === 'every' || key === 'maxSec' || key === 'keep') draft[key] = num(v);
        else if (key === 'quality' || key === 'mode' || key === 'repeat' || key === 'kind') draft[key] = v;
        else if (key === 'auto' || key === 'notify') draft[key] = Boolean(v);
        else if (key === 'window.on') draft.window = { ...(draft.window || { days: [1, 2, 3, 4, 5], from: '19:00', to: '23:00' }), on: Boolean(v) };
        else if (key === 'day') {
            const days = new Set(draft.window.days);
            const d = Number(v);
            if (days.has(d)) days.delete(d); else days.add(d);
            draft.window = { ...draft.window, days: [...days].sort() };
        } else if (key === 'window.from' || key === 'window.to') draft.window = { ...draft.window, [key.split('.')[1]]: v };
    }

    function panelHtml(w, { head = true } = {}) {
        const recent = w.type === 'channel' && (w.recent || []).length ? `<span class="sec-label">Son gelenler</span>
            <div class="fw-recent">${w.recent.slice(0, 5).map((e) => `<a class="fw-recent-row" href="${escapeHtml(e.url)}" target="_blank" rel="noopener">
                <span class="fw-thumb" style="${e.thumb ? `background-image:url('${escapeHtml(e.thumb)}')` : ''}"></span>
                <span><b>${escapeHtml(e.title)}</b><small class="${e.state === 'downloading' ? 'ok' : e.state === 'error' ? 'warn' : ''}">${({ downloading: `İniyor${e.bytes ? ' · ' + formatSize(e.bytes) : ''}`, queued: 'Sırada', done: `İndi${e.bytes ? ' · ' + formatSize(e.bytes) : ''}`, error: escapeHtml(e.error || 'İnmedi'), new: 'Yeni', old: 'Takipten önce', removed: 'Silindi' })[e.state] || ''}</small></span></a>`).join('')}</div>` : '';
        return `${head ? `<div class="fw-panel-head">${w.type === 'channel' ? avatar(w) : ''}<div><b>${escapeHtml(w.name)}</b><small>${escapeHtml(hostPath(w.url))}</small></div></div>` : ''}
            ${w.state === 'login' ? `<div class="notice">Bu site için giriş gerekiyor. "Kendim dokunayım" ile siteyi açıp bir kez giriş yap; giriş sunucunda saklanır ve takip kaldığı yerden sürer.</div>` : ''}
            ${recent}
            ${settingsRows(w, true)}
            <div class="fw-panel-btns"><button class="btn-ghost" data-f="remove" data-id="${w.id}">Takibi bitir</button>
                <button class="btn-ac" data-f="check" data-id="${w.id}">Şimdi bak</button></div>`;
    }

    /* ---------------- Ayrıntı (telefon) ---------------- */

    function renderDetail(w) {
        if (!w) {
            ui.detail = null;
            return render();
        }
        root.innerHTML = `<div class="fw-detail">
            <div class="wz-top"><button class="back-btn" data-f="back" aria-label="Geri">${icon('back')}</button><span>${escapeHtml(w.name)}</span></div>
            ${backoffCard(w)}
            ${isStream(w) ? streamCard(w) : ''}
            ${panelHtml(w, { head: !isStream(w) })}
            ${w.newCount ? `<button class="btn-ghost" data-f="seen" data-id="${w.id}">Yenileri görüldü say</button>` : ''}</div>`;
    }

    /* ---------------- Ekleme ---------------- */

    function guessType(url) {
        return /youtube\.com\/(@|c\/|channel\/|user\/)|tiktok\.com\/@[^/]+\/?$|instagram\.com\/[^/]+\/?$|twitch\.tv\/[^/]+\/videos|\/playlist\?list=|vimeo\.com\/(channels|user)/i.test(url) ? 'channel' : 'live';
    }

    function startAdd(type = 'live', url = '') {
        const now = new Date();
        now.setMinutes(0, 0, 0);
        const start = now.getTime() + 3600000;
        ui.adding = {
            type, url, probe: null, probing: false,
            draft: type === 'channel'
                ? { every: 30, quality: '1080', auto: true, keep: 0, notify: true, kind: 'kanal' }
                : type === 'schedule'
                    ? { quality: 'best', repeat: 'once', early: 5, late: 10, start, end: start + 5400000, notify: true }
                    : { every: 5, maxSec: 14400, quality: 'best', mode: 'each', notify: true, window: { on: false, days: [1, 2, 3, 4, 5], from: '19:00', to: '23:00' } }
        };
        navigate('follow');
        render();
        if (url) probe();
    }

    const localInput = (ts) => {
        const d = new Date(ts - new Date(ts).getTimezoneOffset() * 60000);
        return d.toISOString().slice(0, 16);
    };

    function renderAdd() {
        const a = ui.adding;
        const titles = { live: 'Yayını bekle', schedule: 'Zamanlanmış kayıt', channel: 'Kanalı takip et' };
        const button = { live: 'Beklemeye başla', schedule: 'Zamanla', channel: 'Takibe al' };
        let banner = '';
        if (a.probing) banner = '<div class="fw-banner idle">Sayfa yoklanıyor…</div>';
        else if (a.probe && a.type !== 'channel') {
            banner = !a.probe.reachable
                ? `<div class="fw-banner warn">! <span><b>Sayfa açılmadı.</b> ${escapeHtml(a.probe.error || '')} Yine de eklenebilir; sunucun aralıklarla dener.</span></div>`
                : `<div class="fw-banner ok">✓ <span><b>Sayfa bulundu.</b> ${a.probe.live ? 'Yayın şu an açık — eklenince hemen kayda başlanır.' : 'Yayın şu an kapalı — açıldığı an kayda başlanır, bitince kaydedilir.'}</span></div>`;
        }
        let form = '';
        if (a.type === 'schedule') {
            const d = a.draft;
            const len = Math.max(0, d.end - d.start);
            const occ = occurrences(d, 5);
            const box = (key, label, ts, on) => `<div class="fw-when-box${on ? ' on' : ''}"><span>${label}</span>
                <label class="fw-when-day"><b>${new Date(ts).toLocaleDateString('tr-TR', { weekday: 'short', day: 'numeric', month: 'short' })}</b>
                    <input type="date" data-sched="${key}-date" value="${localInput(ts).slice(0, 10)}"></label>
                <input class="fw-when-time" type="time" data-sched="${key}-time" value="${localInput(ts).slice(11, 16)}"></div>`;
            form = `<div class="fw-when">${box('start', 'Başlat', d.start, true)}${box('end', 'Bitir', d.end, false)}</div>
                <p class="fw-sub">${Math.floor(len / 3600000) ? `${Math.floor(len / 3600000)} sa ` : ''}${Math.round((len % 3600000) / 60000)} dk · ${d.early} dk erken başla, ${d.late} dk geç bitir</p>
                <span class="sec-label">Tekrar</span>${seg('repeat', REPEATS, d.repeat)}
                <span class="sec-label">Yaklaşan kayıtlar</span>
                <div class="fw-occ">${occ.map(([s, e]) => `<div class="fw-occ-row"><span class="fw-date"><b>${new Date(s).getDate()}</b><small>${new Date(s).toLocaleDateString('tr-TR', { weekday: 'short' })}</small></span>
                    <span><b>${escapeHtml(d.name || hostPath(a.url) || 'Kayıt')}</b><small class="mono">${hhmm(s)} – ${hhmm(e)}</small></span>
                    <small>${new Date(s).toLocaleDateString('tr-TR', { month: 'short' })}</small></div>`).join('')}</div>
                ${settingsRows({ type: 'schedule', ...d })}
                <p class="fw-sub">Kaydı sunucun yapar; telefon kapalı olsa da olur.</p>`;
        } else {
            form = settingsRows({ type: a.type, ...a.draft });
        }
        root.innerHTML = `<div class="fw-add">
            <div class="wz-top"><button class="back-btn" data-f="cancel-add" aria-label="Geri">${icon('back')}</button><span>${titles[a.type]}</span></div>
            <input class="input fw-url" type="url" data-add-url placeholder="Yayın ya da kanal sayfasının adresi" value="${escapeHtml(a.url)}" autocomplete="off">
            <div class="seg">${[['live', 'Yayını bekle'], ['schedule', 'Zamanla'], ['channel', 'Kanal']].map(([k, l]) => `<button class="${a.type === k ? 'on' : ''}" data-f="add-type" data-v="${k}">${l}</button>`).join('')}</div>
            ${banner}
            ${form}
            <div class="fw-add-bar"><button class="btn-big" data-f="save-add">${button[a.type]}</button></div></div>`;
    }

    let probeSeq = 0;
    async function probe() {
        const a = ui.adding;
        if (!a || !isHttpUrl(a.url) || a.type !== 'live') return;
        const my = ++probeSeq;
        a.probing = true;
        render();
        try {
            a.probe = await api('/watch/probe', { url: a.url });
        } catch (err) {
            a.probe = { reachable: false, error: err.message };
        }
        if (my !== probeSeq || ui.adding !== a) return;
        a.probing = false;
        if (a.probe.title && !a.draft.name) a.draft.name = a.probe.title;
        render();
    }

    async function saveAdd() {
        const a = ui.adding;
        if (!isHttpUrl(a.url)) return toast('Geçerli bir adres gir');
        try {
            if (a.draft.notify !== false) ensurePush().catch(() => {});
            const w = await api('/watch', { type: a.type, url: a.url, ...a.draft });
            ui.adding = null;
            ui.selected = w.id;
            ui.desk = a.type === 'channel' ? 'channels' : 'streams';
            toast(a.type === 'channel' ? 'Takibe alındı' : a.type === 'schedule' ? 'Zamanlandı' : 'Yayın bekleniyor');
            await load();
            render();
        } catch (err) {
            toast(err.message);
        }
    }

    /* ---------------- Olaylar ---------------- */

    root.addEventListener('click', async (e) => {
        const set = e.target.closest('[data-set]');
        if (set) {
            e.stopPropagation();
            if (ui.adding) {
                applySetting(ui.adding.draft, set.dataset.set, set.dataset.v);
                return render();
            }
            const id = ui.detail || ui.selected;
            const w = items.find((x) => x.id === id);
            if (!w) return;
            const draft = { ...w, window: { ...(w.window || {}) } };
            applySetting(draft, set.dataset.set, set.dataset.v);
            const patch = {};
            for (const k of ['every', 'maxSec', 'quality', 'mode', 'notify', 'auto', 'keep', 'window', 'repeat']) {
                if (JSON.stringify(draft[k]) !== JSON.stringify(w[k])) patch[k] = draft[k];
            }
            Object.assign(w, patch);
            render();
            if (patch.notify) ensurePush().catch(() => {});
            api(`/watch/${w.id}`, patch).then(load).catch((err) => toast(err.message));
            return;
        }
        const btn = e.target.closest('[data-f]');
        if (!btn) return;
        const f = btn.dataset.f;
        const id = btn.dataset.id;
        const w = items.find((x) => x.id === id);
        if (f === 'setup') return navigate('settings');
        if (f === 'filter') ui.filter = btn.dataset.v;
        if (f === 'desk') ui.desk = btn.dataset.v;
        if (f === 'add') return startAdd(btn.dataset.v || 'live');
        if (f === 'add-type') {
            ui.adding.type = btn.dataset.v;
            const url = ui.adding.url;
            startAdd(btn.dataset.v, url);
            return;
        }
        if (f === 'cancel-add') ui.adding = null;
        if (f === 'save-add') return saveAdd();
        if (f === 'back') ui.detail = null;
        if (f === 'library') return navigate('library');
        if (f === 'open' && w) {
            if (e.target.closest('button') && e.target.closest('button') !== btn) return;
            ui.selected = id;
            if (!desktop()) ui.detail = id;
            if (w.newCount) api(`/watch/${id}`, { seenAll: true }).then(load).catch(() => {});
        }
        if (f === 'toggle' && w) {
            e.stopPropagation();
            w.enabled = !w.enabled;
            render();
            api(`/watch/${id}`, { enabled: w.enabled }).then(load).catch((err) => toast(err.message));
            return;
        }
        if (f === 'check' && w) {
            e.stopPropagation();
            w.checking = true;
            render();
            api(`/watch/${id}/check`).then(() => setTimeout(load, 1500)).catch((err) => toast(err.message));
            return;
        }
        if (f === 'stop' && w) {
            e.stopPropagation();
            api(`/watch/${id}/stop`).then(load).catch((err) => toast(err.message));
            toast('Kayıt durduruluyor, kaydedilecek');
            return;
        }
        if (f === 'seen' && w) api(`/watch/${id}`, { seenAll: true }).then(load).catch(() => {});
        if (f === 'remove' && w) {
            if (!(await confirmSheet({ title: 'Takipten çıkarılsın mı?', text: `"${w.name}" artık izlenmez. Daha önce kaydedilenler kitaplıkta kalır.`, danger: true, confirm: 'Takipten çıkar' }))) return;
            await api(`/watch/${id}`, null, 'DELETE').catch((err) => toast(err.message));
            ui.detail = null;
            ui.selected = null;
            return load();
        }
        render();
    });

    root.addEventListener('input', (e) => {
        if (e.target.matches('[data-add-url]') && ui.adding) {
            ui.adding.url = e.target.value.trim();
            if (ui.adding.type !== 'schedule') {
                const guess = guessType(ui.adding.url);
                if (guess !== ui.adding.type && guess === 'channel') {
                    startAdd('channel', ui.adding.url);
                    const input = root.querySelector('[data-add-url]');
                    if (input) input.focus();
                    return;
                }
            }
            clearTimeout(probe.timer);
            probe.timer = setTimeout(probe, 800);
        }
    });
    root.addEventListener('change', (e) => {
        const sched = e.target.dataset.sched;
        if (sched && ui.adding) {
            const d = ui.adding.draft;
            const [which, part] = sched.split('-');
            const cur = localInput(d[which]);
            const value = part === 'date' ? `${e.target.value}T${cur.slice(11, 16)}` : `${cur.slice(0, 10)}T${e.target.value}`;
            const t = new Date(value).getTime();
            if (!isFinite(t)) return;
            if (which === 'start') {
                const len = d.end - d.start;
                d.start = t;
                d.end = t + Math.max(600000, len);
            } else d.end = Math.max(d.start + 300000, t);
            return render();
        }
        const key = e.target.dataset.setInput;
        if (key) {
            if (ui.adding) {
                applySetting(ui.adding.draft, key, e.target.value);
                return;
            }
            const w = items.find((x) => x.id === (ui.detail || ui.selected));
            if (!w) return;
            const draft = { ...w, window: { ...(w.window || {}) } };
            applySetting(draft, key, e.target.value);
            w.window = draft.window;
            api(`/watch/${w.id}`, { window: draft.window }).then(load).catch((err) => toast(err.message));
        }
    });

    /* ---------------- Uyarılar (uygulama açıkken) ---------------- */

    const SEEN_KEY = 'indirici.followSeen';
    let alertBox = null;
    function showAlerts(list) {
        let seenAt = 0;
        try {
            seenAt = Number(localStorage.getItem(SEEN_KEY)) || 0;
        } catch (_) { /* depolama kapalı */ }
        const fresh = list.filter((ev) => ev.at > seenAt).slice(0, 3);
        if (!seenAt) {
            // İlk açılışta eski olaylar uyarı olarak gösterilmez.
            try { localStorage.setItem(SEEN_KEY, String(Date.now())); } catch (_) { /* kapalı */ }
            return;
        }
        if (!fresh.length) return;
        try { localStorage.setItem(SEEN_KEY, String(Math.max(...fresh.map((ev) => ev.at)))); } catch (_) { /* kapalı */ }
        if (!alertBox) {
            alertBox = document.createElement('div');
            alertBox.className = 'fw-alerts';
            document.body.appendChild(alertBox);
            alertBox.addEventListener('click', (e) => {
                const card = e.target.closest('.fw-alert');
                if (!card) return;
                if (e.target.closest('[data-a="go"]')) {
                    const kind = card.dataset.kind;
                    if (kind === 'rec-done') navigate('library');
                    else {
                        ui.selected = card.dataset.watch;
                        if (!desktop()) ui.detail = card.dataset.watch;
                        navigate('follow');
                        render();
                    }
                }
                card.remove();
            });
        }
        for (const ev of fresh.reverse()) {
            const action = { 'live-start': 'Aç', 'new-videos': 'Gör', 'rec-done': 'İzle', unreachable: 'Gör', backoff: 'Gör', recovered: 'Gör' }[ev.kind] || 'Aç';
            const el = document.createElement('div');
            el.className = `fw-alert ${ev.kind === 'live-start' ? 'rec' : ev.kind === 'unreachable' || ev.kind === 'backoff' ? 'warn' : 'ok'}`;
            el.dataset.kind = ev.kind;
            el.dataset.watch = ev.watchId;
            el.innerHTML = `<i></i><span><b>${escapeHtml(ev.title)}</b><small>${escapeHtml(ev.body)}</small></span>
                <button data-a="go">${action}</button><button data-a="x" aria-label="Kapat">${icon('close')}</button>`;
            alertBox.prepend(el);
            setTimeout(() => el.remove(), 12000);
        }
        while (alertBox.children.length > 3) alertBox.lastChild.remove();
    }

    /* ---------------- Bildirim aboneliği ---------------- */

    async function ensurePush() {
        if (!('serviceWorker' in navigator) || !('PushManager' in window) || !getRenderServer()) return false;
        const perm = Notification.permission === 'default' ? await Notification.requestPermission() : Notification.permission;
        if (perm !== 'granted') return false;
        const reg = await navigator.serviceWorker.ready;
        const { key } = await renderApi('/push/key', {}, 10000);
        let sub = await reg.pushManager.getSubscription();
        const raw = Uint8Array.from(atob(key.replace(/-/g, '+').replace(/_/g, '/')), (c) => c.charCodeAt(0));
        if (sub) {
            const current = sub.options && sub.options.applicationServerKey && new Uint8Array(sub.options.applicationServerKey);
            if (current && current.length === raw.length && current.every((b, i) => b === raw[i])) {
                await api('/push/subscribe', sub.toJSON());
                return true;
            }
            await sub.unsubscribe();
        }
        sub = await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: raw });
        await api('/push/subscribe', sub.toJSON());
        return true;
    }

    /* ---------------- Yaşam döngüsü ---------------- */

    function schedule() {
        clearInterval(timer);
        const visible = document.visibilityState === 'visible';
        if (!visible || !getRenderServer()) return;
        const fast = document.body.dataset.view === 'follow' || items.some((w) => w.state === 'recording');
        timer = setInterval(load, fast ? 5000 : 30000);
    }
    document.addEventListener('visibilitychange', () => {
        if (document.visibilityState === 'visible') load();
        schedule();
    });
    window.addEventListener('resize', () => {
        if (document.body.dataset.view === 'follow') render();
    });
    load().then(schedule);

    return {
        refresh() {
            load().then(schedule);
            render();
        },
        /** Algıla'dan: bu sayfayı takibe al. */
        add(url, type) {
            startAdd(type || guessType(url), url);
        },
        ensurePush
    };
}
