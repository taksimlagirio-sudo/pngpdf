// TV'de oynat: Chromecast/akıllı TV (tarayıcının yayın menüsü) ya da TV'nin tarayıcısında açılan
// sayfa. Her iki durumda telefon "kumanda" olur.
import { escapeHtml, clock, getRenderServer, renderApi } from './util.js';
import { uploadItem } from './sync.js';
import { icon } from './icons.js';

function overlay() {
    const el = document.createElement('div');
    el.className = 'remote-overlay cast';
    document.body.appendChild(el);
    document.documentElement.classList.add('remote-open');
    return el;
}

function closeOverlay(el) {
    el.remove();
    if (!document.querySelector('.remote-overlay')) document.documentElement.classList.remove('remote-open');
}

/** Öğenin sunucudaki karşılığı (yoksa yüklenir). */
async function serverSource(item, onStatus) {
    if (item.serverKind && item.serverId) return `${item.serverKind}:${item.serverId}`;
    if (item.synced) return `library:${item.id}`;
    onStatus('Sunucuna gönderiliyor…');
    await uploadItem(item);
    return `library:${item.id}`;
}

function fileUrl(source) {
    const server = getRenderServer();
    const [kind, id] = source.split(':');
    const path = kind === 'library' ? `/library/item/${encodeURIComponent(id)}/file` : `/${kind}/${id}/file`;
    return `${server.url}${path}?token=${encodeURIComponent(server.token)}`;
}

export function openCast(item, { toast }) {
    if (!getRenderServer()) {
        toast('TV\'de oynatmak için kendi sunucun gerekli');
        return;
    }
    const el = overlay();
    const canRemote = 'remote' in HTMLMediaElement.prototype;
    const options = [
        ...(canRemote ? [['remote', icon('cast'), 'Chromecast / akıllı TV', 'Telefonun yayın menüsü açılır']] : []),
        ['browser', icon('globe'), 'Tarayıcıda aç', 'Herhangi bir TV ya da bilgisayar']
    ];
    let choice = options[0][0];
    let stopPolling = null;
    let remoteVideo = null;

    function close() {
        if (stopPolling) stopPolling();
        if (remoteVideo) {
            remoteVideo.pause();
            remoteVideo.remove();
        }
        closeOverlay(el);
    }

    function drawChoice(status = '') {
        el.innerHTML = `<div class="cs">
            <div class="wz-top"><button class="back-btn" data-c="close" aria-label="Kapat">${icon('back')}</button><span>TV'de oynat</span><small class="cs-note">Aynı Wi-Fi'dakiler</small></div>
            <div class="cs-title">${escapeHtml(item.name)}</div>
            <div class="cs-opts">${options.map(([k, ic, l, sub]) => `<button class="cs-opt${choice === k ? ' on' : ''}" data-c="pick" data-v="${k}">
                <span class="cs-ic">${ic}</span><span class="cs-main"><b>${l}</b><small>${sub}</small></span><span class="cs-radio"></span></button>`).join('')}</div>
            ${status ? `<p class="cs-status">${escapeHtml(status)}</p>` : ''}
            <button class="btn-big cs-go" data-c="go">Oynat · ${escapeHtml(options.find(([k]) => k === choice)[2])}</button></div>`;
    }

    async function start() {
        let source;
        try {
            source = await serverSource(item, (t) => drawChoice(t));
        } catch (err) {
            return drawChoice(`Gönderilemedi: ${err.message}`);
        }
        if (choice === 'remote') return startRemote(source);
        return startBrowser(source);
    }

    /* ---- Chromecast / akıllı TV (Remote Playback API) ---- */
    async function startRemote(source) {
        remoteVideo = document.createElement('video');
        remoteVideo.src = fileUrl(source);
        remoteVideo.preload = 'metadata';
        remoteVideo.style.cssText = 'position:fixed;left:-9999px;width:2px;height:2px';
        document.body.appendChild(remoteVideo);
        try {
            await remoteVideo.remote.prompt();
        } catch (err) {
            // Yükleme dokunuşu tükettiyse yeniden dokunmak gerekir.
            return drawChoice(err.name === 'NotAllowedError' ? 'Bir kez daha "Oynat"a dokun' : `TV bulunamadı: ${err.message}`);
        }
        const v = remoteVideo;
        const adapter = {
            name: 'TV',
            send(action, value) {
                if (action === 'play') v.play().catch(() => {});
                if (action === 'pause') v.pause();
                if (action === 'seek') v.currentTime = Math.max(0, v.currentTime + value);
                if (action === 'to') v.currentTime = value;
                if (action === 'volume') v.volume = Math.max(0, Math.min(1, value));
                if (action === 'close') v.remote.state !== 'disconnected' && v.pause();
            },
            state: () => ({ connected: v.remote.state === 'connected', state: { t: v.currentTime, d: v.duration || item.duration || 0, paused: v.paused, volume: v.volume } })
        };
        v.play().catch(() => {});
        remoteControl(adapter);
    }

    /* ---- Tarayıcıda aç ---- */
    async function startBrowser(source) {
        let session;
        try {
            session = await renderApi('/tv', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ source, title: item.name }) }, 20000);
        } catch (err) {
            return drawChoice(err.message);
        }
        const server = getRenderServer();
        const main = session.urls.find((u) => u.label !== 'Bu cihaz') || session.urls[0];
        const qr = `${server.url}/tv/${session.id}/qr?u=${encodeURIComponent(main.url)}&token=${encodeURIComponent(server.token)}`;
        el.innerHTML = `<div class="cs">
            <div class="wz-top"><button class="back-btn" data-c="close" aria-label="Kapat">${icon('back')}</button><span>TV'nin tarayıcısında aç</span></div>
            <p class="cs-note2">TV'nin (ya da bilgisayarın) tarayıcısına bu adresi yaz ya da QR'ı okut. Açılınca kumanda burada çıkar.</p>
            <div class="cs-qr"><img src="${escapeHtml(qr)}" alt="QR"></div>
            <div class="cs-urls">${session.urls.map((u) => `<div><small>${escapeHtml(u.label)}</small><b>${escapeHtml(u.url)}</b></div>`).join('')}</div>
            ${session.urls.length === 1 ? '<p class="cs-note2">Başka cihazdan açmak için sunucuyu HOST=0.0.0.0 ile başlat (aynı Wi-Fi) ya da Tailscale kullan.</p>' : ''}
            <p class="cs-status" data-c-wait>TV bekleniyor…</p></div>`;
        const adapter = {
            name: 'TV tarayıcısı',
            send: (action, value) => renderApi(`/tv/${session.id}/cmd`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ action, value }) }, 8000).catch(() => {}),
            fetchState: () => renderApi(`/tv/${session.id}`, {}, 8000),
            end: () => renderApi(`/tv/${session.id}`, { method: 'DELETE' }, 8000).catch(() => {})
        };
        let alive = true;
        stopPolling = () => { alive = false; };
        while (alive) {
            const st = await adapter.fetchState().catch(() => null);
            if (st && st.connected) break;
            await new Promise((r) => setTimeout(r, 1500));
        }
        if (alive) remoteControl(adapter);
    }

    /* ---- Kumanda ---- */
    function remoteControl(adapter) {
        let state = { t: 0, d: item.duration || 0, paused: false, volume: 0.6 };
        let connected = true;
        el.innerHTML = `<div class="cs km">
            <div class="wz-top"><button class="back-btn" data-c="close" aria-label="Kapat">${icon('back')}</button><span>Kumanda</span>
                <small class="km-dev"><i></i>${escapeHtml(adapter.name)}</small></div>
            <div class="km-prev" style="${item.thumb ? `background-image:url('${item.thumb}')` : ''}"><span>TV'de oynatılıyor</span></div>
            <div class="cs-title">${escapeHtml(item.name)}</div>
            <div class="km-meta">${[item.height ? `${item.height}p` : '', item.site || ''].filter(Boolean).join(' · ')}</div>
            <div class="km-seek"><div class="km-track"><span class="km-fill"></span></div><input type="range" min="0" max="1000" value="0" aria-label="Konum"></div>
            <div class="km-times"><span data-k="t">0:00</span><span data-k="d">${clock(state.d)}</span></div>
            <div class="km-main">
                <button data-k="back"><b>${icon('back10')}</b>10 sn</button>
                <button class="km-play" data-k="play">${icon('pause')}</button>
                <button data-k="fwd"><b>${icon('fwd10')}</b>10 sn</button></div>
            <div class="km-vol-head"><span>Ses</span><span data-k="vol">60%</span></div>
            <div class="km-vol"><button data-k="vdown">−</button><span class="km-bars">${Array.from({ length: 10 }, (_, i) => `<i style="height:${8 + i * 2}px"></i>`).join('')}</span><button data-k="vup">+</button></div>
            <div class="km-extra"><button data-k="subs"><b>${icon('subtitles')}</b>Altyazı</button><button data-k="restart"><b>${icon('rotate')}</b>Baştan</button><button class="danger" data-k="end"><b>${icon('close')}</b>Bağlantıyı kes</button></div>
        </div>`;
        const range = el.querySelector('.km-seek input');
        let seeking = false;
        let subsOn = false;
        const paint = () => {
            el.querySelector('[data-k="t"]').textContent = clock(state.t);
            el.querySelector('[data-k="d"]').textContent = clock(state.d);
            el.querySelector('.km-fill').style.width = `${state.d ? (state.t / state.d) * 100 : 0}%`;
            if (!seeking) range.value = state.d ? Math.round((state.t / state.d) * 1000) : 0;
            el.querySelector('.km-play').innerHTML = icon(state.paused ? 'play' : 'pause');
            el.querySelector('[data-k="vol"]').textContent = `${Math.round(state.volume * 100)}%`;
            el.querySelectorAll('.km-bars i').forEach((b, i) => b.classList.toggle('on', i < Math.round(state.volume * 10)));
            el.querySelector('.km-dev').classList.toggle('off', !connected);
        };
        let alive = true;
        stopPolling = () => { alive = false; };
        (async () => {
            while (alive) {
                const st = adapter.fetchState ? await adapter.fetchState().catch(() => null) : adapter.state();
                if (st && st.state) {
                    state = { ...state, ...st.state };
                    connected = st.connected;
                    paint();
                }
                await new Promise((r) => setTimeout(r, 1000));
            }
        })();
        range.addEventListener('input', () => { seeking = true; });
        range.addEventListener('change', () => {
            seeking = false;
            adapter.send('to', (range.value / 1000) * state.d);
        });
        el.addEventListener('click', (e) => {
            const b = e.target.closest('[data-k]');
            if (!b) return;
            const k = b.dataset.k;
            if (k === 'play') {
                adapter.send(state.paused ? 'play' : 'pause');
                state.paused = !state.paused;
            }
            if (k === 'back') adapter.send('seek', -10);
            if (k === 'fwd') adapter.send('seek', 10);
            if (k === 'restart') adapter.send('to', 0);
            if (k === 'vdown' || k === 'vup') {
                state.volume = Math.max(0, Math.min(1, Math.round((state.volume + (k === 'vup' ? 0.1 : -0.1)) * 10) / 10));
                adapter.send('volume', state.volume);
            }
            if (k === 'subs') {
                subsOn = !subsOn;
                adapter.send('subs', subsOn ? 1 : 0);
                b.classList.toggle('on', subsOn);
            }
            if (k === 'end') {
                adapter.send('close');
                if (adapter.end) adapter.end();
                close();
                return;
            }
            paint();
        });
        paint();
    }

    el.addEventListener('click', (e) => {
        const b = e.target.closest('[data-c]');
        if (!b) return;
        const c = b.dataset.c;
        if (c === 'close') return close();
        if (c === 'pick') {
            choice = b.dataset.v;
            return drawChoice();
        }
        if (c === 'go') start();
    });
    drawChoice();
    return { close };
}
