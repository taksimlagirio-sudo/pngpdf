// Toplu ekle: birden çok bağlantı (ya da çalma listesi) tek seferde bulunur ve sıraya eklenir.
import { escapeHtml, formatSize, clock, isHttpUrl, getRenderServer, renderApi } from './util.js';
import { analyzeUrl } from './detect.js';
import { variantIndexFor } from './sitesettings.js';
import { getPrefs } from './prefs.js';
import { icon } from './icons.js';

const QUALITIES = [['best', 'En iyi'], ['1080', '1080p'], ['720', '720p'], ['audio', 'Sadece ses']];
const PLAYLIST = /[?&]list=|\/playlist|\/liste\/|\/@[^/]+\/?(videos)?$|\/channel\/|\/c\/|\/user\/|\/sets\//i;

/** Metindeki tüm http(s) bağlantıları (tekrarsız, sırayla). */
export function linksIn(text) {
    const out = [];
    for (const m of String(text || '').matchAll(/https?:\/\/[^\s<>"']+/g)) {
        const url = m[0].replace(/[),.;!?]+$/, '');
        if (isHttpUrl(url) && !out.includes(url)) out.push(url);
    }
    return out;
}

function hostPath(url) {
    try {
        const u = new URL(url);
        return (u.host.replace(/^www\./, '') + u.pathname + u.search).replace(/\/$/, '');
    } catch (_) {
        return url;
    }
}

export function openBulk({ text = '', enqueue, toast, navigate }) {
    const el = document.createElement('div');
    el.className = 'remote-overlay bulk';
    document.body.appendChild(el);
    document.documentElement.classList.add('remote-open');

    const st = { text, quality: 'best', rows: [], seq: 0, adding: false };

    function close() {
        st.seq++;
        el.remove();
        document.removeEventListener('keydown', onKey);
        if (!document.querySelector('.remote-overlay')) document.documentElement.classList.remove('remote-open');
    }

    const heightOf = (v) => v.height || (v.resolution && Number(String(v.resolution).split('x')[1])) || 0;

    /** Satırın seçili kaliteye göre özeti: [süre/kalite metni, tahmini boyut] */
    function describe(row) {
        const r = row.result;
        if (!r) return ['', 0];
        if (row.items) return [`${row.items.length} video`, 0];
        const variants = (r.details && r.details.variants) || [];
        const dur = (r.details && (r.details.duration || (r.details.playlist && r.details.playlist.duration))) || r.duration || 0;
        let label = '';
        let size = r.size || 0;
        if (variants.length) {
            const q = st.quality;
            let pick = variants.reduce((a, b) => (heightOf(b) > heightOf(a) ? b : a), variants[0]);
            if (q !== 'best' && q !== 'audio') {
                const fit = variants.filter((v) => heightOf(v) && heightOf(v) <= Number(q));
                if (fit.length) pick = fit.reduce((a, b) => (heightOf(b) > heightOf(a) ? b : a));
            }
            label = q === 'audio' ? 'ses' : heightOf(pick) ? `${heightOf(pick)}p` : '';
            size = dur && pick.bandwidth ? (pick.bandwidth / 8) * dur * (q === 'audio' ? 0.08 : 1) : 0;
        }
        return [[dur ? clock(dur) : '', label].filter(Boolean).join(' · '), size];
    }

    function render() {
        const playlists = st.rows.filter((r) => r.items).length;
        const ok = st.rows.filter((r) => r.state === 'ok');
        const count = ok.reduce((n, r) => n + (r.items ? r.items.length : 1), 0);
        const total = ok.reduce((n, r) => n + describe(r)[1], 0);
        if (!el.querySelector('.bk')) {
            el.innerHTML = `<div class="bk">
                <div class="wz-top"><button class="back-btn" data-b="close" aria-label="Kapat">${icon('back')}</button><span>Toplu ekle</span></div>
                <textarea class="input bk-text" data-b-text spellcheck="false" placeholder="Her satıra bir bağlantı yapıştır (video, sayfa ya da çalma listesi)"></textarea>
                <div class="bk-dyn"></div></div><div class="ed-bar bk-bar"></div>`;
        }
        const ta = el.querySelector('[data-b-text]');
        if (ta.value !== st.text) ta.value = st.text;
        el.querySelector('.bk-dyn').innerHTML = `
                <div class="bk-meta"><span>${st.rows.length} bağlantı${playlists ? ` · ${playlists} çalma listesi` : ''}</span>
                    <button class="link-btn" data-b="paste">Panodan ekle</button></div>
                <div class="bk-rows">${st.rows.map((row, i) => {
                    const [meta] = describe(row);
                    const title = row.title || hostPath(row.url);
                    const mark = row.state === 'ok' ? `<span class="bk-ok">${icon('check')}</span>` : row.state === 'error' ? `<span class="bk-err">${icon('close')}</span>` : '<span class="bk-wait"></span>';
                    return `<div class="bk-row ${row.state}">
                        <span class="bk-th" style="${row.thumb ? `background-image:url('${escapeHtml(row.thumb)}')` : ''}"></span>
                        <span class="bk-main"><b>${row.items ? 'Çalma listesi: ' : ''}${escapeHtml(title)}</b>
                            <small>${row.state === 'error' ? escapeHtml(row.error) : row.state === 'ok' ? escapeHtml(meta) : 'Bakılıyor…'}</small></span>
                        ${mark}<button class="bk-x" data-b="remove" data-i="${i}" aria-label="Çıkar">${icon('close')}</button></div>`;
                }).join('')}</div>
                ${st.rows.length ? `<span class="sec-label">Hepsine aynı kalite</span>
                <div class="seg">${QUALITIES.map(([k, l]) => `<button class="${st.quality === k ? 'on' : ''}" data-b="quality" data-v="${k}">${l}</button>`).join('')}</div>` : ''}`;
        el.querySelector('.bk-bar').innerHTML = `<span data-e-size>${total ? `~${formatSize(total)}` : ''}</span>
                <button class="btn-big" data-b="add"${count && !st.adding ? '' : ' disabled'}>${st.adding ? 'Ekleniyor…' : `${count} tanesini sıraya ekle`}</button>`;
    }

    /** Bağlantıyı analiz eder: sayfaysa içindeki ilk videoya iner; çalma listesiyse videolarını listeler. */
    async function inspect(row, seq) {
        try {
            if (getRenderServer() && PLAYLIST.test(row.url)) {
                const list = await renderApi('/list', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ url: row.url }) }, 60000).catch(() => null);
                if (seq !== st.seq) return;
                if (list && list.ok && list.entries.length > 1) {
                    row.items = list.entries.map((e) => ({ url: e.url, title: e.title }));
                    row.title = list.title || row.title;
                    row.thumb = (list.entries[0] && list.entries[0].thumb) || '';
                    row.state = 'ok';
                    row.result = { playlist: true };
                    return;
                }
            }
            const opts = { mode: getPrefs().conn, noExtract: !getPrefs().useYtdlp };
            let result = await analyzeUrl(row.url, opts);
            let page = '';
            if (result.target === 'page') {
                const link = (result.details.links || []).find((l) => !l.unreachable) || (result.details.links || [])[0];
                if (!link) throw new Error('Sayfada video bulunamadı');
                page = result.url;
                row.title = result.details.title || row.title;
                row.link = link;
                result = await analyzeUrl(link.url, opts);
            }
            if (seq !== st.seq) return;
            if (result.target === 'hls' && result.details && result.details.playlist && result.details.playlist.live) {
                throw new Error('Canlı yayın · Takip ile kaydedebilirsin');
            }
            if (result.details && result.details.drm) throw new Error('Korumalı yayın (DRM)');
            row.result = result;
            row.page = page;
            row.title = row.title || (result.details && result.details.title) || result.suggestedName || '';
            row.thumb = result.previewUrl || '';
            row.state = 'ok';
        } catch (err) {
            if (seq !== st.seq) return;
            row.state = 'error';
            row.error = /DRM/i.test(err.message) ? 'Bulunamadı · korumalı yayın' : err.message.slice(0, 120);
        }
    }

    async function scan() {
        const seq = ++st.seq;
        const urls = linksIn(st.text);
        const keep = new Map(st.rows.map((r) => [r.url, r]));
        st.rows = urls.map((url) => keep.get(url) || { url, state: 'wait', title: '' });
        render();
        const todo = st.rows.filter((r) => r.state === 'wait');
        let next = 0;
        const worker = async () => {
            while (next < todo.length && seq === st.seq) {
                const row = todo[next++];
                await inspect(row, seq);
                if (seq === st.seq) render();
            }
        };
        await Promise.all([worker(), worker()]);
    }

    async function addAll() {
        st.adding = true;
        render();
        let added = 0;
        let failed = 0;
        for (const row of st.rows.filter((r) => r.state === 'ok')) {
            const targets = row.items
                ? row.items.map((it) => ({ url: it.url, title: it.title }))
                : [{ result: row.result, page: row.page, title: row.page ? row.title : '' }];
            for (const t of targets) {
                try {
                    const opts = { mode: getPrefs().conn, noExtract: !getPrefs().useYtdlp };
                    let result = t.result;
                    let page = t.page || '';
                    let link = t.link || null;
                    if (!result) {
                        // Çalma listesindeki video: önce bulunur (gelişmiş bulma açıksa onunla).
                        result = await analyzeUrl(t.url, opts);
                        if (result.target === 'page') {
                            link = (result.details.links || [])[0];
                            if (!link) throw new Error('video yok');
                            page = result.url;
                            result = null;
                        }
                    }
                    // Gelişmiş bulmanın kalitelerinden seçilen kalite (ayrı sesiyle).
                    const pick = link && link.formats ? link.formats[variantIndexFor(link.formats, st.quality === 'audio' ? '720' : st.quality)] : link;
                    if (pick && (!result || pick.url !== link.url)) result = await analyzeUrl(pick.url, opts);
                    await enqueue(result, { quality: st.quality, page, title: t.title, pair: pick ? pick.audioUrl || null : null });
                    added++;
                } catch (err) {
                    failed++;
                }
            }
        }
        st.adding = false;
        toast(`${added} indirme sıraya eklendi${failed ? ` · ${failed} tanesi eklenemedi` : ''}`);
        if (added) {
            close();
            navigate('downloads');
        } else render();
    }

    el.addEventListener('click', async (e) => {
        const btn = e.target.closest('[data-b]');
        if (!btn || btn.disabled) return;
        const b = btn.dataset.b;
        if (b === 'close') return close();
        if (b === 'quality') {
            st.quality = btn.dataset.v;
            return render();
        }
        if (b === 'remove') {
            const row = st.rows[Number(btn.dataset.i)];
            st.text = st.text.split('\n').filter((line) => !line.includes(row.url)).join('\n');
            st.rows.splice(Number(btn.dataset.i), 1);
            return render();
        }
        if (b === 'paste') {
            try {
                const clip = await navigator.clipboard.readText();
                const links = linksIn(clip).filter((u) => !st.text.includes(u));
                if (!links.length) return toast('Panoda yeni bağlantı yok');
                st.text = [st.text.trim(), ...links].filter(Boolean).join('\n');
                render();
                scan();
            } catch (_) {
                toast('Panoya erişilemedi; bağlantıları kutuya yapıştır');
            }
            return;
        }
        if (b === 'add') return addAll();
    });
    let typing = null;
    el.addEventListener('input', (e) => {
        if (!e.target.matches('[data-b-text]')) return;
        st.text = e.target.value;
        clearTimeout(typing);
        typing = setTimeout(scan, 700);
    });
    const onKey = (e) => {
        if (e.key === 'Escape') close();
    };
    document.addEventListener('keydown', onKey);
    render();
    if (linksIn(text).length) scan();
    else setTimeout(() => el.querySelector('[data-b-text]').focus(), 50);
    return { close };
}
