// "Ayarlar" ekranı: tema, varsayılan indirme ayarları, kendi sunucum, ana ekrana ekleme.
import { $, isHttpUrl, getRenderServer, setRenderServer, checkRenderServer } from './util.js';
import { getPrefs, setPref, onPrefs, SAVE_LABELS, CONN_LABELS } from './prefs.js';
import { effectiveSaveMode, canSaveToDisk, canShareFiles, canBackgroundFetch } from './downloads.js';

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
                <span class="toggle${prefs.keepAwake ? ' on' : ''}"></span></button>`;
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
    });
    onPrefs(renderPrefs);
    renderPrefs();

    /* ---- Kendi sunucum ---- */
    const urlInput = $('serverUrl');
    const tokenInput = $('serverToken');
    const status = $('serverStatus');

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
            .then((health) => showState(true, undefined, health.version))
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
        } catch (err) {
            showState(Boolean(getRenderServer()), `Bağlanılamadı: ${err.message}. Sunucu açık mı, adres https mi (veya 127.0.0.1), token doğru mu?`);
        }
    });

    $('serverClearBtn').addEventListener('click', () => {
        setRenderServer(null);
        if (getPrefs().conn === 'proxy') setPref('conn', 'auto');
        showState(false, "Kendi sunucun devre dışı; CORS'a kapalı siteler indirilemeyecek.");
    });

    /* ---- Ana ekrana ekle ---- */
    const installRow = $('installRow');
    install.onAvailable((available) => installRow.classList.toggle('hidden', !available));
    installRow.addEventListener('click', () => install.prompt());
    if (install.iosHint) $('iosInstallHint').classList.remove('hidden');
}
