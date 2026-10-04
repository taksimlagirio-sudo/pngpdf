// Site başına ayarlar: bir siteden gelen bağlantılar hep aynı yöntemle açılır, aynı kalite seçilir
// ve indirilenler Kitaplık'ta aynı klasöre (koleksiyona) girer.
import { escapeHtml } from './util.js';
import { getPrefs, setPref } from './prefs.js';
import { libList } from './library.js';
import { icon } from './icons.js';

export const METHODS = [['auto', 'Otomatik'], ['ytdlp', 'Gelişmiş bulma'], ['remote', 'Kendim dokunayım']];
export const QUALITIES = [['best', 'En iyi'], ['1080', '1080p'], ['720', '720p']];

const domainOf = (url) => {
    try {
        return new URL(url).hostname.replace(/^(www|m|mobile)\./, '').toLowerCase();
    } catch (_) {
        return String(url || '').trim().toLowerCase().replace(/^https?:\/\//, '').replace(/\/.*$/, '').replace(/^(www|m|mobile)\./, '');
    }
};

/** Kayıtlı ayarlar; eski "seçimimi hatırla" kayıtları da buraya katılır. */
export function siteSettings() {
    const prefs = getPrefs();
    const out = { ...(prefs.siteSettings || {}) };
    for (const [d, m] of Object.entries(prefs.siteMethods || {})) {
        if (!out[d]) out[d] = { method: m === 'ytdlp' ? 'ytdlp' : 'page', quality: 'best', folder: '', createdAt: 0 };
    }
    return out;
}

/** Adrese uyan ayar (alt alan adları da: "ders.ornek.edu" → "ornek.edu"). */
export function siteSettingFor(url) {
    const host = domainOf(url);
    if (!host) return null;
    const all = siteSettings();
    const key = Object.keys(all).filter((d) => host === d || host.endsWith('.' + d)).sort((a, b) => b.length - a.length)[0];
    return key ? { domain: key, ...all[key] } : null;
}

function save(all) {
    setPref('siteSettings', all);
    // Eski kayıt yeni yapıya taşındı.
    if (Object.keys(getPrefs().siteMethods || {}).length) setPref('siteMethods', {});
}

export function setSiteSetting(domain, patch) {
    const all = siteSettings();
    all[domain] = { method: 'auto', quality: 'best', folder: '', createdAt: Date.now(), ...(all[domain] || {}), ...patch };
    save(all);
}

export function removeSiteSetting(domain) {
    const all = siteSettings();
    delete all[domain];
    save(all);
}

/** Kalite tercihine en uygun varyant (o yoksa altındaki en yüksek). */
export function variantIndexFor(variants, quality) {
    const height = (v) => v.height || (v.resolution && Number(String(v.resolution).split('x')[1])) || 0;
    if (quality === 'audio') {
        const audioOnly = variants.findIndex((v) => v.audioOnly || /mp4a|opus/.test(v.codecs || '') && !/avc|hvc|vp0|av01/.test(v.codecs || ''));
        return audioOnly >= 0 ? audioOnly : variants.length - 1;
    }
    if (quality && quality !== 'best') {
        const cap = Number(quality);
        let best = -1;
        variants.forEach((v, i) => {
            const h = height(v);
            if (h && h <= cap && (best < 0 || h > height(variants[best]))) best = i;
        });
        return best >= 0 ? best : variants.length - 1;
    }
    let best = 0;
    variants.forEach((v, i) => { if (height(v) > height(variants[best])) best = i; });
    return best;
}

const hue = (s) => [...s].reduce((n, c) => (n * 31 + c.charCodeAt(0)) % 360, 7);

/** S17: Ayarlar → Site başına ayarlar. */
export function openSiteSettings({ toast = () => {} } = {}) {
    const el = document.createElement('div');
    el.className = 'remote-overlay ss';
    document.body.appendChild(el);
    document.documentElement.classList.add('remote-open');
    let sel = Object.keys(siteSettings())[0] || '';
    let adding = false;
    let folders = [];
    libList().then((list) => {
        folders = [...new Set(list.flatMap((i) => i.collections || []))].sort((a, b) => a.localeCompare(b, 'tr'));
    }).catch(() => {});

    const close = () => {
        el.remove();
        if (!document.querySelector('.remote-overlay')) document.documentElement.classList.remove('remote-open');
    };
    const label = (list, v) => (v === 'page' ? 'Sayfayı aç' : (list.find(([k]) => k === v) || list[0])[1]);

    function draw() {
        const all = siteSettings();
        const domains = Object.keys(all).sort((a, b) => (all[b].createdAt || 0) - (all[a].createdAt || 0));
        if (sel && !all[sel]) sel = domains[0] || '';
        const cur = sel ? all[sel] : null;
        el.innerHTML = `<div class="ss-wrap">
            <div class="wz-top"><button class="back-btn" data-s="close" aria-label="Kapat">${icon('back')}</button><span>Site başına ayarlar</span>
                <button class="btn-ghost ss-add" data-s="add">+ Site</button></div>
            <p class="ss-note">Bu sitelerden gelen bağlantılar hep buradaki ayarlarla açılır.</p>
            ${adding ? `<form class="ss-form" data-s-form><input class="input" name="d" placeholder="ornek.com ya da bir bağlantı" autocomplete="off" autocapitalize="off" required>
                <button class="btn-ac">Ekle</button></form>` : ''}
            ${domains.length ? `<div class="ss-list">${domains.map((d) => {
                const s = all[d];
                return `<button class="ss-row${d === sel ? ' on' : ''}" data-s="pick" data-d="${escapeHtml(d)}">
                    <span class="ss-av" style="background:oklch(0.42 0.08 ${hue(d)})">${escapeHtml(d[0].toUpperCase())}</span>
                    <span class="ss-main"><b>${escapeHtml(d)}</b><small>${escapeHtml([label(METHODS, s.method), label(QUALITIES, s.quality), s.folder ? '/' + s.folder : 'Klasörsüz'].join(' · '))}</small></span>
                    <span class="row-chev">›</span></button>`;
            }).join('')}</div>` : adding ? '' : '<p class="ss-empty">Henüz site yok. "+ Site" ile ekle; ya da bir siteden indirirken sorulduğunda "hatırla" de.</p>'}
            ${cur ? `<div class="ss-edit">
                <span class="sec-label">${escapeHtml(sel)} için hep</span>
                <div class="rows filled">
                    <div class="row ss-seg"><span class="row-value" style="font-weight:400">Nasıl açılsın</span>
                        <div class="seg seg-fit">${METHODS.map(([k, l]) => `<button class="${cur.method === k ? 'on' : ''}" data-s="method" data-v="${k}">${l.split(' ')[0]}</button>`).join('')}</div></div>
                    <div class="row ss-seg"><span class="row-value" style="font-weight:400">Kalite</span>
                        <div class="seg seg-fit">${QUALITIES.map(([k, l]) => `<button class="${cur.quality === k ? 'on' : ''}" data-s="quality" data-v="${k}">${l}</button>`).join('')}</div></div>
                    <button class="row" data-s="folder"><span class="row-value" style="font-weight:400">Klasör<span class="muted row-sub">Kitaplık'ta bu klasöre girer</span></span>
                        <span class="muted">${cur.folder ? '/' + escapeHtml(cur.folder) : 'Yok'} ›</span></button>
                </div>
                <button class="ss-remove" data-s="remove">Bu siteyi kaldır</button></div>` : ''}
        </div>`;
        const input = el.querySelector('[data-s-form] input');
        if (input) input.focus();
    }

    function pickFolder(cur) {
        const sheet = document.createElement('div');
        sheet.className = 'ss-sheet';
        sheet.innerHTML = `<div class="ss-sheet-box"><b>Klasör</b>
            <div class="rows filled">${['', ...folders].map((f) => `<button class="row" data-f="${escapeHtml(f)}"><span class="row-value" style="font-weight:400">${f ? '/' + escapeHtml(f) : 'Klasörsüz'}</span>${(cur.folder || '') === f ? '<span class="muted">✓</span>' : ''}</button>`).join('')}</div>
            <form class="ss-form"><input class="input" placeholder="Yeni klasör adı" maxlength="40"><button class="btn-ac">Ekle</button></form></div>`;
        el.appendChild(sheet);
        const done = (f) => {
            setSiteSetting(sel, { folder: f });
            sheet.remove();
            draw();
        };
        sheet.addEventListener('click', (e) => {
            if (e.target === sheet) return sheet.remove();
            const b = e.target.closest('[data-f]');
            if (b) done(b.dataset.f);
        });
        sheet.querySelector('form').addEventListener('submit', (e) => {
            e.preventDefault();
            const v = sheet.querySelector('input').value.trim().replace(/^\/+/, '');
            if (v) {
                if (!folders.includes(v)) folders.push(v);
                done(v);
            }
        });
    }

    el.addEventListener('submit', (e) => {
        if (!e.target.matches('[data-s-form]')) return;
        e.preventDefault();
        const d = domainOf(e.target.querySelector('input').value);
        if (!/^[a-z0-9.-]+\.[a-z]{2,}$/i.test(d)) return toast('Geçerli bir site adı yaz (ör. ornek.com)');
        setSiteSetting(d, {});
        sel = d;
        adding = false;
        draw();
    });
    el.addEventListener('click', (e) => {
        const b = e.target.closest('[data-s]');
        if (!b) return;
        const a = b.dataset.s;
        if (a === 'close') return close();
        if (a === 'add') adding = !adding;
        if (a === 'pick') sel = b.dataset.d;
        if (a === 'method') setSiteSetting(sel, { method: b.dataset.v });
        if (a === 'quality') setSiteSetting(sel, { quality: b.dataset.v });
        if (a === 'folder') return pickFolder(siteSettings()[sel]);
        if (a === 'remove') {
            removeSiteSetting(sel);
            toast('Site kaldırıldı');
            sel = '';
        }
        draw();
    });
    draw();
    return { close };
}
