// "Resimler" ekranı: bir sayfadaki görselleri bulur, boyutlarını okur, seçtiklerini indirir
// (tek tek ya da tek ZIP olarak).
import { $, escapeHtml, isHttpUrl, smartFetch, formatSize, fileNameFromUrl, getRenderServer, renderSniff, renderImages, saveBlob, proxyUrl } from './util.js';
import { findImages, mergeImages } from './detect.js';
import { addJob, effectiveSaveMode, createSink } from './downloads.js';
import { getPrefs } from './prefs.js';
import { createZip } from './zip.js';

const MIN_SIDE = 300;      // "simge" sayılmayan en küçük kenar
const PROBE_PARALLEL = 6;
const PROBE_TIMEOUT_MS = 20000;

export function initImagesTab({ toast }) {
    const urlInput = $('imgUrl');
    const scanBtn = $('imgScanBtn');
    const statusBox = $('imgStatus');
    const resultBox = $('imgResult');

    let items = [];          // {url, src, name, type, w, h, size, loaded, failed}
    let selected = new Set();
    let typeFilter = 'all';
    let showSmall = false;
    let asZip = true;
    let pageTitle = '';
    let source = '';         // resimleri kim buldu (gallery-dl ise site adıyla)
    let seq = 0;

    scanBtn.addEventListener('click', () => scan(urlInput.value.trim()));
    urlInput.addEventListener('keydown', (e) => {
        if (e.key === 'Enter') scan(urlInput.value.trim());
    });

    function setBusy(text) {
        statusBox.innerHTML = text ? `<div class="busy"><span class="spinner"></span><span>${escapeHtml(text)}</span></div>` : '';
    }

    async function scan(url, known = null, title = '') {
        if (!isHttpUrl(url)) {
            statusBox.innerHTML = '<div class="notice error">Geçerli bir sayfa adresi girin.</div>';
            return;
        }
        const mySeq = ++seq;
        scanBtn.disabled = true;
        items = [];
        selected = new Set();
        typeFilter = 'all';
        pageTitle = title;
        source = '';
        resultBox.innerHTML = '';
        try {
            let urls = null;
            const names = new Map();
            // Önce gallery-dl (sunucuda kuruluysa): bilinen sitelerde tam boyutlu resimler ve galerinin tamamı.
            if (getRenderServer()) {
                setBusy('Resimler aranıyor (gallery-dl)...');
                const found = await renderImages(url).catch(() => null);
                if (mySeq !== seq) return;
                if (found && found.ok && found.items.length) {
                    urls = found.items.map((i) => i.url);
                    for (const i of found.items) if (i.name) names.set(i.url, i.name);
                    if (found.title && !pageTitle) pageTitle = found.title;
                    source = `gallery-dl${found.site ? ' · ' + found.site : ''}`;
                }
            }
            if (!urls) urls = known;
            if (!urls) {
                setBusy('Sayfa okunuyor...');
                urls = await collect(url, (text) => mySeq === seq && setBusy(text));
            }
            if (mySeq !== seq) return;
            if (!urls.length) {
                setBusy('');
                resultBox.innerHTML = '<div class="empty">Bu sayfada resim bulunamadı.</div>';
                return;
            }
            items = urls.map((u) => {
                const name = names.get(u) || fileNameFromUrl(u);
                const type = typeOf(u);
                return { url: u, page: url, name, type: type === 'IMG' ? typeOf(name) : type, w: 0, h: 0, size: 0, loaded: false };
            });
            setBusy(`${items.length} resim inceleniyor...`);
            render();
            await probeAll(items, url, () => mySeq === seq && renderSoon());
            if (mySeq !== seq) return;
            setBusy('');
            // Varsayılan seçim: önizlemesi açılan görünür resimler.
            selected = new Set(visible().filter((it) => !it.failed).map((it) => it.url));
            render();
        } catch (err) {
            if (mySeq !== seq) return;
            setBusy('');
            statusBox.innerHTML = `<div class="notice error">${escapeHtml(err.message)}</div>`;
        } finally {
            if (mySeq === seq) scanBtn.disabled = false;
        }
    }

    /** Sayfanın kaynağından (ve varsa kendi sunucunda çalıştırarak) resim adreslerini toplar. */
    async function collect(url, onStage) {
        const mode = getPrefs().conn;
        let res;
        try {
            res = await smartFetch(url, { mode });
        } catch (err) {
            if (!getRenderServer()) throw err;
            res = null;
        }
        let urls = [];
        if (res) {
            const type = (res.headers.get('content-type') || '').toLowerCase();
            if (type.startsWith('image/')) return [url];
            const html = await res.text();
            const title = (html.match(/<title[^>]*>([^<]{0,160})/i) || [])[1];
            if (title) pageTitle = title.trim();
            urls = findImages(html, url);
        }
        // JS ile sonradan yüklenen (tembel yükleme, galeri) resimler için sayfayı sunucunda çalıştır.
        if (getRenderServer()) {
            onStage('Sayfa kendi sunucunda çalıştırılıyor...');
            try {
                const sniffed = await renderSniff(url);
                if (sniffed.title && !pageTitle) pageTitle = sniffed.title;
                urls = mergeImages(urls, sniffed.items.filter((i) => i.kind === 'image').map((i) => i.url));
            } catch (_) { /* statik taramanın bulduklarıyla devam */ }
        }
        return urls;
    }

    let renderTimer = null;
    function renderSoon() {
        if (renderTimer) return;
        renderTimer = setTimeout(() => {
            renderTimer = null;
            render();
        }, 250);
    }

    function isSmall(it) {
        return it.loaded && !it.failed && it.w > 0 && Math.max(it.w, it.h) < MIN_SIDE;
    }

    // Simgeler yalnızca büyük resim de varsa gizlenir; sayfada hepsi küçükse liste boş kalmasın.
    function hidingSmall() {
        return !showSmall && items.some((it) => !isSmall(it));
    }

    // Önizlemesi açılamayan resimler de listede kalır (sona dizilir): çoğu yine de indirilebilir.
    function pooled() {
        const hide = hidingSmall();
        const list = items.filter((it) => !(hide && isSmall(it)));
        return [...list.filter((it) => !it.failed), ...list.filter((it) => it.failed)];
    }

    function visible() {
        return pooled().filter((it) => typeFilter === 'all' || it.type === typeFilter);
    }

    function render() {
        if (!items.length) return;
        const pool = pooled();
        const types = ['JPG', 'PNG', 'WEBP', 'GIF', 'SVG', 'AVIF'].filter((t) => pool.some((it) => it.type === t));
        const list = visible();
        const sel = items.filter((it) => selected.has(it.url));
        const selBytes = sel.reduce((sum, it) => sum + (it.size || 0), 0);
        const allVisSel = list.length > 0 && list.every((it) => selected.has(it.url));
        const hidden = hidingSmall() ? items.filter(isSmall).length : 0;
        const broken = pool.filter((it) => it.failed).length;

        resultBox.innerHTML = `
            ${pageTitle || source ? `<div class="res-meta" style="margin-top:-4px">${escapeHtml([pageTitle, source && `(${source})`].filter(Boolean).join(' '))}</div>` : ''}
            <div class="img-count-row"><span class="img-count">${pool.length} resim bulundu</span>
                <button class="link-btn" data-act="small" style="color:var(--mt);font-weight:500">${showSmall
                    ? 'Simgeler gösteriliyor'
                    : hidden ? `Min. ${MIN_SIDE} px · simgeler gizli (${hidden})` : `Min. ${MIN_SIDE} px`}</button></div>
            ${broken ? `<p class="hint" style="margin:0 0 8px">${broken} resmin önizlemesi açılmadı (site başka yerde gösterilmesini
                engelliyor olabilir)${getRenderServer() ? '' : '; kendi sunucunla açılabilir'}. Seçip indirmeyi yine deneyebilirsin.</p>` : ''}
            <div class="chips">
                <button class="chip${typeFilter === 'all' ? ' on' : ''}" data-act="type" data-v="all">Tümü<span>${pool.length}</span></button>
                ${types.map((t) => `<button class="chip${typeFilter === t ? ' on' : ''}" data-act="type" data-v="${t}">${t}<span>${pool.filter((it) => it.type === t).length}</span></button>`).join('')}
            </div>
            <div class="img-grid">${list.map((it) => `
                <button class="tile${selected.has(it.url) ? ' on' : ''}" data-act="pick" data-url="${escapeHtml(it.url)}">
                    <div class="tile-img">${it.failed
                        ? '<span class="tile-broken">Önizleme yok</span>'
                        : `<img src="${escapeHtml(it.src || it.url)}" alt="" loading="lazy" referrerpolicy="no-referrer">`}
                        <span class="tile-type">${it.type}</span><span class="tile-check">✓</span></div>
                    <div class="tile-body"><div class="tile-name">${escapeHtml(it.name)}</div>
                        <div class="tile-dims">${it.failed ? 'açılmadı' : it.w ? `${it.w}×${it.h}` : it.loaded ? 'boyut bilinmiyor' : '…'}${it.size ? ' · ' + formatSize(it.size) : ''}</div></div>
                </button>`).join('')}</div>
            ${list.length ? '' : '<div class="empty">Bu filtrede resim yok.</div>'}
            <div class="selbar">
                <div class="selbar-text">${sel.length} seçili${selBytes ? ' · ' + formatSize(selBytes) : ''}<br>
                    <button class="link-btn" data-act="all">${allVisSel ? 'Seçimi kaldır' : 'Tümünü seç'}</button>
                    ${sel.length > 1 ? ` · <button class="link-btn" data-act="zip" style="color:var(--mt)">${asZip ? 'ZIP olarak' : 'Tek tek'} ›</button>` : ''}</div>
                <button class="btn-ac" data-act="download" ${sel.length ? '' : 'disabled'}>${sel.length
                    ? `${sel.length} resmi indir${sel.length > 1 && asZip ? ' (ZIP)' : ''}` : 'Resim seçin'}</button>
            </div>`;
    }

    resultBox.addEventListener('click', (e) => {
        const btn = e.target.closest('[data-act]');
        if (!btn || btn.disabled) return;
        const act = btn.dataset.act;
        if (act === 'pick') {
            const url = btn.dataset.url;
            if (selected.has(url)) selected.delete(url); else selected.add(url);
        }
        if (act === 'type') typeFilter = btn.dataset.v;
        if (act === 'small') showSmall = !showSmall;
        if (act === 'zip') asZip = !asZip;
        if (act === 'all') {
            const list = visible();
            const allSel = list.every((it) => selected.has(it.url));
            list.forEach((it) => (allSel ? selected.delete(it.url) : selected.add(it.url)));
        }
        if (act === 'download') return download();
        render();
    });

    async function download() {
        const chosen = items.filter((it) => selected.has(it.url));
        if (!chosen.length) return;
        const mode = getPrefs().conn;
        const zip = chosen.length > 1 && asZip;
        const base = (pageTitle || 'resimler').replace(/[\\/:*?"<>|]+/g, '_').slice(0, 60).trim() || 'resimler';

        if (!zip) {
            // Her resim ayrı bir iş; kuyruk aynı anda kaç tanesinin ineceğini sınırlar.
            for (const it of chosen) {
                addJob({
                    name: it.name,
                    kind: 'image',
                    thumb: it.url,
                    run: (job) => fetchImage(job, it, mode, true)
                });
            }
            toast(`${chosen.length} resim sıraya eklendi · İndirmeler`);
            return;
        }

        const saveMode = effectiveSaveMode(getPrefs().save);
        let diskSink = null;
        try {
            if (saveMode === 'disk') diskSink = await createSink(`${base}.zip`, { mode: 'disk', mime: 'application/zip' });
        } catch (err) {
            if (err.name === 'AbortError') return;
        }
        addJob({
            name: `${base}.zip`,
            kind: 'zip',
            thumb: chosen[0].url,
            saveMode,
            run: async (job) => {
                const files = [];
                const names = new Set();
                let failed = 0;
                for (let i = 0; i < chosen.length; i++) {
                    if (job.signal.aborted) throw new DOMException('Aborted', 'AbortError');
                    job.progress(i, chosen.length);
                    job.detail = `${i}/${chosen.length} resim`;
                    try {
                        const data = await fetchImage(job, chosen[i], mode, false);
                        files.push({ name: uniqueName(chosen[i].name, names), data });
                    } catch (_) {
                        failed++;
                    }
                }
                if (!files.length) throw new Error('Resimler indirilemedi (site izin vermiyor olabilir; Ayarlar → Kendi sunucum)');
                const blob = createZip(files);
                const sink = diskSink || await createSink(job.name, { mode: saveMode, mime: 'application/zip' });
                await sink.write(blob);
                const result = await sink.close();
                if (result) job.attachResult(result);
                job.progress(chosen.length, chosen.length);
                job.done(`${files.length} resim · ${formatSize(blob.size)}${failed ? ` · ${failed} indirilemedi` : ''}`);
            }
        });
        toast('ZIP hazırlanıyor · İndirmeler');
    }

    return {
        /** Algıla ekranında bulunan resimlerle aç. */
        open(pageUrl, urls, title) {
            urlInput.value = pageUrl;
            scan(pageUrl, urls && urls.length ? urls : null, title || '');
        }
    };
}

/** Resmi indirir; `save` ise doğrudan kaydeder, değilse baytları döner (ZIP için). */
async function fetchImage(job, it, mode, save) {
    let res;
    try {
        // Önizleme sunucu üzerinden açıldıysa (ya da hiç açılmadıysa) indirme de oradan, sayfanın Referer'ıyla.
        const viaServer = it.src || (it.failed && proxyUrl(it.url, it.page));
        if (viaServer) {
            res = await fetch(viaServer, { signal: job.signal });
            if (!res.ok) throw new Error(`Sunucu ${res.status} döndü`);
        } else {
            res = await smartFetch(it.url, { mode, init: { signal: job.signal } });
        }
    } catch (err) {
        if (err.name === 'AbortError' || !save) throw err;
        // CORS'a kapalı ve sunucu yok: tarayıcı baytları okuyamaz; resim yine de görüntülenebilir.
        throw new Error('Site indirmeye izin vermiyor · resme basılı tutup kaydedin ya da kendi sunucunu ayarlayın');
    }
    const blob = await res.blob();
    job.addBytes(blob.size);
    if (!save) return new Uint8Array(await blob.arrayBuffer());
    const saveMode = job.saveMode;
    if (saveMode === 'downloads' || saveMode === 'disk') {
        saveBlob(blob, it.name);
        job.saved = true;
    }
    job.attachResult(blob);
    job.done(formatSize(blob.size));
    return null;
}

function uniqueName(name, used) {
    let candidate = name;
    let i = 1;
    while (used.has(candidate.toLowerCase())) {
        candidate = name.replace(/(\.[^.]+)?$/, `-${i++}$1`);
    }
    used.add(candidate.toLowerCase());
    return candidate;
}

function typeOf(url) {
    const ext = ((url.split('?')[0].split('#')[0].match(/\.([a-z0-9]{3,4})$/i) || [])[1] || '').toLowerCase();
    return { jpg: 'JPG', jpeg: 'JPG', png: 'PNG', webp: 'WEBP', gif: 'GIF', svg: 'SVG', avif: 'AVIF' }[ext] || 'IMG';
}

/**
 * Her resmi <img> ile yükleyip piksel boyutunu okur (CORS gerekmez); boyut bilgisi varsa alır.
 * Açılmayan resim (hotlink koruması vb.) kendi sunucun varsa sayfanın Referer'ıyla oradan denenir.
 */
function probeAll(list, pageUrl, onUpdate) {
    let cursor = 0;
    const worker = async () => {
        while (cursor < list.length) {
            const it = list[cursor++];
            let result = await probe(it, it.url);
            const viaServer = result === 'error' && proxyUrl(it.url, pageUrl);
            if (viaServer) {
                result = await probe(it, viaServer);
                if (result === 'ok') it.src = viaServer;
            }
            it.loaded = true;
            // Zaman aşımı "bozuk" sayılmaz: yavaş bağlantıda resim yine de gelir, boyutu bilinmez.
            it.failed = result === 'error';
            onUpdate();
        }
    };
    return Promise.all(Array.from({ length: Math.min(PROBE_PARALLEL, list.length) }, worker));
}

/** 'ok' | 'error' | 'timeout' */
function probe(it, src) {
    return new Promise((resolve) => {
        const img = new Image();
        img.referrerPolicy = 'no-referrer';
        const timer = setTimeout(() => finish('timeout'), PROBE_TIMEOUT_MS);
        function finish(result) {
            clearTimeout(timer);
            img.onload = img.onerror = null;
            if (result === 'ok') {
                it.w = img.naturalWidth;
                it.h = img.naturalHeight;
                // Sunucu Timing-Allow-Origin veriyorsa aktarılan boyut okunabilir.
                const entry = performance.getEntriesByName(src).pop();
                if (entry && entry.encodedBodySize) it.size = entry.encodedBodySize;
            }
            resolve(result);
        }
        img.onload = () => finish(img.naturalWidth > 0 ? 'ok' : 'error');
        img.onerror = () => finish('error');
        img.src = src;
    });
}
