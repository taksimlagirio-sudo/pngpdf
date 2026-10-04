// Uygulama kabuğu: bölümler (alt sekme / kenar çubuğu), tema, PWA kurulumu, paylaşım hedefi.
import { $, autoConfigureLocalServer } from './util.js';
import { getPrefs, setPref, onPrefs } from './prefs.js';
import { initDownloads, setCurrentView, setFloatOpen, getJobs } from './downloads.js';
import { initDetectTab } from './detect-tab.js';
import { initImagesTab } from './images.js';
import { initSettings } from './settings.js';
import { openSetup, parsePairLink, redeemPair } from './setup.js';
import { initLibraryTab } from './library-tab.js';
import { initFollow } from './follow.js';
import { createViewer } from './viewer.js';
import { createEditor } from './editor.js';
import { restoreServerRecordings } from './serverrec.js';
import { canFloat, toggleFloatingBar, onFloatStateChange } from './floatbar.js';

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
        btn.textContent = btn.classList.contains('theme-btn-side')
            ? `${light ? '☾' : '☀'}  Tema: ${light ? 'Açık' : 'Koyu'}`
            : light ? '☾' : '☀';
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
    if (location.hash.slice(1) !== name) history.replaceState(null, '', `#${name}`);
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
    }
});

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
libraryTab = initLibraryTab({ toast, viewer });

settingsTab = initSettings({
    install,
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
const shared = [params.get('url'), params.get('text'), params.get('title')]
    .filter(Boolean)
    .map((value) => (value.match(/https?:\/\/\S+/) || [])[0])
    .find(Boolean);

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
