// Hesaplar: kullanıcının sitelere girişleri. Giriş, sitenin giriş sayfası "Kendim dokunayım" ekranında
// açılarak yapılır; sunucu girişi algılayıp saklar (şifre değil, sitenin verdiği giriş çerezi).
// Sunucu girişin düşüp düşmediğini çerezlerden ve sayfaların giriş istemesinden anlar.
import { escapeHtml, renderApi } from './util.js';
import { icon } from './icons.js';
import { openRemoteOverlay } from './remote.js';

const STATUS = {
    on: ['Girili', 'on'],
    lost: ['Düştü', 'lost'],
    never: ['Girilmedi', 'never']
};

function ago(ms) {
    if (!ms) return '';
    const min = Math.round((Date.now() - ms) / 60000);
    if (min < 2) return 'az önce';
    if (min < 60) return `${min} dk önce`;
    const h = Math.round(min / 60);
    if (h < 24) return `${h} saat önce`;
    const d = Math.round(h / 24);
    return d < 14 ? `${d} gün önce` : `${Math.round(d / 7)} hafta önce`;
}

/**
 * Bir siteye giriş: sunucu giriş sayfasını verir, sayfa "Kendim dokunayım" ekranında açılır;
 * giriş algılanınca onDone çağrılır (ekran "Tamam" ile kapanır).
 * @param {string} site  site adresi ya da alan adı (instagram.com, https://site.com/login)
 */
export async function openAccountLogin(site, { onDone = () => {}, onClose = () => {}, toast = () => {} } = {}) {
    // APK: giriş telefonun kendi tarayıcısında da yapılabilir (robot sayılmaz); önce sorulur.
    if (window.IndiriciAndroid && window.IndiriciAndroid.loginOnPhone) {
        const where = await askWhere();
        if (!where) return null;
        if (where === 'phone') return loginOnPhone(site, { onDone, onClose, toast });
    }
    let acc;
    try {
        acc = await renderApi('/accounts', {
            method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ url: site })
        }, 10000);
    } catch (err) {
        toast(err.status === 404 ? 'Sunucun eski; güncelleyip (git pull) yeniden başlat' : err.message);
        return null;
    }
    let done = false;
    return openRemoteOverlay(acc.login, {
        account: { domain: acc.domain, name: acc.name },
        onLogin: () => { done = true; },
        onClose: () => {
            onClose();
            if (done) onDone(acc);
        }
    });
}

/** APK: girişin nerede yapılacağı (telefonda / sunucuda). */
function askWhere() {
    return new Promise((resolve) => {
        const el = document.createElement('div');
        el.className = 'sheet-backdrop acc-sheet';
        el.innerHTML = `<div class="acc-sheet-box" role="dialog" aria-label="Nerede giriş yapılsın"><span class="cf-grip"></span>
            <b class="acc-sheet-title">Nerede giriş yapılsın?</b>
            <button class="acc-where" data-w="phone"><b>Telefonumda gir <i>önerilen</i></b>
                <small>Sayfa bu telefonda açılır; "Google ile giriş" dahil normal çalışır. Bitince giriş sunucuna aktarılır.</small></button>
            <button class="acc-where" data-w="server"><b>Sunucuda gir</b>
                <small>Sayfa sunucudaki tarayıcıda açılır (Kendim dokunayım). Bazı siteler bunu robot sayabilir.</small></button></div>`;
        document.body.appendChild(el);
        requestAnimationFrame(() => el.classList.add('in'));
        el.addEventListener('click', (e) => {
            const b = e.target.closest('[data-w]');
            if (e.target !== el && !b) return;
            el.remove();
            resolve(b ? b.dataset.w : null);
        });
    });
}

/** Telefonumda gir: APK giriş sayfasını açar, giriş bitince sitenin çerezlerini verir; sunucuya aktarılır. */
async function loginOnPhone(site, { onDone, onClose, toast }) {
    let acc;
    try {
        acc = await renderApi('/accounts', {
            method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ url: site })
        }, 10000);
    } catch (err) {
        toast(err.status === 404 ? 'Sunucun eski; güncelleyip (git pull) yeniden başlat' : err.message);
        return null;
    }
    window.__indiriciPhoneLogin = async (json) => {
        window.__indiriciPhoneLogin = null;
        let cookies = [];
        try {
            cookies = JSON.parse(json || '[]');
        } catch (_) { /* boş */ }
        if (!cookies.length) {
            onClose();
            return toast('Giriş tamamlanmadı');
        }
        try {
            const r = await renderApi('/accounts/import', {
                method: 'POST', headers: { 'content-type': 'application/json' },
                body: JSON.stringify({ text: JSON.stringify(cookies), domain: acc.domain })
            }, 20000);
            onClose();
            if (r.accounts.length) {
                toast(`${acc.name} girişi sunucuna aktarıldı`);
                onDone(acc);
            } else {
                toast('Giriş algılanmadı; sayfada girişi bitirip "Bitti"ye bas');
            }
        } catch (err) {
            onClose();
            toast(err.message);
        }
    };
    window.IndiriciAndroid.loginOnPhone(acc.login, acc.domain, acc.name, JSON.stringify(acc.auth || []));
    return { close() {} };
}

/** Ayarlar › Hesaplar: liste, düşen giriş uyarısı, hesap ekle, diğer çerezler. */
export function mountAccounts(box, { toast = () => {}, onCount = () => {} } = {}) {
    let data = null;
    let showOthers = false;

    async function load() {
        try {
            data = await renderApi('/accounts', {}, 8000);
        } catch (err) {
            data = { error: err.status === 404 ? 'old' : 'off' };
        }
        paint();
    }

    function paint() {
        if (!data || data.error) {
            box.innerHTML = `<p class="hint">${data && data.error === 'old'
                ? 'Sunucun hesapları bilmeyen eski bir sürüm; güncelleyip (git pull) yeniden başlat.'
                : 'Hesaplar kendi sunucunda saklanır; sunucuna bağlanınca burada görünür.'}</p>`;
            onCount(null);
            return;
        }
        if (!data.enabled) {
            box.innerHTML = '<p class="hint">Sunucun girişleri saklamıyor (<code>SAVE_LOGINS=0</code> ile başlatılmış).</p>';
            onCount(null);
            return;
        }
        const list = [...data.accounts].sort((a, b) => (b.loginAt || b.addedAt) - (a.loginAt || a.addedAt));
        const lost = list.filter((a) => a.status === 'lost');
        onCount({ total: list.filter((a) => a.status !== 'never').length, lost: lost.length });
        const row = (a) => {
            const [label, cls] = STATUS[a.status] || STATUS.never;
            const note = a.status === 'on' ? `${ago(a.loginAt)} girildi`
                : a.status === 'lost' ? (a.lostAt ? `${ago(a.lostAt)} düştü · yeniden gir` : 'Girişin süresi doldu · yeniden gir')
                    : 'Giriş bekleniyor · dokun';
            return `<button class="acc-row" data-acc="${escapeHtml(a.domain)}">
                <span class="acc-ic">${escapeHtml((a.name || a.domain)[0].toUpperCase())}</span>
                <span class="acc-t"><b>${escapeHtml(a.name || a.domain)}</b><small>${escapeHtml(note)}</small></span>
                <span class="acc-chip ${cls}"><i></i>${label}</span></button>`;
        };
        box.innerHTML = `
            <p class="hint acc-intro">Giriş yaptığın siteler. Sunucun girişi saklar, videoları bu hesaplarla açar. Şifren hiçbir yerde saklanmaz.</p>
            ${list.length ? `<div class="acc-list">${list.map(row).join('')}</div>` : '<p class="hint">Henüz hesap yok. Bir siteye bir kez giriş yaparsan girili kalır.</p>'}
            ${lost.length ? `<div class="acc-warn"><span class="acc-warn-ic">${icon('alert')}</span>
                <span>${escapeHtml(lost[0].name)} girişi düşmüş.${lost.length > 1 ? ` (+${lost.length - 1} hesap)` : ''} Yeniden girince o sitenin videoları yine açılır.</span>
                <button data-acc-login="${escapeHtml(lost[0].domain)}">Yeniden gir</button></div>` : ''}
            <button class="btn-big acc-add" data-acc-add>${icon('plus')}Hesap ekle</button>
            <button class="btn-ghost acc-others" data-acc-import>Çerezleri içe aktar</button>
            ${data.others.length ? `<button class="btn-ghost acc-others" data-acc-others>${showOthers ? 'Diğer çerezleri gizle' : `Diğer çerezleri gör · ${data.others.length} site`}</button>` : ''}
            ${showOthers ? `<div class="rows filled acc-others-list">${data.others.map((s) => `<div class="row"><span class="row-label">${escapeHtml(s.domain)}</span>
                <span class="row-value muted">${s.cookies} çerez</span><button class="link-btn" data-acc-clear="${escapeHtml(s.domain)}">Sil</button></div>`).join('')}</div>
                <p class="hint">Reklam, takip ve hesap olmayan sitelerin çerezleri. Silmek o sitenin oturumunu da kapatır.</p>` : ''}`;
    }

    const login = (site) => openAccountLogin(site, {
        toast,
        onDone: (acc) => toast(`${acc.name} girişi kaydedildi`),
        onClose: () => load()
    });

    function openAdd() {
        const known = (data.known || []).filter((k) => !data.accounts.some((a) => a.domain === k.domain && a.status === 'on'));
        const el = document.createElement('div');
        el.className = 'sheet-backdrop acc-sheet';
        el.innerHTML = `<div class="acc-sheet-box" role="dialog" aria-label="Hesap ekle"><span class="cf-grip"></span>
            <b class="acc-sheet-title">Hesap ekle</b>
            <div class="acc-known">${known.map((k) => `<button data-acc-site="${escapeHtml(k.domain)}"><span class="acc-ic">${escapeHtml(k.name[0])}</span>${escapeHtml(k.name)}</button>`).join('')}</div>
            <form class="acc-form" novalidate><label class="hint" for="accUrl">Başka bir site</label>
                <div class="acc-form-row"><input id="accUrl" type="url" inputmode="url" placeholder="site.com ya da giriş sayfasının adresi" autocomplete="off">
                <button class="btn-big" type="submit">Aç</button></div></form>
            <p class="hint">Sitenin giriş sayfası sunucunda açılır; sen girersin, sunucu girişi algılayıp saklar.</p></div>`;
        document.body.appendChild(el);
        requestAnimationFrame(() => el.classList.add('in'));
        const close = () => el.remove();
        el.addEventListener('click', (e) => {
            if (e.target === el) return close();
            const b = e.target.closest('[data-acc-site]');
            if (b) {
                close();
                login(b.dataset.accSite);
            }
        });
        el.querySelector('form').addEventListener('submit', (e) => {
            e.preventDefault();
            const v = el.querySelector('input').value.trim();
            if (!v) return;
            close();
            login(v);
        });
    }

    /** Giriş sunucuda reddedilirse (ör. Google): başka tarayıcıdaki girişin çerezleri buraya yapıştırılır. */
    function openImport() {
        const el = document.createElement('div');
        el.className = 'sheet-backdrop acc-sheet';
        el.innerHTML = `<div class="acc-sheet-box" role="dialog" aria-label="Çerezleri içe aktar"><span class="cf-grip"></span>
            <b class="acc-sheet-title">Çerezleri içe aktar</b>
            <p class="hint">Bir site (ör. Google) sunucudaki tarayıcıda girişe izin vermezse: siteye kendi tarayıcında gir,
                çerezleri dışa aktar ve buraya ver. Telefonda Firefox + <b>Cookie-Editor</b> eklentisi (Dışa aktar › JSON ya da
                Netscape), bilgisayarda <b>Get cookies.txt LOCALLY</b> eklentisi olur.</p>
            <textarea class="acc-import-text" rows="6" placeholder="cookies.txt ya da JSON içeriğini yapıştır" spellcheck="false"></textarea>
            <div class="acc-form-row"><label class="btn-ghost acc-file">Dosya seç<input type="file" accept=".txt,.json,text/plain,application/json" hidden></label>
                <button class="btn-big" data-imp="go">İçe aktar</button></div>
            <p class="hint">Çerezler yalnızca kendi sunucunda saklanır. Çerez, o hesaba giriş anahtarıdır: kimseyle paylaşma.</p></div>`;
        document.body.appendChild(el);
        requestAnimationFrame(() => el.classList.add('in'));
        const ta = el.querySelector('textarea');
        el.querySelector('input[type=file]').addEventListener('change', async (e) => {
            const f = e.target.files && e.target.files[0];
            if (f) ta.value = await f.text();
        });
        el.addEventListener('click', async (e) => {
            if (e.target === el) return el.remove();
            if (!e.target.closest('[data-imp="go"]')) return;
            const text = ta.value.trim();
            if (!text) return toast('Önce çerezleri yapıştır ya da dosya seç');
            try {
                const r = await renderApi('/accounts/import', {
                    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ text })
                }, 20000);
                el.remove();
                toast(r.accounts.length ? `${r.accounts.join(', ')} girişi eklendi` : `${r.added} çerez eklendi`);
                load();
            } catch (err) {
                toast(err.status === 404 ? 'Sunucun eski; güncelleyip (git pull) yeniden başlat' : err.message);
            }
        });
    }

    function openAccount(a) {
        const el = document.createElement('div');
        el.className = 'sheet-backdrop acc-sheet';
        el.innerHTML = `<div class="acc-sheet-box" role="dialog" aria-label="${escapeHtml(a.name)}"><span class="cf-grip"></span>
            <b class="acc-sheet-title">${escapeHtml(a.name)}</b><span class="hint">${escapeHtml(a.domain)}${a.loginAt ? ` · ${ago(a.loginAt)} girildi` : ''}</span>
            <button class="btn-big" data-a="login">${a.status === 'on' ? 'Yeniden gir' : a.status === 'lost' ? 'Yeniden gir' : 'Giriş yap'}</button>
            <button class="btn-ghost acc-out" data-a="out">${a.status === 'never' ? 'Listeden kaldır' : 'Çıkış yap ve sil'}</button></div>`;
        document.body.appendChild(el);
        requestAnimationFrame(() => el.classList.add('in'));
        el.addEventListener('click', async (e) => {
            if (e.target === el) return el.remove();
            const b = e.target.closest('[data-a]');
            if (!b) return;
            el.remove();
            if (b.dataset.a === 'login') return login(a.domain);
            try {
                await renderApi(`/accounts?domain=${encodeURIComponent(a.domain)}`, { method: 'DELETE' }, 8000);
                toast(`${a.name} girişi silindi`);
            } catch (err) {
                toast(err.message);
            }
            load();
        });
    }

    box.addEventListener('click', async (e) => {
        if (!data || data.error) return;
        const t = e.target.closest('[data-acc], [data-acc-login], [data-acc-add], [data-acc-others], [data-acc-clear], [data-acc-import]');
        if (!t) return;
        if (t.dataset.accLogin) return login(t.dataset.accLogin);
        if ('accAdd' in t.dataset) return openAdd();
        if ('accImport' in t.dataset) return openImport();
        if ('accOthers' in t.dataset) {
            showOthers = !showOthers;
            return paint();
        }
        if (t.dataset.accClear) {
            await renderApi(`/logins?domain=${encodeURIComponent(t.dataset.accClear)}`, { method: 'DELETE' }, 8000).catch(() => {});
            return load();
        }
        const a = data.accounts.find((x) => x.domain === t.dataset.acc);
        if (!a) return;
        if (a.status === 'never') return login(a.domain);
        openAccount(a);
    });

    return { reload: load };
}
