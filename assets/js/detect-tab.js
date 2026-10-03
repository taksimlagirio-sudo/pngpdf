// "Algıla" ekranı: adresteki içeriği tanır, önizlemesini oynatır, seçenekleri gösterir ve
// indirmeyi/kaydı başlatır.
import { $, escapeHtml, isHttpUrl, formatSize, hms, getRenderServer, isServerStream, checkRenderServer } from './util.js';
import { analyzeUrl, formatDuration, describeMediaPlaylist, cachedManifest } from './detect.js';
import { downloadFile } from './video.js';
import { downloadMerged } from './merge.js';
import { downloadHlsVod, recordHlsLive, loadPlaylist, audioFor, baseNameFor } from './hls.js';
import { dashPlaylist } from './dash.js';
import { recentList, addRecent, updateRecent, persistThumb } from './recent.js';
import {
    addJob, createSink, effectiveSaveMode, canSaveToDisk, canShareFiles, canBackgroundFetch,
    askNotificationPermission
} from './downloads.js';
import { getPrefs, setPref, SAVE_LABELS, CONN_LABELS } from './prefs.js';
import { canRemote, openRemoteOverlay } from './remote.js';
import { canServerRecord, startServerRecording, captureIntoJob } from './serverrec.js';
import { attachPreview, grabFrame, probePreview } from './preview.js';

// yt-dlp'nin en güçlü olduğu büyük platformlar: bunlarda "nasıl bakalım?" diye sorulur.
const BIG_SITES = [
    ['tiktok.com', 'TikTok'], ['instagram.com', 'Instagram'], ['youtube.com', 'YouTube'], ['youtu.be', 'YouTube'],
    ['x.com', 'X'], ['twitter.com', 'X'], ['facebook.com', 'Facebook'], ['fb.watch', 'Facebook'],
    ['vimeo.com', 'Vimeo'], ['reddit.com', 'Reddit'], ['redd.it', 'Reddit'], ['twitch.tv', 'Twitch'],
    ['dailymotion.com', 'Dailymotion'], ['dai.ly', 'Dailymotion'], ['pinterest.com', 'Pinterest'], ['pin.it', 'Pinterest'],
    ['threads.net', 'Threads'], ['threads.com', 'Threads'], ['snapchat.com', 'Snapchat'], ['linkedin.com', 'LinkedIn'],
    ['bilibili.com', 'Bilibili'], ['vk.com', 'VK'], ['ok.ru', 'OK'], ['rumble.com', 'Rumble'], ['kick.com', 'Kick'],
    ['bsky.app', 'Bluesky'], ['tumblr.com', 'Tumblr'], ['streamable.com', 'Streamable']
];

/** Büyük platformsa [alan adı, ad]; değilse null. */
export function bigSiteOf(url) {
    let host;
    try {
        host = new URL(url).hostname.toLowerCase();
    } catch (_) {
        return null;
    }
    return BIG_SITES.find(([d]) => host === d || host.endsWith('.' + d)) || null;
}

// "…'dan paylaşıldı": büyük platformların okunuşuna göre ek; diğerleri ses uyumuyla.
const ABLATIVE = {
    YouTube: "'dan", X: "'ten", Facebook: "'tan", Reddit: "'ten", Twitch: "'ten", Pinterest: "'ten", Threads: "'ten",
    Snapchat: "'ten", LinkedIn: "'den", Vimeo: "'dan", Dailymotion: "'dan", Bilibili: "'den", VK: "'dan", OK: "'den",
    Rumble: "'dan", Kick: "'ten", Bluesky: "'den", Tumblr: "'dan", Streamable: "'dan", Instagram: "'dan", TikTok: "'tan"
};
export function ablative(name) {
    if (ABLATIVE[name]) return name + ABLATIVE[name];
    const w = String(name).toLowerCase();
    const vowels = [...w].filter((c) => 'aeıioöuü'.includes(c));
    const back = 'aıou'.includes(vowels[vowels.length - 1] || 'a');
    const hard = 'pçtkfhsş'.includes(w[w.length - 1]);
    return `${name}'${hard ? 't' : 'd'}${back ? 'a' : 'e'}n`;
}

/** Yapıştırılan/paylaşılan metnin içindeki ilk bağlantı ("şuna bak https://…"). */
export function firstUrl(text) {
    const m = String(text || '').match(/https?:\/\/[^\s<>"']+/i);
    return m ? m[0].replace(/[),.;!?]+$/, '') : String(text || '').trim();
}

const KIND_TAG = { hls: 'HLS', video: 'MP4', audio: 'SES', dash: 'DASH', image: 'IMG' };
const KIND_LABEL = {
    video: 'Video', audio: 'Ses', image: 'Resim', hls: 'HLS', dash: 'DASH', document: 'Belge',
    archive: 'Arşiv', page: 'Web sayfası', unknown: 'Bilinmeyen tür'
};
const REC_LIMITS = [['Sınırsız', 0], ['30 dk', 1800], ['1 sa', 3600], ['2 sa', 7200], ['Özel', -1]];

export function initDetectTab({ navigate, toast, openImages, photos = null, install = null }) {
    const urlInput = $('detectUrl');
    const analyzeBtn = $('detectBtn');
    const statusBox = $('detectStatus');
    const previewBox = $('detectPreview');
    const resultBox = $('detectResult');

    let info = null;      // analyzeUrl sonucu
    let ui = null;        // seçimler (kalite, ad, aralık, kayıt süresi)
    // Sayfanın fotoğrafları: Resimler ekranının taraması (gallery-dl dahil) arka planda yapılır,
    // sonuçlar burada videolardan ayrı bir bölümde gösterilir.
    let photosPage = null;
    let photosSnap = null;
    if (photos) photos.subscribe((snap) => { photosSnap = snap; paintPhotos(); });
    let autoHops = 0;
    let entryUrl = '';    // algılamanın başladığı adres (sayfadan videoya geçilse de)     // sayfadan medyaya otomatik geçişte sonsuz döngüyü engeller
    let remote = null;    // açık "kendim dokunayım" oturumu
    let preview = null;   // açık önizleme oynatıcısı
    let seq = 0;          // eski analizlerin sonucu yenisinin üstüne yazılmasın
    const thumbs = new Map(); // sayfa listesi: adres → {ok, thumb, duration, height}

    analyzeBtn.addEventListener('click', () => onAnalyzeClick());
    urlInput.addEventListener('keydown', (e) => {
        if (e.key === 'Enter') onAnalyzeClick();
    });
    $('detectPasteBtn').addEventListener('click', () => pasteAndAnalyze());

    async function readClipboard() {
        if (!navigator.clipboard || !navigator.clipboard.readText) throw new Error('Bu tarayıcı panoyu okumaya izin vermiyor');
        return navigator.clipboard.readText();
    }

    // Paylaş ile gelindiyse üstte "X'ten paylaşıldı" şeridi (yeni bir algılamaya kadar).
    const sharedBox = document.createElement('div');
    statusBox.insertAdjacentElement('beforebegin', sharedBox);
    function showShared(link) {
        if (!link) {
            sharedBox.innerHTML = '';
            return;
        }
        let from = '';
        try {
            const big = bigSiteOf(link);
            from = big ? big[1] : new URL(link).hostname.replace(/^www\./, '');
        } catch (_) { /* geçersiz adres */ }
        sharedBox.innerHTML = `<div class="shared-banner"><span class="shared-icon">↗</span>
            <span style="min-width:0"><span class="shared-title">${escapeHtml(from ? `${ablative(from)} paylaşıldı` : 'Paylaşıldı')}</span>
            <span class="shared-url">${escapeHtml(link.replace(/^https?:\/\/(www\.)?/, ''))}</span></span></div>`;
    }

    async function onAnalyzeClick() {
        showShared('');
        let url = firstUrl(urlInput.value);
        if (!url) {
            try {
                url = firstUrl(await readClipboard());
            } catch (_) { /* pano izni yok */ }
        }
        urlInput.value = url;
        start(url);
    }

    /** Panodaki bağlantıyı yapıştırıp hemen algılar. */
    async function pasteAndAnalyze() {
        showShared('');
        let text;
        try {
            text = await readClipboard();
        } catch (_) {
            setError('Panoya erişilemedi. Bağlantıyı kutuya basılı tutup yapıştırın (tarayıcı pano izni isterse "İzin ver").');
            urlInput.focus();
            return;
        }
        const url = firstUrl(text);
        if (!isHttpUrl(url)) {
            setError('Panoda bir bağlantı yok. Önce paylaşılacak bağlantıyı kopyalayın.');
            return;
        }
        urlInput.value = url;
        start(url);
    }

    // Sunucuda yt-dlp kurulu mu (bir kez sorulur).
    let ytdlpCheck = null;
    function ytdlpAvailable() {
        const config = getRenderServer();
        if (!config) return Promise.resolve(false);
        if (!ytdlpCheck) {
            ytdlpCheck = checkRenderServer(config).then((h) => Boolean(h && h.ytdlp)).catch(() => {
                ytdlpCheck = null;
                return false;
            });
        }
        return ytdlpCheck;
    }

    /**
     * Kullanıcının başlattığı algılama: büyük platformsa (ve sunucuda yt-dlp varsa) önce "nasıl
     * bakalım?" diye sorar ya da hatırlanan/ayardaki yöntemi kullanır.
     */
    async function start(url) {
        const big = isHttpUrl(url) ? bigSiteOf(url) : null;
        if (!big || !(await ytdlpAvailable())) return analyze(url);
        const prefs = getPrefs();
        const method = (prefs.siteMethods || {})[big[0]] || prefs.bigSites;
        if (method === 'ytdlp') return analyze(url, { useExtract: true });
        if (method === 'ours') return analyze(url, { noExtract: true });
        askMethod(url, big);
    }

    function askMethod(url, [domain, name]) {
        ++seq;
        info = null;
        closePreview();
        setBusy('');
        resultBox.innerHTML = `
            <div class="card card-pad method-choice">
                <div><div class="toggle-row-title">Bu bir ${escapeHtml(name)} bağlantısı. Nasıl bakalım?</div>
                <div class="toggle-row-sub">Gelişmiş bulma ${escapeHtml(name)} için özel yazılmış yöntemle videoyu ve tüm kaliteleri bulur.
                    Sayfayı aç ise sayfayı sunucundaki tarayıcıda açıp oynatıcının isteklerini dinler.
                    Gelişmiş bulma alamazsa kendiliğinden sayfa açılır.</div></div>
                <div class="btn-row">
                    <button class="btn-ac" data-method="ytdlp">Gelişmiş bulma</button>
                    <button class="btn-ghost" data-method="ours" style="height:46px">Sayfayı aç</button>
                </div>
                <label class="remember-row"><input type="checkbox" data-remember>
                    <span>${escapeHtml(name)} için seçimimi hatırla</span></label>
            </div>`;
        resultBox.querySelectorAll('[data-method]').forEach((btn) => btn.addEventListener('click', () => {
            const method = btn.dataset.method;
            if (resultBox.querySelector('[data-remember]').checked) {
                setPref('siteMethods', { ...(getPrefs().siteMethods || {}), [domain]: method });
            }
            analyze(url, method === 'ytdlp' ? { useExtract: true } : { noExtract: true });
        }, { once: true }));
    }

    function setBusy(text) {
        stopProgress();
        statusBox.innerHTML = text ? `<div class="busy"><span class="spinner"></span><span>${escapeHtml(text)}</span></div>` : '';
    }

    /* ---------------- Algılama ilerlemesi (4 adım) ---------------- */

    const STEPS = ['Sayfa kaynağı okunuyor', 'Betikler taranıyor', 'Sunucunda açılıyor', 'Videolar yoklanıyor'];
    const STEP_SEC = [4, 6, 14, 6]; // adımın tipik süresi: çubuk bu sürede adımın sonuna yaklaşır
    let progress = null; // { idx, at, timer }
    let controller = null;

    function stepOf(text) {
        if (/yoklan|Playlist|DASH|Önizleme|Resim okunuyor|ayrıştır/i.test(text)) return 3;
        if (/sunucunda (açıl|çalıştır)|kendi sunucun/i.test(text)) return 2;
        if (/script|betik|çözümleniyor|gelişmiş/i.test(text)) return 1;
        return 0;
    }

    function showProgress(text) {
        const idx = Math.max(progress ? progress.idx : 0, stepOf(text));
        if (!progress || !statusBox.querySelector('.detect-progress')) {
            statusBox.innerHTML = `
                <div class="detect-progress">
                    <div class="dp-head"><span class="dp-step"></span><span class="dp-idx mono"></span></div>
                    <div class="dp-bar"><span></span></div>
                    <div class="dp-steps">${STEPS.map((l) => `<span>${l}</span>`).join('')}</div>
                    <div class="dp-foot"><span>Genelde 5–20 sn sürer</span><button class="link-btn" data-cancel>İptal</button></div>
                </div>`;
            statusBox.querySelector('[data-cancel]').addEventListener('click', cancelAnalyze);
            progress = { idx, at: Date.now(), timer: setInterval(paintProgress, 500) };
        }
        if (idx !== progress.idx) progress = { ...progress, idx, at: Date.now() };
        paintProgress();
    }

    function paintProgress() {
        const box = statusBox.querySelector('.detect-progress');
        if (!box || !progress) return;
        const { idx, at } = progress;
        // Adım içinde çubuk yavaşça ilerler, ama adım bitmeden sonuna varmaz.
        const within = Math.min(0.9, (Date.now() - at) / 1000 / STEP_SEC[idx]);
        box.querySelector('.dp-step').textContent = STEPS[idx];
        box.querySelector('.dp-idx').textContent = `${idx + 1}/${STEPS.length}`;
        box.querySelector('.dp-bar span').style.width = `${Math.round(((idx + within) / STEPS.length) * 100)}%`;
        box.querySelectorAll('.dp-steps span').forEach((el, i) => {
            el.classList.toggle('done', i < idx);
            el.classList.toggle('on', i === idx);
        });
    }

    function stopProgress() {
        if (progress) clearInterval(progress.timer);
        progress = null;
    }

    function cancelAnalyze() {
        seq++;
        if (controller) controller.abort();
        controller = null;
        stopProgress();
        statusBox.innerHTML = '';
        analyzeBtn.disabled = false;
        info = null;
        renderIdle();
    }

    /* ---------------- Boş ekran: ilk açılış ya da son algılananlar ---------------- */

    function renderIdle() {
        if (info) return;
        const recent = recentList();
        if (recent.length) {
            resultBox.innerHTML = `
                <div class="recent">
                    <span class="sec-label">Son algılananlar</span>
                    ${recent.map((r) => `
                        <button class="recent-row" data-act="recent" data-url="${escapeHtml(r.url)}">
                            <span class="thumb recent-thumb">${r.thumb ? `<img src="${escapeHtml(r.thumb)}" alt="">` : ''}${r.duration
                                ? `<span class="thumb-badge">${escapeHtml(r.duration)}</span>` : ''}</span>
                            <span class="recent-text"><span class="recent-title">${escapeHtml(r.title || shortUrl(r.url))}</span>
                                <span class="recent-meta">${escapeHtml(r.meta || '')}</span></span>
                            <span class="recent-act">İndir</span>
                        </button>`).join('')}
                </div>`;
            return;
        }
        const canInstall = install && install.available && install.available();
        resultBox.innerHTML = `
            <div class="welcome">
                <img src="assets/icons/icon.svg" alt="" class="welcome-icon">
                <div class="welcome-title">Bir bağlantı yapıştırın, gerisini biz bulalım</div>
                <div class="welcome-sub">Video, canlı yayın, sayfa ya da galeri.</div>
            </div>
            <div class="rows filled">
                <button class="row" data-act="how-share"><span class="row-value" style="font-weight:600">Başka uygulamadan paylaş
                    <span class="muted" style="display:block;font-size:12px;font-weight:400">Paylaş → İndirici, otomatik algılanır</span></span>
                    <span class="row-chev">›</span></button>
                ${canInstall || (install && install.iosHint) ? `<button class="row" data-act="install"><span class="row-value" style="font-weight:600">Ana ekrana ekle
                    <span class="muted" style="display:block;font-size:12px;font-weight:400">Tam ekran, çevrimdışı açılır</span></span>
                    <span class="row-chev">›</span></button>` : ''}
            </div>
            ${getRenderServer() ? '' : `
            <button class="server-promo" data-act="setup">
                <span class="server-promo-title">Daha çok site için kendi sunucun</span>
                <span class="server-promo-sub">Kapalı siteler, giriş isteyenler ve kilitliyken kayıt. 5 dakikada kurulur.</span>
                <span class="server-promo-act">Kurulumu başlat ›</span>
            </button>`}`;
    }

    /** Algılanan sonucu "Son algılananlar"a yazar; küçük resim gelince günceller. */
    function rememberResult(entryUrl) {
        if (!info || !entryUrl) return;
        const d = info.details || {};
        let kind;
        let meta;
        if (info.target === 'page') {
            const v = (d.links || []).length;
            const p = (d.images || []).length;
            kind = 'Sayfa';
            meta = [`${v} video`, p ? `${p} resim` : ''].filter(Boolean).join(', ');
        } else {
            const v = currentVariant();
            kind = info.unreachable ? 'Video' : (info.target === 'hls' || info.target === 'dash') ? (ui.media && ui.media.live ? 'Canlı yayın' : 'Yayın') : (KIND_LABEL[info.kind] || 'Dosya');
            meta = [v && v.height ? `${v.height}p` : '', info.size ? formatSize(info.size) : ''].filter(Boolean).join(' · ');
        }
        const where = d.fromYtdlp ? 'gelişmiş bulma' : (d.fromRender || info.access === 'render') ? 'sunucunda bulundu' : '';
        const seconds = (ui.media && !ui.media.live && ui.media.duration) || d.duration || 0;
        addRecent({
            url: entryUrl,
            title: (info.target === 'page' ? d.title : ui.name) || d.title || shortUrl(info.url),
            meta: [kind, meta, where].filter(Boolean).join(' · '),
            duration: seconds ? shortDur(seconds) : ''
        });
        // Küçük resim: önizlemeden (video) ya da sayfanın ilk bağlantısının karesinden; kare
        // hazır olana kadar birkaç kez denenir.
        const shown = info;
        const tryThumb = async (left) => {
            if (info !== shown) return; // başka bir şey algılandı
            const src = info.target === 'page'
                ? ([...thumbs.values()].find((t) => t && t.thumb) || {}).thumb || d.thumbnail
                : await currentThumb();
            const thumb = await persistThumb(src);
            if (thumb) updateRecent(entryUrl, { thumb });
            else if (left > 0) setTimeout(() => tryThumb(left - 1), 5000);
        };
        setTimeout(() => tryThumb(4), 3000);
    }

    function setError(text) {
        stopProgress();
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
    async function analyze(url, { pair = null, page = null, title = '', noExtract = false, useExtract = false, fromYtdlp = false } = {}) {
        if (!isHttpUrl(url)) {
            setError('Geçerli bir http(s) adresi girin.');
            return;
        }
        const mySeq = ++seq;
        photosPage = page || null;
        if (!page) entryUrl = url; // "Son algılananlar"a yazılacak, kullanıcının verdiği adres
        analyzeBtn.disabled = true;
        if (remote) {
            remote.close();
            remote = null;
        }
        closePreview();
        info = null;
        resultBox.innerHTML = '';
        if (controller) controller.abort();
        controller = new AbortController();
        const signal = controller.signal;
        showProgress('Bağlanılıyor...');

        try {
            const result = await analyzeUrl(url, {
                mode: getPrefs().conn,
                signal,
                // yt-dlp yalnızca Ayarlar'dan açıldıysa; varsayılan: sayfa doğrudan bizim sunucuda taranır.
                noExtract: noExtract || !(useExtract || getPrefs().useYtdlp),
                onStage: (text) => mySeq === seq && showProgress(text)
            });
            if (mySeq !== seq) return;
            info = result;
            ui = initialUi(result, pair);
            ui.sourcePage = page;
            // Sayfadan açılan videoya sayfanın başlığı ad olur ("videoplayback" yerine).
            if (title && result.target !== 'page') ui.name = cleanTitle(title);
            setBusy('');

            // Sayfanın fotoğrafları arka planda aranmaya başlar (videolarla aynı anda).
            if (result.target === 'page' && photos) {
                photosPage = result.url;
                photos.prefetch(result.url, result.details.images || [], result.details.title || '');
            }
            // Sayfada tek bir video bulunduysa doğrudan onu aç.
            const links = result.details.links || [];
            if (result.target === 'page' && links.length === 1 && autoHops < 2) {
                autoHops++;
                return analyze(links[0].url, {
                    pair: links[0].audioUrl || null, page: result.url, title: result.details.title || '', fromYtdlp: Boolean(links[0].fromYtdlp)
                });
            }
            autoHops = 0;
            render();
            showPreview();
            if (result.target === 'page') probeLinks(mySeq);
            rememberResult(entryUrl);
        } catch (err) {
            if (mySeq !== seq) return;
            console.error(err);
            autoHops = 0;
            // yt-dlp'nin verdiği bağlantı açılmadı: sayfa bizim yöntemle (sunucudaki tarayıcıda) taranır.
            if (fromYtdlp && page) {
                toast('Gelişmiş bulmanın bağlantısı açılmadı; sayfa sunucunda taranıyor');
                return analyze(page, { noExtract: true, title });
            }
            // Video bağlantısı açılmıyor (403, oturum vb.): yine de kart gösterilir; İndir'e basınca
            // video açılıp kaydedilir.
            if (page || err.mediaLike || /\.(m3u8|mp4|m4v|webm|mov|mkv|ts)(\?|$)/i.test(url)) {
                setBusy('');
                info = unreachableInfo(url, err);
                ui = initialUi(info, pair);
                ui.sourcePage = page;
                if (title) ui.name = cleanTitle(title);
                render();
                rememberResult(entryUrl);
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

    function cleanTitle(title) {
        return String(title).replace(/[\\/:*?"<>|]+/g, '_').replace(/\s+/g, ' ').trim().slice(0, 100) || 'video';
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
            // DASH: süre bildirimden; kalite kartları ve aralık seçimi HLS'teki gibi çalışır.
            media: d.playlist ? d : result.target === 'dash' ? { duration: d.duration || 0, live: false } : null,
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
                cached: cachedManifest,
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
            if (link.kind === 'dash') {
                thumbs.set(link.url, { ok: true, height: link.height, duration: link.duration }); // önizleme yok, indirilebilir
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
        if (info.target === 'page') renderPage();
        else if (info.target === 'hls' && ui.media && ui.media.live) renderLive();
        else {
            renderDownload();
            if (ui.rangeOpen) {
                paintRange();
                refreshTexts();
            }
        }
        if (photosPage) {
            // Sayfa sonucunda kendi yeri var; video kartında kartın altına eklenir.
            if (!resultBox.querySelector('.photos-slot')) resultBox.insertAdjacentHTML('beforeend', '<div class="photos-slot"></div>');
            paintPhotos();
        }
    }

    /** "Fotoğraflar" bölümü: videolardan ayrı; Resimler ekranının sonuçlarından. */
    function paintPhotos() {
        const slot = resultBox.querySelector('.photos-slot');
        const bar = resultBox.querySelector('[data-bar-photos]');
        if (!slot || !photosPage) return;
        const snap = photosSnap && photosSnap.url === photosPage ? photosSnap : null;
        const list = snap ? snap.items : [];
        const busy = !snap || snap.busy;
        if (bar) {
            bar.hidden = !list.length;
            bar.textContent = `${list.length} fotoğrafı indir`;
        }
        const head = `<div class="pr-head"><span class="pr-head-title">Fotoğraflar${list.length ? ` · ${list.length}` : ''}</span>
            ${list.length ? '<button class="link-btn pr-head-act" data-act="photos-open">Tümünü gör</button>' : ''}</div>`;
        if (!list.length) {
            slot.innerHTML = `<div class="photos">${head}<div class="${busy ? 'busy' : 'empty'}">${busy
                ? '<span class="spinner"></span><span>Fotoğraflar aranıyor...</span>' : 'Bu sayfada fotoğraf bulunamadı.'}</div></div>`;
            return;
        }
        const max = 8;
        const shown = list.slice(0, max);
        slot.innerHTML = `<div class="photos">${head}
            <div class="photo-strip">${shown.map((it, i) => `
                <button class="photo-tile" data-act="photos-open" title="${escapeHtml(it.name)}">
                    <img src="${escapeHtml(it.src || it.url)}" alt="" loading="lazy" referrerpolicy="no-referrer">
                    ${i === shown.length - 1 && list.length > shown.length ? `<span class="photo-more">+${list.length - shown.length + 1}</span>` : ''}
                </button>`).join('')}</div>
            ${busy ? '<span class="sec-hint">Diğerleri aranıyor...</span>' : ''}
            <button class="btn-ghost photos-dl" data-act="photos-all">${list.length} fotoğrafı indir</button></div>`;
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
        if (info.target === 'dash') return '.mp4';
        if (ui.audioUrl) return '.mp4';
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

    // Aralık çubuğunun süsü: dalga biçimi gibi görünen sabit çubuklar.
    const RANGE_BARS = Array.from({ length: 40 }, (_, i) => Math.round(30 + Math.abs(Math.sin(i * 1.7)) * 70));

    function rangeHtml() {
        if (!['hls', 'dash'].includes(info.target) || !ui.media || ui.media.live || !ui.media.duration) return '';
        const total = ui.media.duration;
        if (!ui.rangeOpen) {
            return `<button class="row" style="border:1px solid var(--ln);border-radius:14px" data-act="range-open">
                <span class="row-label">Aralık</span><span class="row-value">Tamamı · ${shortDur(total)}</span><span class="row-chev">›</span></button>`;
        }
        const presets = [['Tümü', 0, total], ['İlk 10 dk', 0, Math.min(600, total)], ['Son 5 dk', Math.max(0, total - 300), total]];
        return `<div class="range-sec">
            <div class="pr-head"><span class="sec-label">Aralık — çubuğa dokunarak ayarlayın</span>
                <button class="link-btn pr-head-note" data-act="range-close">Kapat</button></div>
            <div class="range-bar" data-range-bar>
                <div class="range-waves">${RANGE_BARS.map((h) => `<span style="height:${h}%"></span>`).join('')}</div>
                <div class="range-sel" data-range-sel></div>
            </div>
            <div class="range-ticks"><span>0:00</span><span>${shortDur(total / 2)}</span><span>${shortDur(total)}</span></div>
            <div class="range-boxes">
                <label class="range-box"><span>Başlangıç</span>
                    <input data-input="rangeStart" value="${escapeHtml(ui.rangeStart || shortDur(0))}" inputmode="numeric" spellcheck="false"></label>
                <label class="range-box"><span>Bitiş</span>
                    <input data-input="rangeEnd" value="${escapeHtml(ui.rangeEnd || shortDur(total))}" inputmode="numeric" spellcheck="false"></label>
            </div>
            <div class="range-presets">${presets.map(([l, a, b]) =>
                `<button data-act="range-preset" data-a="${a}" data-b="${b}">${l}</button>`).join('')}</div>
            <span class="sec-hint" data-range-hint></span></div>`;
    }

    /** Seçili aralığı çubukta ve metinlerde gösterir (yeniden çizmeden). */
    function paintRange() {
        const sel = resultBox.querySelector('[data-range-sel]');
        if (!sel || !ui.media) return;
        const total = ui.media.duration;
        const { start, end } = rangeSeconds();
        const a = Math.max(0, Math.min(start, total));
        const b = Math.max(a, Math.min(end || total, total));
        sel.style.left = `${(a / total) * 100}%`;
        sel.style.width = `${((b - a) / total) * 100}%`;
    }

    function setRange(a, b, { inputs = true } = {}) {
        const total = ui.media.duration;
        a = Math.max(0, Math.min(Math.round(a), total));
        b = Math.max(a + 1, Math.min(Math.round(b), total));
        ui.rangeStart = shortDur(a);
        ui.rangeEnd = shortDur(b);
        if (inputs) {
            const s1 = resultBox.querySelector('[data-input="rangeStart"]');
            const s2 = resultBox.querySelector('[data-input="rangeEnd"]');
            if (s1) s1.value = ui.rangeStart;
            if (s2) s2.value = ui.rangeEnd;
        }
        paintRange();
        refreshTexts();
    }

    function metaLine() {
        const d = info.details;
        const bits = [];
        if (info.unreachable) return `${info.kind === 'hls' ? 'Yayın' : 'Video'} · bağlantı doğrudan açılmıyor`;
        if (info.target === 'dash') {
            bits.push(d.live ? 'Canlı yayın (DASH)' : 'Video (DASH)');
            if (d.duration && !d.live) bits.push(hms(d.duration));
            const v = currentVariant();
            if (v && v.resolution) bits.push(v.resolution.replace('x', '×'));
            if (d.hasAudio) bits.push('ses ayrı · birleştirilecek');
            if (d.drm) bits.push(`DRM (${d.drm})`);
            return bits.join(' · ');
        }
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
            if (ui.audioUrl) bits.push('ses ayrı · birleştirilecek');
        }
        return bits.join(' · ');
    }

    function downloadSize() {
        if (!['hls', 'dash'].includes(info.target)) return info.size || 0;
        if (!ui.media) return 0;
        const { start, end } = rangeSeconds();
        const seconds = ui.rangeOpen ? Math.max(0, Math.min(end || ui.media.duration, ui.media.duration) - start) : ui.media.duration;
        return estimate(currentVariant(), seconds);
    }

    function renderDownload() {
        const isHls = info.target === 'hls' || info.target === 'dash';
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
                    ${optionRows({ background: !isHls && !info.unreachable && !ui.audioUrl })}
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
                        <div class="res-url">${escapeHtml(isServerStream(info.url) ? (ui.sourcePage || 'gelişmiş bulma') : info.url)}</div>
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

    /** Bağlantı için okunur bir ad: dosya adı anlamlıysa o, değilse sayfanın başlığı. */
    function linkTitle(l, i) {
        const d = info.details;
        const page = d.title || 'Video';
        if (l.fromYtdlp) return page;
        let last = '';
        try {
            last = decodeURIComponent(new URL(l.url).pathname.split('/').filter(Boolean).pop() || '');
        } catch (_) { /* geçersiz adres */ }
        const base = last.replace(/\.[a-z0-9]{2,5}$/i, '');
        const generic = /^(index|master|playlist|manifest|videoplayback|chunklist.*|media|video|stream|hls|play|main|output|source|default|v\d*)$/i;
        // Uzun, rakam karışık, kelime içermeyen adlar (kimlik/hash) anlamsız sayılır.
        const hashy = base.length >= 16 && /\d/.test(base) && !/[a-zçğıöşü]{4,}[\s_-]+[a-zçğıöşü]{3,}/i.test(base);
        if (base && !generic.test(base) && !hashy) return base.replace(/[-_.]+/g, ' ').trim().slice(0, 70);
        return i === 0 ? page : `${page} · ${i + 1}`;
    }

    function linkMeta(l, t) {
        const height = (t && t.height) || l.height;
        const fmt = (l.url.split('?')[0].match(/\.([a-z0-9]{2,4})$/i) || [])[1];
        const kind = l.kind === 'hls' || l.kind === 'dash' ? (l.live || (t && t.live) ? 'Canlı yayın' : 'Yayın')
            : l.kind === 'audio' ? 'Ses' : 'Video';
        const bits = [kind];
        if (l.kind !== 'hls' && l.kind !== 'dash' && fmt) bits.push(fmt.toUpperCase());
        if (height) bits.push(`${height}p${l.variants > 1 ? ` (${l.variants} kalite)` : ''}`);
        else if (l.variants > 1) bits.push(`${l.variants} kalite`);
        if (l.size) bits.push(formatSize(l.size));
        if (l.audioUrl) bits.push('ses ayrı');
        if (l.unreachable) bits.push('açılmıyor, kaydedilerek iner');
        return bits.join(' · ');
    }

    function renderPage() {
        const d = info.details;
        const links = d.links || [];
        const embeds = d.embeds || [];
        // Önizlemesi alınamayanlar (oynatılamayan) ayrı tutulur; istenirse gösterilir.
        const failed = links.filter((l) => !l.unreachable && !l.fromYtdlp && thumbs.has(l.url) && !thumbs.get(l.url).ok);
        const shown = links.filter((l) => !failed.includes(l) || ui.showHidden);
        const found = d.fromYtdlp ? 'Gelişmiş bulma ile bulundu' : d.fromRender ? 'Sunucunda açılarak bulundu'
            : d.fromScripts ? 'Betiklerde bulundu' : 'Sayfa kaynağında bulundu';

        const rows = shown.map((l, i) => {
            const t = thumbs.get(l.url);
            const thumb = (t && t.thumb) || (l.fromYtdlp && d.thumbnail) || '';
            const pending = !t ? '<span class="thumb-icon"><span class="spinner"></span></span>' : '';
            const seconds = (t && t.ok && t.duration) || l.duration || 0;
            const dur = (t && t.live) || l.live ? 'CANLI' : seconds ? shortDur(seconds) : '';
            const ext = (l.url.split('?')[0].match(/\.([a-z0-9]{2,4})$/i) || [])[1];
            return `
            <button class="pr-row" data-act="analyze-link" data-url="${escapeHtml(l.url)}" data-pair="${escapeHtml(l.audioUrl || '')}" data-ytdlp="${l.fromYtdlp ? 1 : 0}">
                <span class="thumb pr-thumb">${thumb ? `<img src="${escapeHtml(thumb)}" alt="" referrerpolicy="no-referrer">` : ''}${pending}${dur ? `<span class="thumb-badge">${dur}</span>` : ''}</span>
                <span class="pr-text"><span class="pr-title">${escapeHtml(linkTitle(l, i))}</span>
                    <span class="pr-meta">${escapeHtml(linkMeta(l, t))}</span></span>
                <span class="pr-kind">${l.kind === 'video' || l.kind === 'audio' ? (ext || KIND_TAG[l.kind]).toUpperCase() : KIND_TAG[l.kind] || 'DOSYA'}</span>
                <span class="pr-act">İndir</span>
            </button>`;
        }).join('');

        const videosHead = `<div class="pr-head"><span class="pr-head-title">Videolar · ${shown.length}</span>${failed.length
            ? `<button class="link-btn pr-head-note" data-act="${ui.showHidden ? 'hide-hidden' : 'show-hidden'}">${ui.showHidden
                ? 'Oynamayanları gizle' : `Oynamayanlar gizli (${failed.length})`}</button>` : ''}</div>`;
        const foot = [
            ...embeds.map((e) => `<div class="media-foot">Gömülü oynatıcı: <button data-act="analyze-link" data-url="${escapeHtml(e.url)}">${escapeHtml(e.host)}</button> — içini taramak için dokunun</div>`),
            d.hiddenLinks ? `<div class="media-foot">${d.hiddenLinks} bağlantı gizlendi (kalite parçası, yalnızca ses, önizleme klibi ya da yarıda kalan istek)</div>` : ''
        ].join('');
        const videos = rows || foot ? `<div class="pr-videos">${videosHead}<div class="pr-list">${rows}${foot}</div></div>` : '';
        const first = shown.find((l) => !l.unreachable) || shown[0];

        resultBox.innerHTML = `
            <div class="pr-top">
                <button class="back-btn" data-act="back" aria-label="Geri">←</button>
                <span class="pr-top-label">Sonuç</span>
            </div>
            <div class="pr-titlebox">
                <div class="page-title">${escapeHtml(d.title || shortUrl(info.url))}</div>
                <div class="chips-row">${links.length ? `<span class="chip-ok">✓ ${found}</span>` : ''}${d.blockedAds
                    ? `<span class="chip-mt">${d.blockedAds} reklam engellendi</span>` : ''}</div>
            </div>
            <div class="pr-grid">
                ${videos}
                ${photosPage ? '<div class="photos-slot pr-photos"></div>' : ''}
            </div>
            ${d.fromYtdlp ? `<button class="btn-ghost" data-act="rescan" style="height:46px">Bulunanlar doğru değil mi? Sayfayı başka yöntemle tara</button>` : ''}
            ${warningsHtml()}
            ${captureHtml(!links.length)}
            ${canRemote() ? `<button class="btn-ghost" data-act="remote" style="height:46px">Sayfayı aç, kendim dokunayım</button>` : ''}
            ${first || photosPage ? `<div class="result-bar">
                <button class="btn-ghost" data-act="photos-all" data-bar-photos hidden></button>
                ${first ? `<button class="btn-big" data-act="analyze-link" data-url="${escapeHtml(first.url)}" data-pair="${escapeHtml(first.audioUrl || '')}" data-ytdlp="${first.fromYtdlp ? 1 : 0}">${escapeHtml(shortTitle(linkTitle(first, 0)))} indir</button>` : ''}
            </div>` : ''}`;
    }

    /** Rozet süresi: "0:38", "10:32", "1:02:14". */
    function shortDur(sec) {
        sec = Math.max(0, Math.round(sec || 0));
        const h = Math.floor(sec / 3600);
        const m = Math.floor(sec / 60) % 60;
        const ss = String(sec % 60).padStart(2, '0');
        return h ? `${h}:${String(m).padStart(2, '0')}:${ss}` : `${m}:${ss}`;
    }

    function shortTitle(text) {
        return text.length > 26 ? text.slice(0, 24).trim() + '…' : text;
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
        if (key === 'rangeStart' || key === 'rangeEnd') paintRange();
        const title = resultBox.querySelector('.res-title, .live-title');
        if (title && key === 'name') title.textContent = ui.name;
        refreshTexts();
    });

    function refreshTexts() {
        const rangeHint = resultBox.querySelector('[data-range-hint]');
        if (rangeHint && ui.media) {
            const { start, end } = rangeSeconds();
            const v = currentVariant();
            const size = downloadSize();
            rangeHint.textContent = [`${shortDur(Math.max(0, (end || ui.media.duration) - start))} süre`,
                v && v.height ? `${v.height}p` : '', size ? `~${formatSize(size)}` : ''].filter(Boolean).join(' · ');
        }
        const dlBtn = resultBox.querySelector('[data-act="download"]');
        if (dlBtn) {
            const size = downloadSize();
            dlBtn.textContent = `${ui.rangeOpen ? 'Bu bölümü indir' : 'İndir'}${size ? ' · ~' + formatSize(size) : ''}`;
        }
        const recHint = resultBox.querySelector('[data-rec-hint]');
        if (recHint) recHint.textContent = recHintText();
    }

    // Aralık çubuğu: dokununca ya da sürükleyince en yakın uç oraya gelir.
    let rangeDrag = null;
    resultBox.addEventListener('pointerdown', (e) => {
        const bar = e.target.closest('[data-range-bar]');
        if (!bar || !ui || !ui.media) return;
        const total = ui.media.duration;
        const at = (ev) => {
            const r = bar.getBoundingClientRect();
            return Math.max(0, Math.min(1, (ev.clientX - r.left) / r.width)) * total;
        };
        const { start, end } = rangeSeconds();
        const v = at(e);
        rangeDrag = { bar, at, edge: Math.abs(v - start) <= Math.abs(v - (end || total)) ? 'a' : 'b' };
        bar.setPointerCapture(e.pointerId);
        moveRange(v);
        e.preventDefault();
    });
    resultBox.addEventListener('pointermove', (e) => {
        if (rangeDrag) moveRange(rangeDrag.at(e));
    });
    const endDrag = () => { rangeDrag = null; };
    resultBox.addEventListener('pointerup', endDrag);
    resultBox.addEventListener('pointercancel', endDrag);
    function moveRange(v) {
        const total = ui.media.duration;
        const { start, end } = rangeSeconds();
        const a = start;
        const b = end || total;
        if (rangeDrag.edge === 'a') setRange(Math.min(v, b - 1), b);
        else setRange(a, Math.max(v, a + 1));
    }

    resultBox.addEventListener('click', async (e) => {
        const btn = e.target.closest('[data-act]');
        if (!btn || btn.disabled) return;
        const act = btn.dataset.act;
        const prefs = getPrefs();

        if (act === 'analyze-link') {
            const fromPage = info && info.target === 'page';
            return analyze(btn.dataset.url, {
                pair: btn.dataset.pair || null, page: fromPage ? info.url : null, title: fromPage ? info.details.title || '' : '',
                fromYtdlp: btn.dataset.ytdlp === '1'
            });
        }
        if (act === 'capture') return startCapture(btn.dataset.url || info.url);
        if (act === 'recent') {
            urlInput.value = btn.dataset.url;
            return start(btn.dataset.url);
        }
        if (act === 'how-share') {
            toast('Instagram, TikTok, YouTube gibi uygulamalarda Paylaş\'a dokunup İndirici\'yi seçin (önce ana ekrana ekleyin)');
            return;
        }
        if (act === 'install') {
            if (install && install.available && install.available()) install.prompt();
            else toast('Safari\'de Paylaş → Ana Ekrana Ekle');
            return;
        }
        if (act === 'setup') return navigate('settings');
        if (!info) return;
        if (act === 'rescan') return analyze(info.url, { noExtract: true });
        if (act === 'photos-all' && photos) {
            photos.downloadAll();
            return;
        }
        if (act === 'photos-open' && photosPage) return openImages(photosPage, [], '');
        if (act === 'images') return openImages(info.url, info.details.images || [], info.details.title);
        if (act === 'remote') {
            if (remote) remote.close();
            remote = openRemoteOverlay(info.url, { onPick: (url) => analyze(url), shortUrl, onClose: () => { remote = null; } });
            return;
        }
        if (act === 'variant') return pickVariant(Number(btn.dataset.i));
        if (act === 'show-hidden') ui.showHidden = true;
        if (act === 'hide-hidden') ui.showHidden = false;
        if (act === 'back') {
            closePreview();
            info = null;
            photosPage = null;
            showShared('');
            renderIdle();
            return;
        }
        if (act === 'range-open') ui.rangeOpen = true;
        if (act === 'range-preset') {
            ui.rangeOpen = true;
            return setRange(Number(btn.dataset.a), Number(btn.dataset.b));
        }
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
        if (info.target === 'dash') return render(); // kalite bilgisi bildirimde hazır
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
                job.openUrl = mediaUrl || pageUrl;
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

    /** İşin nereden geldiği: hata olursa "Yeniden algıla" buradan başlar. */
    function jobSource() {
        const page = isHttpUrl(ui.sourcePage || '') ? ui.sourcePage : (entryUrl && entryUrl !== info.url ? entryUrl : '');
        return { page, media: isServerStream(info.url) ? '' : info.url };
    }

    async function startDownload(queueOnly) {
        const prefs = getPrefs();
        const isHls = info.target === 'hls' || (info.unreachable && info.kind === 'hls');
        const name = cleanName();
        try {
            if (info.target === 'dash') {
                const mpd = info.details.mpd;
                const variant = currentVariant();
                const audioRep = mpd.audios[0] || null;
                const { saveMode, createSinkFor } = await prepareSink(`${name}.mp4`, 'video/mp4');
                const range = ui.rangeOpen ? rangeSeconds() : null;
                const mode = prefs.conn;
                addJob({
                    name: `${name}.mp4`,
                    kind: 'hls',
                    thumb: null,
                    saveMode,
                    source: jobSource(),
                    run: withCaptureFallback(async (job) => {
                        job.setDetail('Parça listesi hazırlanıyor...');
                        const [videoPlaylist, audioPlaylist] = await Promise.all([
                            dashPlaylist(mpd, variant, { mode, signal: job.signal }),
                            audioRep ? dashPlaylist(mpd, audioRep, { mode, signal: job.signal }) : null
                        ]);
                        return downloadHlsVod({ job, videoPlaylist, audioPlaylist, name, range, mode, createSinkFor });
                    }, { mediaUrl: info.url, kind: 'video', name, saveMode, createSinkFor })
                });
                toast(queueOnly ? 'Sıraya eklendi · İndirmeler' : 'İndirme başladı · İndirmeler');
                return;
            }
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
                    source: jobSource(),
                    run: withCaptureFallback((job) => downloadHlsVod({
                        job, videoUrl, videoPlaylist, audioUrl, name, range, mode: prefs.conn, createSinkFor
                    }), { mediaUrl: info.url, kind: 'hls', name, saveMode, createSinkFor })
                });
            } else {
                const fileName = name + currentExt();
                const { saveMode, createSinkFor } = await prepareSink(fileName, ui.audioUrl ? 'video/mp4' : info.mime);
                const thumb = await currentThumb();
                const url = info.url;
                // Sunucudaki yt-dlp akışı açılmazsa sunucu kendi adresini açamaz; sayfa açılıp kaydedilir.
                const mediaUrl = isServerStream(url) ? '' : url;
                if (ui.audioUrl) {
                    const audioUrl = ui.audioUrl;
                    addJob({
                        name: fileName,
                        kind: 'video',
                        thumb,
                        saveMode,
                        source: jobSource(),
                        run: withCaptureFallback((job) => downloadMerged({
                            job, videoUrl: url, audioUrl, name, mode: prefs.conn, size: info.size, createSinkFor
                        }), { mediaUrl, kind: 'video', name, saveMode, createSinkFor })
                    });
                    toast(queueOnly ? 'Sıraya eklendi · İndirmeler' : 'İndirme başladı · İndirmeler');
                    return;
                }
                addJob({
                    name: fileName,
                    kind: ['video', 'audio', 'image'].includes(info.kind) ? info.kind : 'file',
                    thumb,
                    saveMode,
                    source: jobSource(),
                    run: withCaptureFallback((job) => downloadFile({
                        job, url, name: fileName, mode: prefs.conn, background: prefs.background,
                        mime: info.mime, size: info.size, createSinkFor
                    }), { mediaUrl, kind: info.kind, name, saveMode, createSinkFor })
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
            source: { page: url, media: '' },
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

    renderIdle();

    return {
        prefill(url, autoStart, { shared = false } = {}) {
            const link = firstUrl(url);
            urlInput.value = link;
            showShared(shared ? link : '');
            if (autoStart) start(link);
        },
        analyze(url) {
            urlInput.value = firstUrl(url);
            start(firstUrl(url));
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
