// "Kendim dokunayım" — tam ekran, kendi ekranın gibi.
//
// Sayfa sunucudaki tarayıcıda telefonun kendi ekran boyutunda açılır; görüntüsü canlı gelir ve tüm
// ekranı kaplar (1:1). Parmak hareketleri (dokunma, sürükleme, savurma, iki parmak) sayfaya gerçek
// dokunmatik olay olarak gider; kaydırmayı tarayıcının kendisi yapar. Bir kutucuğa dokununca
// telefonun klavyesi açılır, yazılan doğrudan o kutucuğa gider. Telefonun geri tuşu sayfada geri gider.
// Bu ekranda hiçbir şey engellenmez: sayfa normal bir tarayıcıdaki gibidir.
import { escapeHtml, renderApi, getRenderServer } from './util.js';
import { rememberManifests } from './detect.js';
import { icon } from './icons.js';

function kindTag(item) {
    if (item.kind === 'hls') return 'HLS';
    if (item.kind === 'dash') return 'DASH';
    const ext = (String(item.url).split(/[?#]/)[0].match(/\.([a-z0-9]{2,4})$/i) || [])[1];
    return ext ? ext.toUpperCase() : item.kind === 'audio' ? 'SES' : 'VİDEO';
}

/**
 * @param {string} pageUrl
 * @param {{ onPick?: (url: string) => void, shortUrl?: (u: string) => string, onClose?: () => void }} options
 */
export function openLiveSession(pageUrl, { onPick = () => {}, shortUrl = (u) => u, onClose = () => {} } = {}) {
    const el = document.createElement('div');
    el.className = 'remote-overlay live';
    el.innerHTML = `
        <img class="lv-screen" alt="Sunucuda açılan sayfa" draggable="false">
        <div class="lv-msg">Sayfa sunucunda açılıyor…</div>
        <div class="lv-bar">
            <button class="lv-btn lv-media hidden" data-l="media" aria-label="Bulunan medya">${icon('film')}<b>0</b></button>
            <button class="lv-btn" data-l="more" aria-label="Diğer">${icon('more')}</button>
            <button class="lv-btn" data-l="close" aria-label="Kapat">${icon('close')}</button>
        </div>
        <input class="lv-kbd" type="text" autocomplete="off" autocapitalize="off" autocorrect="off" spellcheck="false" aria-hidden="true" tabindex="-1">`;
    document.body.appendChild(el);
    document.documentElement.classList.add('remote-open');

    const img = el.querySelector('.lv-screen');
    const msg = el.querySelector('.lv-msg');
    const mediaBtn = el.querySelector('[data-l="media"]');
    const kbd = el.querySelector('.lv-kbd');
    let id = null;
    let alive = true;
    let items = [];
    let msgTimer = 0;

    const say = (text, ms = 2500) => {
        msg.textContent = text;
        msg.classList.add('show');
        clearTimeout(msgTimer);
        if (ms) msgTimer = setTimeout(() => msg.classList.remove('show'), ms);
    };
    const post = (body, timeout = 10000) => renderApi(`/session/${id}/action`, {
        method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body)
    }, timeout);

    // Ekran boyu: telefonun kendi ekranı. Görüntü bant genişliği için en fazla 2x yoğunluk.
    const screen = () => ({ width: Math.round(el.clientWidth), height: Math.round(el.clientHeight), dpr: Math.min(2, window.devicePixelRatio || 1) });

    /* ---- Dokunmatik ---- */
    // Sıra: başlangıç/bitiş hiç atlanmaz; hareketler birikirse yalnızca sonuncusu gider (gecikme birikmez).
    const pointers = new Map(); // pointerId → {x, y, id}
    let nextTouchId = 0;
    let sending = false;
    const queue = [];
    let pendingMove = null;
    async function pump() {
        if (sending || !id) return;
        sending = true;
        try {
            while (queue.length || pendingMove) {
                const ev = queue.length ? queue.shift() : pendingMove;
                if (ev === pendingMove) pendingMove = null;
                try {
                    const res = await post(ev);
                    if (ev.phase === 'end') afterTap(res);
                } catch (err) {
                    if (err.status === 404) return end('Oturum kapandı');
                }
            }
        } finally {
            sending = false;
        }
    }
    const pts = () => [...pointers.values()].map((p) => ({ x: p.x, y: p.y, id: p.id }));
    const frac = (e) => {
        const r = img.getBoundingClientRect();
        return { x: (e.clientX - r.left) / r.width, y: (e.clientY - r.top) / r.height };
    };
    img.addEventListener('pointerdown', (e) => {
        if (!id) return;
        e.preventDefault();
        img.setPointerCapture(e.pointerId);
        pointers.set(e.pointerId, { ...frac(e), id: nextTouchId++ % 1000 });
        if (pendingMove) {
            queue.push(pendingMove);
            pendingMove = null;
        }
        // Yeni parmak: o an ekrandaki tüm parmaklarla "başla" (iki parmak = yakınlaştırma).
        queue.push({ type: 'touch', phase: 'start', points: pts() });
        pump();
    });
    img.addEventListener('pointermove', (e) => {
        const p = pointers.get(e.pointerId);
        if (!p) return;
        Object.assign(p, frac(e));
        pendingMove = { type: 'touch', phase: 'move', points: pts() };
        pump();
    });
    const lift = (e) => {
        if (!pointers.has(e.pointerId)) return;
        pointers.delete(e.pointerId);
        if (pendingMove) {
            queue.push(pendingMove);
            pendingMove = null;
        }
        queue.push(pointers.size ? { type: 'touch', phase: 'move', points: pts() }
            : { type: 'touch', phase: e.type === 'pointercancel' ? 'cancel' : 'end', points: [] });
        pump();
    };
    img.addEventListener('pointerup', lift);
    img.addEventListener('pointercancel', lift);
    img.addEventListener('contextmenu', (e) => e.preventDefault());
    // Fare tekerleği (bilgisayarda): sayfa kaydırılır.
    img.addEventListener('wheel', (e) => {
        if (!id) return;
        e.preventDefault();
        const f = frac(e);
        post({ type: 'wheel', x: f.x, y: f.y, dx: Math.round(e.deltaX), dy: Math.round(e.deltaY) }).catch(() => {});
    }, { passive: false });

    /* ---- Klavye: bir kutucuğa dokununca telefonun klavyesi açılır ---- */
    let typed = ''; // klavyedeki görünmez kutunun son gönderilen hali
    function afterTap(res) {
        if (res && res.focus && !res.focus.frame) {
            kbd.type = res.focus.type === 'password' ? 'password' : 'text';
            kbd.inputMode = res.focus.type === 'email' ? 'email' : res.focus.type === 'tel' || res.focus.type === 'number' ? 'numeric'
                : res.focus.type === 'url' ? 'url' : 'text';
            kbd.enterKeyHint = 'go';
            kbd.value = '';
            typed = '';
            if (document.activeElement !== kbd) kbd.focus({ preventScroll: true });
        } else if (document.activeElement === kbd) {
            kbd.blur();
        }
    }
    // Yazılan, bir önceki hâliyle karşılaştırılır: silinenler kadar ⌫, eklenen metin bir kerede
    // gider (otomatik düzeltme, kelime önerisi ve Türkçe klavyeler böylece doğru çalışır).
    let textChain = Promise.resolve();
    kbd.addEventListener('input', () => {
        const now = kbd.value;
        let same = 0;
        while (same < now.length && same < typed.length && now[same] === typed[same]) same++;
        const removed = typed.length - same;
        const added = now.slice(same);
        typed = now;
        textChain = textChain.then(async () => {
            for (let i = 0; i < removed; i++) await post({ type: 'key', key: 'Backspace' }).catch(() => {});
            if (added) await post({ type: 'text', text: added }).catch(() => {});
        });
    });
    kbd.addEventListener('keydown', (e) => {
        if (e.key === 'Enter') {
            e.preventDefault();
            textChain = textChain.then(() => post({ type: 'key', key: 'Enter' }).catch(() => {}));
            kbd.value = '';
            typed = '';
        } else if (e.key === 'Backspace' && !kbd.value) {
            // Kutu boşken silme: sayfadaki metinden sil.
            textChain = textChain.then(() => post({ type: 'key', key: 'Backspace' }).catch(() => {}));
        }
    });

    // Klavye açılıp kapanınca ekran boyu değişir: sayfa da aynı boyu görsün (kutucuk klavyenin üstünde kalsın).
    let lastSize = '';
    const resize = () => {
        if (!id) return;
        const s = screen();
        const key = `${s.width}x${s.height}`;
        if (key === lastSize) return;
        lastSize = key;
        post({ type: 'viewport', width: s.width, height: s.height }).catch(() => {});
    };
    const ro = new ResizeObserver(() => resize());
    ro.observe(el);

    /* ---- Üst düğmeler ---- */
    el.addEventListener('click', (e) => {
        const b = e.target.closest('[data-l]');
        if (!b) return;
        const act = b.dataset.l;
        if (act === 'close') return end();
        if (act === 'media') return openMedia();
        if (act === 'more') return openMore();
    });

    function sheet(html, onClick) {
        const sh = document.createElement('div');
        sh.className = 'sheet-backdrop lv-sheet';
        sh.innerHTML = `<div class="lv-sheet-box"><span class="cf-grip"></span>${html}</div>`;
        el.appendChild(sh);
        requestAnimationFrame(() => sh.classList.add('in'));
        sh.addEventListener('click', (e) => {
            if (e.target === sh) return sh.remove();
            const b = e.target.closest('[data-s]');
            if (b) {
                sh.remove();
                onClick(b.dataset.s, b);
            }
        });
        return sh;
    }
    function openMore() {
        sheet(`<button class="lv-row" data-s="back">${icon('back')}<span>Geri</span></button>
            <button class="lv-row" data-s="forward">${icon('chevronRight')}<span>İleri</span></button>
            <button class="lv-row" data-s="reload">${icon('refresh')}<span>Yenile</span></button>
            <button class="lv-row" data-s="close">${icon('close')}<span>Kapat</span></button>
            <p class="lv-note">Giriş yaparsan sunucunda saklanır; o sitenin videoları sonra girişli açılır.</p>`, (act) => {
            if (act === 'close') return end();
            post({ type: act }, 20000).catch((err) => say(err.message));
        });
    }
    function openMedia() {
        const media = items.filter((i) => i.kind !== 'image');
        sheet(`<div class="lv-sheet-title">Bulunan medya · ${media.length}</div>
            ${media.map((i) => `<button class="lv-row" data-s="pick" data-url="${escapeHtml(i.url)}">
                <span class="rv-tag">${escapeHtml(kindTag(i))}</span><span class="lv-url">${escapeHtml(shortUrl(i.url))}</span><b>İndir</b></button>`).join('')
                || '<p class="lv-note">Henüz yok. Video başlayınca burada çıkar.</p>'}`, (act, b) => {
            if (act !== 'pick') return;
            const url = b.dataset.url;
            end();
            onPick(url);
        });
    }
    function showItems(list) {
        rememberManifests(list);
        items = list;
        const n = list.filter((i) => i.kind !== 'image').length;
        mediaBtn.classList.toggle('hidden', !n);
        const prev = Number(mediaBtn.querySelector('b').textContent) || 0;
        mediaBtn.querySelector('b').textContent = n;
        if (n > prev) say(n === 1 ? 'Video bulundu · üstteki düğmeden indir' : `${n} medya bulundu`);
    }

    /* ---- Telefonun geri tuşu: sayfada geri; geri gidecek yer yoksa kapanır ---- */
    el.__onBack = () => {
        if (el.querySelector('.lv-sheet')) {
            el.querySelector('.lv-sheet').remove();
            return true;
        }
        if (document.activeElement === kbd) {
            kbd.blur();
            return true;
        }
        if (!id) {
            end();
            return true;
        }
        post({ type: 'back' }, 15000).then((st) => {
            if (st && st.went === false) end();
        }).catch(() => end());
        return true;
    };

    function end(text) {
        if (!alive) return;
        alive = false;
        ro.disconnect();
        img.removeAttribute('src');
        if (id) renderApi(`/session/${id}`, { method: 'DELETE', keepalive: true }, 5000).catch(() => {});
        window.removeEventListener('pagehide', onHide);
        el.remove();
        if (!document.querySelector('.remote-overlay')) document.documentElement.classList.remove('remote-open');
        if (text) console.info(text);
        onClose();
    }
    const onHide = () => end();
    window.addEventListener('pagehide', onHide);

    (async () => {
        try {
            const state = await renderApi('/session', {
                method: 'POST',
                headers: { 'content-type': 'application/json' },
                body: JSON.stringify({ url: pageUrl, screen: screen() })
            }, 40000);
            if (!alive) {
                renderApi(`/session/${state.id}`, { method: 'DELETE' }).catch(() => {});
                return;
            }
            id = state.id;
            lastSize = `${state.width}x${state.height}`;
            showItems(state.items || []);
            const server = getRenderServer();
            img.addEventListener('load', () => msg.classList.remove('show'), { once: true });
            img.addEventListener('error', () => say('Canlı görüntü kesildi; kapatıp yeniden aç', 0));
            img.src = `${server.url}/session/${id}/stream?token=${encodeURIComponent(server.token || '')}`;
            resize();
            // Bulunan medya ve açılan pencereler ara ara sorulur.
            let popup = false;
            while (alive) {
                await new Promise((r) => setTimeout(r, 1500));
                if (!alive) break;
                try {
                    const st = await renderApi(`/session/${id}`, {}, 10000);
                    showItems(st.items || []);
                    if (st.popup !== popup) {
                        popup = st.popup;
                        say(popup ? 'Yeni pencere açıldı · geri tuşu ile önceki sayfaya dönersin' : 'Sayfaya dönüldü');
                    }
                } catch (err) {
                    if (err.status === 404) return end('Oturum kapandı');
                }
            }
        } catch (err) {
            say(err.message, 0);
            alive = false;
        }
    })();

    return { close: end };
}
