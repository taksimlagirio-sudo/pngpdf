// "Algıla" ekranı: adresteki içeriği tanır, önizlemesini oynatır, seçenekleri gösterir ve
// indirmeyi/kaydı başlatır.
import { $, escapeHtml, isHttpUrl, formatSize, hms, getRenderServer, isServerStream, checkRenderServer, saveBlob } from './util.js';
import { analyzeUrl, formatDuration, describeMediaPlaylist, cachedManifest } from './detect.js';
import { downloadFile } from './video.js';
import { downloadMerged } from './merge.js';
import { downloadHlsVod, recordHlsLive, loadPlaylist, audioFor, baseNameFor } from './hls.js';
import { dashPlaylist } from './dash.js';
import { recentList, addRecent, updateRecent, persistThumb, clearRecent } from './recent.js';
import {
    addJob, createSink, effectiveSaveMode, canSaveToDisk, canShareFiles, canBackgroundFetch,
    askNotificationPermission
} from './downloads.js';
import { getPrefs, setPref, SAVE_LABELS, CONN_LABELS } from './prefs.js';
import { canRemote, openRemoteOverlay } from './remote.js';
import { canServerRecord, startServerRecording, captureIntoJob, serverDownloadIntoJob } from './serverrec.js';
import { attachPreview, grabFrame, probePreview } from './preview.js';
import { subLabel, subCode, loadCues, toSrt, toVtt, shiftCues } from './subs.js';
import { embedSubtitles, editMp4, toProgressive } from './mp4edit.js';
import { siteSettingFor, setSiteSetting, variantIndexFor } from './sitesettings.js';
import { icon } from './icons.js';
import { openBookmarklet } from './servertools.js';

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

export function initDetectTab({ navigate, toast, openImages, photos = null, install = null, openSetup = null, onFollow = null, onBulk = null }) {
    const urlInput = $('detectUrl');
    const analyzeBtn = $('detectBtn');
    const statusBox = $('detectStatus');
    const previewBox = $('detectPreview');
    // Sonuç ekranının üst satırı (geri, adres): önizlemenin üstünde durur.
    const resTop = document.createElement('div');
    resTop.className = 'rd-topbox';
    previewBox.insertAdjacentElement('beforebegin', resTop);
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
    let stickyAudio = false; // "Yalnızca ses" seçimi kalite değişince de korunur
    let bulkMode = false; // toplu eklemede: önizleme/konum sorusu/uyarılar yok
    let preview = null;   // açık önizleme oynatıcısı
    let seq = 0;          // eski analizlerin sonucu yenisinin üstüne yazılmasın
    const thumbs = new Map(); // sayfa listesi: adres → {ok, thumb, duration, height}

    analyzeBtn.addEventListener('click', () => onAnalyzeClick());
    urlInput.addEventListener('keydown', (e) => {
        if (e.key === 'Enter') onAnalyzeClick();
    });
    $('detectPasteBtn').addEventListener('click', () => pasteAndAnalyze());
    const bulkLink = $('detectBulkBtn');
    if (bulkLink) bulkLink.addEventListener('click', () => onBulk && onBulk(urlInput.value));
    // Kutuya birden çok bağlantı yapıştırılırsa toplu ekleme açılır.
    urlInput.addEventListener('paste', (e) => {
        const text = (e.clipboardData || window.clipboardData).getData('text');
        if (onBulk && countLinks(text) > 1) {
            e.preventDefault();
            onBulk(text);
        }
    });
    const countLinks = (text) => (String(text).match(/https?:\/\/[^\s<>"']+/g) || []).length;

    /* ---- Bağlantı alanı önerileri: panodaki bağlantı ve son algılananlar ----
     * Pano yalnızca izin önceden verilmişse sessizce okunur (izin sorusu çıkarmaz). Alan boştayken
     * panodaki yeni bağlantı tek dokunuşluk bir öneri olarak çıkar; yazarken son algılananlardan
     * uyanlar listelenir. Telefonda alan klavyenin hemen üstünde durur (sekme çubuğu gizlenir). */
    const suggestBox = $('detectSuggest');
    let clipUrl = '';
    let typing = false;
    async function checkClipboard() {
        try {
            const st = await navigator.permissions.query({ name: 'clipboard-read' });
            if (st.state !== 'granted' || !document.hasFocus()) return;
            const url = firstUrl(await navigator.clipboard.readText());
            if (isHttpUrl(url) && url !== clipUrl) {
                clipUrl = url;
                paintSuggest();
            }
        } catch (_) { /* izin yok ya da desteklenmiyor */ }
    }
    function paintSuggest() {
        if (!suggestBox) return;
        const value = urlInput.value.trim();
        const shortLink = (u) => u.replace(/^https?:\/\/(www\.)?/, '');
        if (typing) {
            const q = value.toLowerCase();
            const items = [];
            if (clipUrl && clipUrl !== value) {
                items.push(`<button class="us-item clip" data-url="${escapeHtml(clipUrl)}">${icon('paste')}<span class="us-t"><b>Panodaki bağlantı</b><small>${escapeHtml(shortLink(clipUrl))}</small></span></button>`);
            }
            recentList()
                .filter((r) => r.url !== value && r.url !== clipUrl && (!q || r.url.toLowerCase().includes(q) || (r.title || '').toLowerCase().includes(q)))
                .slice(0, 3)
                .forEach((r) => items.push(`<button class="us-item" data-url="${escapeHtml(r.url)}">${icon('history')}<span class="us-url">${escapeHtml(shortLink(r.url))}</span></button>`));
            suggestBox.innerHTML = items.length ? `<span class="us-head">Önerilenler</span>${items.join('')}` : '';
            return;
        }
        const recent = recentList()[0];
        const fresh = clipUrl && !info && clipUrl !== value && !(recent && recent.url === clipUrl);
        suggestBox.innerHTML = fresh
            ? `<button class="us-chip" data-url="${escapeHtml(clipUrl)}">${icon('paste')}<span>Panoda: <i>${escapeHtml(shortLink(clipUrl).slice(0, 40))}</i></span><b>Algıla</b></button>`
            : '';
    }
    if (suggestBox) {
        // Öneriye dokunurken alan odağını kaybetmesin (klavye kapanıp liste kaybolmasın).
        suggestBox.addEventListener('pointerdown', (e) => { if (e.target.closest('[data-url]')) e.preventDefault(); });
        suggestBox.addEventListener('click', (e) => {
            const b = e.target.closest('[data-url]');
            if (!b) return;
            const url = b.dataset.url;
            if (url === clipUrl) clipUrl = ''; // kullanıldı
            urlInput.value = url;
            urlInput.blur();
            showShared('');
            start(url);
        });
        urlInput.addEventListener('focus', () => {
            typing = true;
            document.body.classList.add('typing');
            checkClipboard();
            paintSuggest();
        });
        urlInput.addEventListener('blur', () => {
            typing = false;
            document.body.classList.remove('typing');
            paintSuggest();
        });
        urlInput.addEventListener('input', paintSuggest);
        document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'visible') checkClipboard(); });
        window.addEventListener('focus', checkClipboard);
        checkClipboard();
    }

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
        urlInput.blur(); // telefonda klavye kapansın, sonuç görünsün
        start(url);
    }

    /**
     * Pano okunamazsa (izin verilmedi / tarayıcı desteklemiyor): bağlantının yapıştırılacağı bir
     * kutu açılır; klavyenin pano önerisine ya da uzun basıp "Yapıştır"a dokunmak yeter.
     */
    async function pasteFallback() {
        let denied = false;
        try {
            const st = await navigator.permissions.query({ name: 'clipboard-read' });
            denied = st.state === 'denied';
        } catch (_) { /* bu tarayıcıda sorgulanamıyor */ }
        const el = document.createElement('div');
        el.className = 'sheet-backdrop paste-sheet';
        el.innerHTML = `<div class="paste-box" role="dialog" aria-modal="true" aria-label="Bağlantıyı yapıştır">
            <span class="cf-grip"></span>
            <div class="cf-text"><b>Bağlantıyı yapıştır</b><span>Kutuya uzun basıp <strong>Yapıştır</strong>’a dokun ya da klavyenin üstündeki pano önerisini seç. Bağlantı girince algılama kendiliğinden başlar.</span></div>
            <label class="paste-field">${icon('paste')}<input type="url" inputmode="url" placeholder="https://" autocomplete="off" aria-label="Bağlantı"></label>
            ${denied ? `<div class="paste-note">${icon('info')}<span><b>Pano izni kapalı</b><small>Adres çubuğundaki ⓘ (ya da ⋮ → ⓘ) → İzinler → Pano → İzin ver. Sonra tek dokunuşla yapıştırılır.</small></span></div>` : ''}
            <div class="paste-btns"><button class="cf-no" data-p="cancel">Vazgeç</button><button class="cf-ok" data-p="go">Algıla</button></div></div>`;
        document.body.appendChild(el);
        requestAnimationFrame(() => el.classList.add('in'));
        const input = el.querySelector('input');
        const close = () => el.remove();
        const go = () => {
            const text = input.value;
            if (onBulk && countLinks(text) > 1) {
                close();
                return onBulk(text);
            }
            const url = firstUrl(text);
            if (!isHttpUrl(url)) return;
            close();
            urlInput.value = url;
            start(url);
        };
        input.addEventListener('input', () => { if (isHttpUrl(firstUrl(input.value))) go(); });
        input.addEventListener('keydown', (e) => { if (e.key === 'Enter') go(); });
        el.addEventListener('click', (e) => {
            if (e.target === el || e.target.closest('[data-p="cancel"]')) close();
            if (e.target.closest('[data-p="go"]')) go();
        });
        setTimeout(() => input.focus(), 50);
    }

    /** Panodaki bağlantıyı yapıştırıp hemen algılar. */
    async function pasteAndAnalyze() {
        showShared('');
        let text;
        try {
            text = await readClipboard();
        } catch (_) {
            return pasteFallback();
        }
        if (onBulk && countLinks(text) > 1) return onBulk(text);
        const url = firstUrl(text);
        if (!isHttpUrl(url)) {
            // Pano boş görünüyorsa (bazı telefonlar boş döndürür) yapıştırma kutusu açılır.
            return pasteFallback();
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
        // Site başına ayar varsa hep onunla açılır.
        const site = isHttpUrl(url) ? siteSettingFor(url) : null;
        if (site && site.method === 'remote' && canRemote()) {
            entryUrl = url;
            if (remote) remote.close();
            remote = openRemoteOverlay(url, { onPick: (u) => analyze(u), shortUrl, onClose: () => { remote = null; } });
            return;
        }
        if (site && site.method === 'page') return analyze(url, { noExtract: true });
        if (site && (site.method === 'ytdlp' || (site.method === 'auto' && big))) return analyze(url, { useExtract: true });
        if (site) return analyze(url);
        if (!big || !(await ytdlpAvailable())) return analyze(url);
        const prefs = getPrefs();
        const method = prefs.bigSites;
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
                setSiteSetting(domain, { method: method === 'ytdlp' ? 'ytdlp' : 'page' });
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

    /** Kısayollar: yayın takibi, toplu ekle, bilgisayardan gönder, paylaşım / ana ekrana ekle. */
    function shortcutsHtml() {
        const server = Boolean(getRenderServer());
        const canInstall = install && ((install.available && install.available()) || install.iosHint);
        const list = [
            onFollow && server ? ['open-follow', 'broadcast', 'Yayın takibi', 'Açıldıkça kaydet', true] : null,
            onBulk ? ['bulk', 'list', 'Toplu ekle', 'Birden çok bağlantı'] : null,
            server ? ['bookmark', 'laptop', 'Bilgisayardan', 'Tek tıkla gönder'] : null,
            ['how-share', 'share', 'Paylaş ile gel', 'Diğer uygulamalardan'],
            canInstall ? ['install', 'download', 'Ana ekrana ekle', 'Tam ekran açılır'] : null,
            server ? null : ['setup', 'server', 'Kendi sunucun', 'Daha çok site, kayıt']
        ].filter(Boolean).slice(0, 4);
        return `<div class="sc-grid">${list.map(([act, ic, label, sub, hl]) => `<button class="sc-item" data-act="${act}">
            <span class="sc-ic${hl ? ' hl' : ''}">${icon(ic)}</span><span class="sc-t"><b>${label}</b><small>${sub}</small></span></button>`).join('')}</div>`;
    }

    function renderIdle() {
        if (info) return;
        resTop.innerHTML = '';
        const recent = recentList();
        resultBox.innerHTML = `
            ${shortcutsHtml()}
            ${recent.length ? `<div class="recent">
                <div class="recent-head"><span class="sec-label">Son algılananlar</span><button class="link-btn" data-act="recent-clear">Temizle</button></div>
                ${recent.map((r) => `
                    <button class="recent-row" data-act="recent" data-url="${escapeHtml(r.url)}">
                        <span class="thumb recent-thumb">${r.thumb ? `<img src="${escapeHtml(r.thumb)}" alt="">` : ''}${r.duration
                            ? `<span class="thumb-badge">${escapeHtml(r.duration)}</span>` : ''}</span>
                        <span class="recent-text"><span class="recent-title">${escapeHtml(r.title || shortUrl(r.url))}</span>
                            <span class="recent-meta">${escapeHtml(r.meta || '')}</span></span>
                        <span class="recent-act" aria-label="İndir">${icon('download')}</span>
                    </button>`).join('')}
            </div>` : `<div class="welcome">
                <img src="assets/icons/icon.svg" alt="" class="welcome-icon">
                <div class="welcome-title">Bir bağlantı yapıştır, gerisini biz bulalım</div>
                <div class="welcome-sub">Video, canlı yayın, sayfa ya da galeri.</div>
            </div>`}`;
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
    async function analyze(url, { pair = null, page = null, title = '', noExtract = false, useExtract = false, fromYtdlp = false, subtitles = null, formats = null } = {}) {
        if (!isHttpUrl(url)) {
            setError('Geçerli bir http(s) adresi girin.');
            return;
        }
        const mySeq = ++seq;
        if (!page && !formats) stickyAudio = false; // yeni bir bağlantı: varsayılan video
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
            // Sayfadan (gelişmiş bulma) gelen altyazılar seçilen videoya taşınır.
            if (subtitles && subtitles.length && !(result.details.subtitles || []).length) result.details.subtitles = subtitles;
            ui = initialUi(result, pair);
            ui.sourcePage = page;
            ui.formats = formats;
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
                // Kaliteler varsa site ayarındaki kalite (yoksa en iyisi) açılır.
                const fmts = links[0].formats || null;
                const site = siteSettingFor(entryUrl || url);
                const pick = fmts && site && site.quality !== 'best' ? fmts[variantIndexFor(fmts, site.quality)] : links[0];
                return analyze(pick.url, {
                    pair: pick.audioUrl || null, page: result.url, title: result.details.title || '', fromYtdlp: Boolean(pick.fromYtdlp),
                    subtitles: pick.subtitles || result.details.subtitles || null, formats: fmts
                });
            }
            autoHops = 0;
            render();
            showPreview();
            // Site ayarındaki kalite seçilir.
            const site = siteSettingFor(entryUrl || url);
            const variants = result.details.variants || [];
            if (site && site.quality !== 'best' && variants.length > 1) {
                const idx = variantIndexFor(variants, site.quality);
                if (idx !== ui.variant) pickVariant(idx);
            }
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
                ui.formats = formats;
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
            showHidden: false,
            // Altyazı: varsayılan seçili olan sitenin Türkçe altyazısı (varsa).
            subs: new Set((d.subtitles || []).map((sub, i) => (/^tr/i.test(sub.language || '') && !sub.auto ? i : -1)).filter((i) => i >= 0).slice(0, 1)),
            subMode: 'embed',
            audioOnly: stickyAudio
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
            addSubtitleToggle(video, mySeq);
            const variant = currentVariant();
            if (variant) video.addEventListener('loadedmetadata', () => preview && preview.selectQuality(variant.url), { once: true });
        } catch (err) {
            showMsg(err.message);
        }
    }

    /** Önizlemede altyazı seçimi (Kapalı / TR / EN …). */
    function addSubtitleToggle(video, mySeq) {
        const list = (info.details && info.details.subtitles) || [];
        if (!list.length) return;
        const box = document.createElement('div');
        box.className = 'pv-subs';
        const shown = list.slice(0, 3);
        box.innerHTML = `<button class="on" data-sub="-1">Kapalı</button>${shown.map((sub, i) =>
            `<button data-sub="${i}">${escapeHtml(subCode(sub).toUpperCase())}${sub.auto ? '*' : ''}</button>`).join('')}`;
        video.parentElement.appendChild(box);
        const loaded = new Map();
        box.addEventListener('click', async (e) => {
            const b = e.target.closest('[data-sub]');
            if (!b) return;
            const i = Number(b.dataset.sub);
            box.querySelectorAll('button').forEach((x) => x.classList.toggle('on', x === b));
            for (const t of video.textTracks) t.mode = 'disabled';
            if (i < 0) return;
            try {
                if (!loaded.has(i)) {
                    const cues = await loadCues(shown[i], { mode: getPrefs().conn });
                    if (mySeq !== seq) return;
                    const track = document.createElement('track');
                    track.kind = 'subtitles';
                    track.srclang = subCode(shown[i]);
                    track.src = URL.createObjectURL(new Blob([toVtt(cues)], { type: 'text/vtt' }));
                    video.appendChild(track);
                    loaded.set(i, track);
                    await new Promise((r) => { track.addEventListener('load', r, { once: true }); setTimeout(r, 1500); });
                }
                loaded.get(i).track.mode = 'showing';
            } catch (err) {
                toast(`Altyazı açılamadı: ${err.message}`);
            }
        });
    }

    /** İndirme kartındaki küçük resim için önizlemeden o anki kare. */
    async function currentThumb() {
        if (bulkMode) return info.previewUrl || null;
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
        resTop.innerHTML = '';
        paintSuggest();
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

    /** Video mu, yalnızca ses mi? (görüntüsü olan sonuçlarda) */
    function canAudioOnly() {
        if (!info || info.unreachable || !info.downloadable) return false;
        if (info.target === 'hls' || info.target === 'dash') return !info.details.audioOnly && !(ui.media && ui.media.live);
        return info.kind === 'video' || Boolean(ui.audioUrl);
    }

    function audioChoiceHtml() {
        if (!canAudioOnly()) return '';
        return `<div class="sec"><span class="sec-label">Ne indirilsin</span>
            <div class="kind-cards">${[['', 'film', 'Video'], ['1', 'music', 'Yalnızca ses']].map(([v, ic, l]) =>
                `<button class="kind-card${Boolean(ui.audioOnly) === Boolean(v) ? ' on' : ''}" data-act="audio-only" data-v="${v}">${icon(ic)}${l}</button>`).join('')}</div>
            ${ui.audioOnly ? `<span class="sec-hint">${ui.audioUrl ? 'Sitenin ayrı ses dosyası indirilir' : 'Video indirilir, sesi kalite kaybı olmadan ayrılır'} · M4A, telefonlarda ve arabada çalar.</span>` : ''}</div>`;
    }

    /**
     * Gelen MP4'ü bellekte toplar, bitince sesini kayıpsız ayırıp asıl hedefe (.m4a) yazar.
     * `realSinkFor`: prepareSink'in verdiği hedef açıcı.
     */
    function audioExtractSink(realSinkFor, finalName) {
        return async () => {
            const mem = await createSink('gecici.mp4', { mode: 'gallery', mime: 'video/mp4' });
            return {
                ...mem,
                mode: 'memory',
                name: finalName,
                async close() {
                    const blob = await mem.close();
                    let out;
                    try {
                        out = (await editMp4(await toProgressive(blob), { audioOnly: true })).blob;
                    } catch (err) {
                        throw new Error(`Ses ayrılamadı: ${err.message}`);
                    }
                    const real = await realSinkFor(finalName, 'audio/mp4');
                    await real.write(new Uint8Array(await out.arrayBuffer()));
                    return real.close();
                }
            };
        };
    }

    /** "Yalnızca ses" indirmesi. */
    async function startAudioDownload(queueOnly) {
        const prefs = getPrefs();
        const name = cleanName();
        const fileName = `${name}.m4a`;
        const { saveMode, createSinkFor } = await prepareSink(fileName, 'audio/mp4', { subtitles: false });
        const thumb = await currentThumb();
        const source = jobSource();
        const isHls = info.target === 'hls';
        const extract = audioExtractSink(createSinkFor, fileName);
        let run;
        if (!isHls && info.target !== 'dash' && ui.audioUrl) {
            // Sitenin ayrı ses dosyası (gelişmiş bulma): doğrudan o iner.
            const url = ui.audioUrl;
            if (prefs.serverBackground !== false && canServerRecord()) {
                run = (job) => serverDownloadIntoJob(job, { url, name: fileName, page: source.page, createSinkFor });
            } else {
                run = (job) => downloadFile({ job, url, name: fileName, mode: prefs.conn, mime: 'audio/mp4', size: 0, createSinkFor });
            }
        } else if (isHls) {
            const variant = currentVariant();
            const range = ui.rangeOpen ? rangeSeconds() : null;
            // Ayrı ses kanalı varsa yalnızca o, yoksa seçili kalite indirilip sesi ayrılır.
            const videoUrl = ui.audioUrl || (variant ? variant.url : info.url);
            const videoPlaylist = ui.audioUrl ? null : (ui.media ? ui.media.playlist : null);
            run = (job) => downloadHlsVod({ job, videoUrl, videoPlaylist, audioUrl: null, name, range, mode: prefs.conn, createSinkFor: extract });
        } else if (info.target === 'dash') {
            const mpd = info.details.mpd;
            const audioRep = mpd.audios[0] || null;
            const range = ui.rangeOpen ? rangeSeconds() : null;
            run = async (job) => {
                const rep = audioRep || currentVariant();
                const playlist = await dashPlaylist(mpd, rep, { mode: prefs.conn, signal: job.signal });
                return downloadHlsVod({ job, videoPlaylist: playlist, name, range, mode: prefs.conn, createSinkFor: extract });
            };
        } else {
            const url = info.url;
            run = (job) => downloadFile({ job, url, name: `${name}.mp4`, mode: prefs.conn, mime: info.mime, size: info.size, createSinkFor: extract });
        }
        addJob({ name: fileName, kind: 'audio', thumb, saveMode, source, resume: resumeRecipe(), run });
        if (!bulkMode) toast(queueOnly ? 'Sıraya eklendi · İndirmeler' : 'Ses indiriliyor · İndirmeler');
    }

    function qualityHead() {
        return `<div class="sec-head"><span class="sec-label">Kalite</span>${ui.audioUrl && !ui.audioOnly ? '<span class="sec-note">görüntü + ses birleştirilir</span>' : ''}</div>`;
    }

    /** Gelişmiş bulmanın verdiği kaliteler (her biri ayrı dosya). */
    function formatsHtml() {
        const list = ui.formats;
        if (!list || list.length < 2 || (info.details.variants || []).length) return '';
        return `<div class="sec">${qualityHead()}<div class="qcards">${list.map((f, i) =>
            `<button class="qcard${f.url === info.url ? ' on' : ''}" data-act="format" data-i="${i}">
                <div class="qcard-label">${f.kind === 'hls' ? 'Yayın' : f.height ? `${f.height}p` : 'Kalite'}</div>${f.size ? `<div class="qcard-sub">~${formatSize(f.size)}</div>` : ''}</button>`).join('')}</div></div>`;
    }

    function qualityHtml() {
        const variants = info.details.variants || [];
        if (!variants.length) return '';
        const live = ui.media && ui.media.live;
        const seconds = ui.media && !live ? ui.media.duration : 0;
        return `<div class="sec">${qualityHead()}<div class="qcards">${variants.map((v, i) => {
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
        if (ui.audioOnly && canAudioOnly()) return '.m4a';
        if (info.target === 'hls') return info.details.audioOnly ? '.m4a' : '.mp4';
        if (info.target === 'dash') return '.mp4';
        if (ui.audioUrl) return '.mp4';
        return '.' + (info.suggestedName.split('.').pop() || info.ext || 'bin');
    }

    function connRowHtml() {
        return `<button class="row" data-act="cycle-conn"><span class="row-label">Bağlantı</span>
            <span class="row-value">${CONN_LABELS[getPrefs().conn]}</span><span class="row-chev">›</span></button>`;
    }

    /** Başlıktaki tek satır özet: site · süre · kalite sayısı. */
    function summaryLine() {
        if (info.unreachable) return metaLine();
        const d = info.details || {};
        const from = ui.sourcePage || entryUrl || info.url;
        let site = '';
        try {
            const big = bigSiteOf(from);
            site = big ? big[1] : new URL(from).hostname.replace(/^www\./, '');
        } catch (_) { /* geçersiz */ }
        const live = (ui.media && ui.media.live) || d.live;
        const secs = (ui.media && ui.media.duration) || d.duration || 0;
        const n = ui.formats && ui.formats.length > 1 ? ui.formats.length : (d.variants || []).length;
        return [site, live ? 'Canlı' : secs ? shortDur(secs) : '', n > 1 ? `${n} kalite` : info.size ? formatSize(info.size) : '',
            d.drm ? `DRM (${d.drm})` : d.encryption ? 'AES-128 şifreli' : ''].filter(Boolean).join(' · ');
    }

    /** "Daha fazla": bölüm, altyazı, bağlantı yöntemi (seçili bir şey varsa açık gelir). */
    function moreHtml() {
        const range = rangeHtml();
        const subs = subsHtml();
        const nSubs = ((info.details && info.details.subtitles) || []).length;
        const open = ui.moreOpen || ui.rangeOpen || (ui.subs && ui.subs.size) || info.unreachable;
        const parts = [range ? 'Bir bölümünü indir' : '', nSubs ? `altyazı (${nSubs})` : ''].filter(Boolean);
        const label = parts.length ? [...parts, 'bağlantı'].join(' · ') : 'Diğer seçenekler';
        if (!open) return `<button class="more-btn" data-act="more">${icon(range ? 'scissors' : 'more')}<span>${label}</span>${icon('chevronDown')}</button>`;
        return `<div class="more-box">${range}${subs}
            ${info.unreachable ? `<label class="field"><span class="field-label">Videonun bulunduğu sayfa (isteğe bağlı) —
                verirsen o sayfanın çerez/oturumuyla denenir</span>
                <input class="input" type="url" data-input="sourcePage" value="${escapeHtml(ui.sourcePage || '')}"
                    placeholder="https://site.com/video-sayfasi" autocomplete="off"></label>` : ''}
            <div class="rows">${connRowHtml()}</div></div>`;
    }

    function dlButtonHtml() {
        const size = downloadSize();
        return `${icon('download')}<span>${ui.rangeOpen ? 'Bu bölümü indir' : 'İndir'}${size ? ' · ~' + formatSize(size) : ''}</span>`;
    }

    function optionRows({ background = true, conn = true } = {}) {
        const prefs = getPrefs();
        const save = effectiveSaveMode(prefs.save);
        // Kendi sunucun varsa arka planda indirme sunucuda yapılır (her türde); yoksa tarayıcının
        // arka plan indirmesi (yalnızca tek dosya).
        const viaServer = canServerRecord();
        if (viaServer) background = !info.unreachable && info.target !== 'dash';
        const bgSupported = viaServer || (canBackgroundFetch && save !== 'disk');
        return `
            <div class="rows">
                <label class="row"><span class="row-label">Ad</span>
                    <input value="${escapeHtml(ui.name)}" data-input="name" spellcheck="false">
                    <span class="row-ext">${escapeHtml(currentExt())}</span></label>
                <button class="row" data-act="cycle-save"><span class="row-label">Kaydet</span>
                    <span class="row-value">${SAVE_LABELS[save]}</span><span class="row-chev">›</span></button>
                ${conn ? connRowHtml() : ''}
                ${background ? `<button class="row bg-row${bgSupported ? '' : ' disabled'}" data-act="toggle-bg" ${bgSupported ? '' : 'disabled title="Bu tarayıcıda/kaydetme yönteminde desteklenmiyor"'}>
                    <span class="row-tile">${icon(viaServer ? 'server' : 'download')}</span>
                    <span class="row-value">${viaServer ? 'Sunucunda indir' : 'Arka planda indir'}<span class="muted row-sub">${viaServer
                        ? 'Uygulama kapansa da sürer, bitince telefona gelir' : 'Uygulama kapansa da sürer'}</span></span>
                    <span class="toggle${(viaServer ? prefs.serverBackground !== false : prefs.background) && bgSupported ? ' on' : ''}"></span></button>` : ''}
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
            const adSec = (ui.media && ui.media.adSeconds) || d.adSeconds;
            if (adSec) bits.push(`${shortDur(adSec)} reklam atlanacak`);
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
        if (ui.audioOnly) return 0; // ses boyutu önceden bilinmiyor
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
            body = `
                <div class="rd-body">
                    ${audioChoiceHtml()}
                    ${formatsHtml()}
                    ${qualityHtml()}
                    ${optionRows({ background: !isHls && !info.unreachable && !ui.audioUrl, conn: false })}
                    ${moreHtml()}
                </div>
                <div class="dl-actions dl-sticky">
                    <button class="btn-big" data-act="download">${dlButtonHtml()}</button>
                    <button class="btn-ghost dl-queue" data-act="queue" aria-label="Sıraya ekle" title="Sıraya ekle">${icon('list')}</button>
                    <button class="dl-new" data-act="new-link">${icon('link')}<span>Başka bağlantı algıla</span>${icon('paste')}</button>
                </div>`;
        }
        const d = info.details || {};
        const thumbSrc = info.previewUrl || d.thumbnail || '';
        const secs = (ui.media && !ui.media.live && ui.media.duration) || d.duration || 0;
        const badge = ui.media && ui.media.live ? 'CANLI' : secs ? shortDur(secs) : '';
        // Önizleme oynatıcısı görünüyorsa küçük resim tekrar edilmez.
        const showThumb = !previewBox.innerHTML;
        resTop.innerHTML = `<div class="rd-top">
                    <button class="back-btn" data-act="back" aria-label="Geri">${icon('back')}</button>
                    <span class="rd-url">${escapeHtml(shortUrl(ui.sourcePage || entryUrl || info.url))}</span>
                    ${d.fromYtdlp || (ui.formats && ui.formats.length) ? `<span class="chip-ok">${icon('check')} Gelişmiş bulma</span>` : ''}
                </div>`;
        resultBox.innerHTML = `
            <div class="rd">
                <div class="rd-head">
                    ${showThumb ? `<span class="rd-th">${thumbSrc ? `<img src="${escapeHtml(thumbSrc)}" alt="" referrerpolicy="no-referrer">` : icon(info.kind === 'audio' ? 'music' : 'film')}${badge ? `<i>${badge}</i>` : ''}</span>` : ''}
                    <div class="rd-t">
                        <div class="res-title">${escapeHtml(ui.name || info.suggestedName)}</div>
                        <div class="res-meta">${escapeHtml(summaryLine())}</div>
                    </div>
                </div>
                ${body}
            </div>
            ${warningsHtml()}`;
    }

    const SUB_MODES = [['embed', 'Videoya göm'], ['srt', 'Ayrı .srt'], ['both', 'İkisi']];
    const SUB_HINTS = {
        embed: 'Altyazı videonun içinde gelir; oynatıcıda açılıp kapatılabilir.',
        srt: 'Videonun yanına aynı adla .srt dosyası olarak kaydedilir.',
        both: 'Hem videoya gömülür hem ayrı .srt olarak kaydedilir.'
    };

    function subsHtml() {
        const list = (info.details && info.details.subtitles) || [];
        if (!list.length) return '';
        return `<div class="sec subs-sec"><div class="pr-head"><span class="sec-label">Altyazılar · ${list.length}</span>
                <span class="pr-head-note">${ui.subs.size} seçili</span></div>
            <div class="sub-list">${list.map((sub, i) => `<button class="sub-row" data-act="sub-toggle" data-i="${i}">
                <span class="sub-check${ui.subs.has(i) ? ' on' : ''}">${ui.subs.has(i) ? '✓' : ''}</span>
                <span class="sub-name">${escapeHtml(subLabel(sub))}</span><span class="sub-src">${sub.auto ? 'Otomatik' : 'Siteden'}</span></button>`).join('')}</div>
            ${ui.subs.size ? `<span class="sec-label">Nasıl kaydedilsin</span>
            <div class="seg">${SUB_MODES.map(([k, l]) => `<button class="${ui.subMode === k ? 'on' : ''}" data-act="sub-mode" data-v="${k}">${l}</button>`).join('')}</div>
            <span class="sec-hint">${SUB_HINTS[ui.subMode]}</span>` : ''}</div>`;
    }

    /** Seçili altyazılar ve nasıl kaydedilecekleri. */
    function subtitlePlan(fileExt) {
        const list = (info.details && info.details.subtitles) || [];
        const chosen = [...(ui.subs || [])].map((i) => list[i]).filter(Boolean);
        if (!chosen.length) return null;
        const range = ui.rangeOpen ? rangeSeconds() : null;
        let mode = ui.subMode || 'embed';
        // Gömme yalnızca MP4 çıktıya ve bellekteki dosyaya yapılabilir (konum seçildiyse dosya doğrudan diske yazılır).
        const embedOk = /\.mp4$/i.test(fileExt) && effectiveSaveMode(getPrefs().save) !== 'disk';
        if (!embedOk && mode !== 'srt') mode = 'srt';
        return { chosen, mode, range };
    }

    /**
     * Sayfa yeniden yüklenirse (paylaşım, güncelleme, Android'in kapatması) telefonda inen iş yarıda
     * kalır; bu tarif saklanır ve "Yeniden başlat" ile aynı video aynı kalitede yeniden bulunup indirilir.
     * Bir aralığı (klip) indirenler saklanmaz.
     */
    function resumeRecipe() {
        if (ui.rangeOpen) return null;
        const src = jobSource();
        if (!src.media && !src.page) return null;
        const v = currentVariant();
        const height = (v && (v.height || Number(String(v.resolution || '').split('x')[1]))) || 0;
        const quality = ui.audioOnly ? 'audio' : ui.variant && height ? String(height) : 'best';
        return { media: src.media, page: src.page, quality, title: cleanName(), pair: ui.audioUrl || null };
    }

    /** Saklanan tariften işi yeniden kurar: önce bilinen video adresi, açılmazsa sayfa yeniden bulunur. */
    async function resumeFrom(r) {
        const opts = { mode: getPrefs().conn, noExtract: !getPrefs().useYtdlp };
        let result = r.media ? await analyzeUrl(r.media, opts).catch(() => null) : null;
        let pair = r.pair || null;
        if (r.page && (!result || result.unreachable || result.target === 'page')) {
            result = await analyzeUrl(r.page, opts);
            pair = null;
            if (result.target === 'page') {
                const link = (result.details.links || [])[0];
                if (!link) throw new Error('Sayfada video bulunamadı');
                const pick = link.formats ? link.formats[variantIndexFor(link.formats, r.quality === 'audio' ? '720' : r.quality)] : link;
                result = await analyzeUrl(pick.url, opts);
                pair = pick.audioUrl || null;
            }
        }
        if (!result) throw new Error('Video yeniden bulunamadı');
        await enqueueResult(result, { quality: r.quality, page: r.page, title: r.title, pair });
    }

    /** Ayrı .srt dosyaları (küçük işler). */
    function queueSubtitleFiles(plan, name) {
        const conn = getPrefs().conn;
        for (const sub of plan.chosen) {
            const fileName = `${name}.${subCode(sub)}.srt`;
            addJob({
                name: fileName,
                kind: 'file',
                run: async (job) => {
                    job.setDetail('Altyazı alınıyor');
                    let cues = await loadCues(sub, { mode: conn, signal: job.signal });
                    if (plan.range) cues = shiftCues(cues, plan.range.start, plan.range.end || Infinity);
                    const blob = new Blob(['\ufeff' + toSrt(cues)], { type: 'application/x-subrip' });
                    const sink = await createSink(fileName, { mode: effectiveSaveMode(getPrefs().save) === 'disk' ? 'downloads' : effectiveSaveMode(getPrefs().save), mime: 'application/x-subrip' });
                    await sink.write(new Uint8Array(await blob.arrayBuffer()));
                    const out = await sink.close();
                    if (out) job.attachResult(out);
                    job.done(`Altyazı · ${cues.length} satır`);
                }
            });
        }
    }

    /** Gömme: dosya bellekte biter, altyazı izleri eklenir, sonra kaydedilir. */
    function embedSink(plan, saveMode) {
        return async (name, type) => {
            const inner = await createSink(name, { mode: 'gallery', mime: type });
            return {
                ...inner,
                mode: saveMode,
                write: (chunk) => inner.write(chunk),
                patch: (position, bytes) => inner.patch(position, bytes),
                abort: () => inner.abort(),
                async close() {
                    const blob = await inner.close();
                    let out = blob;
                    try {
                        const tracks = [];
                        for (const sub of plan.chosen) {
                            let cues = await loadCues(sub, { mode: getPrefs().conn });
                            if (plan.range) cues = shiftCues(cues, plan.range.start, plan.range.end || Infinity);
                            if (cues.length) tracks.push({ language: subCode(sub), cues });
                        }
                        if (tracks.length) out = await embedSubtitles(blob, tracks);
                    } catch (err) {
                        console.warn('Altyazı gömülemedi:', err);
                        toast(`Altyazı gömülemedi: ${err.message}`);
                    }
                    if (saveMode !== 'gallery') saveBlob(out, name);
                    return out;
                }
            };
        };
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
            ${onFollow && canRemote() ? '<button class="btn-ghost" data-act="follow" style="height:46px">Bu yayını takibe al · her açılışta kaydet</button>' : ''}
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
        const report = !links.length && (d.trace || []).length;

        resultBox.innerHTML = `
            <div class="pr-top">
                <button class="back-btn" data-act="back" aria-label="Geri">${icon('back')}</button>
                <span class="pr-top-label">Sonuç</span>
            </div>
            <div class="pr-titlebox">
                ${report ? `<div class="page-title">Video bulunamadı</div><div class="rp-url">${escapeHtml(shortUrl(info.url))}</div>`
                    : `<div class="page-title">${escapeHtml(d.title || shortUrl(info.url))}</div>`}
                <div class="chips-row">${links.length ? `<span class="chip-ok">✓ ${found}</span>` : ''}${d.blockedAds
                    ? `<span class="chip-mt">${d.blockedAds} reklam engellendi</span>` : ''}</div>
            </div>
            <div class="pr-grid">
                ${videos}
                ${photosPage ? '<div class="photos-slot pr-photos"></div>' : ''}
            </div>
            ${d.fromYtdlp ? `<button class="btn-ghost" data-act="rescan" style="height:46px">Bulunanlar doğru değil mi? Sayfayı başka yöntemle tara</button>` : ''}
            ${report ? reportHtml() : warningsHtml()}
            ${captureHtml(!links.length)}
            ${canRemote() && !report ? `<button class="btn-ghost" data-act="remote" style="height:46px">Sayfayı aç, kendim dokunayım</button>` : ''}
            ${onFollow && canRemote() ? '<button class="btn-ghost" data-act="follow" style="height:46px">Bu sayfayı takibe al</button>' : ''}
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

    /* ---------------- Neden bulunamadı (rapor) ---------------- */

    const TRACE_ORDER = ['page', 'scripts', 'server', 'play', 'ytdlp'];
    const secText = (ms) => `${Math.max(0.1, ms / 1000).toFixed(1).replace('.', ',')} sn`;

    function traceSteps() {
        return [...(info.details.trace || [])].sort((a, b) => TRACE_ORDER.indexOf(a.key) - TRACE_ORDER.indexOf(b.key));
    }

    function reportHtml() {
        const steps = traceSteps();
        const login = steps.some((t) => t.note === 'sayfa giriş istiyor');
        const tips = [
            canRemote() ? ['remote', 'Kendim dokunayım ile aç', 'Sayfa senin dokunuşlarınla oynatılır, istekler yakalanır'] : null,
            canRemote() ? ['remote', 'Siteye giriş yap', login ? 'Sayfa giriş istiyor; bir kez giriş yapman yeter' : 'Video üyelere açıksa'] : null,
            ['focus-url', 'Videonun sayfasını dene', 'Liste ya da ana sayfa değil, videonun kendi sayfası'],
            getRenderServer() ? null : ['setup', 'Kendi sunucunu kur', 'Sayfa gerçek bir tarayıcıda açılır, çok daha fazla site çalışır']
        ].filter(Boolean);
        return `<div class="rp">
            <div class="rp-steps">${steps.map((t) => `<div class="rp-step ${t.state}">
                <span class="rp-ic">${icon(t.state === 'ok' ? 'check' : t.state === 'fail' ? 'close' : 'minus')}</span>
                <span class="rp-main"><b>${escapeHtml(t.label)}</b><small>${[t.ms ? secText(t.ms) : '', escapeHtml(t.note)].filter(Boolean).join(' · ')}</small></span></div>`).join('')}</div>
            <span class="sec-label">Önerilen adımlar</span>
            <div class="rows filled">${tips.map(([act, l, sub]) => `<button class="row" data-act="${act}"><span class="row-value" style="font-weight:400">${l}<span class="muted row-sub">${sub}</span></span><span class="row-chev">›</span></button>`).join('')}</div>
            <button class="rp-copy" data-act="copy-report">Raporu kopyala</button></div>`;
    }

    function reportText() {
        return [`İndirici · video bulunamadı`, info.url, new Date().toLocaleString('tr-TR'), '',
            ...traceSteps().map((t) => `${t.state === 'ok' ? '✓' : t.state === 'fail' ? '✕' : '–'} ${t.label}${t.ms ? ' · ' + secText(t.ms) : ''}${t.note ? ' · ' + t.note : ''}`),
            ...(info.warnings.length ? ['', ...info.warnings] : [])].join('\n');
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
            dlBtn.innerHTML = dlButtonHtml();
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

    function goIdle() {
        closePreview();
        info = null;
        photosPage = null;
        showShared('');
        renderIdle();
        paintSuggest();
    }
    resTop.addEventListener('click', (e) => {
        if (e.target.closest('[data-act="back"]')) goIdle();
    });

    resultBox.addEventListener('click', async (e) => {
        const btn = e.target.closest('[data-act]');
        if (!btn || btn.disabled) return;
        const act = btn.dataset.act;
        const prefs = getPrefs();
        if (act === 'new-link') {
            goIdle();
            urlInput.value = '';
            urlInput.focus();
            return;
        }

        if (act === 'analyze-link') {
            const fromPage = info && info.target === 'page';
            const link = fromPage ? (info.details.links || []).find((l) => l.url === btn.dataset.url) : null;
            return analyze(btn.dataset.url, {
                pair: btn.dataset.pair || null, page: fromPage ? info.url : null, title: fromPage ? info.details.title || '' : '',
                fromYtdlp: btn.dataset.ytdlp === '1',
                subtitles: (link && link.subtitles) || (fromPage ? info.details.subtitles : null)
            });
        }
        if (act === 'more') {
            ui.moreOpen = true;
            return render();
        }
        if (act === 'audio-only') {
            ui.audioOnly = stickyAudio = Boolean(btn.dataset.v);
            return render();
        }
        if (act === 'format' && info && ui.formats) {
            const f = ui.formats[Number(btn.dataset.i)];
            if (!f || f.url === info.url) return;
            return analyze(f.url, {
                pair: f.audioUrl || null, page: ui.sourcePage, title: ui.name, fromYtdlp: true,
                subtitles: info.details.subtitles || null, formats: ui.formats
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
        if (act === 'setup') return openSetup ? openSetup(1) : navigate('settings');
        if (act === 'open-follow') return navigate('follow');
        if (act === 'recent-clear') {
            clearRecent();
            return renderIdle();
        }
        if (act === 'bulk' && onBulk) return onBulk(urlInput.value);
        if (act === 'bookmark') return openBookmarklet({ toast });
        if (!info) return;
        if (act === 'rescan') return analyze(info.url, { noExtract: true });
        if (act === 'focus-url') {
            urlInput.focus();
            urlInput.select();
            return toast('Videonun kendi sayfasının bağlantısını yapıştır');
        }
        if (act === 'copy-report') {
            navigator.clipboard.writeText(reportText()).then(() => {
                btn.textContent = 'Rapor kopyalandı ✓';
                btn.classList.add('done');
            }).catch(() => toast('Kopyalanamadı'));
            return;
        }
        if (act === 'follow' && onFollow) return onFollow(entryUrl || info.url);
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
        if (act === 'back') return goIdle();
        if (act === 'sub-toggle') {
            const i = Number(btn.dataset.i);
            if (ui.subs.has(i)) ui.subs.delete(i); else ui.subs.add(i);
        }
        if (act === 'sub-mode') ui.subMode = btn.dataset.v;
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
        if (act === 'toggle-bg') {
            if (canServerRecord()) setPref('serverBackground', prefs.serverBackground === false);
            else setPref('background', !prefs.background);
        }
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
    async function prepareSink(fileName, mime, { subtitles = true } = {}) {
        let saveMode = effectiveSaveMode(getPrefs().save);
        // Toplu eklemede her dosya için konum sorulamaz (dokunuş tek); İndirilenler'e kaydedilir.
        if (bulkMode && saveMode === 'disk') saveMode = 'downloads';
        let diskSink = null;
        if (saveMode === 'disk') diskSink = await createSink(fileName, { mode: 'disk', mime });
        const plan = bulkMode || !subtitles ? null : subtitlePlan(fileName);
        if (plan && plan.mode !== 'embed') queueSubtitleFiles(plan, fileName.replace(/\.[a-z0-9]{1,5}$/i, ''));
        if (plan && plan.mode !== 'srt') return { saveMode, createSinkFor: embedSink(plan, saveMode) };
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
        if (ui.audioOnly && canAudioOnly()) {
            try {
                return await startAudioDownload(queueOnly);
            } catch (err) {
                if (bulkMode) throw err;
                if (err.name !== 'AbortError') setError(err.message);
                return;
            }
        }
        const prefs = getPrefs();
        const isHls = info.target === 'hls' || (info.unreachable && info.kind === 'hls');
        const name = cleanName();
        // "Arka planda indir" + kendi sunucun: dosya sunucuda iner, bitince telefona alınır.
        const viaServer = prefs.serverBackground !== false && canServerRecord() && !info.unreachable && info.target !== 'dash' && !ui.rangeOpen;
        // Sunucu indiremezse (tek kullanımlık/oturumlu adres sunucuya 403/404 döner, sunucu kapalı...)
        // aynı iş telefonda, eskisi gibi (gerekirse "aç ve kaydet" yedeğiyle) sürer.
        const serverFirst = (opts, createSinkFor, localRun) => async (job) => {
            try {
                return await serverDownloadIntoJob(job, { ...opts, page: jobSource().page, createSinkFor });
            } catch (err) {
                if (job.signal.aborted || job.status !== 'active' || err.name === 'AbortError') throw err;
                if (job.hooks.cancel) job.hooks.cancel(); // sunucudaki yarım iş silinsin
                job.hooks.cancel = null;
                job.serverDl = null;
                job.captureId = null;
                job.bytes = 0;
                job.samples = [];
                job.received = 0;
                job.total = 0;
                job.setDetail(`Sunucu indiremedi (${shortError(err)}); telefonda indiriliyor`);
                return localRun(job);
            }
        };
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
                    source: jobSource(), resume: resumeRecipe(),
                    run: withCaptureFallback(async (job) => {
                        job.setDetail('Parça listesi hazırlanıyor...');
                        const [videoPlaylist, audioPlaylist] = await Promise.all([
                            dashPlaylist(mpd, variant, { mode, signal: job.signal }),
                            audioRep ? dashPlaylist(mpd, audioRep, { mode, signal: job.signal }) : null
                        ]);
                        return downloadHlsVod({ job, videoPlaylist, audioPlaylist, name, range, mode, createSinkFor });
                    }, { mediaUrl: info.url, kind: 'video', name, saveMode, createSinkFor })
                });
                if (!bulkMode) toast(queueOnly ? 'Sıraya eklendi · İndirmeler' : 'İndirme başladı · İndirmeler');
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
                const localRun = withCaptureFallback((job) => downloadHlsVod({
                    job, videoUrl, videoPlaylist, audioUrl, name, range, mode: prefs.conn, createSinkFor
                }), { mediaUrl: info.url, kind: 'hls', name, saveMode, createSinkFor });
                if (viaServer && !isServerStream(videoUrl) && !(ui.media && ui.media.live)) {
                    addJob({ name: name + ext, kind: 'hls', thumb, saveMode, source: jobSource(), resume: resumeRecipe(), now: true,
                        run: serverFirst({ url: videoUrl, audioUrl: audioUrl || '', name: name + ext, hls: true }, createSinkFor, localRun) });
                    if (!bulkMode) toast('Sunucunda indiriliyor · İndirmeler');
                    return;
                }
                addJob({
                    name: name + ext,
                    kind: 'hls',
                    thumb,
                    saveMode,
                    source: jobSource(), resume: resumeRecipe(),
                    run: localRun
                });
            } else {
                const fileName = name + currentExt();
                const { saveMode, createSinkFor } = await prepareSink(fileName, ui.audioUrl ? 'video/mp4' : info.mime);
                const thumb = await currentThumb();
                const url = info.url;
                // Sunucudaki yt-dlp akışı açılmazsa sunucu kendi adresini açamaz; sayfa açılıp kaydedilir.
                const mediaUrl = isServerStream(url) ? '' : url;
                const audioUrl = ui.audioUrl;
                const localRun = audioUrl
                    ? withCaptureFallback((job) => downloadMerged({
                        job, videoUrl: url, audioUrl, name, mode: prefs.conn, size: info.size, createSinkFor
                    }), { mediaUrl, kind: 'video', name, saveMode, createSinkFor })
                    : withCaptureFallback((job) => downloadFile({
                        job, url, name: fileName, mode: prefs.conn, background: prefs.background,
                        mime: info.mime, size: info.size, createSinkFor
                    }), { mediaUrl, kind: info.kind, name, saveMode, createSinkFor });
                if (viaServer) {
                    addJob({ name: fileName, kind: 'video', thumb, saveMode, source: jobSource(), resume: resumeRecipe(), now: true,
                        run: serverFirst({ url, audioUrl: audioUrl || '', name: fileName }, createSinkFor, localRun) });
                    if (!bulkMode) toast('Sunucunda indiriliyor · İndirmeler');
                    return;
                }
                addJob({
                    name: fileName,
                    kind: audioUrl ? 'video' : ['video', 'audio', 'image'].includes(info.kind) ? info.kind : 'file',
                    thumb,
                    saveMode,
                    source: jobSource(), resume: resumeRecipe(),
                    run: localRun
                });
            }
            if (!bulkMode) toast(queueOnly ? 'Sıraya eklendi · İndirmeler' : 'İndirme başladı · İndirmeler');
        } catch (err) {
            if (bulkMode) throw err;
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

    /**
     * Toplu ekleme: analiz edilmiş bir sonucu (Algıla ekranını değiştirmeden) sıraya ekler.
     * quality: 'best' | '1080' | '720' | 'audio'
     */
    async function enqueueResult(result, { quality = 'best', page = '', title = '', pair = null } = {}) {
        const saved = { info, ui, entryUrl };
        bulkMode = true;
        try {
            info = result;
            ui = initialUi(result, pair);
            ui.sourcePage = page || null;
            entryUrl = page || result.url;
            if (title && result.target !== 'page') ui.name = cleanTitle(title);
            const variants = (result.details && result.details.variants) || [];
            if (variants.length) {
                ui.variant = variantIndexFor(variants, quality);
                // Seçilen kalite ilk varyant değilse eldeki liste ona ait değil; indirirken okunur.
                if (ui.variant !== 0 && ui.media) ui.media = { ...ui.media, playlist: null };
            }
            // "Yalnızca ses": sesi ayrı bir kalite yoksa video indirilip sesi ayrılır.
            const v = variants[ui.variant];
            ui.audioOnly = quality === 'audio' && !(v && v.audioOnly) && canAudioOnly();
            await startDownload(true);
        } finally {
            bulkMode = false;
            ({ info, ui, entryUrl } = saved);
        }
    }

    return {
        enqueueResult,
        resumeFrom,
        paste: pasteAndAnalyze,
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
