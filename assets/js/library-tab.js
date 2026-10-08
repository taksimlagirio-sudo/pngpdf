// "Kitaplık" sekmesi: indirilen videolar, fotoğraflar, sesler ve kayıtlar (bu cihazda ve sunucumda).
import { $, escapeHtml, formatSize, clock, getRenderServer, renderApi } from './util.js';
import { getPrefs, setPref, onPrefs } from './prefs.js';
import { deviceInfo, lastSyncState, syncNow, syncedItems, fetchToDevice } from './sync.js';
import { libList, onLibrary, libUsage, libRemove, libPersist, libClean, libUpdate, applyProgress } from './library.js';
import { icon } from './icons.js';
import { confirmSheet } from './sheet.js';

const KIND_LABEL = { video: 'Video', photo: 'Fotoğraf', audio: 'Ses', rec: 'Kayıt', file: 'Dosya' };
const TYPES = [['Tümü', null], ['Video', 'video'], ['Fotoğraf', 'photo'], ['Ses', 'audio'], ['Kayıt', 'rec']];
const SOURCES = [['all', 'Tümü'], ['device', 'Bu cihaz'], ['server', 'Sunucum']];
const APK_SOURCES = [['all', 'Tümü'], ['device', 'Kitaplık'], ['gallery', 'Galeri'], ['server', 'Sunucum']];
const STYLES = [['grid', 'Izgara'], ['wall', 'Duvar'], ['list', 'Liste']];

/** Öğenin türü (kayıtlar ayrı sayılır). */
export const typeOf = (item) => (item.rec ? 'rec' : item.kind);
export const isVisual = (item) => item.kind === 'video' || item.kind === 'photo' || (item.rec && item.kind !== 'audio');

/** "Video · 48:10 · 1,9 GB" */
export function itemMeta(item) {
    const parts = [KIND_LABEL[typeOf(item)] || 'Dosya'];
    if (item.duration) parts.push(clock(item.duration));
    else if (item.width) parts.push(`${item.width}×${item.height}`);
    if (item.size) parts.push(formatSize(item.size));
    return parts.join(' · ');
}

/** Nerede: Sunucuda / Galeride / Yalnız burada */
export function itemWhere(item) {
    if (item.server) return ['Sunucuda', 'srv'];
    if (item.gallery) return ['Telefonda', 'ok'];
    if (item.exportedAt) return ['Galeride', 'ok'];
    return ['Yalnız burada', 'only'];
}

function dayLabel(ts) {
    const d = new Date(ts);
    const today = new Date();
    const start = new Date(today.getFullYear(), today.getMonth(), today.getDate()).getTime();
    if (ts >= start) return 'Bugün';
    if (ts >= start - 86400000) return 'Dün';
    return d.toLocaleDateString('tr-TR', { day: 'numeric', month: 'long', year: d.getFullYear() === today.getFullYear() ? undefined : 'numeric' });
}

/** Sunucudaki biten kayıtlar ("Sunucum"): telefona alınmadan akıtılarak izlenir. */
async function serverItems() {
    const server = getRenderServer();
    if (!server) return [];
    const out = [];
    for (const kind of ['record', 'capture']) {
        try {
            const { items = [] } = await renderApi(`/${kind}`, {}, 8000);
            for (const s of items) {
                if (s.state !== 'done' || !s.fileName) continue;
                out.push({
                    id: `s:${kind}:${s.id}`, server: true, serverKind: kind, serverId: s.id, name: s.fileName,
                    kind: /m4a$/.test(s.ext || '') ? 'audio' : 'video', rec: true, size: s.bytes || 0,
                    duration: s.mediaSec || s.duration || 0, createdAt: s.endedAt || s.startedAt || Date.now(),
                    page: s.pageUrl || s.url || '', site: hostOf(s.pageUrl || s.url || ''),
                    url: `${server.url}/${kind}/${s.id}/file?token=${encodeURIComponent(server.token)}`, thumb: ''
                });
            }
        } catch (_) { /* sunucu kapalı ya da eski */ }
    }
    return out;
}

/**
 * APK: telefon galerisindeki videolar ve fotoğraflar (izin verildiyse). Dosyalara uygulamanın kendi
 * adresi altından ulaşılır (/__galeri/…; kabuk telefonun medya deposundan verir).
 */
function galleryItems(known) {
    const bridge = window.IndiriciAndroid;
    if (!bridge || !bridge.galleryList || bridge.galleryState() !== 'granted') return [];
    let list = [];
    try {
        list = JSON.parse(bridge.galleryList(0, 600) || '[]');
    } catch (_) { /* okunamadı */ }
    // Kitaplıkta zaten olan (İndirilenler'e de kaydedilmiş) dosyalar iki kez görünmesin.
    const have = new Set(known.map((i) => `${i.name}|${i.size}`));
    return list.filter((g) => !have.has(`${g.name}|${g.size}`)).map((g) => ({
        id: `g:${g.id}`, gallery: true, name: g.name || 'dosya', kind: g.kind === 'image' ? 'photo' : 'video',
        mime: g.mime || '', size: g.size || 0, duration: g.duration || 0, width: g.width || 0, height: g.height || 0,
        createdAt: g.at || 0, url: `/__galeri/dosya/${g.id}`, thumb: `/__galeri/kucuk/${g.id}`
    }));
}

/** Sunucudaki öğeleri siler (kayıt, açıp-kaydet ya da eşitlenmiş kitaplık kopyası). */
export async function deleteServerItems(items) {
    let ok = 0;
    for (const it of items) {
        const path = it.serverKind === 'library' ? `/library/item/${encodeURIComponent(it.serverId)}` : `/${it.serverKind}/${it.serverId}`;
        try {
            await renderApi(path, { method: 'DELETE' }, 15000);
            ok++;
        } catch (err) {
            if (err.status === 404) ok++; // zaten yok
        }
    }
    window.dispatchEvent(new CustomEvent('indirici:server-changed'));
    return ok;
}

export function confirmServerDelete(items) {
    const synced = items.some((i) => i.serverKind === 'library');
    return confirmSheet({
        title: 'Sunucudan silinsin mi?', items, danger: true, confirm: 'Sunucudan sil',
        text: synced ? 'Eşitlenmiş kopya diğer cihazlardan da kalkar; bir cihaza indirilmiş kopyalar kalır.'
            : 'Dosya sunucundan kalıcı olarak silinir. Telefona daha önce indirdiğin kopya kalır.'
    });
}

function hostOf(url) {
    try {
        return new URL(url).host.replace(/^www\./, '');
    } catch (_) {
        return '';
    }
}

export function initLibraryTab({ toast, viewer, onMerge = null }) {
    const root = $('libraryView');
    // Sunucudaki bir dosya silinince (oynatıcıdan da) liste tazelenir.
    window.addEventListener('indirici:server-changed', () => refresh({ server: true }).catch(() => {}));
    const ui = { source: 'all', type: null, query: '', searching: false, selected: null, collection: null, picking: false, picked: new Set() };
    const desktop = () => window.matchMedia('(min-width: 960px)').matches;
    let items = [];
    let remote = [];
    let phone = []; // telefon galerisi (APK, izinle)
    let galleryAsked = false;
    try {
        galleryAsked = localStorage.getItem('indirici.galleryAsk') === 'no';
    } catch (_) { /* depolama kapalı */ }
    let usage = null;
    let visible = [];
    let focusSearch = false;

    let syncState = lastSyncState();
    let syncing = null; // { done, total }
    const syncOn = () => getPrefs().libSync && getRenderServer();
    const all = () => {
        const ids = new Set(items.map((i) => i.id));
        const synced = syncOn() ? syncedItems(syncState, ids) : [];
        return [...items, ...remote, ...synced, ...phone].sort((a, b) => b.createdAt - a.createdAt);
    };

    function filtered() {
        const q = ui.query.trim().toLocaleLowerCase('tr');
        const c = ui.collection;
        return all()
            .filter((i) => ui.source === 'all' || (ui.source === 'server' ? i.server : ui.source === 'gallery' ? i.gallery : !i.server && !i.gallery))
            .filter((i) => !c || (c.kind === 'rec' ? i.rec : c.kind === 'edited' ? i.edited : c.kind === 'page' ? i.page === c.value
                : c.kind === 'coll' ? (i.collections || []).includes(c.value) : c.kind === 'tag' ? (i.tags || []).includes(c.value) : i.site === c.value))
            .filter((i) => !q || `${i.name} ${i.site || ''}`.toLocaleLowerCase('tr').includes(q));
    }

    function usageHtml() {
        if (!usage) return '';
        const total = Math.max(1, usage.total);
        const seg = (key, cls) => usage.by[key] ? `<span class="${cls}" style="width:${(usage.by[key] / total) * 100}%"></span>` : '';
        return `<button class="lib-usage" data-l="storage" aria-label="Depolama">
            <span class="lib-bar">${seg('video', 'u-video')}${seg('photo', 'u-photo')}${seg('rec', 'u-rec')}${seg('other', 'u-other')}</span>
            <span class="lib-usage-t">${formatSize(usage.total)} · ${usage.count} öğe</span></button>`;
    }

    function tileBadges(item) {
        return `${item.rec ? '<span class="lib-badge rec">KAYIT</span>' : ''}${item.server ? '<span class="lib-badge srv">SUNUCU</span>' : ''}${item.gallery ? '<span class="lib-badge gal">GALERİ</span>' : ''}`;
    }

    function tileLabel(item) {
        if (item.duration) return clock(item.duration);
        if (item.width) return `${item.width}×${item.height}`;
        return (item.name.split('.').pop() || '').toUpperCase();
    }

    function thumbStyle(item) {
        return item.thumb ? `background-image:url('${item.thumb}')` : '';
    }

    function tileHtml(item, style) {
        const mark = item.thumb ? '' : `<span class="lib-ph">${icon(item.kind === 'audio' ? 'music' : item.kind === 'photo' ? 'image' : 'play')}</span>`;
        if (style === 'list') {
            const [where, cls] = itemWhere(item);
            const devs = syncOn() && (!item.server || item.synced) ? deviceBadges(item) : '';
            return `<button class="lib-row${ui.selected === item.id ? ' sel' : ''}${ui.picking && ui.picked.has(item.id) ? ' picked' : ''}" data-l="open" data-id="${escapeHtml(item.id)}">
                ${ui.picking ? `<span class="lib-pick row${ui.picked.has(item.id) ? ' on' : ''}">${ui.picked.has(item.id) ? '✓' : ''}</span>` : ''}
                <span class="lib-row-th" style="${thumbStyle(item)}">${mark}${item.rec ? '<span class="lib-dot"></span>' : ''}</span>
                <span class="lib-row-main"><span class="lib-row-n">${escapeHtml(item.name)}</span>
                    ${devs ? `<span class="lib-devs">${devs}<small>${item.size ? formatSize(item.size) : ''}</small></span>` : `<span class="lib-row-m">${escapeHtml(itemMeta(item))}</span>`}</span>
                ${item.synced ? `<span class="btn-ac lib-take" data-l="take" data-id="${escapeHtml(item.id)}">${fetching.has(item.id) ? `%${fetching.get(item.id)}` : 'Bu cihaza al'}</span>` : `<span class="lib-where ${cls}">${where}</span>`}</button>`;
        }
        const ratio = style === 'wall' && item.width && item.height ? Math.min(1.9, Math.max(0.5, item.height / item.width)) : 1;
        return `<button class="lib-tile${ui.selected === item.id ? ' sel' : ''}" data-l="open" data-id="${escapeHtml(item.id)}" style="${thumbStyle(item)};aspect-ratio:1/${ratio.toFixed(3)}">
            ${mark}<span class="lib-badges">${tileBadges(item)}</span><span class="lib-dur">${escapeHtml(tileLabel(item))}</span>
            ${ui.picking ? `<span class="lib-pick${ui.picked.has(item.id) ? ' on' : ''}">${ui.picked.has(item.id) ? '✓' : ''}</span>` : ''}</button>`;
    }

    function render() {
        const prefs = getPrefs();
        const style = prefs.libStyle || 'grid';
        const bySource = filtered();
        const counts = TYPES.map(([, k]) => bySource.filter((i) => !k || typeOf(i) === k).length);
        const list = bySource.filter((i) => !ui.type || typeOf(i) === ui.type);
        const groups = [];
        for (const item of list) {
            const label = dayLabel(item.createdAt);
            let g = groups[groups.length - 1];
            if (!g || g.label !== label) groups.push(g = { label, items: [] });
            g.items.push(item);
        }
        const anyVisual = list.some(isVisual);
        const empty = !all().length;

        const shown = list;
        if (ui.selected && !shown.some((i) => i.id === ui.selected)) ui.selected = null;
        if (!ui.selected && shown.length && desktop()) ui.selected = shown[0].id;
        visible = shown;
        const resume = ui.picking || ui.query || ui.collection || (ui.type && ui.type !== 'video') ? []
            : all().filter((i) => i.kind !== 'photo' && i.resumeAt > 10 && (!i.duration || i.resumeAt < i.duration - 15))
                .sort((a, b) => (b.watchedAt || 0) - (a.watchedAt || 0)).slice(0, 10);
        const colls = collectionsOf(all());
        const tags = tagsOf(all());
        const pickBar = ui.picking ? `<div class="lib-selbar"><b>${ui.picked.size} seçili</b>
                <button class="link-btn" data-l="pick-all">Tümü</button>
                <button class="link-btn" data-l="pick-cancel">Vazgeç</button></div>` : '';
        root.innerHTML = `<div class="lib-layout"><div class="lib-main">
            ${pickBar}
            ${galleryCardHtml()}
            ${syncOn() && !ui.picking ? syncCardHtml() : ''}
            ${ui.searching ? `<div class="lib-search"><input class="input" type="search" data-l-q placeholder="Ad ya da site ara" value="${escapeHtml(ui.query)}"></div>` : ''}
            ${usageHtml()}
            <div class="lib-ctrls">
                <label class="lib-desk-search"><input class="input" type="search" data-l-q placeholder="Ad, site ya da tür ara" value="${escapeHtml(ui.query)}"><kbd>Ctrl K</kbd></label>
                <div class="seg lib-seg">${(syncOn() ? [['all', 'Hepsi'], ['device', 'Bu cihazda'], ['server', 'Öbür cihazda']] : window.IndiriciAndroid && window.IndiriciAndroid.galleryList ? APK_SOURCES : SOURCES).map(([k, l]) => `<button class="${ui.source === k ? 'on' : ''}" data-l="source" data-v="${k}">${l}</button>`).join('')}</div>
                <div class="seg lib-seg">${STYLES.map(([k, l]) => `<button class="${style === k ? 'on' : ''}" data-l="style" data-v="${k}">${l}</button>`).join('')}</div>
            </div>
            <div class="lib-chips">${TYPES.map(([l, k], i) => `<button class="lib-chip${ui.type === k ? ' on' : ''}" data-l="type" data-v="${k || ''}">${l} <small>${counts[i]}</small></button>`).join('')}
                ${!ui.picking ? '<button class="lib-chip lib-pick-btn" data-l="pick-start">Seç</button>' : ''}</div>
            ${colls.length || tags.length ? `<div class="lib-chips lib-colls">${colls.map((c) => `<button class="lib-chip${ui.collection && ui.collection.kind === 'coll' && ui.collection.value === c.name ? ' on' : ''}" data-l="coll" data-v="${escapeHtml(c.name)}">▦ ${escapeHtml(c.name)} <small>${c.items.length}</small></button>`).join('')}
                ${tags.map((t) => `<button class="lib-chip tag${ui.collection && ui.collection.kind === 'tag' && ui.collection.value === t ? ' on' : ''}" data-l="tag" data-v="${escapeHtml(t)}">#${escapeHtml(t)}</button>`).join('')}</div>` : ''}
            ${resume.length ? `<div class="lib-group"><div class="lib-ghead"><span>Devam et</span><span>${resume.length}</span></div>
                <div class="lib-resume">${resume.map((i) => `<button class="lib-rcard" data-l="resume" data-id="${escapeHtml(i.id)}">
                    <span class="lib-rthumb" style="${thumbStyle(i)}"><span class="lib-rplay">${icon('play')}</span>
                        <span class="lib-rbar"><i style="width:${i.duration ? Math.min(100, (i.resumeAt / i.duration) * 100) : 30}%"></i></span></span>
                    <b>${escapeHtml(i.name.replace(/\.[^.]+$/, ''))}</b>
                    <small>${i.duration ? `kalan ${Math.max(1, Math.round((i.duration - i.resumeAt) / 60))} dk` : clock(i.resumeAt)}</small></button>`).join('')}</div></div>` : ''}
            ${empty ? `<div class="empty">Kitaplık boş.<br>İndirdiğin videolar, fotoğraflar ve kayıtların bir kopyası burada durur;
                buradan izler, düzenler ve yeniden paylaşırsın.</div>`
                : !list.length ? '<div class="empty">Bu seçimde öğe yok.</div>'
                : groups.map((g) => `
                <div class="lib-group">
                    <div class="lib-ghead"><span>${escapeHtml(g.label)}</span><span>${g.items.length} öğe</span></div>
                    <div class="lib-${style}">${g.items.map((i) => tileHtml(i, style)).join('')}</div>
                </div>`).join('')}
            ${ui.collection ? `<button class="lib-coll-chip" data-l="coll-clear">${escapeHtml(ui.collection.label)} ${icon('close')}</button>` : ''}
            ${ui.picking ? `<div class="lib-pick-actions">
                <button class="btn-ghost" data-l="pick-coll"${ui.picked.size ? '' : ' disabled'}>Koleksiyona ekle</button>
                <button class="btn-ghost" data-l="pick-merge"${pickedVideos().length >= 2 ? '' : ' disabled'}>Birleştir</button>
                <button class="btn-ghost danger" data-l="pick-delete"${ui.picked.size ? '' : ' disabled'}>Sil</button></div>`
                : anyVisual ? `<button class="lib-feed-btn" data-l="feed">${icon('play')} Akışta izle</button>` : ''}
            </div><aside class="lib-insp">${inspectorHtml()}</aside></div>`;
        renderSide();
        if (ui.searching || focusSearch) {
            focusSearch = false;
            const input = root.querySelector(ui.searching && !desktop() ? '.lib-search [data-l-q]' : '.lib-desk-search [data-l-q]');
            input.focus();
            input.setSelectionRange(input.value.length, input.value.length);
        }
    }

    /** APK: telefon galerisini de göstermek için izin kartı (bir kez sorulur, "Şimdi değil" denince gizlenir). */
    function galleryCardHtml() {
        const bridge = window.IndiriciAndroid;
        if (ui.picking || !bridge || !bridge.galleryState || bridge.galleryState() === 'granted') return '';
        if (galleryAsked && ui.source !== 'gallery') return '';
        return `<div class="gal-card"><span class="gal-ic">${icon('image')}</span>
            <span class="gal-t"><b>Telefon galerin de burada görünsün mü?</b>
                <small>Videoların ve fotoğrafların, indirdiklerin ve sunucundakilerle birlikte listelenir. Dosyalar telefonda kalır, hiçbir yere gönderilmez.</small></span>
            <span class="gal-btns"><button class="btn-ac" data-l="gal-allow">İzin ver</button>
                ${galleryAsked ? '' : '<button class="link-btn" data-l="gal-later">Şimdi değil</button>'}</span></div>`;
    }

    const fetching = new Map();

    function deviceBadges(item) {
        const me = deviceInfo();
        const devices = recentDevices();
        const ids = [me.id, ...Object.keys(devices).filter((id) => id !== me.id)];
        const has = (id) => (id === me.id ? !item.server : Boolean(item.devices && item.devices[id]));
        // Sunucudaki karşılığı bu cihaz için de bilgi taşır (öbür cihaz bende ne olduğunu bilir).
        const serverCopy = syncState && syncState.items.find((x) => x.id === item.id);
        return ids.slice(0, 3).map((id) => {
            const on = has(id) || Boolean(serverCopy && serverCopy.devices && serverCopy.devices[id]);
            const name = id === me.id ? me.name : (devices[id] || {}).name || 'Cihaz';
            return `<span class="dev-badge${on ? ' on' : ''}">${escapeHtml(name.toLocaleUpperCase('tr'))}</span>`;
        }).join('');
    }

    /** Son 60 günde eşitlenmiş cihazlar. */
    function recentDevices() {
        const all = (syncState && syncState.devices) || {};
        return Object.fromEntries(Object.entries(all).filter(([, d]) => Date.now() - (d.lastSync || 0) < 60 * 864e5));
    }

    function syncCardHtml() {
        const devices = recentDevices();
        const me = deviceInfo();
        const others = Object.entries(devices).filter(([id]) => id !== me.id).map(([, d]) => d.name);
        const when = syncState ? Math.round((Date.now() - syncState.at) / 60000) : null;
        const status = syncing ? `Eşitleniyor · ${syncing.done}/${syncing.total}` : syncState ? `Eşitlendi · ${when < 1 ? 'az önce' : `${when} dk önce`}` : 'Henüz eşitlenmedi';
        return `<div class="sync-card"><i class="${syncing ? 'busy' : syncState ? 'ok' : ''}"></i>
            <span><b>${status}</b><small>Bu ${me.name.toLocaleLowerCase('tr')}${others.length ? ` ↔ ${escapeHtml(others.join(', '))}` : ''} · sunucu üzerinden</small></span>
            <button class="link-btn" data-l="sync"${syncing ? ' disabled' : ''}>Eşitle</button></div>`;
    }

    async function runSync() {
        if (syncing || !syncOn()) return;
        syncing = { done: 0, total: 0 };
        render();
        try {
            syncState = await syncNow({ onProgress: (done, total) => { syncing = { done, total }; render(); } });
        } catch (err) {
            toast(`Eşitlenemedi: ${err.message}`);
        } finally {
            syncing = null;
            render();
        }
    }

    function collectionsOf(list) {
        const map = new Map();
        for (const i of list) for (const c of i.collections || []) {
            if (!map.has(c)) map.set(c, []);
            map.get(c).push(i);
        }
        return [...map].map(([name, items]) => ({ name, items })).sort((a, b) => b.items.length - a.items.length);
    }

    function tagsOf(list) {
        const set = new Map();
        for (const i of list) for (const t of i.tags || []) set.set(t, (set.get(t) || 0) + 1);
        return [...set].sort((a, b) => b[1] - a[1]).map(([t]) => t).slice(0, 20);
    }

    function pickedItems() {
        return all().filter((i) => ui.picked.has(i.id));
    }

    function pickedVideos() {
        return pickedItems().filter((i) => i.kind === 'video' && !i.server && !i.gallery);
    }

    function selectedItem() {
        return visible.find((i) => i.id === ui.selected) || null;
    }

    function inspectorHtml() {
        const it = selectedItem();
        if (!it) return '<div class="lib-insp-empty">Bir öğe seç</div>';
        const rows = [
            ['Boyut', it.size ? formatSize(it.size) : '—'],
            ['Süre / ölçü', it.duration ? clock(it.duration) : it.width ? `${it.width}×${it.height}` : '—'],
            ['Kaynak', it.site || '—'],
            ['Nerede', it.server ? 'Sunucum (akıtılır)' : it.gallery ? 'Telefon galerisi' : it.exportedAt ? 'Bu cihaz · galeride de var' : 'Yalnızca bu cihaz'],
            ['İndirildi', new Date(it.createdAt).toLocaleString('tr-TR', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' })]
        ];
        return `
            <button class="lib-insp-prev" data-l="insp-open" style="${thumbStyle(it)}">${it.kind === 'photo' ? '' : `<span class="lib-insp-play">${icon('play')}</span>`}</button>
            <div class="lib-insp-t">${escapeHtml(it.name)}</div>
            <div class="lib-insp-m">${KIND_LABEL[typeOf(it)] || 'Dosya'} · ${it.server ? 'sunucunda' : it.gallery ? 'telefon galerisinde' : 'bu cihazda'}</div>
            <div class="lib-insp-rows">${rows.map(([k, v]) => `<div><span>${k}</span><b>${escapeHtml(v)}</b></div>`).join('')}</div>
            <div class="lib-insp-btns">
                <button class="btn-ac" data-l="insp-open">Aç</button>
                <button class="btn-ghost" data-l="insp-edit"${it.server ? ' disabled' : ''}>Düzenle</button>
                <button class="btn-ghost" data-l="insp-export">Klasöre aktar</button>
                <button class="btn-ghost" data-l="insp-share">Paylaş</button>
                <button class="btn-ghost danger" data-l="insp-delete">${it.server ? 'Sunucudan sil' : 'Sil'}</button>
            </div>
            <div class="lib-keys"><span><kbd>Boşluk</kbd> önizle</span><span><kbd>Enter</kbd> aç</span><span><kbd>E</kbd> düzenle</span><span><kbd>Del</kbd> sil</span></div>`;
    }

    /** Kenar çubuğu: koleksiyonlar ve depolama (masaüstü). */
    function renderSide() {
        const box = $('libCollections');
        const store = $('libSideStorage');
        if (!box) return;
        const list = all();
        const pages = new Map();
        const sites = new Map();
        for (const i of list) {
            if (i.page) pages.set(i.page, (pages.get(i.page) || 0) + 1);
            if (i.site) sites.set(i.site, (sites.get(i.site) || 0) + 1);
        }
        const colls = collectionsOf(list).slice(0, 6).map((c) => ({ kind: 'coll', value: c.name, label: c.name }));
        const topPage = [...pages].filter(([, n]) => n > 1).sort((a, b) => b[1] - a[1])[0];
        if (topPage) {
            const inPage = list.filter((i) => i.page === topPage[0]);
            const main = inPage.find((i) => i.kind === 'video' && !i.edited) || inPage[0];
            colls.push({ kind: 'page', value: topPage[0], label: main.kind === 'video' ? baseTitle(main.name) : pathLabel(topPage[0]) });
        }
        for (const [site] of [...sites].sort((a, b) => b[1] - a[1]).slice(0, 2)) colls.push({ kind: 'site', value: site, label: site });
        if (list.some((i) => i.rec)) colls.push({ kind: 'rec', label: 'Canlı kayıtlar' });
        if (list.some((i) => i.edited)) colls.push({ kind: 'edited', label: 'Düzenlenenler' });
        sideColls = colls;
        box.innerHTML = colls.length ? `<span class="side-coll-t">Koleksiyonlar</span>${colls.map((c, k) =>
            `<button class="${ui.collection && ui.collection.label === c.label ? 'on' : ''}" data-coll="${k}">${escapeHtml(c.label)}</button>`).join('')}` : '';
        if (store && usage) {
            const free = usage.free ? ` · ~${formatSize(usage.free)} boş` : '';
            store.innerHTML = `<b>${formatSize(usage.total)} · bu cihaz</b>
                <span class="lib-bar"><span class="u-video" style="width:${Math.min(100, usage.free ? (usage.total / (usage.total + usage.free)) * 100 : 5)}%"></span></span>
                <small>${usage.count} öğe${free}</small>`;
        }
    }
    let sideColls = [];
    const pathLabel = (url) => {
        try {
            const u = new URL(url);
            return (u.host.replace(/^www\./, '') + u.pathname).replace(/\/$/, '');
        } catch (_) {
            return url;
        }
    };
    const baseTitle = (name) => name.replace(/\.[^.]+$/, '').replace(/-(\d+|duzenlendi)$/, '');

    let autoSyncTimer = null;
    /** Eşitleme açıksa: kitaplık açıldığında (2 dk'da bir) ve yeni öğe gelince arkadan eşitlenir. */
    function scheduleSync(delay = 4000) {
        if (!syncOn()) return;
        clearTimeout(autoSyncTimer);
        autoSyncTimer = setTimeout(() => {
            if (!syncState || Date.now() - syncState.at > 2 * 60 * 1000 || delay === 0) runSync();
        }, delay);
    }

    async function refresh({ server = false } = {}) {
        scheduleSync();
        items = await libList();
        usage = await libUsage();
        if (server) remote = applyProgress(await serverItems());
        phone = applyProgress(galleryItems(items));
        render();
    }

    root.addEventListener('click', (e) => {
        const btn = e.target.closest('[data-l]');
        if (!btn) return;
        const act = btn.dataset.l;
        if (act === 'source') {
            ui.source = btn.dataset.v;
            if (ui.source !== 'device') refresh({ server: true });
        }
        if (act === 'gal-allow') {
            window.__indiriciGalleryPerm = (st) => {
                if (st !== 'granted') toast('İzin verilmedi; Ayarlar › Uygulamalar › İndirici › İzinler\'den açabilirsin');
                refresh().catch(() => {});
            };
            return window.IndiriciAndroid.galleryRequest();
        }
        if (act === 'gal-later') {
            galleryAsked = true;
            try { localStorage.setItem('indirici.galleryAsk', 'no'); } catch (_) { /* depolama kapalı */ }
        }
        if (act === 'style') setPref('libStyle', btn.dataset.v);
        if (act === 'type') ui.type = btn.dataset.v || null;
        if (act === 'storage') return openStorage();
        if (act === 'sync') return runSync();
        if (act === 'take') {
            e.stopPropagation();
            const item = all().find((i) => i.id === btn.dataset.id);
            if (!item || fetching.has(item.id)) return;
            fetching.set(item.id, 0);
            render();
            fetchToDevice(item, { onProgress: (p) => { fetching.set(item.id, Math.round(p * 100)); render(); } })
                .then(() => { toast(`"${item.name}" bu cihaza alındı`); runSync(); })
                .catch((err) => toast(err.message))
                .finally(() => { fetching.delete(item.id); refresh(); });
            return;
        }
        if (act === 'open' && ui.picking) {
            const id = btn.dataset.id;
            if (ui.picked.has(id)) ui.picked.delete(id); else ui.picked.add(id);
            return render();
        }
        if (act === 'pick-start') {
            ui.picking = true;
            ui.picked.clear();
        }
        if (act === 'pick-cancel') {
            ui.picking = false;
            ui.picked.clear();
        }
        if (act === 'pick-all') visible.forEach((i) => ui.picked.add(i.id));
        if (act === 'pick-coll') return openCollectionSheet();
        if (act === 'pick-merge' && onMerge) {
            const list = pickedVideos();
            ui.picking = false;
            ui.picked.clear();
            render();
            return onMerge(list);
        }
        if (act === 'pick-delete') {
            const picked = pickedItems();
            const list = picked.filter((i) => !i.server && !i.gallery);
            const remote = picked.filter((i) => i.server);
            if (!picked.length) return;
            const only = list.filter((i) => !i.exportedAt).length;
            const lines = [
                list.length ? `${list.length} öğe bu cihazdan${only ? ` (${only} tanesi yalnızca burada)` : ''}` : '',
                remote.length ? `${remote.length} öğe sunucundan` : ''
            ].filter(Boolean);
            confirmSheet({ title: `${picked.length} öğe silinsin mi?`, text: `${lines.join(', ')} silinecek. Silinenler geri gelmez.`, items: picked, danger: true, confirm: 'Sil' })
                .then((ok) => ok && Promise.all([list.length ? libRemove(list.map((i) => i.id)) : null, remote.length ? deleteServerItems(remote) : null]).then(() => {
                ui.picking = false;
                ui.picked.clear();
                toast(`${picked.length} öğe silindi`);
                if (remote.length) refresh({ server: true });
            }));
            return;
        }
        if (act === 'coll') ui.collection = ui.collection && ui.collection.kind === 'coll' && ui.collection.value === btn.dataset.v ? null : { kind: 'coll', value: btn.dataset.v, label: btn.dataset.v };
        if (act === 'tag') ui.collection = ui.collection && ui.collection.kind === 'tag' && ui.collection.value === btn.dataset.v ? null : { kind: 'tag', value: btn.dataset.v, label: '#' + btn.dataset.v };
        if (act === 'resume') {
            const item = all().find((i) => i.id === btn.dataset.id);
            if (item) viewer.open([item], 0);
            return;
        }
        if (act === 'open') {
            if (desktop() && ui.selected !== btn.dataset.id) {
                ui.selected = btn.dataset.id;
                return render();
            }
            return openSelected(btn.dataset.id);
        }
        if (act === 'insp-open') return openSelected(ui.selected);
        if (act === 'insp-edit' && selectedItem()) return viewer.edit(selectedItem(), visible.filter((i) => i.kind === 'photo' && !i.server && !i.gallery));
        if (act === 'insp-export' && selectedItem()) return viewer.toGallery(selectedItem());
        if (act === 'insp-share' && selectedItem()) return viewer.share(selectedItem());
        if (act === 'insp-delete' && selectedItem()) {
            const it = selectedItem();
            return viewer.remove(it).then((done) => {
                if (!done) return;
                ui.selected = null;
                if (it.server) refresh({ server: true });
            });
        }
        if (act === 'coll-clear') ui.collection = null;
        if (act === 'feed') {
            const list = filtered().filter((i) => (!ui.type || typeOf(i) === ui.type) && isVisual(i));
            viewer.feed(list);
            return;
        }
        render();
    });
    // Uzun basınca seçim modu açılır.
    let pressTimer = null;
    root.addEventListener('pointerdown', (e) => {
        const tile = e.target.closest('[data-l="open"]');
        if (!tile || ui.picking) return;
        pressTimer = setTimeout(() => {
            ui.picking = true;
            ui.picked = new Set([tile.dataset.id]);
            suppressClick = true;
            render();
        }, 550);
    });
    let suppressClick = false;
    ['pointerup', 'pointercancel', 'pointerleave'].forEach((ev) => root.addEventListener(ev, () => clearTimeout(pressTimer)));
    root.addEventListener('click', (e) => {
        if (suppressClick) {
            suppressClick = false;
            e.stopImmediatePropagation();
        }
    }, true);

    /* ---- Koleksiyona ekle / etiketler ---- */
    function openCollectionSheet() {
        const items = pickedItems().filter((i) => !i.server && !i.gallery);
        if (!items.length) return toast('Sunucudaki ve galerideki öğeler koleksiyona eklenemez');
        const colls = collectionsOf(all());
        const tags = tagsOf(all());
        const st = { coll: null, newName: '', tags: new Set(), newTag: '' };
        const el = document.createElement('div');
        el.className = 'sheet-backdrop lib-sheet';
        document.body.appendChild(el);
        const cover = (list) => `<span class="coll-cover">${[0, 1, 2, 3].map((k) => `<i style="${list[k] ? thumbStyle(list[k]) : ''}"></i>`).join('')}</span>`;
        const draw = () => {
            el.innerHTML = `<div class="sheet coll-sheet">
                <span class="sheet-grip"></span>
                <b class="coll-title">Koleksiyona ekle</b>
                <div class="coll-grid">
                    <button class="coll-card new${st.coll === '' ? ' on' : ''}" data-c="new"><span class="coll-cover plus">+</span><b>Yeni</b></button>
                    ${colls.map((c) => `<button class="coll-card${st.coll === c.name ? ' on' : ''}" data-c="pick" data-v="${escapeHtml(c.name)}">${cover(c.items)}<b>${escapeHtml(c.name)}</b><small>${c.items.length} öğe</small></button>`).join('')}
                </div>
                ${st.coll === '' ? `<input class="input" data-c-name placeholder="Koleksiyon adı" value="${escapeHtml(st.newName)}">` : ''}
                <span class="sec-label">Etiketler</span>
                <div class="coll-tags">${[...new Set([...tags, ...st.tags])].map((t) => `<button class="lib-chip tag${st.tags.has(t) ? ' on' : ''}" data-c="tag" data-v="${escapeHtml(t)}">#${escapeHtml(t)}</button>`).join('')}
                    <input class="coll-newtag" data-c-tag placeholder="+ etiket" value="${escapeHtml(st.newTag)}"></div>
                <div class="coll-bar"><span>${st.coll ? escapeHtml(st.coll) : st.coll === '' ? 'Yeni koleksiyon' : st.tags.size ? `${st.tags.size} etiket` : 'Bir koleksiyon seç'}</span>
                    <button class="btn-ac" data-c="save">Ekle</button></div></div>`;
            const nameInput = el.querySelector('[data-c-name]');
            if (nameInput && document.activeElement !== nameInput) nameInput.focus();
        };
        const close = () => el.remove();
        el.addEventListener('click', async (e) => {
            if (e.target === el) return close();
            const b = e.target.closest('[data-c]');
            if (!b) return;
            const c = b.dataset.c;
            if (c === 'new') st.coll = st.coll === '' ? null : '';
            if (c === 'pick') st.coll = st.coll === b.dataset.v ? null : b.dataset.v;
            if (c === 'tag') {
                if (st.tags.has(b.dataset.v)) st.tags.delete(b.dataset.v); else st.tags.add(b.dataset.v);
            }
            if (c === 'save') {
                const name = st.coll === '' ? st.newName.trim() : st.coll;
                if (st.coll === '' && !name) return toast('Koleksiyona bir ad ver');
                if (!name && !st.tags.size) return toast('Bir koleksiyon ya da etiket seç');
                for (const it of items) {
                    const patch = {};
                    if (name) patch.collections = [...new Set([...(it.collections || []), name])];
                    if (st.tags.size) patch.tags = [...new Set([...(it.tags || []), ...st.tags])];
                    await libUpdate(it.id, patch);
                }
                toast(`${items.length} öğe ${name ? `"${name}" koleksiyonuna eklendi` : 'etiketlendi'}`);
                ui.picking = false;
                ui.picked.clear();
                close();
                return render();
            }
            draw();
        });
        el.addEventListener('input', (e) => {
            if (e.target.matches('[data-c-name]')) st.newName = e.target.value;
        });
        el.addEventListener('keydown', (e) => {
            if (e.target.matches('[data-c-tag]') && e.key === 'Enter') {
                const t = e.target.value.trim().replace(/^#/, '').replace(/\s+/g, '-').toLocaleLowerCase('tr');
                if (t) st.tags.add(t);
                st.newTag = '';
                draw();
                const input = el.querySelector('[data-c-tag]');
                if (input) input.focus();
            }
        });
        draw();
    }

    root.addEventListener('dblclick', (e) => {
        const btn = e.target.closest('[data-l="open"]');
        if (btn && desktop()) openSelected(btn.dataset.id);
    });

    function openSelected(id) {
        const index = visible.findIndex((i) => i.id === id);
        if (index >= 0) viewer.open(visible, index);
    }

    const sideBox = $('libCollections');
    if (sideBox) {
        sideBox.addEventListener('click', (e) => {
            const b = e.target.closest('[data-coll]');
            if (!b) return;
            const c = sideColls[Number(b.dataset.coll)];
            ui.collection = ui.collection && ui.collection.label === c.label ? null : c;
            if (document.body.dataset.view !== 'library') location.hash = 'library';
            render();
        });
    }
    const sideStore = $('libSideStorage');
    if (sideStore) sideStore.addEventListener('click', () => openStorage());

    // Masaüstü kısayolları
    document.addEventListener('keydown', (e) => {
        if (document.body.dataset.view !== 'library' || document.querySelector('.remote-overlay')) return;
        if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'k') {
            e.preventDefault();
            focusSearch = true;
            if (!desktop()) ui.searching = true;
            return render();
        }
        if (e.target.matches('input, textarea, select')) return;
        const it = selectedItem();
        const idx = visible.findIndex((i) => i.id === ui.selected);
        if (e.key === 'ArrowRight' || e.key === 'ArrowDown' || e.key === 'ArrowLeft' || e.key === 'ArrowUp') {
            if (!visible.length) return;
            e.preventDefault();
            const step = e.key === 'ArrowRight' || e.key === 'ArrowDown' ? 1 : -1;
            ui.selected = visible[Math.max(0, Math.min(visible.length - 1, idx + step))].id;
            render();
            const el = root.querySelector('.sel');
            if (el) el.scrollIntoView({ block: 'nearest' });
            return;
        }
        if (!it) return;
        if (e.key === ' ' || e.key === 'Enter') {
            e.preventDefault();
            openSelected(it.id);
        }
        if (e.key.toLowerCase() === 'e') viewer.edit(it, visible.filter((i) => i.kind === 'photo' && !i.server && !i.gallery));
        if (e.key === 'Delete' || e.key === 'Backspace') viewer.remove(it);
    });

    root.addEventListener('input', (e) => {
        if (!e.target.matches('[data-l-q]')) return;
        ui.query = e.target.value;
        focusSearch = true;
        render();
    });

    // Başlıktaki "Ara"
    const searchBtn = $('libSearchBtn');
    if (searchBtn) {
        searchBtn.addEventListener('click', () => {
            ui.searching = !ui.searching;
            if (!ui.searching) ui.query = '';
            searchBtn.classList.toggle('on', ui.searching);
            render();
        });
    }

    let lastCount = -1;
    onLibrary((list) => {
        if (lastCount >= 0 && list.length > lastCount && syncOn()) {
            clearTimeout(autoSyncTimer);
            autoSyncTimer = setTimeout(runSync, 5000);
        }
        lastCount = list.length;
        refresh();
    });
    onPrefs(() => render());
    libClean().then((n) => {
        if (n) toast(`${n} eski öğe kitaplıktan kaldırıldı (galeride duruyor)`);
    }).finally(() => refresh());

    /* ---- Depolama ---- */
    function openStorage() {
        const el = document.createElement('div');
        el.className = 'remote-overlay lib-storage';
        document.body.appendChild(el);
        document.documentElement.classList.add('remote-open');
        const close = () => {
            el.remove();
            if (!document.querySelector('.remote-overlay')) document.documentElement.classList.remove('remote-open');
        };

        async function draw() {
            const u = await libUsage();
            const list = await libList();
            const prefs = getPrefs();
            const total = Math.max(1, u.total);
            const legend = [['video', 'Videolar', 'u-video'], ['photo', 'Fotoğraflar', 'u-photo'], ['rec', 'Kayıtlar', 'u-rec'], ['other', 'Diğer', 'u-other']];
            const biggest = [...list].sort((a, b) => b.size - a.size).slice(0, 5);
            const srv = getRenderServer();
            el.innerHTML = `
                <div class="st">
                    <div class="wz-top"><button class="back-btn" data-s="close" aria-label="Geri">${icon('back')}</button><span>Depolama</span></div>
                    <div class="st-total"><b>${formatSize(u.total)}</b><span>bu cihazda${u.free ? ` · ~${formatSize(u.free)} boş` : ''}</span></div>
                    <div class="lib-bar st-bar">${legend.map(([k, , c]) => u.by[k] ? `<span class="${c}" style="width:${(u.by[k] / total) * 100}%"></span>` : '').join('')}</div>
                    <div class="st-legend">${legend.map(([k, l, c]) => `<div><i class="${c}"></i><span>${l}</span><b>${formatSize(u.by[k])}</b></div>`).join('')}</div>
                    ${u.persisted
                        ? `<div class="st-ok">✓ <span><b>Kalıcı depolama açık.</b> Tarayıcı yer açarken bu dosyaları silmez. Yine de asıl kopyayı Galeride tut.</span></div>`
                        : `<div class="st-warn"><span><b>Kalıcı depolama kapalı.</b> Yer azalınca tarayıcı bu kopyaları silebilir; asıl kopya Galeride/İndirilenler'de durur.</span>
                            <button class="btn-ghost" data-s="persist">Kalıcı yap</button></div>`}
                    <div class="rows filled">
                        <button class="row" data-s="clean"><span class="row-value" style="font-weight:400">Galeriye kaydedilenleri temizle
                            <span class="muted row-sub">7 gün sonra kitaplıktan kaldır</span></span>
                            <span class="toggle${prefs.libAutoClean ? ' on' : ''}"></span></button>
                        ${srv ? `<button class="row" data-s="sync"><span class="row-value" style="font-weight:400">Cihazlar arası eşitle
                            <span class="muted row-sub">Kitaplık sunucun üzerinden telefon ve bilgisayar arasında eşitlenir</span></span>
                            <span class="toggle${prefs.libSync ? ' on' : ''}"></span></button>` : ''}
                        <button class="row" data-s="keep"><span class="row-value" style="font-weight:400">İndirilenleri kitaplıkta da tut
                            <span class="muted row-sub">Kapalıyken yalnızca seçtiğin yere kaydedilir</span></span>
                            <span class="toggle${prefs.libKeep !== false ? ' on' : ''}"></span></button>
                        ${srv ? `<button class="row" data-s="server"><span class="row-value" style="font-weight:400">Sunucumdaki dosyalar
                            <span class="muted row-sub">${remote.length} kayıt · akıtarak izlenir</span></span><span class="row-chev">›</span></button>` : ''}
                    </div>
                    ${biggest.length ? `<span class="sec-label">En büyükler</span>
                    <div class="st-big">${biggest.map((i) => `
                        <div class="st-big-row"><span class="lib-row-th" style="${thumbStyle(i)}"></span>
                            <span class="lib-row-main"><span class="lib-row-n">${escapeHtml(i.name)}</span>
                            <span class="lib-row-m">${formatSize(i.size)} · ${i.exportedAt ? 'Galeride var' : 'yalnızca burada'}</span></span>
                            <button class="st-del" data-s="del" data-id="${escapeHtml(i.id)}">Sil</button></div>`).join('')}</div>` : ''}
                </div>`;
        }

        el.addEventListener('click', async (e) => {
            const btn = e.target.closest('[data-s]');
            if (!btn) return;
            const s = btn.dataset.s;
            if (s === 'close') return close();
            if (s === 'persist') {
                const ok = await libPersist();
                toast(ok ? 'Kalıcı depolama açıldı' : 'Tarayıcı izin vermedi; uygulamayı ana ekrana eklemek genelde yeter');
            }
            if (s === 'clean') {
                setPref('libAutoClean', !getPrefs().libAutoClean);
                const n = await libClean();
                if (n) toast(`${n} öğe kaldırıldı`);
            }
            if (s === 'keep') setPref('libKeep', getPrefs().libKeep === false);
            if (s === 'sync') {
                setPref('libSync', !getPrefs().libSync);
                if (getPrefs().libSync) runSync();
            }
            if (s === 'server') {
                close();
                ui.source = 'server';
                return refresh({ server: true });
            }
            if (s === 'del') {
                const item = (await libList()).find((i) => i.id === btn.dataset.id);
                if (!item) return;
                const ok = await confirmSheet({ title: 'Kitaplıktan silinsin mi?', items: [item], danger: true, confirm: 'Sil',
                    text: item.exportedAt ? 'Galeriye ya da İndirilenler’e kaydettiğin kopya kalır.' : 'Bu dosya yalnızca burada; silinirse geri gelmez.' });
                if (!ok) return;
                await libRemove(item.id);
            }
            draw();
        });
        draw();
    }

    return {
        refresh: () => refresh({ server: ui.source !== 'device' }),
        openStorage
    };
}
