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
    const ui = { source: 'all', type: null, query: '', searching: false };
    let items = [];
    let remote = [];
    let usage = null;

    const all = () => [...items, ...remote].sort((a, b) => b.createdAt - a.createdAt);

    function filtered() {
        const q = ui.query.trim().toLocaleLowerCase('tr');
        return all()
            .filter((i) => ui.source === 'all' || (ui.source === 'server' ? i.server : !i.server))
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
            return `<button class="lib-row" data-l="open" data-id="${escapeHtml(item.id)}">
                <span class="lib-row-th" style="${thumbStyle(item)}">${icon}${item.rec ? '<span class="lib-dot"></span>' : ''}</span>
                <span class="lib-row-main"><span class="lib-row-n">${escapeHtml(item.name)}</span>
                    <span class="lib-row-m">${escapeHtml(itemMeta(item))}</span></span>
                <span class="lib-where ${cls}">${where}</span></button>`;
        }
        const ratio = style === 'wall' && item.width && item.height ? Math.min(1.9, Math.max(0.5, item.height / item.width)) : 1;
        return `<button class="lib-tile" data-l="open" data-id="${escapeHtml(item.id)}" style="${thumbStyle(item)};aspect-ratio:1/${ratio.toFixed(3)}">
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

        root.innerHTML = `
            ${ui.searching ? `<div class="lib-search"><input class="input" type="search" data-l-q placeholder="Ad ya da site ara" value="${escapeHtml(ui.query)}"></div>` : ''}
            ${usageHtml()}
            <div class="lib-ctrls">
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
            ${anyVisual ? '<button class="lib-feed-btn" data-l="feed">▶ Akışta izle</button>' : ''}`;
        if (ui.searching) {
            const input = root.querySelector('[data-l-q]');
            input.focus();
            input.setSelectionRange(input.value.length, input.value.length);
        }
    }

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
            const list = filtered().filter((i) => !ui.type || typeOf(i) === ui.type);
            const index = list.findIndex((i) => i.id === btn.dataset.id);
            if (index >= 0) viewer.open(list, index);
            return;
        }
        if (act === 'feed') {
            const list = filtered().filter((i) => (!ui.type || typeOf(i) === ui.type) && isVisual(i));
            viewer.feed(list);
            return;
        }
        render();
    });
    root.addEventListener('input', (e) => {
        if (!e.target.matches('[data-l-q]')) return;
        ui.query = e.target.value;
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
