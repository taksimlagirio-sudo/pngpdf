// Uygulama kabuğu: bölümler (alt sekme / kenar çubuğu), tema, PWA kurulumu, paylaşım hedefi.
import { $, autoConfigureLocalServer } from './util.js';
import { getPrefs, setPref, onPrefs } from './prefs.js';
import { initDownloads, setCurrentView, setFloatOpen, getJobs, interruptedCount } from './downloads.js';
import { initDetectTab } from './detect-tab.js';
import { initImagesTab } from './images.js';
import { initSettings } from './settings.js';
import { startInbox } from './servertools.js';
import { openSetup, parsePairLink, redeemPair } from './setup.js';
import { initLibraryTab } from './library-tab.js';
import { initFollow } from './follow.js';
import { openBulk } from './bulk.js';
import { createViewer } from './viewer.js';
import { createEditor } from './editor.js';
import { restoreServerRecordings } from './serverrec.js';
import { canFloat, toggleFloatingBar, onFloatStateChange } from './floatbar.js';
import { icon } from './icons.js';

let settingsTab = null; // Ayarlar açılınca sayaçları tazelemek için
let libraryTab = null;
let followTab = null;
const VIEWS = ['detect', 'images', 'library', 'downloads', 'follow', 'settings'];
// Eski sürümlerin sekme adresleri (kısayollar, yer imleri) yeni bölümlere düşsün.
const LEGACY = { mp4: 'detect', hls: 'detect', image: 'images', pdf: 'detect' };

/* ---- Tema ---- */
function applyTheme(theme) {
    const light = theme === 'light';
    if (light) document.documentElement.dataset.theme = 'light';
    else delete document.documentElement.dataset.theme;
    document.querySelector('meta[name="theme-color"]').content = light ? '#F3F1EC' : '#121110';
    document.querySelectorAll('[data-theme-toggle]').forEach((btn) => {
        btn.innerHTML = btn.classList.contains('theme-btn-side')
            ? `${icon(light ? 'moon' : 'sun')} Tema: ${light ? 'Açık' : 'Koyu'}`
            : icon(light ? 'moon' : 'sun');
    });
}
applyTheme(getPrefs().theme);
onPrefs((prefs, key) => {
    if (key === 'theme') applyTheme(prefs.theme);
});

/* ---- Kısa bildirim ---- */
let toastTimer = null;
function toast(text) {
    let el = document.querySelector('.toast');
    if (!el) {
        el = document.createElement('div');
        el.className = 'toast';
        el.setAttribute('role', 'status');
        document.body.appendChild(el);
    }
    el.textContent = text;
    el.classList.remove('hidden');
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => el.classList.add('hidden'), 2600);
}

/* ---- Bölümler ---- */
function navigate(name) {
    if (!VIEWS.includes(name)) name = LEGACY[name] || 'detect';
    document.body.dataset.view = name;
    VIEWS.forEach((v) => $(`view-${v}`).classList.toggle('active', v === name));
    // Takip, telefonda İndirmeler'in bir sekmesidir; alt çubukta İndirmeler seçili görünür.
    document.querySelectorAll('.tab, .nav-item').forEach((el) => el.classList.toggle('active',
        el.dataset.view === name || (name === 'follow' && el.classList.contains('tab') && el.dataset.view === 'downloads')));
    if (location.hash.slice(1) !== name) history.replaceState(history.state, '', `#${name}`);
    setCurrentView(name);
    if (name === 'settings' && settingsTab) settingsTab.refresh();
    if (name === 'library' && libraryTab) libraryTab.refresh();
    if (name === 'follow' && followTab) followTab.refresh();
    window.scrollTo(0, 0);
}

document.addEventListener('click', (e) => {
    // "Yapıştır ve algıla" her sekmede: Algıla'ya geçip panodaki bağlantıyı algılar.
    if (e.target.closest('[data-paste]')) {
        navigate('detect');
        detectTab.paste();
        return;
    }
    const themeBtn = e.target.closest('[data-theme-toggle]');
    if (themeBtn) {
        setPref('theme', getPrefs().theme === 'light' ? 'dark' : 'light');
        return;
    }
    const floatBtn = e.target.closest('[data-float-toggle]');
    if (floatBtn) {
        toggleFloatingBar().catch((err) => toast(err.message));
        return;
    }
    const target = e.target.closest('[data-view]');
    if (target && target !== document.body) navigate(target.dataset.view);
});
window.addEventListener('hashchange', () => navigate(location.hash.slice(1)));

initDownloads({
    onNavigate: navigate,
    onDetect: (url) => {
        navigate('detect');
        detectTab.prefill(url, true);
    },
    onResume: (recipe) => detectTab.resumeFrom(recipe)
});
if (interruptedCount()) toast(`${interruptedCount()} indirme yarıda kaldı · İndirmeler'den yeniden başlat`);

// Kendi sunucundan açıldıysa token'ı kendiliğinden al.
await autoConfigureLocalServer();

/* ---- Ana ekrana ekleme ---- */
let installPrompt = null;
const installListeners = new Set();
const setInstallable = (value) => installListeners.forEach((fn) => fn(value));
window.addEventListener('beforeinstallprompt', (event) => {
    event.preventDefault();
    installPrompt = event;
    setInstallable(true);
});
window.addEventListener('appinstalled', () => {
    installPrompt = null;
    setInstallable(false);
});
const standalone = window.matchMedia('(display-mode: standalone)').matches || window.navigator.standalone === true;

const install = {
    onAvailable(fn) {
        installListeners.add(fn);
        fn(Boolean(installPrompt));
    },
    available: () => Boolean(installPrompt),
    async prompt() {
        if (!installPrompt) return;
        installPrompt.prompt();
        await installPrompt.userChoice;
        installPrompt = null;
        setInstallable(false);
    },
    iosHint: !standalone && /iPhone|iPad|iPod/.test(navigator.userAgent)
};

const imagesTab = initImagesTab({ toast });
function showSetup(step = 1) {
    if (!settingsTab) return;
    openSetup({ connect: (config) => settingsTab.connect(config), toast, step });
}

const detectTab = initDetectTab({
    navigate,
    toast,
    openSetup: showSetup,
    onFollow: (url) => followTab && followTab.add(url),
    onBulk: (text) => openBulk({ text, enqueue: (r, o) => detectTab.enqueueResult(r, o), toast, navigate }),
    photos: imagesTab,
    install,
    openImages(pageUrl, urls, title) {
        navigate('images');
        imagesTab.open(pageUrl, urls, title);
    }
});

/* ---- Ayarlar + kenar çubuğundaki sunucu kartı ---- */
followTab = initFollow({ navigate, toast });
document.addEventListener('click', (e) => {
    if (e.target.closest('[data-follow-add]')) followTab.add('', 'live');
});
const viewer = createViewer({ toast });
const editor = createEditor({ toast });
viewer.setEditor((item, list) => editor.open(item, list));
libraryTab = initLibraryTab({ toast, viewer, onMerge: (items) => editor.merge(items) });

settingsTab = initSettings({
    install,
    toast,
    openStorage: () => libraryTab.openStorage(),
    openSetup: showSetup,
    onServerChange(server, version) {
        const card = $('sideServer');
        card.querySelector('.dot').classList.toggle('on', Boolean(server));
        let host = 'ayarlı değil';
        if (server) {
            try {
                host = new URL(server.url).host;
            } catch (_) { /* geçersiz adres */ }
            if (version) host += ` · v${version}`;
        }
        card.querySelector('.server-card-sub').textContent = host;
        detectTab.refresh();
    }
});

restoreServerRecordings();

// Bilgisayardan (yer imi düğmesiyle) gönderilen bağlantı gelince algılama başlar.
startInbox({
    onLink(url) {
        navigate('detect');
        detectTab.prefill(url, true, { shared: true });
        toast('Bilgisayardan bağlantı geldi');
    }
});
// Telefon uygulamayı alta alınca sayfayı dondurabilir ya da kapatabilir; kayıtlar sunucuda sürer.
// Öne gelince sunucudaki kayıtlarla yeniden eşitlenir (eksik olanlar eklenir, bitenler iner).
document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible') restoreServerRecordings();
});

/* ---- Diğer uygulamaların üstünde yüzen mini pencere ---- */
if (canFloat) {
    document.body.classList.add('can-float');
    onFloatStateChange(setFloatOpen);
}

/* ---- Paylaşım hedefi: başka uygulamadan paylaşılan bağlantı ---- */
const params = new URLSearchParams(location.search);
let shared = [params.get('url'), params.get('text'), params.get('title')]
    .filter(Boolean)
    .map((value) => (value.match(/https?:\/\/\S+/) || [])[0])
    .find(Boolean);
// Paylaşımdan hemen sonra sayfa (güncelleme yüzünden) yenilenirse bağlantı kaybolmasın.
try {
    if (shared) sessionStorage.setItem('indirici.share', JSON.stringify({ url: shared, at: Date.now() }));
    else {
        const saved = JSON.parse(sessionStorage.getItem('indirici.share') || 'null');
        if (saved && Date.now() - saved.at < 20000) shared = saved.url;
        sessionStorage.removeItem('indirici.share');
    }
} catch (_) { /* depolama kapalı */ }

// QR ile bağlanma: sunucunun "/baglan" QR'ı telefon kamerasıyla okutulunca …/?pair=KOD açılır.
const pairLink = params.get('pair') ? parsePairLink(location.href) : null;
if (pairLink) {
    history.replaceState(null, '', location.pathname + '#settings');
    navigate('settings');
    redeemPair(pairLink)
        .then((config) => settingsTab.connect(config))
        .then(() => toast('Sunucuna bağlandı'))
        .catch((err) => toast(`Bağlanılamadı: ${err.message}`));
} else if (shared) {
    history.replaceState(null, '', location.pathname + '#detect');
    navigate('detect');
    detectTab.prefill(shared, true, { shared: true });
} else {
    navigate(location.hash.slice(1) || 'detect');
}

/* ---- Geri tuşu: uygulamadan çıkmak yerine açık ekranı kapatır ---- */
// Geçmişe bir "bekçi" kaydı eklenir; geri tuşu onu tüketince önce en üstteki pencere/sayfa kapanır,
// sonra Algıla'ya dönülür. Algıla'da süren indirme varsa çıkmak için iki kez basmak gerekir.
let exitArmed = 0;
function handleBack() {
    const layers = [...document.querySelectorAll('.remote-overlay, .sheet-backdrop, .ss-sheet')];
    const top = layers[layers.length - 1];
    if (top) {
        if (top.matches('.remote-overlay')) {
            // Tam ekrandaki oynatıcı önce tam ekrandan çıkar.
            const fs = top.classList.contains('fs') && top.querySelector('[data-v="fs"]');
            if (fs) {
                fs.click();
                return true;
            }
            const btn = ['.back-btn', '[aria-label="Kapat"]', '[data-r="close"]', '[data-a="close"]']
                .map((sel) => top.querySelector(sel)).find(Boolean);
            if (btn) btn.click();
            if (top.isConnected && !btn) {
                top.remove();
                if (!document.querySelector('.remote-overlay')) document.documentElement.classList.remove('remote-open');
            }
        } else {
            top.click(); // arka plana dokunmak sayfayı kapatır
            if (top.isConnected) top.remove();
        }
        return true;
    }
    const view = document.querySelector('.view.active');
    const inner = view && [...view.querySelectorAll('.back-btn')].find((b) => b.offsetParent !== null);
    if (inner) {
        inner.click();
        return true;
    }
    if (document.body.dataset.view !== 'detect') {
        navigate('detect');
        return true;
    }
    const busy = getJobs().some((j) => j.status === 'active' && !j.bgId && !j.serverRec && !j.serverDl);
    if (busy && Date.now() - exitArmed > 2500) {
        exitArmed = Date.now();
        toast('İndirme sürüyor; çıkarsan durur. Çıkmak için bir daha bas');
        return true;
    }
    return false;
}
history.replaceState({ root: true }, '', location.href);
history.pushState({ guard: true }, '', location.href);
window.addEventListener('popstate', (e) => {
    // Yalnızca bekçinin altına inildiyse (geri tuşu) ele alınır; #sekme değişimleri kendi yolunda.
    if (!e.state || !e.state.root) return;
    // Kök kaydın adresi eski sekmeyi gösterebilir; bekçi şu anki sekmeyle yeniden eklenir.
    if (handleBack()) history.pushState({ guard: true }, '', `${location.pathname}${location.search}#${document.body.dataset.view}`);
    else history.back();
});

/* ---- Paylaşım uygulama açıkken gelirse (launch_handler) ----
 * Manifest "navigate-existing" kullanır: "focus-existing" Android'de paylaşılan bağlantıyı düşürüyordu
 * (uygulama öne gelir ama bağlantı gelmez, ikinci paylaşım gerekir). Açık pencere paylaşım adresine
 * gider; bağlantı hem adres satırından hem launchQueue'dan okunur, aynısı iki kez işlenmez. */
if ('launchQueue' in window) {
    let lastShared = shared || '';
    window.launchQueue.setConsumer((launch) => {
        if (!launch || !launch.targetURL) return;
        const p = new URL(launch.targetURL).searchParams;
        const link = [p.get('url'), p.get('text'), p.get('title')].filter(Boolean)
            .map((v) => (v.match(/https?:\/\/\S+/) || [])[0]).find(Boolean);
        if (!link || link === lastShared) return;
        lastShared = link;
        navigate('detect');
        detectTab.prefill(link, true, { shared: true });
    });
}

/* ---- Service worker ---- */
if ('serviceWorker' in navigator) {
    // Yeni sürüm kontrolü devralınca sayfayı bir kez yenile; yoksa bellekteki eski kod yeni dosyalarla
    // karışır. İlk kurulumda yenileme yapılmaz. Süren bir indirme/kayıt varsa yenileme ertelenir.
    let hasController = Boolean(navigator.serviceWorker.controller);
    let reloading = false;
    navigator.serviceWorker.addEventListener('controllerchange', () => {
        if (!hasController) {
            hasController = true;
            return;
        }
        if (reloading || getJobs().some((j) => j.status === 'active' || j.status === 'queued')) return;
        reloading = true;
        location.reload();
    });
    window.addEventListener('load', () => {
        navigator.serviceWorker.register('sw.js').catch((err) => console.warn('SW kaydı başarısız:', err));
    });
}
