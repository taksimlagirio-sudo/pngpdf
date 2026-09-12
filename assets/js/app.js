// Sekme yönetimi ve modüllerin başlatılması
import { initPdfTab } from './pdf.js';
import { initImageTab } from './image.js';
import { initVideoTab } from './video.js';
import { initHlsTab } from './hls.js';

const tabs = Array.from(document.querySelectorAll('.tab'));
const panels = Array.from(document.querySelectorAll('.panel'));

function activate(name) {
    tabs.forEach((t) => t.classList.toggle('active', t.dataset.tab === name));
    panels.forEach((p) => p.classList.toggle('active', p.id === `panel-${name}`));
    if (location.hash.slice(1) !== name) {
        history.replaceState(null, '', `#${name}`);
    }
}

tabs.forEach((tab) => tab.addEventListener('click', () => activate(tab.dataset.tab)));
window.addEventListener('hashchange', () => {
    const name = location.hash.slice(1);
    if (tabs.some((t) => t.dataset.tab === name)) activate(name);
});

initPdfTab();
initImageTab();
initVideoTab();
initHlsTab();

const initial = location.hash.slice(1);
activate(tabs.some((t) => t.dataset.tab === initial) ? initial : 'pdf');
