// Alttan açılan onay sayfası: tarayıcının gri onay kutusu (confirm) yerine.
import { escapeHtml, formatSize, clock } from './util.js';
import { icon } from './icons.js';

/**
 * @param {object} o
 * @param {string} o.title     Soru ("Sunucudan silinsin mi?")
 * @param {string} [o.text]    Açıklama
 * @param {string} o.confirm   Onay düğmesi ("Sil")
 * @param {boolean} [o.danger] Kırmızı düğme ve çöp kutusu ikonu
 * @param {object[]} [o.items] Kitaplık öğeleri: ilki küçük resmiyle gösterilir, fazlası sayılır
 * @returns {Promise<boolean>}
 */
export function confirmSheet({ title, text = '', confirm = 'Tamam', cancel = 'Vazgeç', danger = false, items = [] }) {
    return new Promise((resolve) => {
        const el = document.createElement('div');
        el.className = 'sheet-backdrop cf-sheet';
        const first = items[0];
        const where = first ? (first.server ? 'Sunucumda' : 'Bu cihazda') : '';
        el.innerHTML = `<div class="cf-box" role="dialog" aria-modal="true" aria-label="${escapeHtml(title)}">
            <span class="cf-grip"></span>
            ${first ? `<div class="cf-item">
                <span class="cf-th" style="${first.thumb ? `background-image:url('${first.thumb}')` : ''}">${first.thumb ? '' : icon(first.kind === 'audio' ? 'music' : first.kind === 'photo' ? 'image' : 'film')}${first.duration ? `<i>${clock(first.duration)}</i>` : ''}</span>
                <span class="cf-meta"><b>${escapeHtml(items.length > 1 ? `${first.name} ve ${items.length - 1} öğe daha` : first.name)}</b>
                    <small>${escapeHtml([where, items.length === 1 && first.size ? formatSize(first.size) : ''].filter(Boolean).join(' · '))}</small></span></div>` : ''}
            <div class="cf-text"><b>${escapeHtml(title)}</b>${text ? `<span>${escapeHtml(text)}</span>` : ''}</div>
            <div class="cf-btns">
                <button class="cf-ok${danger ? ' danger' : ''}" data-c="ok">${danger ? icon('trash') : ''}${escapeHtml(confirm)}</button>
                <button class="cf-no" data-c="no">${escapeHtml(cancel)}</button>
            </div></div>`;
        document.body.appendChild(el);
        const done = (v) => {
            el.classList.add('out');
            setTimeout(() => el.remove(), 160);
            resolve(v);
        };
        el.addEventListener('click', (e) => {
            if (e.target === el) return done(false);
            const b = e.target.closest('[data-c]');
            if (b) done(b.dataset.c === 'ok');
        });
        // Geri tuşu (app.js) arka plana dokunur → vazgeçilmiş sayılır.
        requestAnimationFrame(() => el.classList.add('in'));
        el.querySelector('[data-c="no"]').focus();
    });
}
