// Sekme yönetimi, PWA kurulumu ve paylaşım hedefi
import { $ } from './util.js';
import { initDownloadBar } from './downloads.js';
import { initPdfTab } from './pdf.js';
import { initImageTab } from './image.js';
import { initVideoTab } from './video.js';
import { initHlsTab } from './hls.js';
import { initDetectTab } from './detect-tab.js';
import { canFloat, toggleFloatingBar, onFloatStateChange } from './floatbar.js';

const tabs = Array.from(document.querySelectorAll('.tab'));
const panels = Array.from(document.querySelectorAll('.panel'));

function activate(name) {
    tabs.forEach((t) => t.classList.toggle('active', t.dataset.tab === name));
    panels.forEach((p) => p.classList.toggle('active', p.id === `panel-${name}`));
    if (location.hash.slice(1) !== name) history.replaceState(null, '', `#${name}`);
}

tabs.forEach((tab) => tab.addEventListener('click', () => activate(tab.dataset.tab)));
window.addEventListener('hashchange', () => {
    const name = location.hash.slice(1);
    if (tabs.some((t) => t.dataset.tab === name)) activate(name);
});

initDownloadBar();
initPdfTab();
initImageTab();
initVideoTab();
initHlsTab();
const detectTab = initDetectTab();

/* ---- Diğer uygulamaların üstünde yüzen mini pencere ---- */
const floatBtn = $('taskbarFloatBtn');
if (canFloat) {
    floatBtn.classList.remove('hidden');
    floatBtn.addEventListener('click', async (event) => {
        event.stopPropagation(); // alt çubuğun aç/kapa davranışını tetiklemesin
        try {
            await toggleFloatingBar();
        } catch (err) {
            console.warn('Yüzen pencere açılamadı:', err);
            floatBtn.title = err.message;
        }
    });
    onFloatStateChange((open) => {
        floatBtn.textContent = open ? '✕' : '🪟';
        floatBtn.title = open ? 'Yüzen pencereyi kapat' : 'Diğer uygulamaların üstünde mini pencere';
    });
} else {
    $('floatHint').textContent = '🪟 Yüzen mini pencere bu tarayıcıda desteklenmiyor (Android Chrome ve masaüstü Chrome destekler).';
}

/* ---- Paylaşım hedefi: başka uygulamadan paylaşılan bağlantı ---- */
const params = new URLSearchParams(location.search);
const shared = [params.get('url'), params.get('text'), params.get('title')]
    .filter(Boolean)
    .map((value) => (value.match(/https?:\/\/\S+/) || [])[0])
    .find(Boolean);

let initialTab = location.hash.slice(1);
if (shared) {
    detectTab.prefill(shared, true);
    initialTab = 'detect';
    history.replaceState(null, '', location.pathname + '#detect');
}
activate(tabs.some((t) => t.dataset.tab === initialTab) ? initialTab : 'detect');

/* ---- Service worker ---- */
if ('serviceWorker' in navigator) {
    window.addEventListener('load', () => {
        navigator.serviceWorker.register('sw.js').catch((err) => console.warn('SW kaydı başarısız:', err));
    });
}

/* ---- Ana ekrana ekleme ---- */
const installBtn = $('installBtn');
const iosHint = $('iosInstallHint');
let installPrompt = null;

window.addEventListener('beforeinstallprompt', (event) => {
    event.preventDefault();
    installPrompt = event;
    installBtn.classList.remove('hidden');
});

installBtn.addEventListener('click', async () => {
    if (!installPrompt) return;
    installPrompt.prompt();
    const { outcome } = await installPrompt.userChoice;
    if (outcome === 'accepted') installBtn.classList.add('hidden');
    installPrompt = null;
});

window.addEventListener('appinstalled', () => {
    installBtn.classList.add('hidden');
    installPrompt = null;
});

// iOS'ta beforeinstallprompt yok; kullanıcıya yolu tarif ediyoruz.
const standalone = window.matchMedia('(display-mode: standalone)').matches || window.navigator.standalone === true;
if (!standalone && /iPhone|iPad|iPod/.test(navigator.userAgent)) {
    iosHint.classList.remove('hidden');
}
