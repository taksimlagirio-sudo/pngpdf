// "Kitaplık" sekmesi: indirilen videolar, fotoğraflar, sesler ve kayıtlar (bu cihazda ve sunucumda).
import { $, escapeHtml, formatSize, clock, getRenderServer, renderApi } from './util.js';
import { getPrefs, setPref, onPrefs } from './prefs.js';
import { libList, onLibrary, libUsage, libRemove, libPersist, libClean } from './library.js';

const KIND_LABEL = { video: 'Video', photo: 'Fotoğraf', audio: 'Ses', rec: 'Kayıt', file: 'Dosya' };
const TYPES = [['Tümü', null], ['Video', 'video'], ['Fotoğraf', 'photo'], ['Ses', 'audio'], ['Kayıt', 'rec']];
const SOURCES = [['all', 'Tümü'], ['device', 'Bu cihaz'], ['server', 'Sunucum']];
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
                    kind: s.ext === '.m4a' ? 'audio' : 'video', rec: true, size: s.bytes || 0,
                    duration: s.mediaSec || s.duration || 0, createdAt: s.endedAt || s.startedAt || Date.now(),
                    page: s.pageUrl || s.url || '', site: hostOf(s.pageUrl || s.url || ''),
                    url: `${server.url}/${kind}/${s.id}/file?token=${encodeURIComponent(server.token)}`, thumb: ''
                });
            }
        } catch (_) { /* sunucu kapalı ya da eski */ }
    }
    return out;
}

function hostOf(url) {
    try {
        return new URL(url).host.replace(/^www\./, '');
    } catch (_) {
        return '';
    }
}

export function initLibraryTab({ toast, viewer }) {
    const root = $('libraryView');
    const ui = { source: 'all', type: null, query: '', searching: false, selected: null, collection: null };
    const desktop = () => window.matchMedia('(min-width: 960px)').matches;
    let items = [];
    let remote = [];
    let usage = null;
    let visible = [];
    let focusSearch = false;

    const all = () => [...items, ...remote].sort((a, b) => b.createdAt - a.createdAt);

    function filtered() {
        const q = ui.query.trim().toLocaleLowerCase('tr');
        const c = ui.collection;
        return all()
            .filter((i) => ui.source === 'all' || (ui.source === 'server' ? i.server : !i.server))
            .filter((i) => !c || (c.kind === 'rec' ? i.rec : c.kind === 'edited' ? i.edited : c.kind === 'page' ? i.page === c.value : i.site === c.value))
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
        return `${item.rec ? '<span class="lib-badge rec">KAYIT</span>' : ''}${item.server ? '<span class="lib-badge srv">SUNUCU</span>' : ''}`;
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
        const icon = item.thumb ? '' : `<span class="lib-ph">${item.kind === 'audio' ? '♪' : item.kind === 'photo' ? '▣' : '▶'}</span>`;
        if (style === 'list') {
            const [where, cls] = itemWhere(item);
            return `<button class="lib-row${ui.selected === item.id ? ' sel' : ''}" data-l="open" data-id="${escapeHtml(item.id)}">
                <span class="lib-row-th" style="${thumbStyle(item)}">${icon}${item.rec ? '<span class="lib-dot"></span>' : ''}</span>
                <span class="lib-row-main"><span class="lib-row-n">${escapeHtml(item.name)}</span>
                    <span class="lib-row-m">${escapeHtml(itemMeta(item))}</span></span>
                <span class="lib-where ${cls}">${where}</span></button>`;
        }
        const ratio = style === 'wall' && item.width && item.height ? Math.min(1.9, Math.max(0.5, item.height / item.width)) : 1;
        return `<button class="lib-tile${ui.selected === item.id ? ' sel' : ''}" data-l="open" data-id="${escapeHtml(item.id)}" style="${thumbStyle(item)};aspect-ratio:1/${ratio.toFixed(3)}">
            ${icon}<span class="lib-badges">${tileBadges(item)}</span><span class="lib-dur">${escapeHtml(tileLabel(item))}</span></button>`;
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
        root.innerHTML = `<div class="lib-layout"><div class="lib-main">
            ${ui.searching ? `<div class="lib-search"><input class="input" type="search" data-l-q placeholder="Ad ya da site ara" value="${escapeHtml(ui.query)}"></div>` : ''}
            ${usageHtml()}
            <div class="lib-ctrls">
                <label class="lib-desk-search"><input class="input" type="search" data-l-q placeholder="Ad, site ya da tür ara" value="${escapeHtml(ui.query)}"><kbd>Ctrl K</kbd></label>
                <div class="seg lib-seg">${SOURCES.map(([k, l]) => `<button class="${ui.source === k ? 'on' : ''}" data-l="source" data-v="${k}">${l}</button>`).join('')}</div>
                <div class="seg lib-seg">${STYLES.map(([k, l]) => `<button class="${style === k ? 'on' : ''}" data-l="style" data-v="${k}">${l}</button>`).join('')}</div>
            </div>
            <div class="lib-chips">${TYPES.map(([l, k], i) => `<button class="lib-chip${ui.type === k ? ' on' : ''}" data-l="type" data-v="${k || ''}">${l} <small>${counts[i]}</small></button>`).join('')}</div>
            ${empty ? `<div class="empty">Kitaplık boş.<br>İndirdiğin videolar, fotoğraflar ve kayıtların bir kopyası burada durur;
                buradan izler, düzenler ve yeniden paylaşırsın.</div>`
                : !list.length ? '<div class="empty">Bu seçimde öğe yok.</div>'
                : groups.map((g) => `
                <div class="lib-group">
                    <div class="lib-ghead"><span>${escapeHtml(g.label)}</span><span>${g.items.length} öğe</span></div>
                    <div class="lib-${style}">${g.items.map((i) => tileHtml(i, style)).join('')}</div>
                </div>`).join('')}
            ${ui.collection ? `<button class="lib-coll-chip" data-l="coll-clear">${escapeHtml(ui.collection.label)} ✕</button>` : ''}
            ${anyVisual ? '<button class="lib-feed-btn" data-l="feed">▶ Akışta izle</button>' : ''}
            </div><aside class="lib-insp">${inspectorHtml()}</aside></div>`;
        renderSide();
        if (ui.searching || focusSearch) {
            focusSearch = false;
            const input = root.querySelector(ui.searching && !desktop() ? '.lib-search [data-l-q]' : '.lib-desk-search [data-l-q]');
            input.focus();
            input.setSelectionRange(input.value.length, input.value.length);
        }
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
            ['Nerede', it.server ? 'Sunucum (akıtılır)' : it.exportedAt ? 'Bu cihaz · galeride de var' : 'Yalnızca bu cihaz'],
            ['İndirildi', new Date(it.createdAt).toLocaleString('tr-TR', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' })]
        ];
        return `
            <button class="lib-insp-prev" data-l="insp-open" style="${thumbStyle(it)}">${it.kind === 'photo' ? '' : '<span class="lib-insp-play">▶</span>'}</button>
            <div class="lib-insp-t">${escapeHtml(it.name)}</div>
            <div class="lib-insp-m">${KIND_LABEL[typeOf(it)] || 'Dosya'} · ${it.server ? 'sunucunda' : 'bu cihazda'}</div>
            <div class="lib-insp-rows">${rows.map(([k, v]) => `<div><span>${k}</span><b>${escapeHtml(v)}</b></div>`).join('')}</div>
            <div class="lib-insp-btns">
                <button class="btn-ac" data-l="insp-open">Aç</button>
                <button class="btn-ghost" data-l="insp-edit"${it.server ? ' disabled' : ''}>Düzenle</button>
                <button class="btn-ghost" data-l="insp-export">Klasöre aktar</button>
                <button class="btn-ghost" data-l="insp-share">Paylaş</button>
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
        const colls = [];
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

    async function refresh({ server = false } = {}) {
        items = await libList();
        usage = await libUsage();
        if (server) remote = await serverItems();
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
        if (act === 'style') setPref('libStyle', btn.dataset.v);
        if (act === 'type') ui.type = btn.dataset.v || null;
        if (act === 'storage') return openStorage();
        if (act === 'open') {
            if (desktop() && ui.selected !== btn.dataset.id) {
                ui.selected = btn.dataset.id;
                return render();
            }
            return openSelected(btn.dataset.id);
        }
        if (act === 'insp-open') return openSelected(ui.selected);
        if (act === 'insp-edit' && selectedItem()) return viewer.edit(selectedItem(), visible.filter((i) => i.kind === 'photo' && !i.server));
        if (act === 'insp-export' && selectedItem()) return viewer.toGallery(selectedItem());
        if (act === 'insp-share' && selectedItem()) return viewer.share(selectedItem());
        if (act === 'coll-clear') ui.collection = null;
        if (act === 'feed') {
            const list = filtered().filter((i) => (!ui.type || typeOf(i) === ui.type) && isVisual(i));
            viewer.feed(list);
            return;
        }
        render();
    });
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
        if (e.key.toLowerCase() === 'e') viewer.edit(it, visible.filter((i) => i.kind === 'photo' && !i.server));
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

    onLibrary(() => refresh());
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
                    <div class="wz-top"><button class="back-btn" data-s="close" aria-label="Geri">←</button><span>Depolama</span></div>
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
            if (s === 'server') {
                close();
                ui.source = 'server';
                return refresh({ server: true });
            }
            if (s === 'del') {
                const item = (await libList()).find((i) => i.id === btn.dataset.id);
                if (!item) return;
                const note = item.exportedAt ? '' : '\nBu dosya yalnızca burada; silinirse geri gelmez.';
                if (!confirm(`"${item.name}" kitaplıktan silinsin mi?${note}`)) return;
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
