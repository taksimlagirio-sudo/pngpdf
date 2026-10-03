// Kitaplık görüntüleyicileri: video/ses oynatıcı, fotoğraf görüntüleyici ve dikey "Akış".
import { escapeHtml, formatSize, clock, saveBlob } from './util.js';
import { libFile, libRemove, libUpdate, libAdd } from './library.js';
import { canShareFiles } from './downloads.js';
import { itemWhere } from './library-tab.js';

const SPEEDS = [0.5, 1, 1.5, 2, 4];
const speedLabel = (v) => `${String(v).replace('.', ',')}×`;

/** Öğenin oynatılabilir adresi (bu cihazdaysa Blob adresi). */
async function sourceOf(item) {
    if (item.server) return { url: item.url, revoke() {} };
    const blob = await libFile(item.id);
    const url = URL.createObjectURL(blob);
    return { url, blob, revoke: () => URL.revokeObjectURL(url) };
}

function overlay(cls) {
    const el = document.createElement('div');
    el.className = `remote-overlay viewer ${cls}`;
    document.body.appendChild(el);
    document.documentElement.classList.add('remote-open');
    return el;
}

function closeOverlay(el) {
    el.remove();
    if (!document.querySelector('.remote-overlay')) document.documentElement.classList.remove('remote-open');
}

function fileName(item) {
    return item.name || 'dosya';
}

export function createViewer({ toast, edit = null }) {
    /** Galeriye (paylaşım sayfası) ya da İndirilenler'e kaydeder. */
    async function toGallery(item) {
        if (item.server) {
            window.open(item.url, '_blank', 'noopener');
            return;
        }
        const blob = await libFile(item.id);
        const file = new File([blob], fileName(item), { type: blob.type || item.mime || 'application/octet-stream' });
        if (canShareFiles && navigator.canShare && navigator.canShare({ files: [file] })) {
            try {
                await navigator.share({ files: [file], title: item.name });
                await libUpdate(item.id, { exportedAt: Date.now() });
                toast('Galeriye gönderildi');
            } catch (err) {
                if (err.name !== 'AbortError') toast(`Paylaşılamadı: ${err.message}`);
            }
            return;
        }
        saveBlob(blob, fileName(item));
        await libUpdate(item.id, { exportedAt: Date.now() });
        toast('İndirilenler\'e kaydedildi');
    }

    async function share(item) {
        if (item.server) {
            if (navigator.share) navigator.share({ url: item.page || item.url, title: item.name }).catch(() => {});
            return;
        }
        const blob = await libFile(item.id);
        const file = new File([blob], fileName(item), { type: blob.type || 'application/octet-stream' });
        if (navigator.canShare && navigator.canShare({ files: [file] })) {
            navigator.share({ files: [file], title: item.name }).catch(() => {});
        } else if (navigator.share && item.page) {
            navigator.share({ url: item.page, title: item.name }).catch(() => {});
        } else {
            toast('Bu tarayıcı dosya paylaşamıyor');
        }
    }

    async function remove(item) {
        if (item.server) {
            toast('Sunucudaki dosyayı sunucunda sil');
            return false;
        }
        const note = item.exportedAt ? '' : '\nBu dosya yalnızca burada; silinirse geri gelmez.';
        if (!confirm(`"${item.name}" kitaplıktan silinsin mi?${note}`)) return false;
        await libRemove(item.id);
        toast('Silindi');
        return true;
    }

    function startEdit(item, closeFn) {
        if (!edit) return;
        if (item.server) return toast('Düzenlemek için önce telefona al');
        closeFn();
        edit(item);
    }

    const ACTIONS = [['edit', '✎', 'Düzenle'], ['gallery', '↧', 'Galeriye'], ['share', '↗', 'Paylaş'], ['delete', '⌫', 'Sil']];
    const actionsHtml = (extra = []) => `<div class="vw-actions">${[...ACTIONS.slice(0, 3), ...extra, ACTIONS[3]].map(([k, i, l]) =>
        `<button data-v="${k}"><span>${i}</span>${l}</button>`).join('')}</div>`;

    /* ---------------- Video / ses oynatıcı ---------------- */

    function openPlayer(list, index) {
        const el = overlay('vw-player');
        let item = list[index];
        let src = null;
        let speed = 1;
        let ab = null; // { a, b }
        let video = null;

        const related = () => list.filter((i) => i !== item && i.kind !== 'photo' && ((item.page && i.page === item.page) || (!item.page && item.site && i.site === item.site))).slice(0, 6);

        async function load() {
            if (src) src.revoke();
            ab = null;
            el.innerHTML = '<div class="vw-loading">Açılıyor…</div>';
            try {
                src = await sourceOf(item);
            } catch (err) {
                el.innerHTML = `<div class="vw-loading">${escapeHtml(err.message)}<br><button class="btn-ghost" data-v="close">Kapat</button></div>`;
                return;
            }
            draw();
        }

        function draw() {
            const isAudio = item.kind === 'audio';
            const meta = [item.height ? `${item.height}p` : '', item.size ? formatSize(item.size) : '',
                item.server ? 'sunucunda' : 'bu cihazda', item.site || ''].filter(Boolean).join(' · ');
            const rel = related();
            el.innerHTML = `
                <div class="vw-stage${isAudio ? ' audio' : ''}">
                    <video playsinline ${isAudio ? 'poster=""' : ''} src="${escapeHtml(src.url)}"></video>
                    ${isAudio ? '<span class="vw-audio-art">♪</span>' : ''}
                    <button class="vw-x" data-v="close" aria-label="Kapat">✕</button>
                    <span class="vw-spd-badge">${speedLabel(speed)}</span>
                    <button class="vw-skip back" data-v="back10">« 10 sn</button>
                    <button class="vw-play" data-v="play" aria-label="Oynat/duraklat">▶</button>
                    <button class="vw-skip fwd" data-v="fwd10">10 sn »</button>
                </div>
                <div class="vw-body">
                    <div class="vw-title">${escapeHtml(item.name)}</div>
                    <div class="vw-meta">${escapeHtml(meta)}</div>
                    <div class="vw-seek"><div class="vw-track"><span class="vw-ab hidden"></span><span class="vw-fill"></span></div>
                        <input type="range" min="0" max="1000" value="0" aria-label="Konum"></div>
                    <div class="vw-times"><span data-t="cur">0:00</span><span data-t="ab"></span><span data-t="dur">${item.duration ? clock(item.duration) : ''}</span></div>
                    <div class="vw-chips">
                        <button data-v="speed"><b>${speedLabel(speed)}</b>Hız</button>
                        <button data-v="track" data-track><b>—</b>Ses izi</button>
                        <button data-v="ab"><b>A–B</b>Döngü</button>
                        <button data-v="frame"${isAudio ? ' disabled' : ''}><b>◫</b>Kare al</button>
                        <button data-v="pip"${isAudio || !document.pictureInPictureEnabled ? ' disabled' : ''}><b>⧉</b>PiP</button>
                    </div>
                    ${actionsHtml()}
                    ${rel.length ? `<span class="sec-label">Aynı sayfadan</span>
                        <div class="vw-rel">${rel.map((r) => `<button class="lib-row" data-v="rel" data-id="${escapeHtml(r.id)}">
                            <span class="lib-row-th" style="${r.thumb ? `background-image:url('${r.thumb}')` : ''}"></span>
                            <span class="lib-row-main"><span class="lib-row-n">${escapeHtml(r.name)}</span>
                            <span class="lib-row-m">${r.duration ? clock(r.duration) + ' · ' : ''}${formatSize(r.size)}</span></span></button>`).join('')}</div>` : ''}
                    <p class="vw-hint">Çift dokun: ±10 sn · yatay çevir: tam ekran</p>
                </div>`;
            video = el.querySelector('video');
            video.playbackRate = speed;
            const range = el.querySelector('.vw-seek input');
            const fill = el.querySelector('.vw-fill');
            const cur = el.querySelector('[data-t="cur"]');
            const dur = el.querySelector('[data-t="dur"]');
            const playBtn = el.querySelector('.vw-play');
            let seeking = false;
            const paint = () => {
                const d = video.duration || item.duration || 0;
                const p = d ? video.currentTime / d : 0;
                if (!seeking) range.value = Math.round(p * 1000);
                fill.style.width = `${p * 100}%`;
                cur.textContent = clock(video.currentTime);
                if (d) dur.textContent = clock(d);
                if (ab && ab.b !== undefined && video.currentTime >= ab.b) video.currentTime = ab.a;
            };
            video.addEventListener('timeupdate', paint);
            video.addEventListener('loadedmetadata', () => {
                paint();
                const tracks = video.audioTracks;
                const tb = el.querySelector('[data-track] b');
                if (tracks && tracks.length > 1) {
                    const on = [...tracks].find((t) => t.enabled) || tracks[0];
                    tb.textContent = (on.language || on.label || '1').slice(0, 3).toUpperCase();
                } else {
                    el.querySelector('[data-track]').disabled = true;
                }
            });
            video.addEventListener('play', () => { playBtn.textContent = '❚❚'; el.classList.add('playing'); });
            video.addEventListener('pause', () => { playBtn.textContent = '▶'; el.classList.remove('playing'); });
            video.addEventListener('ended', () => { playBtn.textContent = '▶'; el.classList.remove('playing'); });
            range.addEventListener('input', () => {
                seeking = true;
                const d = video.duration || 0;
                if (d) video.currentTime = (range.value / 1000) * d;
            });
            range.addEventListener('change', () => { seeking = false; });
            // Çift dokunuş: sol yarı geri, sağ yarı ileri.
            let lastTap = 0;
            el.querySelector('.vw-stage').addEventListener('click', (e) => {
                if (e.target.closest('button')) return;
                const now = Date.now();
                if (now - lastTap < 300) {
                    const r = e.currentTarget.getBoundingClientRect();
                    video.currentTime += (e.clientX - r.left < r.width / 2 ? -10 : 10);
                    lastTap = 0;
                    return;
                }
                lastTap = now;
                setTimeout(() => {
                    if (lastTap === now) el.classList.toggle('chrome-hidden');
                }, 310);
            });
            video.play().catch(() => {});
        }

        function paintAb() {
            const band = el.querySelector('.vw-ab');
            const label = el.querySelector('[data-t="ab"]');
            const btn = el.querySelector('[data-v="ab"]');
            const d = video.duration || 0;
            btn.classList.toggle('on', Boolean(ab));
            if (!ab || !d) {
                band.classList.add('hidden');
                label.textContent = '';
                return;
            }
            const b = ab.b === undefined ? video.currentTime : ab.b;
            band.classList.remove('hidden');
            band.style.left = `${(ab.a / d) * 100}%`;
            band.style.width = `${(Math.max(0, b - ab.a) / d) * 100}%`;
            label.textContent = ab.b === undefined ? `A ${clock(ab.a)} · B'yi seç` : `${clock(ab.a)} – ${clock(ab.b)} döngü`;
        }

        async function grabFrame() {
            if (!video.videoWidth) return;
            const canvas = document.createElement('canvas');
            canvas.width = video.videoWidth;
            canvas.height = video.videoHeight;
            canvas.getContext('2d').drawImage(video, 0, 0);
            const blob = await new Promise((r) => canvas.toBlob(r, 'image/png'));
            if (!blob) return toast('Kare alınamadı');
            const base = item.name.replace(/\.[^.]+$/, '');
            await libAdd(blob, { name: `${base}-${clock(video.currentTime).replace(/:/g, '.')}.png`, page: item.page, edited: true, from: item.id });
            toast('Kare kitaplığa eklendi');
        }

        function close() {
            if (video) video.pause();
            if (document.pictureInPictureElement === video) document.exitPictureInPicture().catch(() => {});
            if (src) src.revoke();
            document.removeEventListener('keydown', onKey);
            closeOverlay(el);
        }

        el.addEventListener('click', async (e) => {
            const btn = e.target.closest('[data-v]');
            if (!btn || btn.disabled) return;
            const v = btn.dataset.v;
            if (v === 'close') return close();
            if (!video) return;
            if (v === 'play') return video.paused ? video.play().catch(() => {}) : video.pause();
            if (v === 'back10') video.currentTime = Math.max(0, video.currentTime - 10);
            if (v === 'fwd10') video.currentTime += 10;
            if (v === 'speed') {
                speed = SPEEDS[(SPEEDS.indexOf(speed) + 1) % SPEEDS.length];
                video.playbackRate = speed;
                btn.querySelector('b').textContent = speedLabel(speed);
                el.querySelector('.vw-spd-badge').textContent = speedLabel(speed);
            }
            if (v === 'track') {
                const tracks = video.audioTracks;
                if (tracks && tracks.length > 1) {
                    const i = [...tracks].findIndex((t) => t.enabled);
                    const next = (i + 1) % tracks.length;
                    [...tracks].forEach((t, j) => { t.enabled = j === next; });
                    btn.querySelector('b').textContent = (tracks[next].language || tracks[next].label || String(next + 1)).slice(0, 3).toUpperCase();
                }
            }
            if (v === 'ab') {
                if (!ab) ab = { a: video.currentTime };
                else if (ab.b === undefined) {
                    if (video.currentTime > ab.a + 0.5) ab.b = video.currentTime;
                    else ab = null;
                } else ab = null;
                paintAb();
            }
            if (v === 'frame') grabFrame();
            if (v === 'pip') {
                try {
                    if (document.pictureInPictureElement) await document.exitPictureInPicture();
                    else await video.requestPictureInPicture();
                } catch (err) {
                    toast(`PiP açılamadı: ${err.message}`);
                }
            }
            if (v === 'edit') startEdit(item, close);
            if (v === 'gallery') toGallery(item);
            if (v === 'share') share(item);
            if (v === 'delete' && await remove(item)) close();
            if (v === 'rel') {
                const next = list.find((i) => i.id === btn.dataset.id);
                if (next) {
                    item = next;
                    load();
                }
            }
        });

        const onKey = (e) => {
            if (e.target.matches('input, textarea')) return;
            if (e.key === 'Escape') close();
            if (!video) return;
            if (e.key === ' ' || e.key === 'k') {
                e.preventDefault();
                video.paused ? video.play() : video.pause();
            }
            if (e.key === 'ArrowLeft' || e.key === 'j') video.currentTime -= 10;
            if (e.key === 'ArrowRight' || e.key === 'l') video.currentTime += 10;
        };
        document.addEventListener('keydown', onKey);
        load();
    }

    /* ---------------- Fotoğraf görüntüleyici ---------------- */

    function openPhoto(list, index) {
        const photos = list.filter((i) => i.kind === 'photo');
        let i = Math.max(0, photos.indexOf(list[index]));
        const el = overlay('vw-photo');
        let src = null;
        let zoom = 1;
        let pan = { x: 0, y: 0 };
        let info = false;
        let slideTimer = null;

        el.innerHTML = `
            <div class="ph-top"><button class="back-btn" data-v="close" aria-label="Kapat">←</button>
                <span class="ph-idx"></span><button class="rv-btn" data-v="info">Bilgi</button></div>
            <div class="ph-stage"><img alt=""><span class="ph-zoom"></span><span class="ph-hint">Dokun: yakınlaştır · kaydır: sonraki</span></div>
            <div class="ph-strip"></div>
            <div class="ph-info"></div>
            ${actionsHtml([['slide', '▶', 'Slayt']])}`;
        const img = el.querySelector('.ph-stage img');
        const stage = el.querySelector('.ph-stage');

        function applyZoom() {
            img.style.transform = `translate(${pan.x}px, ${pan.y}px) scale(${zoom})`;
            el.querySelector('.ph-zoom').textContent = `${zoom.toFixed(1).replace('.', ',')}×`;
        }

        async function show() {
            const item = photos[i];
            zoom = 1;
            pan = { x: 0, y: 0 };
            applyZoom();
            el.querySelector('.ph-idx').textContent = `${i + 1} / ${photos.length}`;
            const ext = (item.name.split('.').pop() || '').toUpperCase();
            el.querySelector('.ph-info').innerHTML = [item.width ? `${item.width}×${item.height}` : '', `${ext} · ${formatSize(item.size)}`, item.site,
                info ? new Date(item.createdAt).toLocaleString('tr-TR') : '', info ? itemWhere(item)[0] : '']
                .filter(Boolean).map((t) => `<span>${escapeHtml(t)}</span>`).join('');
            const strip = el.querySelector('.ph-strip');
            const from = Math.max(0, Math.min(i - 3, photos.length - 8));
            strip.innerHTML = photos.slice(from, from + 8).map((p, k) =>
                `<button class="${from + k === i ? 'on' : ''}" data-v="go" data-i="${from + k}" style="${p.thumb ? `background-image:url('${p.thumb}')` : ''}"></button>`).join('');
            const prev = src;
            try {
                src = await sourceOf(item);
                img.src = src.url;
            } catch (err) {
                toast(err.message);
            }
            if (prev) setTimeout(() => prev.revoke(), 1000);
        }

        const go = (n) => {
            if (n < 0 || n >= photos.length) return;
            i = n;
            show();
        };

        // Kaydırma: yakınlaştırılmamışsa sonraki/önceki; yakınlaştırılmışsa resmi gezdirir.
        let start = null;
        stage.addEventListener('pointerdown', (e) => {
            start = { x: e.clientX, y: e.clientY, px: pan.x, py: pan.y, t: Date.now() };
            stage.setPointerCapture(e.pointerId);
        });
        stage.addEventListener('pointermove', (e) => {
            if (!start || zoom === 1) return;
            pan = { x: start.px + e.clientX - start.x, y: start.py + e.clientY - start.y };
            applyZoom();
        });
        stage.addEventListener('pointerup', (e) => {
            if (!start) return;
            const dx = e.clientX - start.x;
            const dy = e.clientY - start.y;
            const tap = Math.abs(dx) < 8 && Math.abs(dy) < 8 && Date.now() - start.t < 400;
            start = null;
            if (tap) {
                zoom = zoom >= 3 ? 1 : zoom + 1;
                if (zoom === 1) pan = { x: 0, y: 0 };
                return applyZoom();
            }
            if (zoom === 1 && Math.abs(dx) > 50 && Math.abs(dx) > Math.abs(dy)) go(i + (dx < 0 ? 1 : -1));
        });

        function stopSlide() {
            clearInterval(slideTimer);
            slideTimer = null;
            const b = el.querySelector('[data-v="slide"] span');
            if (b) b.textContent = '▶';
        }

        function close() {
            stopSlide();
            if (src) src.revoke();
            document.removeEventListener('keydown', onKey);
            closeOverlay(el);
        }

        el.addEventListener('click', async (e) => {
            const btn = e.target.closest('[data-v]');
            if (!btn) return;
            const v = btn.dataset.v;
            const item = photos[i];
            if (v === 'close') return close();
            if (v === 'info') {
                info = !info;
                btn.classList.toggle('on', info);
                show();
            }
            if (v === 'go') go(Number(btn.dataset.i));
            if (v === 'slide') {
                if (slideTimer) return stopSlide();
                btn.querySelector('span').textContent = '❚❚';
                slideTimer = setInterval(() => (i + 1 < photos.length ? go(i + 1) : stopSlide()), 3000);
            }
            if (v === 'edit') startEdit(item, close);
            if (v === 'gallery') toGallery(item);
            if (v === 'share') share(item);
            if (v === 'delete' && await remove(item)) {
                photos.splice(i, 1);
                if (!photos.length) return close();
                go(Math.min(i, photos.length - 1));
            }
        });
        const onKey = (e) => {
            if (e.key === 'Escape') close();
            if (e.key === 'ArrowRight') go(i + 1);
            if (e.key === 'ArrowLeft') go(i - 1);
        };
        document.addEventListener('keydown', onKey);
        show();
    }

    /* ---------------- Akış ---------------- */

    function openFeed(list, { mode = 'video' } = {}) {
        const el = overlay('vw-feed');
        const sources = new Map(); // id → kaynak
        let observer = null;
        let current = null;
        if (!list.some((i) => i.kind !== 'photo')) mode = 'photo';
        if (!list.some((i) => i.kind === 'photo')) mode = 'video';

        const pick = () => list.filter((i) => mode === 'mixed' || (mode === 'photo' ? i.kind === 'photo' : i.kind !== 'photo'));

        function draw() {
            for (const s of sources.values()) s.revoke();
            sources.clear();
            if (observer) observer.disconnect();
            const items = pick();
            const date = (ts) => new Date(ts).toLocaleString('tr-TR', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' });
            el.innerHTML = `
                <div class="fd-top"><button class="fd-x" data-v="close" aria-label="Kapat">✕</button>
                    <div class="seg lib-seg fd-seg">${[['video', 'Videolar'], ['photo', 'Fotoğraflar'], ['mixed', 'Karışık']].map(([k, l]) =>
                        `<button class="${mode === k ? 'on' : ''}" data-v="mode" data-m="${k}">${l}</button>`).join('')}</div></div>
                <div class="fd-scroll">${items.length ? items.map((it, n) => `
                    <section class="fd-slide" data-n="${n}">
                        ${it.kind === 'photo' ? '<img alt="">' : '<video playsinline loop preload="none"></video>'}
                        <div class="fd-rail">${ACTIONS.map(([k, ic, l]) => `<button data-v="${k}"><span>${ic}</span>${l}</button>`).join('')}</div>
                        <div class="fd-info"><b>${escapeHtml(it.name)}</b>
                            <span>${escapeHtml([it.site, date(it.createdAt), it.width ? `${it.width}×${it.height}` : ''].filter(Boolean).join(' · '))}</span>
                            ${it.kind !== 'photo' ? '<span class="fd-time">0:00</span>' : ''}</div>
                        ${it.kind !== 'photo' ? '<div class="fd-prog"><span></span></div>' : ''}
                    </section>`).join('') : '<div class="fd-empty">Bu seçimde öğe yok.</div>'}</div>
                <p class="fd-hint">Yukarı kaydır: sonraki · çift dokun: ±10 sn</p>`;

            const slides = [...el.querySelectorAll('.fd-slide')];
            observer = new IntersectionObserver((entries) => {
                for (const entry of entries) {
                    if (entry.isIntersecting && entry.intersectionRatio > 0.6) activate(Number(entry.target.dataset.n));
                }
            }, { root: el.querySelector('.fd-scroll'), threshold: [0.6] });
            slides.forEach((s) => observer.observe(s));

            async function ensure(n) {
                const it = items[n];
                const slide = slides[n];
                if (!it || !slide || sources.has(it.id)) return;
                const src = await sourceOf(it).catch(() => null);
                if (!src) return;
                sources.set(it.id, src);
                const media = slide.querySelector('video, img');
                media.src = src.url;
                if (media.tagName === 'VIDEO') {
                    const time = slide.querySelector('.fd-time');
                    const bar = slide.querySelector('.fd-prog span');
                    media.addEventListener('timeupdate', () => {
                        time.textContent = `${clock(media.currentTime)} / ${clock(media.duration || it.duration)}`;
                        bar.style.width = `${(media.currentTime / (media.duration || 1)) * 100}%`;
                    });
                }
            }

            function activate(n) {
                current = n;
                for (const k of [n - 1, n, n + 1]) ensure(k);
                // Uzaktaki kaynaklar bırakılır (bellek).
                items.forEach((it, k) => {
                    if (Math.abs(k - n) > 2 && sources.has(it.id)) {
                        sources.get(it.id).revoke();
                        sources.delete(it.id);
                        const m = slides[k].querySelector('video, img');
                        m.removeAttribute('src');
                        if (m.tagName === 'VIDEO') m.load();
                    }
                });
                slides.forEach((s, k) => {
                    const v = s.querySelector('video');
                    if (!v) return;
                    if (k === n) {
                        const play = () => v.play().catch(() => {
                            v.muted = true;
                            v.play().catch(() => {});
                        });
                        if (v.src) play();
                        else setTimeout(() => v.src && play(), 300);
                    } else v.pause();
                });
            }

            let lastTap = 0;
            el.querySelector('.fd-scroll').addEventListener('click', (e) => {
                if (e.target.closest('button')) return;
                const slide = e.target.closest('.fd-slide');
                const v = slide && slide.querySelector('video');
                if (!v) return;
                const now = Date.now();
                if (now - lastTap < 300) {
                    const r = slide.getBoundingClientRect();
                    v.currentTime += e.clientX - r.left < r.width / 2 ? -10 : 10;
                    lastTap = 0;
                    return;
                }
                lastTap = now;
                setTimeout(() => {
                    if (lastTap !== now) return;
                    if (v.muted) v.muted = false;
                    else if (v.paused) v.play().catch(() => {});
                    else v.pause();
                }, 310);
            });
            if (slides.length) activate(0);
        }

        function close() {
            if (observer) observer.disconnect();
            el.querySelectorAll('video').forEach((v) => v.pause());
            for (const s of sources.values()) s.revoke();
            document.removeEventListener('keydown', onKey);
            closeOverlay(el);
        }

        el.addEventListener('click', async (e) => {
            const btn = e.target.closest('[data-v]');
            if (!btn) return;
            const v = btn.dataset.v;
            if (v === 'close') return close();
            if (v === 'mode') {
                mode = btn.dataset.m;
                return draw();
            }
            const slide = btn.closest('.fd-slide');
            const item = slide ? pick()[Number(slide.dataset.n)] : null;
            if (!item) return;
            if (v === 'edit') startEdit(item, close);
            if (v === 'gallery') toGallery(item);
            if (v === 'share') share(item);
            if (v === 'delete' && await remove(item)) {
                list = list.filter((i) => i !== item);
                draw();
            }
        });
        const onKey = (e) => {
            if (e.key === 'Escape') close();
            const scroller = el.querySelector('.fd-scroll');
            if (e.key === 'ArrowDown' && scroller) scroller.scrollBy({ top: scroller.clientHeight, behavior: 'smooth' });
            if (e.key === 'ArrowUp' && scroller) scroller.scrollBy({ top: -scroller.clientHeight, behavior: 'smooth' });
        };
        document.addEventListener('keydown', onKey);
        draw();
        return { current: () => current };
    }

    return {
        open(list, index) {
            const item = list[index];
            if (item.kind === 'photo') return openPhoto(list, index);
            if (item.kind === 'video' || item.kind === 'audio') return openPlayer(list, index);
            // Diğer dosyalar: kaydet/paylaş.
            toGallery(item);
        },
        feed(list) {
            openFeed(list);
        },
        setEditor(fn) {
            edit = fn;
        }
    };
}
