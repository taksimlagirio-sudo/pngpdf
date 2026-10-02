// "Algıla" ekranı: adresteki içeriği tanır, seçenekleri gösterir ve indirmeyi/kaydı başlatır.
import { $, escapeHtml, isHttpUrl, formatSize, hms, getRenderServer } from './util.js';
import { analyzeUrl, formatDuration, describeMediaPlaylist } from './detect.js';
import { downloadFile } from './video.js';
import {
    downloadHlsVod, recordHlsLive, loadPlaylist, formatsFor, extFor, mimeFor, baseNameFor
} from './hls.js';
import {
    addJob, createSink, effectiveSaveMode, canSaveToDisk, canShareFiles, canBackgroundFetch,
    askNotificationPermission
} from './downloads.js';
import { getPrefs, setPref, SAVE_LABELS, CONN_LABELS } from './prefs.js';
import { canRemote, openRemoteView } from './remote.js';
import { canServerRecord, startServerRecording, startServerCapture } from './serverrec.js';

const KIND_TAG = { hls: 'HLS', video: 'MP4', audio: 'SES', dash: 'DASH', image: 'IMG' };
const KIND_LABEL = {
    video: 'Video', audio: 'Ses', image: 'Resim', hls: 'HLS', dash: 'DASH', document: 'Belge',
    archive: 'Arşiv', page: 'Web sayfası', unknown: 'Bilinmeyen tür'
};
const REC_LIMITS = [['Sınırsız', 0], ['30 dk', 1800], ['1 sa', 3600], ['2 sa', 7200], ['Özel', -1]];

export function initDetectTab({ navigate, toast, openImages }) {
    const urlInput = $('detectUrl');
    const analyzeBtn = $('detectBtn');
    const statusBox = $('detectStatus');
    const resultBox = $('detectResult');

    let info = null;      // analyzeUrl sonucu
    let ui = null;        // seçimler (kalite, format, ad, aralık, kayıt süresi)
    let previewUrl = null;
    let autoHops = 0;     // sayfadan medyaya otomatik geçişte sonsuz döngüyü engeller
    let remote = null;    // açık "kendim dokunayım" oturumu
    let seq = 0;          // eski analizlerin sonucu yenisinin üstüne yazılmasın

    analyzeBtn.addEventListener('click', () => onAnalyzeClick());
    urlInput.addEventListener('keydown', (e) => {
        if (e.key === 'Enter') onAnalyzeClick();
    });

    async function onAnalyzeClick() {
        let url = urlInput.value.trim();
        if (!url && navigator.clipboard && navigator.clipboard.readText) {
            try {
                url = (await navigator.clipboard.readText()).trim();
                urlInput.value = url;
            } catch (_) { /* pano izni yok */ }
        }
        analyze(url);
    }

    function setBusy(text) {
        statusBox.innerHTML = text ? `<div class="busy"><span class="spinner"></span><span>${escapeHtml(text)}</span></div>` : '';
    }

    function setError(text) {
        statusBox.innerHTML = `<div class="notice error">${escapeHtml(text)}</div>`;
    }

    async function analyze(url) {
        if (!isHttpUrl(url)) {
            setError('Geçerli bir http(s) adresi girin.');
            return;
        }
        const mySeq = ++seq;
        analyzeBtn.disabled = true;
        if (remote) {
            remote.close();
            remote = null;
        }
        resultBox.innerHTML = '';
        setBusy('Bağlanılıyor...');

        try {
            const result = await analyzeUrl(url, {
                mode: getPrefs().conn,
                onStage: (text) => mySeq === seq && setBusy(text)
            });
            if (mySeq !== seq) return;
            if (previewUrl) URL.revokeObjectURL(previewUrl);
            previewUrl = result.previewUrl || null;
            info = result;
            ui = initialUi(result);
            setBusy('');

            // Sayfada tek bir medya bulunduysa doğrudan onu analiz et.
            const links = result.details.links || [];
            if (result.target === 'page' && links.length === 1 && autoHops < 2) {
                autoHops++;
                return analyze(links[0].url);
            }
            autoHops = 0;
            render();
        } catch (err) {
            if (mySeq !== seq) return;
            console.error(err);
            setError(`Algılanamadı: ${err.message}`);
            if (canServerRecord()) {
                info = null;
                resultBox.innerHTML = captureHtml(true).replace('data-act="capture"', `data-act="capture" data-url="${escapeHtml(url)}"`);
            }
        } finally {
            if (mySeq === seq) analyzeBtn.disabled = false;
        }
    }

    function initialUi(result) {
        const d = result.details;
        return {
            variant: 0,
            format: 'mp4',
            name: result.target === 'hls' ? baseNameFor(result.url) : result.suggestedName.replace(/\.[a-z0-9]{1,5}$/i, ''),
            rangeOpen: false,
            rangeStart: '',
            rangeEnd: '',
            recLimit: 2,
            recCustomMin: 45,
            media: d.playlist ? d : null,
            loadingVariant: false
        };
    }

    /* ---------------- Çizim ---------------- */

    function render() {
        if (!info) return;
        if (info.target === 'page') return renderPage();
        if (info.target === 'hls' && ui.media && ui.media.live) return renderLive();
        return renderDownload();
    }

    function warningsHtml() {
        return info.warnings.map((w) => `<div class="notice">${escapeHtml(w)}</div>`).join('');
    }

    function thumbHtml(badge) {
        return `<span class="thumb">${info.previewUrl ? `<img src="${info.previewUrl}" alt="">` : ''}${
            badge ? `<span class="thumb-badge">${escapeHtml(badge)}</span>` : ''}</span>`;
    }

    function variantLabel(v) {
        if (v.resolution) return `${v.resolution.split('x')[1] || v.resolution}p`;
        return v.bandwidth ? `${Math.round(v.bandwidth / 1000)} kbps` : 'Kalite';
    }

    function rangeSeconds() {
        const start = parseTime(ui.rangeStart) || 0;
        const end = parseTime(ui.rangeEnd) || 0;
        return { start, end };
    }

    /** Tahmini dosya boyutu (bayt). */
    function estimate({ variant, seconds }) {
        if (info.target !== 'hls') return info.size || 0;
        if (ui.format === 'audio') return (128000 / 8) * seconds;
        const bw = variant ? variant.bandwidth : 0;
        return bw ? (bw / 8) * seconds : 0;
    }

    function currentVariant() {
        const variants = info.details.variants || [];
        return variants[ui.variant] || null;
    }

    function qualityHtml(compact = false) {
        const variants = info.details.variants || [];
        if (variants.length < 2) return '';
        const seconds = ui.media && !ui.media.live ? ui.media.duration : 3600;
        return `<div class="sec"><span class="sec-label">Kalite</span><div class="qcards">${variants.map((v, i) => {
            const size = estimate({ variant: v, seconds });
            const sub = ui.media && ui.media.live
                ? (v.bandwidth ? `${(v.bandwidth / 1e6).toLocaleString('tr-TR', { maximumFractionDigits: 1 })} Mbps` : '')
                : (size ? '~' + formatSize(size) : '');
            return `<button class="qcard${i === ui.variant ? ' on' : ''}" data-act="variant" data-i="${i}">
                <div class="qcard-label">${escapeHtml(variantLabel(v))}</div>${compact || !sub ? '' : `<div class="qcard-sub">${sub}</div>`}</button>`;
        }).join('')}</div>${ui.loadingVariant ? '<span class="sec-hint">Kalite bilgisi okunuyor...</span>' : ''}</div>`;
    }

    function formatHtml() {
        if (info.target !== 'hls' || !ui.media) return '';
        const options = formatsFor(ui.media.fmp4);
        if (!options.some((o) => o.id === ui.format)) ui.format = options[0].id;
        if (options.length < 2) return '';
        const hint = options.find((o) => o.id === ui.format).hint;
        return `<div class="sec"><span class="sec-label">Format</span><div class="seg">${options.map((o) =>
            `<button class="${o.id === ui.format ? 'on' : ''}" data-act="format" data-v="${o.id}">${o.label}</button>`).join('')}</div>
            <span class="sec-hint">${escapeHtml(hint)}</span></div>`;
    }

    function currentExt() {
        if (info.target === 'hls') return '.' + extFor(ui.format, ui.media ? ui.media.fmp4 : false);
        return '.' + (info.suggestedName.split('.').pop() || info.ext || 'bin');
    }

    function optionRows({ background = true } = {}) {
        const prefs = getPrefs();
        const save = effectiveSaveMode(prefs.save);
        const bgSupported = canBackgroundFetch && save !== 'disk';
        return `
            <div class="rows">
                <label class="row"><span class="row-label">Ad</span>
                    <input value="${escapeHtml(ui.name)}" data-input="name" spellcheck="false">
                    <span class="row-ext">${escapeHtml(currentExt())}</span></label>
                <button class="row" data-act="cycle-save"><span class="row-label">Kaydet</span>
                    <span class="row-value">${SAVE_LABELS[save]}</span><span class="row-chev">›</span></button>
                <button class="row" data-act="cycle-conn"><span class="row-label">Bağlantı</span>
                    <span class="row-value">${CONN_LABELS[prefs.conn]}</span><span class="row-chev">›</span></button>
                ${background ? `<button class="row${bgSupported ? '' : ' disabled'}" data-act="toggle-bg" ${bgSupported ? '' : 'disabled title="Bu tarayıcıda/kaydetme yönteminde desteklenmiyor"'}>
                    <span class="row-value">Arka planda indir</span>
                    <span class="toggle${prefs.background && bgSupported ? ' on' : ''}"></span></button>` : ''}
            </div>`;
    }

    function rangeHtml() {
        if (info.target !== 'hls' || !ui.media || ui.media.live) return '';
        const total = ui.media.duration;
        if (!ui.rangeOpen) {
            return `<button class="row" style="border:1px solid var(--ln);border-radius:14px" data-act="range-open">
                <span class="row-label">Aralık</span><span class="row-value">Tamamı · ${hms(total)}</span><span class="row-chev">›</span></button>`;
        }
        const { start, end } = rangeSeconds();
        const len = Math.max(0, (end || total) - start);
        return `<div class="sec"><span class="sec-label">Aralık (başlangıç – bitiş)</span>
            <div class="range-inputs">
                <input data-input="rangeStart" value="${escapeHtml(ui.rangeStart)}" placeholder="00:00:00" inputmode="numeric">
                <span class="muted">–</span>
                <input data-input="rangeEnd" value="${escapeHtml(ui.rangeEnd)}" placeholder="${hms(total)}" inputmode="numeric">
                <button class="btn-ghost" data-act="range-close" style="flex:none">Tamamı</button>
            </div>
            <span class="sec-hint" data-range-hint>${hms(len)} indirilecek · yayın ${hms(total)}</span></div>`;
    }

    function metaLine() {
        const d = info.details;
        const bits = [];
        if (info.target === 'hls') {
            bits.push(d.live ? 'HLS canlı' : 'HLS');
            if (d.container) bits.push(d.container);
            if (d.segments) bits.push(`${d.segments} parça`);
            bits.push(d.encryption ? (d.drm ? `DRM (${d.drm})` : 'AES-128 şifreli') : 'şifresiz');
        } else {
            bits.push(KIND_LABEL[info.kind] || info.kind);
            bits.push(String(info.format).toUpperCase());
            if (d.width) bits.push(`${d.width}×${d.height}`);
            if (info.size) bits.push(formatSize(info.size));
            if (info.resumable && info.kind !== 'image') bits.push('parçalı indirme destekleniyor');
        }
        return bits.join(' · ');
    }

    function downloadSize() {
        if (info.target !== 'hls') return info.size || 0;
        if (!ui.media) return 0;
        const { start, end } = rangeSeconds();
        const seconds = ui.rangeOpen ? Math.max(0, Math.min(end || ui.media.duration, ui.media.duration) - start) : ui.media.duration;
        return estimate({ variant: currentVariant(), seconds });
    }

    function renderDownload() {
        const d = info.details;
        const duration = d.duration ? hms(d.duration) : '';
        let body = '';
        if (info.downloadable) {
            const size = downloadSize();
            body = `
                <div class="card-pad">
                    ${qualityHtml()}
                    ${formatHtml()}
                    ${rangeHtml()}
                    ${optionRows()}
                    <div class="dl-actions">
                        <button class="btn-big" data-act="download">İndir${size ? ' · ~' + formatSize(size) : ''}</button>
                        <button class="btn-ghost" data-act="queue" title="Sıraya ekle">Sıraya ekle</button>
                    </div>
                </div>`;
        }
        resultBox.innerHTML = `
            <div class="card">
                <div class="res-head">
                    ${thumbHtml(duration)}
                    <div style="flex:1;min-width:0">
                        <div class="res-title">${escapeHtml(ui.name || info.suggestedName)}</div>
                        <div class="res-meta">${escapeHtml(metaLine())}</div>
                        <div class="res-url">${escapeHtml(info.url)}</div>
                    </div>
                </div>
                ${body}
            </div>
            ${warningsHtml()}`;
    }

    function recLimitSeconds() {
        const [, value] = REC_LIMITS[ui.recLimit];
        if (value === -1) return Math.max(1, Number(ui.recCustomMin) || 0) * 60;
        return value;
    }

    function recLimitLabel() {
        const [label, value] = REC_LIMITS[ui.recLimit];
        return value === -1 ? `${Number(ui.recCustomMin) || 0} dk` : label;
    }

    function recHintText() {
        const limit = recLimitSeconds();
        const bw = currentVariant() ? currentVariant().bandwidth : 0;
        const perHour = ui.format === 'audio' ? 128000 / 8 * 3600 : bw / 8 * 3600;
        return limit
            ? `${recLimitLabel()} sonra kayıt kendiliğinden durur ve kaydedilir${perHour ? ' · ~' + formatSize(perHour * limit / 3600) : ''}`
            : `Siz durdurana kadar kaydeder${perHour ? ' · saatte ~' + formatSize(perHour) : ''}`;
    }

    function renderLive() {
        const d = info.details;
        const prefs = getPrefs();
        const hint = recHintText();
        const server = canServerRecord();
        const where = server ? prefs.recWhere : 'device';
        const segLen = d.targetDuration ? `${d.targetDuration} sn parçalar` : '';

        resultBox.innerHTML = `
            <div class="live-preview">
                ${info.previewUrl ? `<img src="${info.previewUrl}" alt="">` : '<span class="mono muted" style="font-size:12px">canlı yayın</span>'}
                <span class="live-badge">CANLI</span>
                ${segLen ? `<span class="live-corner">${segLen}</span>` : ''}
            </div>
            <div>
                <div class="live-title">${escapeHtml(ui.name)}</div>
                <div class="res-meta">${escapeHtml(metaLine())}</div>
            </div>
            ${info.downloadable ? `
            <div class="sec"><span class="sec-label">Kayıt süresi</span>
                <div class="seg seg-tight">${REC_LIMITS.map(([label], i) =>
                    `<button class="${i === ui.recLimit ? 'on' : ''}" data-act="rec-limit" data-i="${i}">${label}</button>`).join('')}</div>
                ${REC_LIMITS[ui.recLimit][1] === -1 ? `<div class="range-inputs"><input data-input="recCustomMin" value="${escapeHtml(String(ui.recCustomMin))}" inputmode="numeric" style="max-width:110px"><span class="muted">dakika</span></div>` : ''}
                <span class="sec-hint" data-rec-hint>${escapeHtml(hint)}</span></div>
            ${qualityHtml(true)}
            ${formatHtml()}
            ${server ? `<div class="sec"><span class="sec-label">Nerede kaydedilsin</span>
                <div class="seg">
                    <button class="${where === 'server' ? 'on' : ''}" data-act="rec-where" data-v="server">Sunucumda</button>
                    <button class="${where === 'device' ? 'on' : ''}" data-act="rec-where" data-v="device">Bu cihazda</button>
                </div>
                <span class="sec-hint">${where === 'server'
                    ? 'Kayıt kendi sunucunda sürer: telefonu kilitlesen, uygulamayı kapatsan da durmaz. Bitince buradan indirirsin.'
                    : 'Kayıt bu tarayıcıda yapılır; uygulama açık kalmalı.'}</span></div>` : ''}
            ${where === 'device' ? `
            <button class="toggle-row" data-act="toggle-awake">
                <div style="flex:1"><div class="toggle-row-title">Ekran kapansa da sürdür</div>
                <div class="toggle-row-sub">Ekran kilidi tutulur · diğer indirmelerle aynı anda${server ? '' : ' · uzun kayıtlarda kendi sunucun daha güvenli'}</div></div>
                <span class="toggle${prefs.keepAwake ? ' on' : ''}"></span>
            </button>
            ${optionRows({ background: false })}` : `
            <div class="rows"><label class="row"><span class="row-label">Ad</span>
                <input value="${escapeHtml(ui.name)}" data-input="name" spellcheck="false">
                <span class="row-ext">${escapeHtml(currentExt())}</span></label></div>`}
            <button class="btn-rec" data-act="record">Kaydı şimdi başlat</button>` : ''}
            ${warningsHtml()}`;
    }

    function renderPage() {
        const d = info.details;
        const links = d.links || [];
        const images = d.images || [];
        const embeds = d.embeds || [];
        const counts = [];
        if (links.length) counts.push(`${links.length} medya`);
        if (images.length) counts.push(`${images.length} resim`);
        const source = d.fromRender ? ' (sunucunda çalıştırılarak)' : d.fromScripts ? ' (script dosyalarında)' : '';

        const rows = links.map((l) => `
            <button class="media-row" data-act="analyze-link" data-url="${escapeHtml(l.url)}">
                <span class="tag">${KIND_TAG[l.kind] || 'DOSYA'}</span>
                <span class="media-url">${escapeHtml(shortUrl(l.url))}</span>
                <span class="media-col">${l.size ? formatSize(l.size) : '—'}</span>
                <span class="media-act accent">Aç ›</span>
            </button>`).join('');

        const exts = [...new Set(images.map((u) => (u.split('?')[0].match(/\.([a-z0-9]{3,4})$/i) || [])[1]).filter(Boolean)
            .map((e) => e.toLowerCase()))].slice(0, 4);
        const imageRow = images.length ? `
            <button class="media-row images" data-act="images">
                <span class="tag">IMG</span>
                <span class="img-peek">${images.slice(0, 2).map((u) =>
                    `<span class="thumb"><img src="${escapeHtml(u)}" alt="" loading="lazy" referrerpolicy="no-referrer"></span>`).join('')}
                    <span class="img-peek-text">${images.length > 2 ? '+' + (images.length - 2) : ''}${exts.length ? ' · ' + exts.join(', ') : ''}</span></span>
                <span class="media-col">${images.length} resim</span>
                <span class="media-act accent">Resimleri gör ›</span>
            </button>` : '';

        const foot = embeds.map((e) => `<div class="media-foot">Gömülü oynatıcı: <button data-act="analyze-link" data-url="${escapeHtml(e.url)}">${escapeHtml(e.host)}</button> — içini taramak için dokunun</div>`).join('');
        const table = rows || imageRow || foot ? `
            <div class="card media-table">
                <div class="media-head"><span>Tür</span><span>Adres</span><span>Boyut</span><span></span></div>
                ${rows}${imageRow}${foot}
            </div>` : '';

        resultBox.innerHTML = `
            <div>
                <div class="page-title">${escapeHtml(d.title || shortUrl(info.url))}</div>
                <div class="res-meta">Web sayfası${counts.length ? ' · ' + counts.join(', ') : ''}${source}</div>
            </div>
            ${table}
            ${warningsHtml()}
            ${captureHtml(!links.length)}
            ${canRemote() ? `<button class="btn-ghost" data-act="remote" style="height:46px">Sayfayı aç, kendim dokunayım</button>` : ''}
            <div class="remote-slot"></div>`;
    }

    /** İnmeyen videolar için: sunucuda hızlandırılmış oynatıp kaydet. */
    function captureHtml(primary) {
        if (!canServerRecord()) return '';
        return `<div class="card card-pad" style="gap:10px">
            <div><div class="toggle-row-title">İnmiyor mu? Sunucuda oynatıp kaydet</div>
            <div class="toggle-row-sub">Sayfa sunucunda açılır, video sessizce ve hızlandırılmış oynatılıp kaydedilir.
                Sen yalnızca sürenin dolduğunu görürsün; dosya normal hızda, orijinal kalitede çıkar.</div></div>
            <button class="${primary ? 'btn-rec' : 'btn-ghost'}" data-act="capture" ${primary ? '' : 'style="height:46px"'}>Sunucuda kaydet</button>
        </div>`;
    }

    /* ---------------- Etkileşim ---------------- */

    // Yazarken yeniden çizilmez (klavye kapanmasın, odak kaybolmasın); yalnızca metinler tazelenir.
    resultBox.addEventListener('input', (e) => {
        const key = e.target.dataset.input;
        if (!key || !ui) return;
        ui[key] = e.target.value;
        const title = resultBox.querySelector('.res-title, .live-title');
        if (title && key === 'name') title.textContent = ui.name;
        refreshTexts();
    });

    function refreshTexts() {
        const rangeHint = resultBox.querySelector('[data-range-hint]');
        if (rangeHint && ui.media) {
            const { start, end } = rangeSeconds();
            rangeHint.textContent = `${hms(Math.max(0, (end || ui.media.duration) - start))} indirilecek · yayın ${hms(ui.media.duration)}`;
        }
        const dlBtn = resultBox.querySelector('[data-act="download"]');
        if (dlBtn) {
            const size = downloadSize();
            dlBtn.textContent = `İndir${size ? ' · ~' + formatSize(size) : ''}`;
        }
        const recHint = resultBox.querySelector('[data-rec-hint]');
        if (recHint) recHint.textContent = recHintText();
    }

    resultBox.addEventListener('click', async (e) => {
        const btn = e.target.closest('[data-act]');
        if (!btn || btn.disabled) return;
        const act = btn.dataset.act;
        const prefs = getPrefs();

        if (act === 'analyze-link') return analyze(btn.dataset.url);
        if (act === 'images') return openImages(info.url, info.details.images || [], info.details.title);
        if (act === 'remote') {
            btn.classList.add('hidden');
            const slot = resultBox.querySelector('.remote-slot');
            remote = openRemoteView(slot, info.url, { onPick: (url) => analyze(url), shortUrl });
            slot.scrollIntoView({ block: 'start', behavior: 'smooth' });
            return;
        }
        if (act === 'variant') return pickVariant(Number(btn.dataset.i));
        if (act === 'format') ui.format = btn.dataset.v;
        if (act === 'range-open') ui.rangeOpen = true;
        if (act === 'range-close') {
            ui.rangeOpen = false;
            ui.rangeStart = ui.rangeEnd = '';
        }
        if (act === 'rec-limit') ui.recLimit = Number(btn.dataset.i);
        if (act === 'rec-where') setPref('recWhere', btn.dataset.v);
        if (act === 'toggle-awake') setPref('keepAwake', !prefs.keepAwake);
        if (act === 'cycle-save') setPref('save', nextSaveMode(prefs.save));
        if (act === 'cycle-conn') setPref('conn', nextConn(prefs.conn));
        if (act === 'toggle-bg') setPref('background', !prefs.background);
        if (act === 'download') return startDownload(false);
        if (act === 'queue') return startDownload(true);
        if (act === 'record') return startRecording();
        if (act === 'capture') return startCapture(btn.dataset.url || info.url);
        render();
    });

    async function pickVariant(index) {
        ui.variant = index;
        const variant = currentVariant();
        ui.loadingVariant = true;
        render();
        try {
            const playlist = await loadPlaylist(variant.url, { mode: getPrefs().conn });
            ui.media = describeMediaPlaylist(playlist);
        } catch (err) {
            toast(`Kalite okunamadı: ${err.message}`);
        } finally {
            ui.loadingVariant = false;
            render();
        }
    }

    /** "Konum seç" yönteminde dosya konumu hemen (dokunuş geçerliyken) sorulur. */
    async function prepareSink(fileName, mime) {
        const saveMode = effectiveSaveMode(getPrefs().save);
        let diskSink = null;
        if (saveMode === 'disk') diskSink = await createSink(fileName, { mode: 'disk', mime });
        return {
            saveMode,
            createSinkFor: (name, type) => diskSink ? Promise.resolve(diskSink) : createSink(name, { mode: saveMode, mime: type })
        };
    }

    function cleanName() {
        return (ui.name || 'indirilen').replace(/[\\/:*?"<>|]+/g, '_').trim().slice(0, 120) || 'indirilen';
    }

    async function startDownload(queueOnly) {
        const prefs = getPrefs();
        const isHls = info.target === 'hls';
        const name = cleanName();
        try {
            if (isHls) {
                if (!ui.media) throw new Error('Yayın bilgisi okunamadı');
                const variant = currentVariant();
                const url = variant ? variant.url : info.url;
                const isFmp4 = ui.media.fmp4;
                const ext = extFor(ui.format, isFmp4);
                const { saveMode, createSinkFor } = await prepareSink(`${name}.${ext}`, mimeFor(ext));
                const range = ui.rangeOpen ? rangeSeconds() : null;
                const playlist = ui.media.playlist;
                const format = ui.format;
                addJob({
                    name: `${name}.${ext}`,
                    kind: 'hls',
                    thumb: info.previewUrl || null,
                    now: false,
                    saveMode,
                    run: (job) => downloadHlsVod({
                        job, url, playlist, name, format, range, mode: prefs.conn,
                        background: prefs.background, createSinkFor
                    })
                });
            } else {
                const ext = currentExt();
                const fileName = name + ext;
                const { saveMode, createSinkFor } = await prepareSink(fileName, info.mime);
                const url = info.url;
                addJob({
                    name: fileName,
                    kind: ['video', 'audio', 'image'].includes(info.kind) ? info.kind : 'file',
                    thumb: info.previewUrl || null,
                    saveMode,
                    run: (job) => downloadFile({
                        job, url, name: fileName, mode: prefs.conn, background: prefs.background,
                        mime: info.mime, size: info.size, createSinkFor
                    })
                });
            }
            toast(queueOnly ? 'Sıraya eklendi · İndirmeler' : 'İndirme başladı · İndirmeler');
            // Önizleme adresi artık işin küçük resmi; yeni analizde silinmesin.
            previewUrl = null;
        } catch (err) {
            if (err.name !== 'AbortError') setError(err.message);
        }
    }

    async function startRecording() {
        const prefs = getPrefs();
        const variant = currentVariant();
        const url = variant ? variant.url : info.url;
        const name = cleanName();
        const limitSec = recLimitSeconds();
        const quality = variant ? variantLabel(variant) : '';
        askNotificationPermission();

        try {
            if (canServerRecord() && prefs.recWhere === 'server') {
                await startServerRecording({
                    url, name, format: ui.format, limitSec, limitLabel: recLimitLabel(), quality,
                    thumb: info.previewUrl || null
                });
            } else {
                const ext = extFor(ui.format, ui.media.fmp4);
                const { saveMode, createSinkFor } = await prepareSink(`${name}.${ext}`, mimeFor(ext));
                const format = ui.format;
                addJob({
                    name: `${name}.${ext}`,
                    kind: 'rec',
                    thumb: info.previewUrl || null,
                    now: true, // kayıt sıra beklemez; yayın kaçmasın
                    saveMode,
                    run: (job) => recordHlsLive({
                        job, url, name, format, limitSec, limitLabel: recLimitLabel(), quality,
                        mode: prefs.conn, createSinkFor
                    })
                });
            }
            previewUrl = null;
            navigate('downloads');
        } catch (err) {
            if (err.name !== 'AbortError') setError(`Kayıt başlatılamadı: ${err.message}`);
        }
    }

    async function startCapture(url) {
        let name = 'video';
        if (info && info.url === url && info.details && info.details.title) name = info.details.title;
        else name = baseNameFor(url);
        name = name.replace(/[\\/:*?"<>|]+/g, '_').trim().slice(0, 80) || 'video';
        askNotificationPermission();
        try {
            await startServerCapture({ url, name, thumb: null });
            navigate('downloads');
        } catch (err) {
            setError(`Sunucuda kayıt başlatılamadı: ${err.message}`);
        }
    }

    function nextSaveMode(current) {
        const order = ['downloads', 'gallery', 'disk'].filter((m) =>
            m === 'downloads' || (m === 'gallery' && canShareFiles) || (m === 'disk' && canSaveToDisk));
        return order[(order.indexOf(effectiveSaveMode(current)) + 1) % order.length];
    }

    function nextConn(current) {
        const order = getRenderServer() ? ['auto', 'direct', 'proxy'] : ['auto', 'direct'];
        return order[(order.indexOf(current) + 1) % order.length] || 'auto';
    }

    return {
        prefill(url, autoStart) {
            urlInput.value = url;
            if (autoStart) analyze(url);
        },
        analyze(url) {
            urlInput.value = url;
            analyze(url);
        },
        refresh: render
    };
}

/** "1:02:03", "12:30", "90" → saniye. */
export function parseTime(text) {
    const value = String(text || '').trim();
    if (!value) return 0;
    const parts = value.split(':').map((p) => Number(p.replace(',', '.')));
    if (parts.some((n) => !isFinite(n) || n < 0)) return 0;
    return parts.reduce((total, n) => total * 60 + n, 0);
}

/** Uzun adresleri listede okunur kısaltır. */
export function shortUrl(url) {
    try {
        const { hostname, pathname } = new URL(url);
        const file = pathname.split('/').filter(Boolean).pop() || pathname;
        return `${hostname}/…/${decodeURIComponent(file).slice(0, 48)}`;
    } catch (_) {
        return url.slice(0, 70);
    }
}

export { formatDuration };
