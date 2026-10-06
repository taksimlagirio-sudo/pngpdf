// "Kendim dokunayım" — tam ekran, kendi ekranın gibi.
//
// Sayfa sunucudaki tarayıcıda telefonun kendi ekran boyutunda açılır; görüntüsü canlı gelir ve tüm
// ekranı kaplar (1:1). Parmak hareketleri (dokunma, sürükleme, savurma, iki parmak) sayfaya gerçek
// dokunmatik olay olarak gider; kaydırmayı tarayıcının kendisi yapar. Bir kutucuğa dokununca
// telefonun klavyesi açılır, yazılan doğrudan o kutucuğa gider. Telefonun geri tuşu sayfada geri gider.
// Bu ekranda hiçbir şey engellenmez: sayfa normal bir tarayıcıdaki gibidir.
//
// Medya: sayfanın yüklediği videolar arka planda toplanır; "Bu videoyu yakala" oynayan videoyu
// elle arar. Liste önizlemeli (küçük resim, süre, çözünürlük; dokununca oynar). Birini seçince oturum
// kapanmaz, yalnızca gizlenir: sonuçtan geri gelince aynı sayfa ve aynı liste durur.
//
// captureId verilirse aynı ekran "aç ve kaydet"in kendin başlat ekranıdır: video başlayınca kayıt
// başlar, üstteki şerit kaydın durumunu gösterir.
import { escapeHtml, renderApi, getRenderServer, formatSize, clock } from './util.js';
import { rememberManifests } from './detect.js';
import { attachPreview } from './preview.js';
import { icon } from './icons.js';

function kindTag(item) {
    if (item.kind === 'hls') return 'HLS';
    if (item.kind === 'dash') return 'DASH';
    const ext = (String(item.url).split(/[?#]/)[0].match(/\.([a-z0-9]{2,4})$/i) || [])[1];
    return ext ? ext.toUpperCase() : item.kind === 'audio' ? 'SES' : 'VİDEO';
}

/** Ana HLS listesinden kaliteler: "4 kalite · 1080p'ye kadar". */
function hlsQualities(text) {
    if (!text || !text.includes('#EXT-X-STREAM-INF')) return '';
    const heights = [...text.matchAll(/RESOLUTION=\d+x(\d+)/g)].map((m) => Number(m[1]));
    const n = (text.match(/#EXT-X-STREAM-INF/g) || []).length;
    const top = heights.length ? Math.max(...heights) : 0;
    return `${n} kalite${top ? ` · ${top}p'ye kadar` : ''}`;
}

function hostPath(url) {
    try {
        const u = new URL(url);
        const file = u.pathname.split('/').filter(Boolean).pop() || '';
        return `${u.host.replace(/^www\./, '')}/…/${decodeURIComponent(file).slice(0, 40)}`;
    } catch (_) {
        return url;
    }
}

/**
 * @param {string|null} pageUrl
 * @param {object} o
 * @param {(url: string, item: object) => void} [o.onPick]   medya seçildi (ekran gizlenir, oturum açık kalır)
 * @param {(pageUrl: string) => void} [o.onCapture]          "oynatıp kaydet" istendi
 * @param {() => void} [o.onClose]
 * @param {string} [o.captureId]                             kayıt bekleyen sayfa (kendin başlat)
 * @returns {{ close: () => void, hide: () => void, show: () => void, readonly hidden: boolean }}
 */
export function openLiveSession(pageUrl, { onPick = () => {}, onCapture = null, onClose = () => {}, captureId = null, account = null, onLogin = () => {} } = {}) {
    const el = document.createElement('div');
    // account: { domain, name } — hesaba giriş ekranı: üstte site adı, giriş algılanınca onay kartı.
    el.className = `remote-overlay live${captureId ? ' cap' : ''}${account ? ' acc' : ''}`;
    el.innerHTML = `
        <img class="lv-screen" alt="Sunucuda açılan sayfa" draggable="false">
        <div class="lv-msg">${captureId ? 'Kayıt sayfası açılıyor…' : 'Sayfa sunucunda açılıyor…'}</div>
        ${account ? `<div class="lv-acc"><button class="lv-btn" data-l="close" aria-label="Kapat">${icon('close')}</button>
            <span class="lv-acc-t"><b>${escapeHtml(account.name)} hesabına giriş</b><small class="lv-acc-u">${escapeHtml(account.domain)}</small></span>
            <span class="lv-acc-lock">${icon('lock')}sunucunda</span></div>
        <div class="lv-acc-done hidden"><div class="lv-acc-row"><span class="lv-acc-ok">${icon('check')}</span>
            <span><b>Giriş algılandı</b><small>${escapeHtml(account.name)} girişin sunucunda saklandı; bu sitenin videoları artık girişli açılır.</small></span></div>
            <button class="lv-acc-btn" data-l="close">Tamam</button></div>` : captureId ? `<div class="lv-cap">
            <div class="lv-cap-row"><i class="lv-dot"></i><span class="lv-cap-t"><b>Videoyu başlat</b><small>Başladığı an kayıt kendiliğinden başlar</small></span>
                <button class="lv-btn" data-l="close" aria-label="Kapat">${icon('close')}</button></div>
            <div class="lv-cap-prog hidden"><i></i></div>
            <div class="lv-cap-btns hidden"><button class="lv-cap-bg" data-l="close">Arka plana al</button><button class="lv-cap-stop" data-l="stop">Durdur ve kaydet</button></div>
        </div>` : `<div class="lv-bar">
            <button class="lv-btn lv-media hidden" data-l="media" aria-label="Bulunan medya">${icon('film')}<b>0</b></button>
            <button class="lv-btn" data-l="more" aria-label="Diğer">${icon('more')}</button>
            <button class="lv-btn" data-l="close" aria-label="Kapat">${icon('close')}</button>
        </div>
        <div class="lv-fab-wrap hidden"><span class="lv-fab-note">Video oynuyor ama bağlantısı henüz görünmedi</span>
            <button class="lv-fab" data-l="catch">${icon('record')}Bu videoyu yakala</button></div>`}
        <input class="lv-kbd" type="text" autocomplete="off" autocapitalize="off" autocorrect="off" spellcheck="false" aria-hidden="true" tabindex="-1">`;
    document.body.appendChild(el);
    document.documentElement.classList.add('remote-open');

    const img = el.querySelector('.lv-screen');
    const msg = el.querySelector('.lv-msg');
    const mediaBtn = el.querySelector('[data-l="media"]');
    const fab = el.querySelector('.lv-fab-wrap');
    const kbd = el.querySelector('.lv-kbd');
    let id = captureId;
    let alive = true;
    let hidden = false;
    let items = [];
    let playing = false;
    let msgTimer = 0;
    let streamUrl = '';
    const base = () => (captureId ? `/capture/${captureId}` : `/session/${id}`);

    const say = (text, ms = 2500) => {
        msg.textContent = text;
        msg.classList.add('show');
        clearTimeout(msgTimer);
        if (ms) msgTimer = setTimeout(() => msg.classList.remove('show'), ms);
    };
    const post = (body, timeout = 10000) => renderApi(`${base()}/action`, {
        method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body)
    }, timeout);

    // Ekran boyu: telefonun kendi ekranı. Görüntü bant genişliği için en fazla 2x yoğunluk.
    const screen = () => ({ width: Math.round(img.clientWidth || el.clientWidth), height: Math.round(img.clientHeight || el.clientHeight), dpr: Math.min(2, window.devicePixelRatio || 1) });

    /* ---- Dokunmatik ---- */
    const pointers = new Map();
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
                    if (err.status === 404) return end();
                }
            }
        } finally {
            sending = false;
        }
    }
    const pts = () => [...pointers.values()].map((p) => ({ x: p.x, y: p.y, id: p.id }));
    // Kayıt sayfası masaüstü boyutunda: görüntü ekrana sığdırılır (kenarlarda boşluk), dokunuş
    // görüntünün çizildiği alana göre hesaplanır.
    const frac = (e) => {
        const r = img.getBoundingClientRect();
        let { left, top, width, height } = r;
        if (captureId && img.naturalWidth) {
            const scale = Math.min(r.width / img.naturalWidth, r.height / img.naturalHeight);
            width = img.naturalWidth * scale;
            height = img.naturalHeight * scale;
            left += (r.width - width) / 2;
            top += (r.height - height) / 2;
        }
        return { x: (e.clientX - left) / width, y: (e.clientY - top) / height };
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
    img.addEventListener('wheel', (e) => {
        if (!id) return;
        e.preventDefault();
        const f = frac(e);
        post({ type: 'wheel', x: f.x, y: f.y, dx: Math.round(e.deltaX), dy: Math.round(e.deltaY) }).catch(() => {});
    }, { passive: false });

    /* ---- Klavye: bir kutucuğa dokununca telefonun klavyesi açılır ---- */
    let typed = '';
    function afterTap(res) {
        if (res && res.focus && !res.focus.frame) {
            kbd.type = res.focus.type === 'password' ? 'password' : 'text';
            kbd.inputMode = res.focus.type === 'email' ? 'email' : res.focus.type === 'tel' || res.focus.type === 'number' ? 'numeric'
                : res.focus.type === 'url' ? 'url' : 'text';
            kbd.enterKeyHint = 'go';
            kbd.value = '';
            typed = '';
            if (document.activeElement !== kbd) kbd.focus({ preventScroll: true });
            // APK: uygulama içindeki tarayıcı klavyeyi yalnızca doğrudan dokunuşla açar; Android'e açtırılır.
            if (window.IndiriciAndroid && window.IndiriciAndroid.showKeyboard) window.IndiriciAndroid.showKeyboard();
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
            textChain = textChain.then(() => post({ type: 'key', key: 'Backspace' }).catch(() => {}));
        }
    });

    // Klavye açılıp kapanınca ekran boyu değişir: sayfa da aynı boyu görsün.
    let lastSize = '';
    const resize = () => {
        if (!id || captureId || hidden) return;
        const s = screen();
        const key = `${s.width}x${s.height}`;
        if (key === lastSize) return;
        lastSize = key;
        post({ type: 'viewport', width: s.width, height: s.height }).catch(() => {});
    };
    const ro = new ResizeObserver(() => resize());
    ro.observe(el);

    /* ---- Düğmeler ---- */
    el.addEventListener('click', (e) => {
        const b = e.target.closest('[data-l]');
        if (!b) return;
        const act = b.dataset.l;
        if (act === 'close') return end();
        if (act === 'media') return openMedia();
        if (act === 'more') return openMore();
        if (act === 'catch') return catchPlaying();
        if (act === 'stop') {
            b.disabled = true;
            renderApi(`/capture/${captureId}/stop`, { method: 'POST' }, 10000).catch((err) => say(err.message));
        }
    });

    function sheet(html) {
        el.querySelectorAll('.lv-sheet').forEach((s) => s.remove());
        const sh = document.createElement('div');
        sh.className = 'sheet-backdrop lv-sheet';
        sh.innerHTML = `<div class="lv-sheet-box"><span class="cf-grip"></span>${html}</div>`;
        el.appendChild(sh);
        requestAnimationFrame(() => sh.classList.add('in'));
        sh.addEventListener('click', (e) => { if (e.target === sh) closeSheet(sh); });
        return sh;
    }
    function closeSheet(sh) {
        sh.querySelectorAll('video').forEach((v) => { if (v._pv) v._pv.destroy(); });
        sh.remove();
    }
    function openMore() {
        const sh = sheet(`<button class="lv-row" data-s="back">${icon('back')}<span>Geri</span></button>
            <button class="lv-row" data-s="forward">${icon('chevronRight')}<span>İleri</span></button>
            <button class="lv-row" data-s="reload">${icon('refresh')}<span>Yenile</span></button>
            <button class="lv-row" data-s="goto">${icon('link')}<span>Adrese git</span></button>
            <button class="lv-row" data-s="close">${icon('close')}<span>Kapat</span></button>
            <p class="lv-note">Giriş yaparsan sunucunda saklanır; o sitenin videoları sonra girişli açılır.</p>`);
        sh.addEventListener('click', (e) => {
            const b = e.target.closest('[data-s]');
            if (!b) return;
            closeSheet(sh);
            if (b.dataset.s === 'close') return end();
            if (b.dataset.s === 'goto') return openGoto();
            post({ type: b.dataset.s }, 20000).catch((err) => say(err.message));
        });
    }

    /** Adrese git: e-postadaki tek kullanımlık giriş bağlantısı gibi bir adres sunucudaki sayfada açılır. */
    function openGoto() {
        const sh = sheet(`<div class="lv-sheet-title">Adrese git</div>
            <p class="lv-note">Örneğin e-postana gelen "tek kullanımlık giriş" bağlantısını kopyalayıp buraya yapıştır; giriş sunucudaki sayfada tamamlanır.</p>
            <form class="lv-goto"><input type="url" inputmode="url" placeholder="https://…" autocomplete="off" spellcheck="false">
                <button class="lv-goto-btn" type="submit">Git</button></form>
            <button class="lv-back-btn" data-s="close-sheet">Vazgeç</button>`);
        const input = sh.querySelector('input');
        navigator.clipboard?.readText?.().then((t) => { if (/^https?:\/\//.test(t.trim()) && !input.value) input.value = t.trim(); }).catch(() => {});
        setTimeout(() => input.focus(), 150);
        sh.addEventListener('click', (e) => { if (e.target.closest('[data-s="close-sheet"]')) closeSheet(sh); });
        sh.querySelector('form').addEventListener('submit', (e) => {
            e.preventDefault();
            const url = input.value.trim();
            if (!url) return;
            closeSheet(sh);
            say('Açılıyor…', 0);
            post({ type: 'goto', url }, 40000).then(() => say('Açıldı', 1500)).catch((err) => say(err.message));
        });
    }

    /* ---- Medya listesi: önizlemeli ---- */
    const probes = new Map(); // url → Promise<{thumb, duration, width, height, error}>
    const probe = (url) => {
        if (!probes.has(url)) probes.set(url, post({ type: 'probe', url }, 40000).catch(() => ({})));
        return probes.get(url);
    };
    function mediaList() {
        return items.filter((i) => i.kind !== 'image' && !i.failed);
    }
    function openMedia({ title = '', playingSrcs = [], blob = false, catching = false } = {}) {
        const media = mediaList();
        const rank = (i) => (playingSrcs.includes(i.url) ? 0 : i.kind === 'hls' || i.kind === 'dash' ? 1 : 2);
        media.sort((a, b) => rank(a) - rank(b) || (b.size || 0) - (a.size || 0));
        const row = (i) => `<div class="lv-item" data-url="${escapeHtml(i.url)}">
            <button class="lv-th" data-s="preview" aria-label="Önizle"><span class="lv-th-tag">${escapeHtml(kindTag(i))}</span>${icon('play')}</button>
            <span class="lv-meta"><b>${playingSrcs.includes(i.url) ? '<i class="lv-badge">Oynayan</i>' : ''}<span class="lv-title">${escapeHtml(i.kind === 'audio' ? 'Ses' : 'Video')}${i.text ? ` · ${escapeHtml(hlsQualities(i.text))}` : ''}</span></b>
                <small class="lv-sub">${escapeHtml(hostPath(i.url))}${i.size ? ` · ${formatSize(i.size)}` : ''}</small></span>
            <button class="lv-dl" data-s="pick">İndir</button>
            <div class="lv-pv-box hidden"></div>
        </div>`;
        const sh = sheet(`<div class="lv-sheet-title">${escapeHtml(title || `Bulunan medya · ${media.length}`)}</div>
            ${catching ? '<p class="lv-note lv-wait">Oynayan video aranıyor…</p>' : ''}
            <div class="lv-items">${media.map(row).join('')}</div>
            ${!catching && !media.length ? `<p class="lv-note">${blob ? 'Video oynuyor ama parça parça yükleniyor; bağlantısı görünmüyor.' : 'Henüz yok. Videoyu başlatıp "Bu videoyu yakala"ya bas.'}</p>` : ''}
            ${onCapture ? `<button class="lv-capture" data-s="capture"><span class="lv-cap-ic">${icon('record')}</span>
                <span><b>Bağlantı inmezse: oynatıp kaydet</b><small>Sunucun bu sayfayı açık oturumunla oynatır, gördüğü videoyu kaydeder.</small></span></button>` : ''}
            <button class="lv-back-btn" data-s="close-sheet">Sayfaya dön</button>`);
        // Küçük resim, süre ve çözünürlük sırayla gelir (aynı anda en fazla iki).
        const rows = [...sh.querySelectorAll('.lv-item')];
        let next = 0;
        const worker = async () => {
            while (next < rows.length && sh.isConnected) {
                const r = rows[next++];
                const info = await probe(r.dataset.url);
                if (!sh.isConnected) return;
                if (info.thumb) {
                    const th = r.querySelector('.lv-th');
                    th.style.backgroundImage = `url('${info.thumb}')`;
                    th.classList.add('has');
                }
                const bits = [];
                if (info.height) bits.push(`${info.height}p`);
                if (info.duration) bits.push(clock(info.duration));
                if (bits.length) {
                    const t = r.querySelector('.lv-title');
                    t.textContent = `${t.textContent} · ${bits.join(' · ')}`;
                }
                if (info.error && !info.thumb) r.querySelector('.lv-sub').textContent += ' · önizleme yok';
            }
        };
        worker();
        worker();
        sh.addEventListener('click', (e) => {
            const b = e.target.closest('[data-s]');
            if (!b) return;
            const act = b.dataset.s;
            if (act === 'close-sheet') return closeSheet(sh);
            if (act === 'capture') {
                closeSheet(sh);
                const at = pageUrl;
                renderApi(base(), {}, 8000).then((st) => onCapture(st.url || at)).catch(() => onCapture(at));
                return;
            }
            const r = b.closest('.lv-item');
            if (!r) return;
            const item = items.find((i) => i.url === r.dataset.url) || { url: r.dataset.url };
            if (act === 'pick') {
                closeSheet(sh);
                hide();
                onPick(item.url, item);
                return;
            }
            if (act === 'preview') togglePreview(r, item);
        });
        return sh;
    }
    function togglePreview(r, item) {
        const box = r.querySelector('.lv-pv-box');
        if (!box.classList.contains('hidden')) {
            const v = box.querySelector('video');
            if (v && v._pv) v._pv.destroy();
            box.innerHTML = '';
            box.classList.add('hidden');
            return;
        }
        // Aynı anda tek önizleme.
        r.closest('.lv-items').querySelectorAll('.lv-pv-box:not(.hidden)').forEach((b) => {
            const v = b.querySelector('video');
            if (v && v._pv) v._pv.destroy();
            b.innerHTML = '';
            b.classList.add('hidden');
        });
        box.classList.remove('hidden');
        box.innerHTML = '<video class="lv-pv" controls muted autoplay playsinline></video><small class="lv-pv-err hidden"></small>';
        const video = box.querySelector('video');
        attachPreview(video, item.url, {
            kind: item.kind, proxied: true, startLow: true, cached: item.text || null,
            onError: () => {
                const err = box.querySelector('.lv-pv-err');
                err.textContent = 'Önizleme oynatılamadı; indirmeyi yine de deneyebilirsin.';
                err.classList.remove('hidden');
            }
        }).then((pv) => { video._pv = pv; }).catch(() => {});
    }

    /** "Bu videoyu yakala": oynayan videoya bakılır; bulunanlar listede öne çıkar. */
    async function catchPlaying() {
        const sh = openMedia({ title: 'Bu video', catching: true });
        try {
            const st = await post({ type: 'catch' }, 20000);
            showItems(st.items || [], true);
            closeSheet(sh);
            const srcs = (st.playing || []).map((p) => p.src).filter((s) => s && s !== 'blob');
            const found = mediaList().length;
            openMedia({
                title: srcs.length ? 'Oynayan video yakalandı' : found ? 'Oynayan video bunlardan biri olabilir' : 'Oynayan videonun bağlantısı bulunamadı',
                playingSrcs: srcs, blob: st.blob
            });
        } catch (err) {
            closeSheet(sh);
            say(err.message);
        }
    }

    function showItems(list, quiet = false) {
        rememberManifests(list);
        items = list;
        if (!mediaBtn) return;
        const n = mediaList().length;
        mediaBtn.classList.toggle('hidden', !n);
        const prev = Number(mediaBtn.querySelector('b').textContent) || 0;
        mediaBtn.querySelector('b').textContent = n;
        if (n > prev && !quiet) say(n === 1 ? 'Video bulundu · üstteki düğmeden bak' : `${n} medya bulundu`);
        paintFab();
    }
    function paintFab() {
        if (!fab) return;
        fab.classList.toggle('hidden', !playing);
        fab.querySelector('.lv-fab-note').classList.toggle('hidden', mediaList().length > 0);
    }

    /* ---- Kayıt ekranı (kendin başlat): üstteki şerit ---- */
    function paintCapture(st) {
        const box = el.querySelector('.lv-cap');
        if (!box) return;
        const rec = st.state === 'capturing' && !st.needsUser;
        box.classList.toggle('rec', rec);
        box.querySelector('.lv-cap-t b').textContent = rec ? 'Kaydediliyor' : 'Videoyu başlat';
        const dur = st.duration > 0 ? clock(st.duration) : '';
        box.querySelector('.lv-cap-t small').textContent = rec
            ? [`${clock(st.mediaSec || 0)}${dur ? ` / ${dur}` : ''}`, st.speed ? `${Math.round(st.speed)}×` : ''].filter(Boolean).join(' · ')
            : 'Başladığı an kayıt kendiliğinden başlar';
        const prog = box.querySelector('.lv-cap-prog');
        prog.classList.toggle('hidden', !rec || !(st.duration > 0));
        if (st.duration > 0) prog.querySelector('i').style.width = `${Math.min(100, (100 * (st.mediaSec || 0)) / st.duration)}%`;
        box.querySelector('.lv-cap-btns').classList.toggle('hidden', !rec);
    }

    /* ---- Gizle / göster: seçilen medyaya bakılırken oturum açık kalır ---- */
    function hide() {
        if (hidden || !alive) return;
        hidden = true;
        el.classList.add('lv-hidden');
        img.removeAttribute('src'); // gizliyken görüntü akmasın
        if (document.activeElement === kbd) kbd.blur();
        if (!document.querySelector('.remote-overlay:not(.lv-hidden)')) document.documentElement.classList.remove('remote-open');
    }
    function show() {
        if (!hidden || !alive) return;
        hidden = false;
        el.classList.remove('lv-hidden');
        document.documentElement.classList.add('remote-open');
        if (streamUrl) img.src = streamUrl;
        resize();
    }

    /* ---- Telefonun geri tuşu ---- */
    el.__onBack = () => {
        if (hidden) return false;
        const open = el.querySelector('.lv-sheet');
        if (open) {
            closeSheet(open);
            return true;
        }
        if (document.activeElement === kbd) {
            kbd.blur();
            return true;
        }
        if (!id || captureId) {
            end();
            return true;
        }
        post({ type: 'back' }, 15000).then((st) => {
            if (st && st.went === false) end();
        }).catch(() => end());
        return true;
    };

    function end() {
        if (!alive) return;
        alive = false;
        ro.disconnect();
        img.removeAttribute('src');
        el.querySelectorAll('.lv-sheet').forEach(closeSheet);
        if (id && !captureId) renderApi(`/session/${id}`, { method: 'DELETE', keepalive: true }, 5000).catch(() => {});
        window.removeEventListener('pagehide', onHide);
        el.remove();
        if (!document.querySelector('.remote-overlay:not(.lv-hidden)')) document.documentElement.classList.remove('remote-open');
        onClose();
    }
    const onHide = () => end();
    window.addEventListener('pagehide', onHide);

    function startStream() {
        const server = getRenderServer();
        img.addEventListener('load', () => msg.classList.remove('show'), { once: true });
        img.addEventListener('error', () => { if (!hidden && alive) say('Canlı görüntü kesildi; kapatıp yeniden aç', 0); });
        streamUrl = `${server.url}${base()}/stream?token=${encodeURIComponent(server.token || '')}`;
        if (!hidden) img.src = streamUrl;
    }

    (async () => {
        try {
            if (!captureId) {
                const state = await renderApi('/session', {
                    method: 'POST',
                    headers: { 'content-type': 'application/json' },
                    body: JSON.stringify({ url: pageUrl, screen: screen(), account: account ? account.domain : undefined })
                }, 40000);
                if (!alive) {
                    renderApi(`/session/${state.id}`, { method: 'DELETE' }).catch(() => {});
                    return;
                }
                id = state.id;
                lastSize = `${state.width}x${state.height}`;
                showItems(state.items || [], true);
                resize();
            }
            startStream();
            // Bulunan medya, oynayan video ve açılan pencereler ara ara sorulur (gizliyken de: oturum açık kalsın).
            let popup = false;
            let tick = 0;
            let loggedIn = false;
            while (alive) {
                await new Promise((r) => setTimeout(r, 1500));
                if (!alive) break;
                try {
                    if (captureId) {
                        const st = await renderApi(base(), {}, 10000);
                        if (['done', 'error', 'cancelled'].includes(st.state)) return end();
                        paintCapture(st);
                        continue;
                    }
                    const withVideos = !hidden && tick++ % 2 === 0;
                    const st = await renderApi(`${base()}${withVideos ? '?videos=1' : ''}`, {}, 10000);
                    showItems(st.items || []);
                    if (st.login && st.login.done && !loggedIn) {
                        loggedIn = true;
                        if (account) {
                            el.querySelector('.lv-acc-done').classList.remove('hidden');
                            if (document.activeElement === kbd) kbd.blur();
                        } else {
                            say('Giriş kaydedildi · Ayarlar › Hesaplar', 4000);
                        }
                        onLogin(st.login);
                    }
                    if (withVideos && 'playing' in st && st.playing !== playing) {
                        playing = st.playing;
                        paintFab();
                    }
                    if (st.popup !== popup) {
                        popup = st.popup;
                        if (!hidden) say(popup ? 'Yeni pencere açıldı · geri tuşu ile önceki sayfaya dönersin' : 'Sayfaya dönüldü');
                    }
                } catch (err) {
                    if (err.status === 404) return end();
                }
            }
        } catch (err) {
            say(err.message, 0);
            alive = false;
        }
    })();

    return { close: end, hide, show, get hidden() { return hidden; } };
}
