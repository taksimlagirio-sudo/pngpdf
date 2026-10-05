// "Kendim dokunayım": sayfa kendi sunucunda açık kalır, canlı görüntüsü burada gösterilir;
// dokunuşlar ve parmakla kaydırma sunucudaki sayfaya iletilir. Bu ekranda reklam engellenmez:
// sayfa normal bir tarayıcıdaki gibi davranır. Çerez onayı, yaş onayı, birden çok "oynat" gibi
// otomatik geçilemeyen adımlar böyle elle geçilir; bu sırada gelen medya canlı listelenir.
import { escapeHtml, renderApi, renderBlob, getRenderServer } from './util.js';
import { rememberManifests } from './detect.js';
import { icon } from './icons.js';

const FRAME_DELAY_MS = 500;

/** Bulunan medyanın etiketi: HLS, DASH ya da dosya uzantısı. */
function kindTag(item) {
    if (item.kind === 'hls') return 'HLS';
    if (item.kind === 'dash') return 'DASH';
    const ext = (String(item.url).split(/[?#]/)[0].match(/\.([a-z0-9]{2,4})$/i) || [])[1];
    if (ext) return ext.toUpperCase();
    return item.kind === 'audio' ? 'SES' : 'VİDEO';
}

function pageLabel(url) {
    try {
        const u = new URL(url);
        return (u.host.replace(/^www\./, '') + u.pathname).replace(/\/$/, '');
    } catch (_) {
        return url || '';
    }
}

/**
 * Tam ekran "Kendim dokunayım": telefonda tüm ekranı, masaüstünde sağda medya paneli olan bir
 * katman açar. Kapatılınca katman kaldırılır.
 */
export function openRemoteOverlay(pageUrl, options = {}) {
    const el = document.createElement('div');
    el.className = 'remote-overlay';
    document.body.appendChild(el);
    document.documentElement.classList.add('remote-open');
    return openRemoteView(el, pageUrl, {
        ...options,
        onClose: () => {
            el.remove();
            if (!document.querySelector('.remote-overlay')) document.documentElement.classList.remove('remote-open');
            if (options.onClose) options.onClose();
        }
    });
}

export function canRemote() {
    return Boolean(getRenderServer());
}

/**
 * Etkileşimli görünümü `container` içine kurar.
 * @param {(url: string) => void} onPick  bulunan bir medyaya dokunulunca (oturum kapatılır)
 * @returns {{ close: () => void }}
 */
export function openRemoteView(container, pageUrl, { onPick = () => {}, shortUrl = (u) => u, captureId = null, onClose = () => {} } = {}) {
    // captureId verilirse yeni oturum açılmaz: video kaydının (başlamayı bekleyen) sayfası kullanılır.
    const base = () => (captureId ? `/capture/${captureId}` : `/session/${id}`);
    const where = captureId ? 'kaydın beklediği sayfa' : pageLabel(pageUrl);
    container.innerHTML = `
        <div class="remote-view">
            <div class="rv-main">
                <div class="rv-head">
                    <div class="rv-title-box"><div class="rv-title">Sayfaya dokun</div>
                        <div class="rv-url">${escapeHtml(where)}<span class="rv-desk"> · sunucunda açık</span></div></div>
                    <div class="rv-head-btns">
                        <button class="rv-btn rv-desk" data-r="back">${icon('back')} Geri</button>
                        <button class="rv-btn rv-desk" data-r="forward">İleri</button>
                        <button class="rv-btn rv-desk" data-r="reload">↻ Yenile</button>
                        <button class="rv-btn" data-r="close">Kapat</button>
                    </div>
                </div>
                <div class="rv-hint remote-status">Sayfa sunucunda açılıyor…</div>
                <div class="remote-screen">
                    <img alt="Sunucuda açılan sayfa" draggable="false">
                    <span class="remote-dot hidden"></span>
                    <span class="rv-live hidden"><i></i>canlı</span>
                </div>
                <div class="remote-controls rv-mob">
                    <button class="rv-btn" data-r="back">${icon('back')} Geri</button>
                    <button class="rv-btn" data-r="forward">İleri</button>
                    <button class="rv-btn" data-r="reload">↻ Yenile</button>
                </div>
                <div class="remote-type">
                    <input class="input" type="text" enterkeyhint="done" autocomplete="off" autocapitalize="off" spellcheck="false" placeholder="Önce sayfadaki kutucuğa dokun, sonra buraya yaz">
                    <button class="rv-btn rv-send" data-r="type">Yaz</button>
                </div>
                <div class="remote-keys">
                    <button class="rv-btn" data-r="key" data-key="Backspace" title="Son harfi sil">⌫ Sil</button>
                    <button class="rv-btn" data-r="key" data-key="Tab" title="Sonraki kutucuk">Sonraki ⇥</button>
                    <button class="rv-btn" data-r="key" data-key="Enter" title="Gönder / Giriş yap">Enter ↵</button>
                </div>
            </div>
            <div class="rv-side${captureId ? ' hidden' : ''}">
                <div class="rv-found-head"><span data-found-count>Bulunan medya · 0</span><span class="rv-mob rv-note">Giriş yaparsan saklanır</span></div>
                <div class="remote-found"><div class="rv-empty">Video başlayınca burada çıkar.</div></div>
                <div class="rv-login">Bu ekranda giriş yaparsan giriş sunucunda saklanır; o sitenin videoları sonra girişli açılır.</div>
            </div>
        </div>`;

    const status = container.querySelector('.remote-status');
    const img = container.querySelector('.remote-screen img');
    const dot = container.querySelector('.remote-dot');
    const textInput = container.querySelector('.remote-type input');
    const foundBox = container.querySelector('.remote-found');
    const foundCount = container.querySelector('[data-found-count]');
    const live = container.querySelector('.rv-live');

    let id = null;
    let alive = true;
    let frameUrl = null;
    let kick = null; // dokununca bekleme süresini kısaltıp hemen yeni görüntü al
    let foundKey = '';
    let inPopup = false;

    /** Sayfada odaklanan kutucuğa göre yazma alanı: şifre gizli yazılır, e-postada uygun klavye açılır. */
    function showFocus(focus) {
        const type = focus ? focus.type : '';
        textInput.type = type === 'password' ? 'password' : 'text';
        textInput.inputMode = type === 'email' ? 'email' : type === 'tel' || type === 'number' ? 'numeric' : 'text';
        textInput.placeholder = !focus ? 'Önce sayfadaki kutucuğa dokun, sonra buraya yaz'
            : type === 'password' ? 'Şifre (gizli yazılır)'
                : `${focus.label ? focus.label.slice(0, 40) : 'Kutucuğa'} yaz`;
        if (focus) textInput.focus({ preventScroll: true });
    }

    const setStatus = (text, isError = false) => {
        status.textContent = text;
        status.classList.toggle('error', isError);
    };

    function renderFound(items) {
        rememberManifests(items); // ana listelerin içeriği: seçilince kaliteler yeniden istenmeden açılır
        const media = items.filter((i) => i.kind !== 'image');
        const key = media.map((i) => i.url).join('\n');
        if (key === foundKey) return;
        foundKey = key;
        foundCount.textContent = `Bulunan medya · ${media.length}`;
        foundBox.innerHTML = media.length
            ? media.map((i) => `
                <button class="rv-item" data-r="pick" data-url="${escapeHtml(i.url)}">
                    <span class="rv-tag">${escapeHtml(kindTag(i))}</span>
                    <span class="rv-item-url">${escapeHtml(shortUrl(i.url))}</span>
                    <span class="rv-dl">İndir</span>
                </button>`).join('')
            : '<div class="rv-empty">Video başlayınca burada çıkar.</div>';
        if (media.length) setStatus('Medya bulundu. Aşağıdan seç ya da dokunmaya devam et.');
    }

    // Dokunuşlar sırayla uygulanır; önceki bitmeden gelen dokunuş atılmaz, sıraya girer.
    let queue = Promise.resolve();
    function action(body) {
        queue = queue.then(() => runAction(body));
        return queue;
    }

    async function runAction(body) {
        if (!id || !alive) return;
        try {
            const state = await renderApi(`${base()}/action`, {
                method: 'POST',
                headers: { 'content-type': 'application/json' },
                body: JSON.stringify(body)
            });
            if (state.items) renderFound(state.items);
            if ('focus' in state) showFocus(state.focus);
            noteState(state);
        } catch (err) {
            setStatus(err.message, true);
            if (err.status === 404) stop();
        } finally {
            if (kick) kick();
        }
    }

    async function loop() {
        let tick = 0;
        while (alive) {
            try {
                const blob = await renderBlob(`${base()}/shot`);
                if (!alive) break;
                const next = URL.createObjectURL(blob);
                img.src = next;
                live.classList.remove('hidden');
                if (frameUrl) URL.revokeObjectURL(frameUrl);
                frameUrl = next;
                if (!captureId && tick++ % 3 === 0) renderFound((await renderApi(base(), {}, 10000)).items);
            } catch (err) {
                if (!alive) break;
                live.classList.add('hidden');
                setStatus(err.message, true);
                if (err.status === 404) return stop();
            }
            await new Promise((resolve) => {
                kick = resolve;
                setTimeout(resolve, FRAME_DELAY_MS);
            });
            kick = null;
        }
    }

    /**
     * Canlı görüntü: sunucu her yeni kareyi hemen gönderir (MJPEG). Açılamazsa eski yönteme
     * (yarım saniyede bir ekran görüntüsü) dönülür. Bulunan medya ayrıca 1,5 sn'de bir sorulur.
     */
    function startStream() {
        const server = getRenderServer();
        let fellBack = false;
        const fallback = () => {
            if (fellBack || !alive) return;
            fellBack = true;
            img.removeAttribute('src');
            loop();
        };
        img.addEventListener('load', () => live.classList.remove('hidden'), { once: true });
        img.addEventListener('error', fallback, { once: true });
        img.src = `${server.url}${base()}/stream?token=${encodeURIComponent(server.token || '')}`;
        (async () => {
            while (alive) {
                await new Promise((r) => setTimeout(r, 1500));
                if (!alive || fellBack) break;
                try {
                    const st = await renderApi(base(), {}, 10000);
                    renderFound(st.items || []);
                    noteState(st);
                } catch (err) {
                    if (err.status === 404) {
                        setStatus(err.message, true);
                        return stop();
                    }
                }
            }
        })();
    }

    function noteState(state) {
        if (!captureId && 'popup' in state && state.popup !== inPopup) {
            inPopup = state.popup;
            setStatus(inPopup ? 'Yeni pencere açıldı. Kapanınca ya da Geri ile önceki sayfaya dönülür.'
                : 'Sayfaya dönüldü. Giriş yaptıysan bu site için saklandı.');
        }
    }

    function stop() {
        alive = false;
        if (kick) kick();
        img.removeAttribute('src'); // canlı görüntü bağlantısı kapansın
    }

    function close() {
        stop();
        if (id && !captureId) {
            renderApi(`/session/${id}`, { method: 'DELETE', keepalive: true }, 5000).catch(() => {});
            id = null;
        }
        if (frameUrl) URL.revokeObjectURL(frameUrl);
        frameUrl = null;
        container.innerHTML = '';
        window.removeEventListener('pagehide', close);
        document.removeEventListener('keydown', onKey);
        onClose();
    }

    /* ---- Dokunma ve parmakla kaydırma ----
     * Kısa dokunuş: o noktaya tıklanır. Sürükleme: parmağın altındaki öğe aynı miktarda kaydırılır
     * (sayfa, iç liste ya da galeri); hızlı bırakılırsa kayma biraz sürer. Kaydırmalar birikip
     * tek istekte gider, sırada beklemez. */
    let pageW = 412;
    let pageH = 800;
    let drag = null;
    const wheel = { dx: 0, dy: 0, x: 0.5, y: 0.5, busy: false };
    async function flushWheel() {
        if (wheel.busy) return;
        wheel.busy = true;
        try {
            while (Math.abs(wheel.dx) + Math.abs(wheel.dy) >= 1 && alive && id) {
                const body = { type: 'wheel', x: wheel.x, y: wheel.y, dx: Math.round(wheel.dx), dy: Math.round(wheel.dy) };
                wheel.dx = 0;
                wheel.dy = 0;
                await renderApi(`${base()}/action`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }, 10000)
                    .catch(() => {});
            }
        } finally {
            wheel.busy = false;
        }
    }
    const point = (e) => {
        const rect = img.getBoundingClientRect();
        return { x: (e.clientX - rect.left) / rect.width, y: (e.clientY - rect.top) / rect.height, sx: pageW / rect.width, sy: pageH / rect.height };
    };
    img.addEventListener('pointerdown', (e) => {
        if (e.button !== undefined && e.button > 0) return;
        img.setPointerCapture(e.pointerId);
        const p = point(e);
        drag = { id: e.pointerId, x0: e.clientX, y0: e.clientY, lx: e.clientX, ly: e.clientY, lt: e.timeStamp, vx: 0, vy: 0, moved: false, p };
    });
    img.addEventListener('pointermove', (e) => {
        if (!drag || e.pointerId !== drag.id) return;
        if (!drag.moved && Math.hypot(e.clientX - drag.x0, e.clientY - drag.y0) < 8) return;
        drag.moved = true;
        const dx = e.clientX - drag.lx;
        const dy = e.clientY - drag.ly;
        const dt = Math.max(1, e.timeStamp - drag.lt);
        drag.vx = 0.7 * drag.vx + 0.3 * (dx / dt);
        drag.vy = 0.7 * drag.vy + 0.3 * (dy / dt);
        drag.lx = e.clientX;
        drag.ly = e.clientY;
        drag.lt = e.timeStamp;
        wheel.x = drag.p.x;
        wheel.y = drag.p.y;
        wheel.dx -= dx * drag.p.sx;
        wheel.dy -= dy * drag.p.sy;
        flushWheel();
    });
    const endDrag = (e) => {
        if (!drag || e.pointerId !== drag.id) return;
        const d = drag;
        drag = null;
        if (!d.moved) {
            dot.style.left = `${d.p.x * 100}%`;
            dot.style.top = `${d.p.y * 100}%`;
            dot.classList.remove('hidden');
            setTimeout(() => dot.classList.add('hidden'), 500);
            action({ type: 'tap', x: d.p.x, y: d.p.y });
            return;
        }
        // Hızlı bırakılan kaydırma: parmak hızına göre biraz daha kayar.
        if (e.type === 'pointerup' && Math.hypot(d.vx, d.vy) > 0.4) {
            wheel.dx -= d.vx * 280 * d.p.sx;
            wheel.dy -= d.vy * 280 * d.p.sy;
            flushWheel();
        }
    };
    img.addEventListener('pointerup', endDrag);
    img.addEventListener('pointercancel', endDrag);
    img.addEventListener('contextmenu', (e) => e.preventDefault());

    container.addEventListener('click', (e) => {
        const btn = e.target.closest('button[data-r]');
        if (!btn) return;
        const r = btn.dataset.r;
        if (r === 'close') return close();
        if (r === 'back') return action({ type: 'back' });
        if (r === 'forward') return action({ type: 'forward' });
        if (r === 'reload') return action({ type: 'reload' });
        if (r === 'type') return sendText();
        if (r === 'key') return sendText().then(() => action({ type: 'key', key: btn.dataset.key }));
        if (r === 'pick') {
            const url = btn.dataset.url;
            close();
            onPick(url);
        }
    });

    // Yazılan metin sayfadaki kutucuğa gönderilir; Enter'a ayrıca basılmaz (kullanıcı adından sonra
    // form erken gönderilmesin). Enter/Sonraki/Sil düğmeleri önce bekleyen metni yazar.
    async function sendText() {
        const text = textInput.value;
        textInput.value = '';
        if (text) await action({ type: 'type', text });
    }
    textInput.addEventListener('keydown', (e) => {
        if (e.key === 'Enter') {
            e.preventDefault();
            sendText();
        }
    });

    const onKey = (e) => {
        if (e.key === 'Escape' && container.closest('.remote-overlay')) close();
    };
    document.addEventListener('keydown', onKey);

    // Uygulama kapanırsa sunucudaki sayfa açık kalmasın (sunucu da 90 sn sonra kendisi kapatır).
    window.addEventListener('pagehide', close);

    if (captureId) {
        id = captureId;
        img.style.aspectRatio = '16 / 9';
        setStatus('Videonun oynat düğmesine dokun (reklam/onay varsa önce onları geç). Video başladığı an kayıt başlar.');
        loop();
        return { close };
    }

    (async () => {
        try {
            const state = await renderApi('/session', {
                method: 'POST',
                headers: { 'content-type': 'application/json' },
                body: JSON.stringify({ url: pageUrl })
            }, 40000);
            if (!alive) {
                renderApi(`/session/${state.id}`, { method: 'DELETE' }).catch(() => {});
                return;
            }
            id = state.id;
            pageW = state.width;
            pageH = state.height;
            img.style.aspectRatio = `${state.width} / ${state.height}`;
            setStatus('Dokun: tıklar · Parmağını sürükle: kaydırır. Video başlayınca aşağıda çıkar.');
            renderFound(state.items);
            startStream();
        } catch (err) {
            setStatus(err.message, true);
            alive = false;
        }
    })();

    return { close };
}
