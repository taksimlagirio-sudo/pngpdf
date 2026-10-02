// "Algıla" ekranı: adresteki içeriği tanır, önizlemesini oynatır, seçenekleri gösterir ve
// indirmeyi/kaydı başlatır.
import { $, escapeHtml, isHttpUrl, formatSize, hms, getRenderServer } from './util.js';
import { analyzeUrl, formatDuration, describeMediaPlaylist } from './detect.js';
import { downloadFile } from './video.js';
import { downloadHlsVod, recordHlsLive, loadPlaylist, audioFor, baseNameFor } from './hls.js';
import {
    addJob, createSink, effectiveSaveMode, canSaveToDisk, canShareFiles, canBackgroundFetch,
    askNotificationPermission
} from './downloads.js';
import { getPrefs, setPref, SAVE_LABELS, CONN_LABELS } from './prefs.js';
import { canRemote, openRemoteView } from './remote.js';
import { canServerRecord, startServerRecording, captureIntoJob } from './serverrec.js';
import { attachPreview, grabFrame, probePreview } from './preview.js';

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
    const previewBox = $('detectPreview');
    const resultBox = $('detectResult');

    let info = null;      // analyzeUrl sonucu
    let ui = null;        // seçimler (kalite, ad, aralık, kayıt süresi)
    let autoHops = 0;     // sayfadan medyaya otomatik geçişte sonsuz döngüyü engeller
    let remote = null;    // açık "kendim dokunayım" oturumu
    let preview = null;   // açık önizleme oynatıcısı
    let seq = 0;          // eski analizlerin sonucu yenisinin üstüne yazılmasın
    const thumbs = new Map(); // sayfa listesi: adres → {ok, thumb, duration, height}

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

    function closePreview() {
        if (preview) preview.destroy();
        preview = null;
        previewBox.innerHTML = '';
    }

    /**
     * `pair`: sayfada ayrı bulunan ses playlist'i (görüntüyle birleştirilecek).
     * `page`: bağlantının bulunduğu sayfa — bağlantı inmezse video o sayfayla açılıp kaydedilir.
     */
    async function analyze(url, { pair = null, page = null } = {}) {
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
        closePreview();
        resultBox.innerHTML = '';
        setBusy('Bağlanılıyor...');

        try {
            const result = await analyzeUrl(url, {
                mode: getPrefs().conn,
                onStage: (text) => mySeq === seq && setBusy(text)
            });
            if (mySeq !== seq) return;
            info = result;
            ui = initialUi(result, pair);
            ui.sourcePage = page;
            setBusy('');

            // Sayfada tek bir video bulunduysa doğrudan onu aç.
            const links = result.details.links || [];
            if (result.target === 'page' && links.length === 1 && autoHops < 2) {
                autoHops++;
                return analyze(links[0].url, { pair: links[0].audioUrl || null, page: result.url });
            }
            autoHops = 0;
            render();
            showPreview();
            if (result.target === 'page') probeLinks(mySeq);
        } catch (err) {
            if (mySeq !== seq) return;
            console.error(err);
            autoHops = 0;
            // Video bağlantısı açılmıyor (403, oturum vb.): yine de kart gösterilir; İndir'e basınca
            // video açılıp kaydedilir.
            if (page || err.mediaLike || /\.(m3u8|mp4|m4v|webm|mov|mkv|ts)(\?|$)/i.test(url)) {
                setBusy('');
                info = unreachableInfo(url, err);
                ui = initialUi(info, pair);
                ui.sourcePage = page;
                render();
                return;
            }
            setError(`Algılanamadı: ${err.message}`);
            if (canServerRecord()) {
                info = null;
                resultBox.innerHTML = captureHtml(true).replace('data-act="capture"', `data-act="capture" data-url="${escapeHtml(url)}"`);
            }
        } finally {
            if (mySeq === seq) analyzeBtn.disabled = false;
        }
    }

    function unreachableInfo(url, err) {
        const isHls = err.mediaKind ? err.mediaKind === 'hls' : /\.m3u8(\?|$)/i.test(url);
        return {
            url,
            kind: isHls ? 'hls' : 'video',
            format: isHls ? 'm3u8' : 'mp4',
            mime: 'video/mp4',
            ext: 'mp4',
            size: 0,
            target: 'file',
            suggestedName: baseNameFor(url).replace(/\.[a-z0-9]{2,5}$/i, '') + '.mp4',
            downloadable: true,
            unreachable: true,
            access: 'direct',
            warnings: [canServerRecord()
                ? `Bağlantı açılmıyor (${shortError(err)}). İndir'e basınca video açılıp kaydedilir.`
                : `Bağlantı açılmıyor (${shortError(err)}). Videoyu açıp kaydetmek için Ayarlar → Kendi sunucum ayarlı olmalı.`],
            details: {}
        };
    }

    function initialUi(result, pair) {
        const d = result.details;
        return {
            variant: 0,
            name: result.target === 'hls' ? baseNameFor(result.url) : result.suggestedName.replace(/\.[a-z0-9]{1,5}$/i, ''),
            rangeOpen: false,
            rangeStart: '',
            rangeEnd: '',
            recLimit: 2,
            recCustomMin: 45,
            media: d.playlist ? d : null,
            audioUrl: d.audioUrl || pair || null,
            loadingVariant: false,
            showHidden: false
        };
    }

    /* ---------------- Önizleme ---------------- */

    /** Video/yayın için oynatılabilir önizleme; tek seferlik kurulur, seçimler değişince bozulmaz. */
    async function showPreview() {
        closePreview();
        if (!info || info.unreachable || !['hls', 'file'].includes(info.target) || !['hls', 'video'].includes(info.kind)) return;
        if (info.kind === 'hls' && info.details.audioOnly) return;
        const live = info.target === 'hls' && ui.media && ui.media.live;
        previewBox.innerHTML = `
            <div class="live-preview">
                <video controls muted playsinline preload="metadata"></video>
                ${live ? '<span class="live-badge">CANLI</span>' : ''}
                <span class="preview-msg mono muted hidden"></span>
            </div>`;
        const video = previewBox.querySelector('video');
        const msg = previewBox.querySelector('.preview-msg');
        const showMsg = (text) => {
            msg.textContent = text;
            msg.classList.remove('hidden');
        };
        const mySeq = seq;
        try {
            const p = await attachPreview(video, info.url, {
                kind: info.kind,
                proxied: info.access === 'proxy',
                onError: () => showMsg('Önizleme bu tarayıcıda oynatılamıyor; indirme yine de çalışır.')
            });
            if (mySeq !== seq) return p.destroy();
            preview = p;
            const variant = currentVariant();
            if (variant) video.addEventListener('loadedmetadata', () => preview && preview.selectQuality(variant.url), { once: true });
        } catch (err) {
            showMsg(err.message);
        }
    }

    /** İndirme kartındaki küçük resim için önizlemeden o anki kare. */
    async function currentThumb() {
        const video = previewBox.querySelector('video');
        return (video && await grabFrame(video)) || info.previewUrl || null;
    }

    /** Sayfa listesindeki her bağlantı için arka planda kare + süre alınır. */
    async function probeLinks(mySeq) {
        const links = (info.details.links || []).slice(0, 8);
        for (const link of links) {
            if (mySeq !== seq) return;
            if (thumbs.has(link.url)) continue;
            if (link.unreachable) {
                thumbs.set(link.url, { ok: false }); // doğrudan oynatılamaz; kaydedilerek indirilir
                continue;
            }
            const result = await probePreview(link.url, { kind: link.kind, proxied: false });
            if (!result.ok && getRenderServer()) {
                Object.assign(result, await probePreview(link.url, { kind: link.kind, proxied: true }));
            }
            thumbs.set(link.url, result);
            if (mySeq === seq && info && info.target === 'page') render();
        }
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

    function variantLabel(v) {
        if (v.height) return `${v.height}p`;
        if (v.resolution) return v.resolution;
        return v.bandwidth ? `${Math.round(v.bandwidth / 1000)} kbps` : 'Kalite';
    }

    function rangeSeconds() {
        return { start: parseTime(ui.rangeStart) || 0, end: parseTime(ui.rangeEnd) || 0 };
    }

    /** Tahmini dosya boyutu (bayt): kalitenin bit hızı × süre. */
    function estimate(variant, seconds) {
        return variant && variant.bandwidth ? (variant.bandwidth / 8) * seconds : 0;
    }

    function currentVariant() {
        const variants = info.details.variants || [];
        return variants[ui.variant] || null;
    }

    function qualityHtml() {
        const variants = info.details.variants || [];
        if (!variants.length) return '';
        const live = ui.media && ui.media.live;
        const seconds = ui.media && !live ? ui.media.duration : 0;
        return `<div class="sec"><span class="sec-label">Kalite</span><div class="qcards">${variants.map((v, i) => {
            const size = estimate(v, seconds);
            const sub = live
                ? (v.bandwidth ? `${(v.bandwidth / 1e6).toLocaleString('tr-TR', { maximumFractionDigits: 1 })} Mbps` : '')
                : (size ? '~' + formatSize(size) : '');
            return `<button class="qcard${i === ui.variant ? ' on' : ''}" data-act="variant" data-i="${i}">
                <div class="qcard-label">${escapeHtml(variantLabel(v))}</div>${sub ? `<div class="qcard-sub">${sub}</div>` : ''}</button>`;
        }).join('')}</div>${ui.loadingVariant ? '<span class="sec-hint">Kalite bilgisi okunuyor...</span>' : ''}</div>`;
    }

    function currentExt() {
        if (info.unreachable) return '.mp4';
        if (info.target === 'hls') return info.details.audioOnly ? '.m4a' : '.mp4';
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
        if (info.unreachable) return `${info.kind === 'hls' ? 'Yayın' : 'Video'} · bağlantı doğrudan açılmıyor`;
        if (info.target === 'hls') {
            bits.push(d.live ? 'Canlı yayın' : 'Video');
            if (d.duration && !d.live) bits.push(hms(d.duration));
            const v = currentVariant();
            if (v && v.resolution) bits.push(v.resolution.replace('x', '×'));
            if (d.audioOnly) bits.push('yalnızca ses');
            else if (ui.audioUrl) bits.push('ses ayrı · birleştirilecek');
            if (d.encryption) bits.push(d.drm ? `DRM (${d.drm})` : 'AES-128 şifreli');
        } else {
            bits.push(KIND_LABEL[info.kind] || info.kind);
            bits.push(String(info.format).toUpperCase());
            if (d.width) bits.push(`${d.width}×${d.height}`);
            if (info.size) bits.push(formatSize(info.size));
        }
        return bits.join(' · ');
    }

    function downloadSize() {
        if (info.target !== 'hls') return info.size || 0;
        if (!ui.media) return 0;
        const { start, end } = rangeSeconds();
        const seconds = ui.rangeOpen ? Math.max(0, Math.min(end || ui.media.duration, ui.media.duration) - start) : ui.media.duration;
        return estimate(currentVariant(), seconds);
    }

    function renderDownload() {
        const isHls = info.target === 'hls';
        let body = '';
        if (info.downloadable) {
            const size = downloadSize();
            body = `
                <div class="card-pad">
                    ${qualityHtml()}
                    ${rangeHtml()}
                    ${info.unreachable ? `<label class="field"><span class="field-label">Videonun bulunduğu sayfa (isteğe bağlı) —
                        verirsen o sayfanın çerez/oturumuyla denenir</span>
                        <input class="input" type="url" data-input="sourcePage" value="${escapeHtml(ui.sourcePage || '')}"
                            placeholder="https://site.com/video-sayfasi" autocomplete="off"></label>` : ''}
                    ${optionRows({ background: !isHls && !info.unreachable })}
                    <div class="dl-actions">
                        <button class="btn-big" data-act="download">İndir${size ? ' · ~' + formatSize(size) : ''}</button>
                        <button class="btn-ghost" data-act="queue" title="Sıraya ekle">Sıraya ekle</button>
                    </div>
                </div>`;
        }
        const thumb = !previewBox.innerHTML && info.previewUrl
            ? `<span class="thumb" style="width:96px;height:60px"><img src="${info.previewUrl}" alt=""></span>` : '';
        resultBox.innerHTML = `
            <div class="card">
                <div class="res-head">
                    ${thumb}
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
        const v = currentVariant();
        const perHour = v && v.bandwidth ? v.bandwidth / 8 * 3600 : 0;
        return limit
            ? `${recLimitLabel()} sonra kayıt kendiliğinden durur ve kaydedilir${perHour ? ' · ~' + formatSize(perHour * limit / 3600) : ''}`
            : `Siz durdurana kadar kaydeder${perHour ? ' · saatte ~' + formatSize(perHour) : ''}`;
    }

    function renderLive() {
        const prefs = getPrefs();
        const server = canServerRecord();
        const where = server ? prefs.recWhere : 'device';

        resultBox.innerHTML = `
            <div>
                <div class="live-title">${escapeHtml(ui.name)}</div>
                <div class="res-meta">${escapeHtml(metaLine())}</div>
            </div>
            ${info.downloadable ? `
            <div class="sec"><span class="sec-label">Kayıt süresi</span>
                <div class="seg seg-tight">${REC_LIMITS.map(([label], i) =>
                    `<button class="${i === ui.recLimit ? 'on' : ''}" data-act="rec-limit" data-i="${i}">${label}</button>`).join('')}</div>
                ${REC_LIMITS[ui.recLimit][1] === -1 ? `<div class="range-inputs"><input data-input="recCustomMin" value="${escapeHtml(String(ui.recCustomMin))}" inputmode="numeric" style="max-width:110px"><span class="muted">dakika</span></div>` : ''}
                <span class="sec-hint" data-rec-hint>${escapeHtml(recHintText())}</span>
                <span class="sec-hint">Dosya kaydın başladığı andan (0:00) başlar ve ileri-geri sarılabilir.</span></div>
            ${qualityHtml()}
            ${server ? `<div class="sec"><span class="sec-label">Nerede kaydedilsin</span>
                <div class="seg">
                    <button class="${where === 'server' ? 'on' : ''}" data-act="rec-where" data-v="server">Sunucumda</button>
                    <button class="${where === 'device' ? 'on' : ''}" data-act="rec-where" data-v="device">Bu cihazda</button>
                </div>
                <span class="sec-hint">${where === 'server'
                    ? 'Kayıt kendi sunucunda sürer: uygulamayı alta alsan, telefonu kilitlesen ya da kapatsan da durmaz. Aynı anda birden çok kayıt yapılabilir; bitince buradan indirirsin.'
                    : 'Kayıt bu tarayıcıda yapılır.'}</span></div>` : ''}
            ${where === 'device' ? `<div class="notice">Uygulamayı alta alırsan telefon tarayıcıyı dondurabilir ya da kapatabilir; kayıt
                o sırada durur ya da kaybolur. ${server ? 'Arka planda sürmesi için "Sunucumda" seç.'
                    : 'Arka planda sürmesi için kendi sunucunu (telefonda Termux ile) kur: Ayarlar → Kendi sunucum.'}</div>` : ''}
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
        // Önizlemesi alınamayanlar (oynatılamayan) ayrı tutulur; istenirse gösterilir.
        const failed = links.filter((l) => !l.unreachable && thumbs.has(l.url) && !thumbs.get(l.url).ok);
        const shown = links.filter((l) => !failed.includes(l) || ui.showHidden);
        const counts = [];
        if (links.length) counts.push(`${links.length - (ui.showHidden ? 0 : failed.length)} video`);
        if (images.length) counts.push(`${images.length} resim`);
        const source = d.fromRender ? ' (sunucunda çalıştırılarak)' : d.fromScripts ? ' (script dosyalarında)' : '';

        const rows = shown.map((l) => {
            const t = thumbs.get(l.url);
            const thumb = t && t.thumb ? `<img src="${t.thumb}" alt="">` : '';
            const pending = !t ? '<span class="thumb-icon"><span class="spinner"></span></span>' : '';
            const dur = t && t.ok ? (t.live || l.live ? 'CANLI' : hms(t.duration || l.duration || 0)) : '';
            const quality = t && t.height ? `${t.height}p${l.variants > 1 ? ` · ${l.variants} kalite` : ''}` : (l.variants ? `${l.variants} kalite` : '—');
            return `
            <button class="media-row" data-act="analyze-link" data-url="${escapeHtml(l.url)}" data-pair="${escapeHtml(l.audioUrl || '')}">
                <span class="thumb media-thumb">${thumb}${pending}${dur ? `<span class="thumb-badge">${dur}</span>` : ''}</span>
                <span style="min-width:0"><span class="media-url">${escapeHtml(shortUrl(l.url))}</span>
                    <span class="media-sub">${KIND_TAG[l.kind] || 'DOSYA'}${t && t.height ? ' · ' + t.height + 'p' : ''}${l.audioUrl ? ' · ses ayrı, birleştirilir' : ''}${l.unreachable ? ' · bağlantı açılmıyor, kaydedilerek indirilir' : t && !t.ok ? ' · önizleme yok' : ''}</span></span>
                <span class="media-col">${escapeHtml(quality)}</span>
                <span class="media-act accent">Aç ›</span>
            </button>`;
        }).join('');

        const exts = [...new Set(images.map((u) => (u.split('?')[0].match(/\.([a-z0-9]{3,4})$/i) || [])[1]).filter(Boolean)
            .map((e) => e.toLowerCase()))].slice(0, 4);
        const imageRow = images.length ? `
            <button class="media-row images" data-act="images">
                <span class="img-peek">${images.slice(0, 1).map((u) =>
                    `<span class="thumb media-thumb"><img src="${escapeHtml(u)}" alt="" loading="lazy" referrerpolicy="no-referrer"></span>`).join('')}</span>
                <span style="min-width:0"><span class="media-url">${images.length} resim</span>
                    <span class="media-sub">${exts.join(', ')}</span></span>
                <span class="media-col"></span>
                <span class="media-act accent">Resimleri gör ›</span>
            </button>` : '';

        const hiddenNote = [];
        if (d.hiddenLinks) hiddenNote.push(`${d.hiddenLinks} bağlantı gizlendi (yalnızca ses, kalite parçası ya da açılmıyor)`);
        if (failed.length && !ui.showHidden) hiddenNote.push(`<button data-act="show-hidden">${failed.length} oynatılamayanı göster</button>`);
        const foot = embeds.map((e) => `<div class="media-foot">Gömülü oynatıcı: <button data-act="analyze-link" data-url="${escapeHtml(e.url)}">${escapeHtml(e.host)}</button> — içini taramak için dokunun</div>`).join('')
            + (hiddenNote.length ? `<div class="media-foot">${hiddenNote.join(' · ')}</div>` : '');
        const table = rows || imageRow || foot ? `
            <div class="card media-table">
                <div class="media-head"><span></span><span>Adres</span><span>Kalite</span><span></span></div>
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

    /** Sayfada indirilebilir video bulunamadıysa: sayfadaki videoyu oynatıp kaydet. */
    function captureHtml(primary) {
        if (!canServerRecord()) return '';
        return `<div class="card card-pad" style="gap:10px">
            <div><div class="toggle-row-title">Video bulunamadı mı? Oynatıp kaydet</div>
            <div class="toggle-row-sub">Sayfadaki video açılıp hızlandırılmış oynatılır ve kaydedilir; dosya normal hızda,
                orijinal kalitede bu cihaza iner. Video kendiliğinden başlamazsa sen dokunup başlatırsın.</div></div>
            <button class="${primary ? 'btn-rec' : 'btn-ghost'}" data-act="capture" ${primary ? '' : 'style="height:46px"'}>Videoyu kaydet</button>
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

        if (act === 'analyze-link') return analyze(btn.dataset.url, { pair: btn.dataset.pair || null, page: info && info.target === 'page' ? info.url : null });
        if (act === 'capture') return startCapture(btn.dataset.url || info.url);
        if (!info) return;
        if (act === 'images') return openImages(info.url, info.details.images || [], info.details.title);
        if (act === 'remote') {
            btn.classList.add('hidden');
            const slot = resultBox.querySelector('.remote-slot');
            remote = openRemoteView(slot, info.url, { onPick: (url) => analyze(url), shortUrl });
            slot.scrollIntoView({ block: 'start', behavior: 'smooth' });
            return;
        }
        if (act === 'variant') return pickVariant(Number(btn.dataset.i));
        if (act === 'show-hidden') ui.showHidden = true;
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
        render();
    });

    async function pickVariant(index) {
        ui.variant = index;
        const variant = currentVariant();
        if (info.details.master) ui.audioUrl = audioFor(info.details.master, variant) || ui.audioUrl;
        if (preview) preview.selectQuality(variant.url);
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

    /**
     * İndirme işi: önce bağlantıdan indirilir; bağlantı hata verirse (403, oturum, CORS...) aynı iş
     * içinde video açılıp kaydedilir — kullanıcıya ayrıca bir şey sorulmaz.
     */
    function withCaptureFallback(download, { mediaUrl, kind, name, saveMode, createSinkFor }) {
        const pageUrl = isHttpUrl(ui.sourcePage || '') ? ui.sourcePage : '';
        const unreachable = Boolean(info.unreachable); // iş sonra başlarsa ekrandaki sonuç değişmiş olabilir
        const capture = async (job, why) => {
            try {
                return await captureIntoJob(job, { pageUrl, mediaUrl, kind, name, createSinkFor: sinkForCapture, why });
            } catch (err) {
                // Sunucudan da olmadıysa: bağlantı telefonun kendi tarayıcısında açılabilsin.
                job.openUrl = mediaUrl;
                throw err;
            }
        };
        // Konum seçildiyse o dosya ilk denemede kapanmış olabilir; kayıt İndirilenler'e düşer.
        const sinkForCapture = saveMode === 'disk'
            ? (n, t) => createSink(n, { mode: 'downloads', mime: t })
            : createSinkFor;
        return async (job) => {
            if (!unreachable) {
                try {
                    return await download(job);
                } catch (err) {
                    if (err.name === 'AbortError' || job.status !== 'active' || /DRM/.test(err.message)) throw err;
                    if (!canServerRecord()) {
                        job.openUrl = mediaUrl;
                        throw new Error(`${shortError(err)} · Bağlantı inmedi; videoyu açıp kaydetmek için Ayarlar → Kendi sunucum ayarlı olmalı.`);
                    }
                    job.progress(0, 0);
                    return capture(job, `Bağlantı hata verdi (${shortError(err)})`);
                }
            }
            if (!canServerRecord()) {
                job.openUrl = mediaUrl;
                throw new Error('Bağlantı açılmıyor; videoyu açıp kaydetmek için Ayarlar → Kendi sunucum ayarlı olmalı.');
            }
            return capture(job, 'Bağlantı açılmıyor');
        };
    }

    async function startDownload(queueOnly) {
        const prefs = getPrefs();
        const isHls = info.target === 'hls' || (info.unreachable && info.kind === 'hls');
        const name = cleanName();
        try {
            if (isHls) {
                if (!ui.media && !info.unreachable) throw new Error('Yayın bilgisi okunamadı');
                const variant = currentVariant();
                const videoUrl = variant ? variant.url : info.url;
                const ext = currentExt();
                const { saveMode, createSinkFor } = await prepareSink(name + ext, ext === '.m4a' ? 'audio/mp4' : 'video/mp4');
                const thumb = await currentThumb();
                const range = ui.rangeOpen ? rangeSeconds() : null;
                const videoPlaylist = ui.media ? ui.media.playlist : null;
                const audioUrl = ui.audioUrl;
                addJob({
                    name: name + ext,
                    kind: 'hls',
                    thumb,
                    saveMode,
                    run: withCaptureFallback((job) => downloadHlsVod({
                        job, videoUrl, videoPlaylist, audioUrl, name, range, mode: prefs.conn, createSinkFor
                    }), { mediaUrl: info.url, kind: 'hls', name, saveMode, createSinkFor })
                });
            } else {
                const fileName = name + currentExt();
                const { saveMode, createSinkFor } = await prepareSink(fileName, info.mime);
                const thumb = await currentThumb();
                const url = info.url;
                addJob({
                    name: fileName,
                    kind: ['video', 'audio', 'image'].includes(info.kind) ? info.kind : 'file',
                    thumb,
                    saveMode,
                    run: withCaptureFallback((job) => downloadFile({
                        job, url, name: fileName, mode: prefs.conn, background: prefs.background,
                        mime: info.mime, size: info.size, createSinkFor
                    }), { mediaUrl: url, kind: info.kind, name, saveMode, createSinkFor })
                });
            }
            toast(queueOnly ? 'Sıraya eklendi · İndirmeler' : 'İndirme başladı · İndirmeler');
        } catch (err) {
            if (err.name !== 'AbortError') setError(err.message);
        }
    }

    async function startRecording() {
        const prefs = getPrefs();
        const variant = currentVariant();
        const videoUrl = variant ? variant.url : info.url;
        const audioUrl = ui.audioUrl;
        const name = cleanName();
        const limitSec = recLimitSeconds();
        const quality = variant ? variantLabel(variant) : '';
        askNotificationPermission();

        try {
            const thumb = await currentThumb();
            if (canServerRecord() && prefs.recWhere === 'server') {
                await startServerRecording({
                    url: videoUrl, audioUrl, name, limitSec, limitLabel: recLimitLabel(), quality, thumb
                });
            } else {
                const { saveMode, createSinkFor } = await prepareSink(`${name}.mp4`, 'video/mp4');
                addJob({
                    name: `${name}.mp4`,
                    kind: 'rec',
                    thumb,
                    now: true, // kayıt sıra beklemez; yayın kaçmasın
                    saveMode,
                    run: (job) => recordHlsLive({
                        job, videoUrl, audioUrl, name, limitSec, limitLabel: recLimitLabel(), quality,
                        mode: prefs.conn, createSinkFor
                    })
                });
            }
            navigate('downloads');
        } catch (err) {
            if (err.name !== 'AbortError') setError(`Kayıt başlatılamadı: ${err.message}`);
        }
    }

    /** Sayfadaki videoyu oynatıp kaydet (bağlantı bulunamadığında). */
    async function startCapture(url) {
        let name = 'video';
        if (info && info.url === url && info.details && info.details.title) name = info.details.title;
        else name = baseNameFor(url);
        name = name.replace(/[\\/:*?"<>|]+/g, '_').trim().slice(0, 80) || 'video';
        const saveMode = effectiveSaveMode(getPrefs().save);
        const createSinkFor = (n, t) => createSink(n, { mode: saveMode === 'disk' ? 'downloads' : saveMode, mime: t });
        askNotificationPermission();
        addJob({
            name: `${name}.mp4`,
            kind: 'rec',
            now: true,
            saveMode,
            run: (job) => captureIntoJob(job, { pageUrl: url, name, createSinkFor })
        });
        navigate('downloads');
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

/** Hata mesajını kısa bir nedene indirger (ör. "HTTP 403"). */
function shortError(err) {
    const message = String((err && err.message) || 'hata');
    const http = message.match(/HTTP (\d{3})|(\d{3}) döndü/);
    if (http) return `HTTP ${http[1] || http[2]}`;
    return message.length > 60 ? message.slice(0, 57) + '…' : message;
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
