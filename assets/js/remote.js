// "Kendim dokunayım": sayfa kendi sunucunda açık kalır, ekran görüntüsü burada gösterilir ve
// dokunuşlar sunucudaki sayfaya iletilir. Çerez onayı, yaş onayı, birden çok "oynat" gibi
// otomatik geçilemeyen adımlar böyle elle geçilir; bu sırada gelen medya canlı listelenir.
import { escapeHtml, renderApi, renderBlob, getRenderServer } from './util.js';

const ICONS = { hls: '📡', video: '🎬', audio: '🎵', dash: '📺', image: '🖼️' };
const FRAME_DELAY_MS = 500;

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
    container.innerHTML = `
        <div class="remote-view">
            <div class="remote-head">
                <strong>👆 Sayfaya kendin dokun</strong>
                <button class="btn btn-secondary" data-r="close">✕ Kapat</button>
            </div>
            <p class="hint remote-status">Sayfa sunucunda açılıyor...</p>
            <div class="remote-screen">
                <img alt="Sunucuda açılan sayfa">
                <span class="remote-dot hidden"></span>
            </div>
            <div class="remote-controls">
                <button class="btn btn-secondary" data-r="up" title="Yukarı kaydır">▲</button>
                <button class="btn btn-secondary" data-r="down" title="Aşağı kaydır">▼</button>
                <button class="btn btn-secondary" data-r="back" title="Geri">←</button>
                <button class="btn btn-secondary" data-r="reload" title="Yenile">⟳</button>
            </div>
            <div class="remote-type">
                <input class="input" type="text" placeholder="Kutucuğa dokun, sonra buraya yaz">
                <button class="btn btn-secondary" data-r="type">Yaz ⏎</button>
            </div>
            <div class="remote-found"></div>
        </div>`;

    const status = container.querySelector('.remote-status');
    const img = container.querySelector('.remote-screen img');
    const dot = container.querySelector('.remote-dot');
    const textInput = container.querySelector('.remote-type input');
    const foundBox = container.querySelector('.remote-found');

    let id = null;
    let alive = true;
    let frameUrl = null;
    let kick = null; // dokununca bekleme süresini kısaltıp hemen yeni görüntü al
    let foundKey = '';

    const setStatus = (text, isError = false) => {
        status.textContent = text;
        status.classList.toggle('error', isError);
    };

    function renderFound(items) {
        const media = items.filter((i) => i.kind !== 'image');
        const key = media.map((i) => i.url).join('\n');
        if (key === foundKey) return;
        foundKey = key;
        foundBox.innerHTML = media.length
            ? `<p class="hint">🔎 Bulunan medya (<strong>${media.length}</strong>) — indirmek için dokun:</p>
               <div class="variant-list">${media.map((i) => `
                   <button class="variant" data-r="pick" data-url="${escapeHtml(i.url)}">
                       <span>${ICONS[i.kind] || '📄'} ${escapeHtml(shortUrl(i.url))}</span><span>⬇️</span>
                   </button>`).join('')}</div>`
            : '';
        if (media.length) setStatus('✅ Medya bulundu. Aşağıdan seç ya da dokunmaya devam et.');
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
        } catch (err) {
            setStatus(`❌ ${err.message}`, true);
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
                if (frameUrl) URL.revokeObjectURL(frameUrl);
                frameUrl = next;
                if (!captureId && tick++ % 3 === 0) renderFound((await renderApi(base(), {}, 10000)).items);
            } catch (err) {
                if (!alive) break;
                setStatus(`❌ ${err.message}`, true);
                if (err.status === 404) return stop();
            }
            await new Promise((resolve) => {
                kick = resolve;
                setTimeout(resolve, FRAME_DELAY_MS);
            });
            kick = null;
        }
    }

    function stop() {
        alive = false;
        if (kick) kick();
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
        onClose();
    }

    img.addEventListener('click', (e) => {
        const rect = img.getBoundingClientRect();
        const x = (e.clientX - rect.left) / rect.width;
        const y = (e.clientY - rect.top) / rect.height;
        dot.style.left = `${x * 100}%`;
        dot.style.top = `${y * 100}%`;
        dot.classList.remove('hidden');
        setTimeout(() => dot.classList.add('hidden'), 600);
        action({ type: 'tap', x, y });
    });

    container.addEventListener('click', (e) => {
        const btn = e.target.closest('button[data-r]');
        if (!btn) return;
        const r = btn.dataset.r;
        if (r === 'close') return close();
        if (r === 'up') return action({ type: 'scroll', dy: -0.6 });
        if (r === 'down') return action({ type: 'scroll', dy: 0.6 });
        if (r === 'back') return action({ type: 'back' });
        if (r === 'reload') return action({ type: 'reload' });
        if (r === 'type') return sendText();
        if (r === 'pick') {
            const url = btn.dataset.url;
            close();
            onPick(url);
        }
    });

    async function sendText() {
        const text = textInput.value;
        textInput.value = '';
        if (text) await action({ type: 'type', text });
        await action({ type: 'key', key: 'Enter' });
    }
    textInput.addEventListener('keydown', (e) => {
        if (e.key === 'Enter') sendText();
    });

    // Uygulama kapanırsa sunucudaki sayfa açık kalmasın (sunucu da 90 sn sonra kendisi kapatır).
    window.addEventListener('pagehide', close);

    if (captureId) {
        id = captureId;
        img.style.aspectRatio = '16 / 9';
        setStatus('Videonun oynat düğmesine dokun (reklam/onay varsa önce onları geç). Video başladığı an kayıt kendiliğinden başlar.');
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
            img.style.aspectRatio = `${state.width} / ${state.height}`;
            setStatus('Görüntüye dokun: dokunduğun yer sunucudaki sayfada tıklanır. Video başlayınca adresi aşağıda çıkar.');
            renderFound(state.items);
            loop();
        } catch (err) {
            setStatus(`❌ ${err.message}`, true);
            alive = false;
        }
    })();

    return { close };
}
