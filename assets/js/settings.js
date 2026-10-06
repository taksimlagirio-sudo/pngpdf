// "Ayarlar" ekranı: tema, varsayılan indirme ayarları, kendi sunucum, ana ekrana ekleme.
import { $, isHttpUrl, getRenderServer, setRenderServer, checkRenderServer, renderApi, escapeHtml } from './util.js';
import { getPrefs, setPref, onPrefs, SAVE_LABELS, CONN_LABELS } from './prefs.js';
import { effectiveSaveMode, canSaveToDisk, canShareFiles, canBackgroundFetch } from './downloads.js';
import { siteSettings, openSiteSettings } from './sitesettings.js';
import { openBookmarklet, openServerStatus } from './servertools.js';
import { icon } from './icons.js';
import { libUsage } from './library.js';
import { formatSize } from './util.js';
import { mountAccounts } from './accounts.js';

const BIG_LABELS = { ask: 'Sor', ytdlp: 'Açık', ours: 'Kapalı' };

export function initSettings({ onServerChange, install, toast = () => {}, openSetup = () => {}, openStorage = () => {} }) {
    const root = $('settingsView');
    root.innerHTML = `
        <div class="st-card" data-part="srvcard"></div>
        <div class="st-groups" data-part="groups"></div>

        <div class="st-sub" data-sub="conn">
            <div class="wz-top"><button class="back-btn" data-set="sub-back" aria-label="Geri">${icon('back')}</button><span>Sunucu bağlantısı</span></div>
            <div class="settings-sec-head"><span class="sec-label">Kendi sunucum</span>
                <span class="status-chip" data-part="chip">Kapalı</span></div>
            <div class="server-panel">
                <span class="hint">Sayfalar gerçek bir tarayıcıda açılır, CORS'a kapalı siteler bu sunucu üzerinden iner
                    ve canlı yayınlar telefon kilitliyken de orada kaydedilir. Bilgisayarında ya da telefonda Termux ile
                    <code>render-server</code>'ı çalıştır.</span>
                <label class="field"><span class="field-label">Adres</span>
                    <input class="input" type="url" id="serverUrl" placeholder="https://bilgisayarim.tailXXXX.ts.net" autocomplete="off"></label>
                <label class="field"><span class="field-label">Token</span>
                    <input class="input" type="password" id="serverToken" placeholder="Sunucu açılışta yazdırır" autocomplete="off" style="letter-spacing:.1em"></label>
                <div class="btn-row">
                    <button class="btn-ghost" id="serverWizardBtn">Kurulum</button>
                    <button class="btn-ghost" id="serverQrBtn">QR ile bağlan</button>
                </div>
                <div class="btn-row">
                    <button class="btn-ghost" id="serverClearBtn">Kapat</button>
                    <button class="btn-ac" id="serverSaveBtn">Kaydet ve test et</button>
                </div>
                <p class="hint" id="serverStatus"></p>
            </div>
        </div>

        <div class="st-sub" data-sub="adblock">
            <div class="wz-top"><button class="back-btn" data-set="sub-back" aria-label="Geri">${icon('back')}</button><span>Reklam engelleme</span></div>
            <div class="settings-sec-head"><span class="sec-label">Durum</span>
                <span class="status-chip" id="adblockChip">Sunucu yok</span></div>
            <div class="server-panel">
                <span class="hint" id="adblockText">Kendi sunucun ayarlanınca, sunucunun açtığı sayfalarda reklamlar,
                    açılır pencereler ve reklama yönlendirmeler engellenir.</span>
                <div class="ad-stats hidden" id="adStats">
                    <div><b id="adBlocked">0</b><span>engellenen istek</span></div>
                    <div><b id="adVideo">0</b><span>atlanan video reklamı</span></div>
                </div>
                <details class="what-box">
                    <summary>Neyi görür, neyi görmez?</summary>
                    <p class="hint" style="margin:8px 0 0"><strong>Görür:</strong> yalnızca sunucunun açtığı sayfaların istekleri.
                        <strong>Görmez:</strong> telefonundaki tarayıcı, dosyaların, şifrelerin.</p>
                    <ul class="hint" style="margin:8px 0 0 18px;display:flex;flex-direction:column;gap:6px">
                        <li><strong>Bağlandığı tek yer:</strong> sunucu açılırken reklam listelerini GitHub'dan
                            (ghostery/adblocker) indirir; bu sırada GitHub yalnızca sunucunun IP adresini görür.</li>
                        <li>Açık kaynak (MPL-2.0). Tamamen kapatmak için sunucuyu <code>ADBLOCK=0</code> ile başlat.</li>
                    </ul>
                </details>
            </div>
        </div>

        <div class="st-sub" data-sub="logins">
            <div class="wz-top"><button class="back-btn" data-set="sub-back" aria-label="Geri">${icon('back')}</button><span>Hesaplar</span></div>
            <div class="acc-box" id="accountsBox"></div>
        </div>

        <button class="link-btn st-sharelog" data-set="sharelog">Paylaşım kaydı</button>

        <button class="rows filled hidden" id="installRow" style="width:100%">
            <span class="row"><span class="row-value" style="font-weight:400">Ana ekrana ekle</span><span class="row-chev">›</span></span>
        </button>
        <p class="hint hidden" id="iosInstallHint">Ana ekrana eklemek için Safari'de <strong>Paylaş</strong> → <strong>Ana Ekrana Ekle</strong>.</p>

        <p class="about">Yalnızca indirme hakkına sahip olduğunuz içerikleri indirin. DRM korumalı (Widevine, FairPlay,
            SAMPLE-AES) yayınlar desteklenmez. Dosyalar bir aracıya yüklenmez; indirme tarayıcınızda ya da kendi
            sunucunuzda yapılır.</p>`;

    const chip = root.querySelector('[data-part="chip"]');
    const cardBox = root.querySelector('[data-part="srvcard"]');
    const groupsBox = root.querySelector('[data-part="groups"]');
    // Sunucu ve kitaplık bilgisi (satırlardaki değerler için).
    const srv = { on: false, version: '', reach: true, blocked: null, adOn: false, logins: null, usage: 0 };

    /** Alt sayfa (sunucu bağlantısı, reklam engelleme, sitelere girişler). */
    function openSub(name) {
        root.classList.toggle('sub-open', Boolean(name));
        root.querySelectorAll('.st-sub').forEach((el) => el.classList.toggle('open', el.dataset.sub === name));
        window.scrollTo(0, 0);
    }

    const row = (key, ic, label, { sub = '', value = '', toggle = null, disabled = false } = {}) => `
        <button class="row st-row${disabled ? ' disabled' : ''}" data-set="${key}"${disabled ? ' disabled' : ''}>
            <span class="row-tile">${icon(ic)}</span>
            <span class="row-value">${label}${sub ? `<span class="muted row-sub">${sub}</span>` : ''}</span>
            ${toggle === null ? `${value ? `<span class="st-val">${escapeHtml(value)}</span>` : ''}<span class="row-chev">${icon('chevronRight')}</span>`
                : `<span class="toggle${toggle ? ' on' : ''}"></span>`}</button>`;
    const group = (title, rows) => `<div class="st-group"><span class="sec-label">${title}</span><div class="rows filled">${rows.join('')}</div></div>`;

    function renderPrefs() {
        const prefs = getPrefs();
        const server = getRenderServer();
        let host = '';
        try {
            host = server ? new URL(server.url).host : '';
        } catch (_) { /* geçersiz */ }
        cardBox.innerHTML = server
            ? `<div class="st-card-top"><span class="st-card-ic on">${icon('server')}</span>
                <span class="st-card-t"><b>Kendi sunucum</b><small>${escapeHtml(host)}${server.url === location.origin ? ' · bu cihaz' : ''}</small></span>
                <span class="status-chip${srv.reach ? ' on' : ''}">${srv.reach ? `Bağlı${srv.version ? ' · v' + escapeHtml(srv.version) : ''}` : 'Ulaşılamıyor'}</span></div>
                <div class="st-card-btns"><button class="btn-ghost" data-set="status">Sunucu durumu</button><button class="btn-ghost" data-set="sub" data-v="conn">Bağlantı</button></div>`
            : `<div class="st-card-top"><span class="st-card-ic">${icon('server')}</span>
                <span class="st-card-t"><b>Kendi sunucum</b><small>Kapalı siteler, giriş isteyenler ve kilitliyken kayıt için</small></span>
                <span class="status-chip">Kapalı</span></div>
                <div class="st-card-btns"><button class="btn-ac" data-set="setup">Kurulum</button><button class="btn-ghost" data-set="sub" data-v="conn">Bağlan</button></div>`;

        const save = effectiveSaveMode(prefs.save);
        const sites = Object.keys(siteSettings());
        const bgOk = canBackgroundFetch && save !== 'disk';
        const groups = [
            group('Görünüm', [row('theme-cycle', prefs.theme === 'light' ? 'sun' : 'moon', 'Tema', { value: prefs.theme === 'light' ? 'Açık' : 'Koyu' })]),
            group('İndirme', [
                row('save', 'download', 'Kaydet', { value: SAVE_LABELS[save] }),
                row('conn', 'globe', 'Bağlantı yöntemi', { value: CONN_LABELS[prefs.conn] }),
                server ? row('serverBackground', 'server', 'Sunucunda indir', { sub: 'Uygulama kapansa, geri tuşuna bassan da sürer', toggle: prefs.serverBackground !== false })
                    : row('background', 'download', 'Arka planda indir', { sub: canBackgroundFetch ? '' : 'Bu tarayıcıda yok', toggle: prefs.background && bgOk, disabled: !bgOk }),
                row('keepAwake', 'sun', 'İndirirken ekranı açık tut', { toggle: prefs.keepAwake })
            ]),
            group('Bulma', [
                row('bigSites', 'globe', 'Bilinen sitelerde gelişmiş bulma', { sub: 'YouTube, Instagram, TikTok, X…', value: BIG_LABELS[prefs.bigSites] || BIG_LABELS.ask }),
                row('sites', 'list', 'Site başına ayarlar', { value: sites.length ? `${sites.length} site` : '' }),
                row('useYtdlp', 'globe', 'Diğer sitelerde de gelişmiş bulma', { sub: 'Kapalıyken sayfa doğrudan sunucunda taranır', toggle: Boolean(prefs.useYtdlp) }),
                row('fullGalleries', 'image', 'Galerilerin tamamı', { sub: 'Resimlerde tam boyut ve tüm sayfalar', toggle: prefs.fullGalleries !== false })
            ]),
            group('Oynatma', [row('fsLandscape', 'rotate', 'Tam ekranda yataya çevir', { sub: 'Yatay videolarda', toggle: Boolean(prefs.fsLandscape) })]),
            server ? group('Sunucu', [
                row('bookmark', 'laptop', 'Bilgisayardan gönder', { sub: 'Tarayıcıdaki sayfayı tek tıkla yolla' }),
                row('sub-adblock', 'alert', 'Reklam engelleme', { value: srv.blocked === null ? '' : srv.adOn ? `${srv.blocked.toLocaleString('tr-TR')} engellendi` : 'Kapalı' }),
                row('sub-logins', 'user', 'Hesaplar', { value: !srv.logins ? '' : srv.logins.lost ? `${srv.logins.lost} giriş düştü` : srv.logins.total ? `${srv.logins.total} hesap` : 'Yok' }),
                row('libSync', 'sync', 'Cihazlar arası eşitleme', { sub: 'Kitaplık sunucun üzerinden', toggle: Boolean(prefs.libSync) })
            ]) : '',
            group('Kitaplık', [row('storage', 'folder', 'Kitaplık ve depolama', { value: srv.usage ? formatSize(srv.usage) : '' })]),
            // Android uygulaması (APK): paylaşım ve kaydetme Chrome'dan bağımsız, daha sorunsuz.
            window.IndiriciAndroid
                ? group('Uygulama', [row('apk', 'download', 'Android uygulaması', { sub: 'Yeni sürümü indir', value: `v${window.IndiriciAndroid.version()}` })])
                : /Android/i.test(navigator.userAgent)
                    ? group('Uygulama', [row('apk', 'download', 'Android uygulamasını indir', { sub: 'Paylaşım ve kaydetme daha sorunsuz çalışır' })])
                    : ''
        ];
        groupsBox.innerHTML = groups.join('');
    }
    libUsage().then((u) => { srv.usage = u.total; renderPrefs(); }).catch(() => {});

    root.addEventListener('click', (e) => {
        const btn = e.target.closest('[data-set]');
        if (!btn || btn.disabled) return;
        const prefs = getPrefs();
        const key = btn.dataset.set;
        if (key === 'theme') setPref('theme', btn.dataset.v);
        if (key === 'theme-cycle') setPref('theme', prefs.theme === 'light' ? 'dark' : 'light');
        if (key === 'sub') return openSub(btn.dataset.v);
        if (key === 'sub-back') return openSub(null);
        if (key === 'sub-adblock') return openSub('adblock');
        if (key === 'sub-logins') {
            accounts.reload();
            return openSub('logins');
        }
        if (key === 'setup') return openSetup(1);
        if (key === 'sharelog') return openShareLog();
        if (key === 'apk') return downloadApk();
        if (key === 'libSync') setPref('libSync', !prefs.libSync);
        if (key === 'storage') return openStorage();
        if (key === 'save') {
            const order = ['downloads', 'gallery', 'disk'].filter((m) =>
                m === 'downloads' || (m === 'gallery' && canShareFiles) || (m === 'disk' && canSaveToDisk));
            setPref('save', order[(order.indexOf(effectiveSaveMode(prefs.save)) + 1) % order.length]);
        }
        if (key === 'conn') {
            const order = getRenderServer() ? ['auto', 'direct', 'proxy'] : ['auto', 'direct'];
            setPref('conn', order[(order.indexOf(prefs.conn) + 1) % order.length] || 'auto');
        }
        if (key === 'background') setPref('background', !prefs.background);
        if (key === 'serverBackground') setPref('serverBackground', prefs.serverBackground === false);
        if (key === 'keepAwake') setPref('keepAwake', !prefs.keepAwake);
        if (key === 'fsLandscape') setPref('fsLandscape', !prefs.fsLandscape);
        if (key === 'useYtdlp') setPref('useYtdlp', !prefs.useYtdlp);
        if (key === 'fullGalleries') setPref('fullGalleries', prefs.fullGalleries === false);
        if (key === 'bigSites') {
            const order = ['ask', 'ytdlp', 'ours'];
            setPref('bigSites', order[(order.indexOf(prefs.bigSites) + 1) % order.length]);
        }
        if (key === 'sites') return openSiteSettings({ toast });
        if (key === 'status') return openServerStatus({ toast });
        if (key === 'bookmark') return openBookmarklet({ toast });
    });
    onPrefs(renderPrefs);
    renderPrefs();

    /* ---- Kendi sunucum ---- */
    const urlInput = $('serverUrl');
    const tokenInput = $('serverToken');
    const status = $('serverStatus');

    const adChip = $('adblockChip');
    const adText = $('adblockText');
    const showAdblock = (health) => {
        const ab = health && health.adblock;
        srv.blocked = ab && typeof ab.blocked === 'number' ? ab.blocked : null;
        srv.adOn = Boolean(ab && ab.enabled);
        renderPrefs();
        const hasStats = Boolean(ab && ab.enabled && typeof ab.blocked === 'number');
        $('adStats').classList.toggle('hidden', !hasStats);
        if (hasStats) {
            $('adBlocked').textContent = ab.blocked.toLocaleString('tr-TR');
            $('adVideo').textContent = ab.videoAds.toLocaleString('tr-TR');
        }
        if (!health) {
            adChip.textContent = 'Sunucu yok';
            adChip.classList.remove('on');
            return;
        }
        if (!ab) {
            adChip.textContent = 'Sunucu eski';
            adChip.classList.remove('on');
            adText.textContent = 'Sunucun reklam engelleme içermeyen eski bir sürüm; güncelleyip (git pull) yeniden başlat.';
            return;
        }
        const label = { lists: 'Açık · hazır listeler', builtin: 'Açık · yerleşik liste', loading: 'Açılıyor', off: 'Kapalı' }[ab.engine] || 'Açık';
        adChip.textContent = label;
        adChip.classList.toggle('on', ab.enabled);
        adText.textContent = ab.enabled
            ? 'Sunucunun açtığı sayfalarda reklamlar, video reklamları, açılır pencereler ve oynat düğmesine basınca reklama ' +
              'yönlendirmeler engellenir; sayfa reklama kaçarsa videonun sayfasına geri dönülür.' +
              (ab.engine === 'builtin' ? ' Hazır listeler indirilemedi; yaygın reklam ağlarının yerleşik listesi kullanılıyor.' : '')
            : 'Sunucu ADBLOCK=0 ile başlatılmış; reklam engelleme kapalı (açılır pencereler yine kapatılır).';
    };

    /* ---- Hesaplar ---- */
    const accounts = mountAccounts($('accountsBox'), {
        toast,
        onCount: (c) => {
            srv.logins = c;
            renderPrefs();
        }
    });
    const loadLogins = () => accounts.reload();

    /** APK, uygulamanın kendi adresinden (Termux sunucusu ya da Netlify) indirilir. */
    async function downloadApk() {
        const url = new URL('assets/indirici.apk', location.href).href;
        try {
            const r = await fetch(url, { method: 'HEAD', cache: 'no-store' });
            if (!r.ok) throw new Error();
        } catch (_) {
            return toast('APK henüz hazır değil; sunucunu güncelle (git pull) ve biraz sonra yeniden dene');
        }
        toast('İndiriliyor · bitince bildirimden ya da İndirilenler\'den açıp kur');
        const a = document.createElement('a');
        a.href = url;
        a.download = 'indirici.apk';
        document.body.appendChild(a);
        a.click();
        a.remove();
    }

    /** Paylaşım kaydı: telefonun paylaşımda ne yaptığı (sorun bildirmek için kopyalanır). */
    async function openShareLog() {
        let list = [];
        try {
            list = JSON.parse(localStorage.getItem('indirici.shareLog') || '[]');
        } catch (_) { /* yok */ }
        // Service worker'ın gördüğü açılış istekleri (paylaşım adresi istendi mi?).
        try {
            const r = await (await caches.open('indirici-inbox')).match('/__navlog');
            if (r) list = list.concat((await r.json()).map((e) => ({ at: e.at, ev: 'sw istek', q: e.q }))).sort((a, b) => a.at - b.at);
        } catch (_) { /* yok */ }
        const time = (ms) => new Date(ms).toLocaleTimeString('tr-TR');
        // Hangi sürüm çalışıyor: sayfanın adresi ve etkin service worker'ın önbellek sürümü.
        let sw = 'yok';
        try {
            const shells = (await caches.keys()).filter((n) => n.startsWith('shell-'));
            sw = `${navigator.serviceWorker && navigator.serviceWorker.controller ? 'etkin' : 'denetlemiyor'} · ${shells.join(',') || 'önbellek yok'}`;
        } catch (_) { /* yok */ }
        const head = [`Adres: ${location.origin}`, `Service worker: ${sw}`, `Ekran: ${matchMedia('(display-mode: standalone)').matches ? 'uygulama' : 'tarayıcı sekmesi'}`];
        const lines = head.concat(list.map((e) => [time(e.at), e.ev, e.nav ? `(${e.nav})` : '', e.q || '', e.link ? '· bağlantı var' : ''].filter(Boolean).join(' ')));
        const el = document.createElement('div');
        el.className = 'sheet-backdrop acc-sheet';
        el.innerHTML = `<div class="acc-sheet-box" role="dialog" aria-label="Paylaşım kaydı"><span class="cf-grip"></span>
            <b class="acc-sheet-title">Paylaşım kaydı</b>
            <p class="hint">Uygulama açıkken bir bağlantıyı paylaş (ilk deneme gelmese de), sonra buraya dönüp kaydı kopyala ve gönder.</p>
            <pre class="acc-import-text" style="white-space:pre-wrap;margin:0">${escapeHtml(lines.join('\n') || 'Kayıt yok')}</pre>
            <div class="acc-form-row"><button class="btn-ghost" data-sl="clear" style="flex:1;height:48px">Temizle</button>
                <button class="btn-big" data-sl="copy" style="flex:1">Kopyala</button></div></div>`;
        document.body.appendChild(el);
        el.addEventListener('click', (e) => {
            if (e.target === el) return el.remove();
            const b = e.target.closest('[data-sl]');
            if (!b) return;
            if (b.dataset.sl === 'clear') {
                try { localStorage.removeItem('indirici.shareLog'); } catch (_) { /* yok */ }
                if ('caches' in window) caches.open('indirici-inbox').then((c) => c.delete('/__navlog')).catch(() => {});
                el.remove();
                return;
            }
            navigator.clipboard.writeText(lines.join('\n')).then(() => toast('Kayıt kopyalandı')).catch(() => toast('Kopyalanamadı'));
        });
    }

    const showState = (on, text, version) => {
        srv.on = on;
        if (version) srv.version = version;
        if (on) srv.reach = true;
        chip.textContent = on ? `Bağlı${version ? ' · v' + version : ''}` : 'Kapalı';
        chip.classList.toggle('on', on);
        renderPrefs();
        if (text !== undefined) status.textContent = text;
        onServerChange(on ? getRenderServer() : null, version);
    };

    const current = getRenderServer();
    if (current) {
        urlInput.value = current.url;
        tokenInput.value = current.token;
        showState(true, current.url === location.origin
            ? 'Uygulama bu cihazdaki sunucudan açıldı; otomatik bağlı, token gerekmez.'
            : 'Kayıtlı. Sayfa adresleri bu sunucuda açılacak.');
        checkRenderServer(current)
            .then((health) => {
                showState(true, undefined, health.version);
                showAdblock(health);
                loadLogins(health);
            })
            .catch(() => {
                chip.textContent = 'Ulaşılamıyor';
                chip.classList.remove('on');
                srv.reach = false;
                renderPrefs();
            });
    } else {
        showState(false);
    }

    /** Sunucuyu dener; olursa kaydeder ve ekranı günceller (sihirbaz ve QR da bunu kullanır). */
    async function connect(config) {
        const health = await checkRenderServer(config);
        setRenderServer(config);
        urlInput.value = config.url;
        tokenInput.value = config.token;
        showState(true, `Bağlandı (sürüm ${health.version}). Sayfa adresleri artık bu sunucuda açılacak.`, health.version);
        showAdblock(health);
        loadLogins(health);
        return health;
    }

    $('serverSaveBtn').addEventListener('click', async () => {
        const config = { url: urlInput.value.trim().replace(/\/+$/, ''), token: tokenInput.value.trim() };
        if (!isHttpUrl(config.url) || !config.token) {
            status.textContent = 'Adres (http/https) ve token gerekli.';
            return;
        }
        status.textContent = 'Bağlanılıyor... (Chrome yerel ağ izni isterse "İzin ver"e bas)';
        try {
            await connect(config);
        } catch (err) {
            showState(Boolean(getRenderServer()), `Bağlanılamadı: ${err.message}. Sunucu açık mı, adres https mi (veya 127.0.0.1), token doğru mu?`);
        }
    });
    $('serverWizardBtn').addEventListener('click', () => openSetup(1));
    $('serverQrBtn').addEventListener('click', () => openSetup(3));

    $('serverClearBtn').addEventListener('click', () => {
        setRenderServer(null);
        if (getPrefs().conn === 'proxy') setPref('conn', 'auto');
        showState(false, "Kendi sunucun devre dışı; CORS'a kapalı siteler indirilemeyecek.");
        showAdblock(null);
        loadLogins(null);
    });

    /** Ayarlar açılınca sayaçlar ve girişler tazelenir. */
    function refresh() {
        const server = getRenderServer();
        if (!server) return;
        checkRenderServer(server).then((health) => {
            showAdblock(health);
            loadLogins(health);
        }).catch(() => {});
    }

    /* ---- Ana ekrana ekle ---- */
    const installRow = $('installRow');
    install.onAvailable((available) => installRow.classList.toggle('hidden', !available));
    installRow.addEventListener('click', () => install.prompt());
    if (install.iosHint) $('iosInstallHint').classList.remove('hidden');
    return { refresh, connect };
}
