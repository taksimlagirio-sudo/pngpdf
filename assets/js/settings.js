// "Ayarlar" ekranı: tema, varsayılan indirme ayarları, kendi sunucum, ana ekrana ekleme.
import { $, isHttpUrl, getRenderServer, setRenderServer, checkRenderServer, renderApi, escapeHtml } from './util.js';
import { getPrefs, setPref, onPrefs, SAVE_LABELS, CONN_LABELS } from './prefs.js';
import { effectiveSaveMode, canSaveToDisk, canShareFiles, canBackgroundFetch } from './downloads.js';

const BIG_LABELS = { ask: 'Sor', ytdlp: 'yt-dlp', ours: 'Kendi yöntemimiz' };

export function initSettings({ onServerChange, install }) {
    const root = $('settingsView');
    root.innerHTML = `
        <div class="settings-sec"><span class="sec-label">Görünüm</span>
            <div class="seg" data-part="theme"></div></div>

        <div class="settings-sec"><span class="sec-label">Varsayılan indirme</span>
            <div class="rows filled" data-part="defaults"></div></div>

        <div class="settings-sec">
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
                    <button class="btn-ghost" id="serverClearBtn">Kapat</button>
                    <button class="btn-ac" id="serverSaveBtn">Kaydet ve test et</button>
                </div>
                <p class="hint" id="serverStatus"></p>
            </div>
        </div>

        <div class="settings-sec">
            <div class="settings-sec-head"><span class="sec-label">Reklam engelleme</span>
                <span class="status-chip" id="adblockChip">Sunucu yok</span></div>
            <div class="server-panel">
                <span class="hint" id="adblockText">Kendi sunucun ayarlanınca, sunucunun açtığı sayfalarda reklamlar,
                    açılır pencereler ve reklama yönlendirmeler engellenir.</span>
                <details>
                    <summary class="link-btn" style="cursor:pointer">Engelleyici neyi görür, neyi görmez?</summary>
                    <ul class="hint" style="margin:8px 0 0 18px;display:flex;flex-direction:column;gap:6px">
                        <li><strong>Görür:</strong> yalnızca kendi sunucundaki tarayıcının açtığı sayfaların istek
                            adresleri — yani indirmek için açtırdığın sayfalar. "Bu adres reklam mı?" kontrolü sunucunun
                            içinde yapılır; adresler Ghostery'ye ya da başka bir yere gönderilmez.</li>
                        <li><strong>Görmez:</strong> telefonundaki tarayıcı, gezdiğin siteler, dosyaların, şifrelerin ve bu
                            uygulamadaki ayarların. Telefon uygulamasında engelleyici hiç çalışmaz.</li>
                        <li><strong>Bağlandığı tek yer:</strong> sunucu açılırken reklam listelerini GitHub'dan
                            (ghostery/adblocker) indirir; bu sırada GitHub yalnızca sunucunun IP adresini görür.</li>
                        <li>Açık kaynak (MPL-2.0). Tamamen kapatmak için sunucuyu <code>ADBLOCK=0</code> ile başlat.</li>
                    </ul>
                </details>
            </div>
        </div>

        <div class="settings-sec">
            <div class="settings-sec-head"><span class="sec-label">Sitelere girişler</span>
                <span class="status-chip" id="loginsChip">Sunucu yok</span></div>
            <div class="server-panel">
                <span class="hint" id="loginsText">Bir siteye "Kendim dokunayım" ekranında bir kez giriş yaparsan giriş
                    kendi sunucunda saklanır; o sitenin videoları sonra girişli açılır ve kaydedilir.</span>
                <div class="rows filled hidden" id="loginsList"></div>
                <span class="hint">Girişler (çerezler) yalnızca kendi sunucundaki <code>.logins.json</code> dosyasında durur,
                    başka yere gönderilmez. Saklamayı kapatmak için sunucuyu <code>SAVE_LOGINS=0</code> ile başlat.</span>
            </div>
        </div>

        <button class="rows filled hidden" id="installRow" style="width:100%">
            <span class="row"><span class="row-value" style="font-weight:400">Ana ekrana ekle</span><span class="row-chev">›</span></span>
        </button>
        <p class="hint hidden" id="iosInstallHint">Ana ekrana eklemek için Safari'de <strong>Paylaş</strong> → <strong>Ana Ekrana Ekle</strong>.</p>

        <p class="about">Yalnızca indirme hakkına sahip olduğunuz içerikleri indirin. DRM korumalı (Widevine, FairPlay,
            SAMPLE-AES) yayınlar desteklenmez. Dosyalar bir aracıya yüklenmez; indirme tarayıcınızda ya da kendi
            sunucunuzda yapılır.</p>`;

    const themeBox = root.querySelector('[data-part="theme"]');
    const defaultsBox = root.querySelector('[data-part="defaults"]');
    const chip = root.querySelector('[data-part="chip"]');

    function renderPrefs() {
        const prefs = getPrefs();
        themeBox.innerHTML = [['dark', 'Koyu'], ['light', 'Açık']].map(([v, l]) =>
            `<button class="${prefs.theme === v ? 'on' : ''}" data-set="theme" data-v="${v}">${l}</button>`).join('');
        const save = effectiveSaveMode(prefs.save);
        const remembered = Object.entries(prefs.siteMethods || {});
        const bgOk = canBackgroundFetch && save !== 'disk';
        defaultsBox.innerHTML = `
            <button class="row" data-set="save"><span class="row-value" style="font-weight:400">Kaydet</span>
                <span class="muted">${SAVE_LABELS[save]} ›</span></button>
            <button class="row" data-set="conn"><span class="row-value" style="font-weight:400">Bağlantı yöntemi</span>
                <span class="muted">${CONN_LABELS[prefs.conn]} ›</span></button>
            <button class="row${bgOk ? '' : ' disabled'}" data-set="background" ${bgOk ? '' : 'disabled'}>
                <span class="row-value" style="font-weight:400">Arka planda indir${canBackgroundFetch ? '' : ' (bu tarayıcıda yok)'}</span>
                <span class="toggle${prefs.background && bgOk ? ' on' : ''}"></span></button>
            <button class="row" data-set="keepAwake"><span class="row-value" style="font-weight:400">İndirirken ekranı açık tut</span>
                <span class="toggle${prefs.keepAwake ? ' on' : ''}"></span></button>
            <button class="row" data-set="bigSites"><span class="row-value" style="font-weight:400">Büyük platformlar
                <span class="muted" style="display:block;font-size:12px">TikTok, Instagram, YouTube, X… (sunucuda yt-dlp kuruluysa)</span></span>
                <span class="muted">${BIG_LABELS[prefs.bigSites] || BIG_LABELS.ask} ›</span></button>
            ${remembered.length ? `<button class="row" data-set="resetSites"><span class="row-value" style="font-weight:400">Hatırlanan seçimler
                <span class="muted" style="display:block;font-size:12px">${remembered.map(([d, m]) => `${d}: ${m === 'ytdlp' ? 'yt-dlp' : 'kendi yöntemimiz'}`).join(', ')}</span></span>
                <span class="muted">Sıfırla</span></button>` : ''}
            <button class="row" data-set="useYtdlp"><span class="row-value" style="font-weight:400">Diğer sitelerde de yt-dlp dene
                <span class="muted" style="display:block;font-size:12px">Kapalıyken diğer sayfalar doğrudan sunucunda taranır</span></span>
                <span class="toggle${prefs.useYtdlp ? ' on' : ''}"></span></button>`;
    }

    root.addEventListener('click', (e) => {
        const btn = e.target.closest('[data-set]');
        if (!btn || btn.disabled) return;
        const prefs = getPrefs();
        const key = btn.dataset.set;
        if (key === 'theme') setPref('theme', btn.dataset.v);
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
        if (key === 'keepAwake') setPref('keepAwake', !prefs.keepAwake);
        if (key === 'useYtdlp') setPref('useYtdlp', !prefs.useYtdlp);
        if (key === 'bigSites') {
            const order = ['ask', 'ytdlp', 'ours'];
            setPref('bigSites', order[(order.indexOf(prefs.bigSites) + 1) % order.length]);
        }
        if (key === 'resetSites') setPref('siteMethods', {});
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

    /* ---- Sitelere girişler ---- */
    const loginsChip = $('loginsChip');
    const loginsText = $('loginsText');
    const loginsList = $('loginsList');
    const showLogins = (data) => {
        const sites = (data && data.sites) || [];
        loginsChip.classList.toggle('on', Boolean(data && data.enabled));
        loginsChip.textContent = !data ? 'Sunucu yok' : !data.enabled ? 'Kapalı' : sites.length ? `${sites.length} site` : 'Açık';
        loginsList.classList.toggle('hidden', !sites.length);
        loginsList.innerHTML = sites.map((site) => `
            <div class="row"><span class="row-value" style="font-weight:400">${escapeHtml(site.domain)}</span>
                <button class="link-btn" data-logout="${escapeHtml(site.domain)}">Çıkış yap</button></div>`).join('') +
            (sites.length > 1 ? `<div class="row"><span></span><button class="link-btn" data-logout="">Hepsinden çıkış yap</button></div>` : '');
    };
    const loadLogins = (health) => {
        if (!health) return showLogins(null);
        if (!health.logins) {
            loginsChip.textContent = 'Sunucu eski';
            loginsChip.classList.remove('on');
            loginsText.textContent = 'Sunucun girişleri saklamayan eski bir sürüm; güncelleyip (git pull) yeniden başlat.';
            return;
        }
        renderApi('/logins').then(showLogins).catch(() => showLogins(null));
    };
    loginsList.addEventListener('click', (e) => {
        const btn = e.target.closest('[data-logout]');
        if (!btn) return;
        const domain = btn.dataset.logout;
        renderApi(`/logins?domain=${encodeURIComponent(domain)}`, { method: 'DELETE' }).then(showLogins).catch(() => {});
    });

    const showState = (on, text, version) => {
        chip.textContent = on ? `Bağlı${version ? ' · v' + version : ''}` : 'Kapalı';
        chip.classList.toggle('on', on);
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
            });
    } else {
        showState(false);
    }

    $('serverSaveBtn').addEventListener('click', async () => {
        const config = { url: urlInput.value.trim().replace(/\/+$/, ''), token: tokenInput.value.trim() };
        if (!isHttpUrl(config.url) || !config.token) {
            status.textContent = 'Adres (http/https) ve token gerekli.';
            return;
        }
        status.textContent = 'Bağlanılıyor... (Chrome yerel ağ izni isterse "İzin ver"e bas)';
        try {
            const health = await checkRenderServer(config);
            setRenderServer(config);
            showState(true, `Bağlandı (sürüm ${health.version}). Sayfa adresleri artık bu sunucuda açılacak.`, health.version);
            showAdblock(health);
            loadLogins(health);
        } catch (err) {
            showState(Boolean(getRenderServer()), `Bağlanılamadı: ${err.message}. Sunucu açık mı, adres https mi (veya 127.0.0.1), token doğru mu?`);
        }
    });

    $('serverClearBtn').addEventListener('click', () => {
        setRenderServer(null);
        if (getPrefs().conn === 'proxy') setPref('conn', 'auto');
        showState(false, "Kendi sunucun devre dışı; CORS'a kapalı siteler indirilemeyecek.");
        showAdblock(null);
        loadLogins(null);
    });

    /* ---- Ana ekrana ekle ---- */
    const installRow = $('installRow');
    install.onAvailable((available) => installRow.classList.toggle('hidden', !available));
    installRow.addEventListener('click', () => install.prompt());
    if (install.iosHint) $('iosInstallHint').classList.remove('hidden');
}
