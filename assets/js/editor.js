// Düzenleyiciler: video (kes, böl, kare al, sesi çıkar, sessiz, döndür) ve fotoğraf (kırp, ayarla,
// filtre, boyut/biçim). Sonuç her zaman kitaplığa "kopya" olarak eklenir; asıl dosyaya dokunulmaz.
import { escapeHtml, formatSize, clock } from './util.js';
import { libFile, libAdd } from './library.js';
import { readMp4, editMp4, estimateSize, snapStart, toProgressive, rotationOf } from './mp4edit.js';

function overlay(cls) {
    const el = document.createElement('div');
    el.className = `remote-overlay editor ${cls}`;
    document.body.appendChild(el);
    document.documentElement.classList.add('remote-open');
    return el;
}

function closeOverlay(el) {
    el.remove();
    if (!document.querySelector('.remote-overlay')) document.documentElement.classList.remove('remote-open');
}

const baseName = (name) => name.replace(/\.[^.]+$/, '');
const parseClock = (text) => {
    const parts = String(text).trim().split(':').map((p) => Number(p.replace(',', '.')));
    if (!parts.length || parts.some((n) => !isFinite(n) || n < 0)) return NaN;
    return parts.reduce((t, n) => t * 60 + n, 0);
};

/* ---------------- Yeniden kodlama (kare kare tam kesim) ---------------- */

function pickRecorderType(audioOnly) {
    const list = audioOnly
        ? ['audio/mp4;codecs=mp4a.40.2', 'audio/webm;codecs=opus', 'audio/webm']
        : ['video/mp4;codecs=avc1.42E01E,mp4a.40.2', 'video/mp4', 'video/webm;codecs=vp9,opus', 'video/webm;codecs=vp8,opus', 'video/webm'];
    return list.find((t) => window.MediaRecorder && MediaRecorder.isTypeSupported(t)) || '';
}

/**
 * Aralığı oynatıp yeniden kaydeder (gerçek zamanlı sürer). Döndürme tuvalde yapılır.
 */
async function reencode(blob, { start, end, mute, audioOnly, rotate, onProgress, isCancelled }) {
    const type = pickRecorderType(audioOnly);
    if (!type) throw new Error('Bu tarayıcı yeniden kodlayamıyor; "Kayıpsız"ı açık bırak');
    const url = URL.createObjectURL(blob);
    const video = document.createElement('video');
    video.playsInline = true;
    video.src = url;
    video.style.cssText = 'position:fixed;left:-9999px;width:2px;height:2px';
    document.body.appendChild(video);
    try {
        await new Promise((resolve, reject) => {
            video.onloadedmetadata = resolve;
            video.onerror = () => reject(new Error('Video açılamadı'));
        });
        const tracks = [];
        let audioCtx = null;
        if (!mute) {
            audioCtx = new AudioContext();
            const srcNode = audioCtx.createMediaElementSource(video);
            const dest = audioCtx.createMediaStreamDestination();
            srcNode.connect(dest); // hoparlöre bağlanmaz: sessiz işlenir
            tracks.push(...dest.stream.getAudioTracks());
        }
        let canvas = null;
        let draw = null;
        if (!audioOnly) {
            const w = video.videoWidth;
            const h = video.videoHeight;
            const turned = rotate === 90 || rotate === 270;
            canvas = document.createElement('canvas');
            canvas.width = turned ? h : w;
            canvas.height = turned ? w : h;
            const ctx = canvas.getContext('2d');
            draw = () => {
                ctx.save();
                ctx.translate(canvas.width / 2, canvas.height / 2);
                ctx.rotate((rotate * Math.PI) / 180);
                ctx.drawImage(video, -w / 2, -h / 2, w, h);
                ctx.restore();
            };
            tracks.push(...canvas.captureStream(30).getVideoTracks());
        }
        if (!tracks.length) throw new Error('Kaydedilecek iz yok');
        const recorder = new MediaRecorder(new MediaStream(tracks), { mimeType: type, videoBitsPerSecond: 6e6 });
        const chunks = [];
        recorder.ondataavailable = (e) => e.data.size && chunks.push(e.data);
        video.currentTime = start;
        await new Promise((r) => { video.onseeked = r; });
        if (draw) draw();
        recorder.start(1000);
        if (audioCtx) await audioCtx.resume();
        await video.play();
        await new Promise((resolve) => {
            const tick = () => {
                if (draw) draw();
                onProgress((video.currentTime - start) / (end - start));
                if (video.currentTime >= end || video.ended || isCancelled()) return resolve();
                if (video.requestVideoFrameCallback) video.requestVideoFrameCallback(tick);
                else requestAnimationFrame(tick);
            };
            tick();
        });
        video.pause();
        await new Promise((r) => { recorder.onstop = r; recorder.stop(); });
        if (audioCtx) audioCtx.close();
        if (isCancelled()) throw new Error('İptal edildi');
        return new Blob(chunks, { type: type.split(';')[0] });
    } finally {
        video.remove();
        URL.revokeObjectURL(url);
    }
}

/** Aralıktan eşit aralıklı kareler (JPG). */
async function grabFrames(blob, { start, end, max = 60, onProgress }) {
    const url = URL.createObjectURL(blob);
    const video = document.createElement('video');
    video.muted = true;
    video.src = url;
    try {
        await new Promise((resolve, reject) => {
            video.onloadedmetadata = resolve;
            video.onerror = () => reject(new Error('Video açılamadı'));
        });
        const step = Math.max(1, (end - start) / max);
        const canvas = document.createElement('canvas');
        canvas.width = video.videoWidth;
        canvas.height = video.videoHeight;
        const ctx = canvas.getContext('2d');
        const out = [];
        for (let t = start; t < end && out.length < max; t += step) {
            video.currentTime = t;
            await new Promise((r) => { video.onseeked = r; });
            ctx.drawImage(video, 0, 0);
            out.push({ t, blob: await new Promise((r) => canvas.toBlob(r, 'image/jpeg', 0.9)) });
            onProgress(out.length / Math.ceil((end - start) / step));
        }
        return out;
    } finally {
        URL.revokeObjectURL(url);
    }
}

export function createEditor({ toast, onSaved = () => {} }) {
    /* ---------------- Video düzenleyici ---------------- */

    async function openVideo(item) {
        const el = overlay('ed-video');
        el.innerHTML = '<div class="vw-loading">Açılıyor…</div>';
        let blob;
        let info = null;
        try {
            blob = await libFile(item.id);
            if (/mp4|quicktime|m4a/.test(blob.type || item.mime || '') || /\.(mp4|m4v|mov|m4a)$/i.test(item.name)) {
                blob = await toProgressive(blob);
                info = await readMp4(blob);
            }
        } catch (err) {
            info = null;
        }
        if (!blob) {
            el.innerHTML = '<div class="vw-loading">Dosya açılamadı</div>';
            return;
        }
        const url = URL.createObjectURL(blob);
        const isAudio = item.kind === 'audio';
        const OUTS = isAudio ? [['audio', 'Ses']] : [['mp4', 'MP4 video'], ['audio', 'Sadece ses'], ['frames', 'Kare dizisi']];
        const st = {
            start: 0, end: 0, mute: false, rotate: info ? rotationOf(info) : 0, out: OUTS[0][0],
            lossless: Boolean(info)
        };
        const history = [];
        const future = [];
        let duration = (info && info.duration) || item.duration || 0;
        let busy = false;
        let cancelled = false;

        el.innerHTML = `
            <div class="ed ed-v">
                <div class="ed-top"><button class="back-btn" data-e="close" aria-label="Kapat">←</button>
                    <span class="ed-title"><span class="ed-mob">Düzenle</span><span class="ed-desk">${escapeHtml(baseName(item.name))} · düzenleniyor</span></span>
                    <button class="link-btn" data-e="undo">Geri al</button><button class="link-btn ed-desk" data-e="redo">Yinele</button></div>
                <div class="ed-stage"><video playsinline src="${url}"></video><span class="ed-now">0:00</span></div>
                <div class="ed-timeline">
                    <div class="ed-ticks ed-desk"></div>
                    <div class="ed-strip" data-strip><div class="ed-thumbs"></div><div class="ed-sel"></div><div class="ed-head"></div></div>
                    <div class="ed-keys ed-desk"><span><kbd>J</kbd><kbd>K</kbd><kbd>L</kbd> oynat</span><span><kbd>I</kbd><kbd>O</kbd> giriş/çıkış</span><span><kbd>S</kbd> böl</span></div>
                </div>
                <div class="ed-boxes">
                    <label class="range-box"><span>Başlangıç</span><input data-e-in="start" inputmode="numeric"></label>
                    <label class="range-box"><span>Bitiş</span><input data-e-in="end" inputmode="numeric"></label>
                    <div class="range-box ed-dur"><span>Süre</span><b data-e-dur></b></div>
                </div>
                <div class="ed-tools">
                    <button data-e="split"><b>✂</b>Böl</button>
                    <button data-e="frame"${isAudio ? ' disabled' : ''}><b>◫</b>Kare al</button>
                    <button data-e="extract"${isAudio ? ' disabled' : ''}><b>♪</b>Sesi çıkar</button>
                    <button data-e="mute"${isAudio ? ' disabled' : ''}><b>∅</b>Sessiz</button>
                    <button data-e="rotate"${isAudio ? ' disabled' : ''}><b>⟲</b>Döndür</button>
                </div>
                <div class="ed-side">
                    <span class="ed-side-t ed-desk">Dışa aktar</span>
                    <span class="sec-label ed-desk">Çıktı</span>
                    <div class="seg ed-desk" data-e-outs>${OUTS.map(([k, l]) => `<button data-e="out" data-v="${k}">${l}</button>`).join('')}</div>
                    <button class="ed-ll" data-e="lossless"${info ? '' : ' disabled'}>
                        <span><b>Kayıpsız ve hızlı</b><small data-e-llhint></small></span><span class="toggle"></span></button>
                    <span class="sec-label ed-mob">Çıktı</span>
                    <div class="seg ed-mob" data-e-outs>${OUTS.map(([k, l]) => `<button data-e="out" data-v="${k}">${l}</button>`).join('')}</div>
                    <div class="lib-insp-rows ed-desk ed-info"></div>
                    <div class="ed-progress hidden"><div class="stage-bar"><div></div></div><span></span><button class="link-btn" data-e="cancel">İptal</button></div>
                    <div class="ed-bar"><span data-e-size></span><button class="btn-big" data-e="save"><span class="ed-mob">Kopya olarak kaydet</span><span class="ed-desk">Dışa aktar</span></button></div>
                </div>
            </div>`;

        const video = el.querySelector('video');
        const strip = el.querySelector('[data-strip]');
        const inStart = el.querySelector('[data-e-in="start"]');
        const inEnd = el.querySelector('[data-e-in="end"]');

        const snapshot = () => JSON.stringify({ start: st.start, end: st.end, mute: st.mute, rotate: st.rotate, out: st.out, lossless: st.lossless });
        const remember = () => {
            const s = snapshot();
            if (history[history.length - 1] !== s) {
                history.push(s);
                future.length = 0;
            }
            if (history.length > 50) history.shift();
        };

        function realStart() {
            return st.lossless && info && st.out !== 'audio' && !(st.out === 'frames') ? snapStart(info, st.start) : st.start;
        }

        function paint() {
            const d = duration || 1;
            const sel = el.querySelector('.ed-sel');
            sel.style.left = `${(st.start / d) * 100}%`;
            sel.style.width = `${((st.end - st.start) / d) * 100}%`;
            if (document.activeElement !== inStart) inStart.value = clock(st.start);
            if (document.activeElement !== inEnd) inEnd.value = clock(st.end);
            const snapped = realStart();
            el.querySelector('[data-e-dur]').textContent = clock(st.end - snapped);
            el.querySelector('[data-e="mute"]').classList.toggle('on', st.mute);
            el.querySelector('[data-e="rotate"]').classList.toggle('on', st.rotate !== 0);
            el.querySelector('[data-e="rotate"] b').textContent = st.rotate ? `${st.rotate}°` : '⟲';
            el.querySelector('.ed-ll').classList.toggle('on', st.lossless);
            el.querySelector('.ed-ll .toggle').classList.toggle('on', st.lossless);
            el.querySelector('[data-e-llhint]').textContent = !info
                ? 'Bu dosya MP4 değil; kesim yeniden kodlanarak yapılır'
                : st.lossless
                    ? `Yeniden kodlamaz, saniyeler sürer · kesim en yakın anahtar kareye kayar${Math.abs(snapped - st.start) > 0.05 ? ` (${clock(snapped)})` : ''}`
                    : 'Kare kare tam kesim · cihazda yeniden kodlanır, video süresi kadar sürer';
            el.querySelectorAll('[data-e="out"]').forEach((b) => b.classList.toggle('on', b.dataset.v === st.out));
            video.style.transform = st.rotate ? `rotate(${st.rotate}deg)` : '';
            video.classList.toggle('turned', st.rotate === 90 || st.rotate === 270);
            const label = OUTS.find(([k]) => k === st.out)[1];
            let size = '';
            if (st.out === 'frames') size = `${Math.min(60, Math.ceil(st.end - st.start))} kare`;
            else if (info && st.lossless) size = `~${formatSize(estimateSize(info, { start: snapped, end: st.end, mute: st.mute, audioOnly: st.out === 'audio' }))}`;
            else if (item.size && duration) size = `~${formatSize((item.size / duration) * (st.end - st.start) * (st.out === 'audio' ? 0.08 : 1))}`;
            el.querySelector('[data-e-size]').textContent = [label, size].filter(Boolean).join(' · ');
            el.querySelector('.ed-info').innerHTML = [['Aralık', `${clock(snapped)} – ${clock(st.end)}`], ['Süre', clock(st.end - snapped)],
                ['Tahmini', [label, size].filter(Boolean).join(' · ')], ['Hedef', 'Yeni kopya · Kitaplık']]
                .map(([k, v]) => `<div><span>${k}</span><b>${escapeHtml(v)}</b></div>`).join('');
            const ticks = el.querySelector('.ed-ticks');
            if (duration && !ticks.childElementCount) {
                ticks.innerHTML = [0, 0.25, 0.5, 0.75, 1].map((f) => `<span>${clock(f * duration)}</span>`).join('');
            }
        }

        function setRange(a, b) {
            const d = duration || 0;
            st.start = Math.max(0, Math.min(a, d - 0.5));
            st.end = Math.max(st.start + 0.5, Math.min(b, d));
            paint();
        }

        video.addEventListener('loadedmetadata', () => {
            if (!duration || !isFinite(duration)) duration = isFinite(video.duration) ? video.duration : 0;
            if (!st.end) st.end = duration;
            remember();
            paint();
            makeThumbs();
        });
        video.addEventListener('timeupdate', () => {
            el.querySelector('.ed-now').textContent = clock(video.currentTime);
            el.querySelector('.ed-head').style.left = `${(video.currentTime / (duration || 1)) * 100}%`;
            if (!video.paused && video.currentTime >= st.end) video.pause();
        });
        el.querySelector('.ed-stage').addEventListener('click', () => {
            if (video.paused) {
                if (video.currentTime < st.start || video.currentTime >= st.end - 0.1) video.currentTime = st.start;
                video.play().catch(() => {});
            } else video.pause();
        });

        // Şerit: dokununca/sürükleyince en yakın uç oraya gelir; video da o kareyi gösterir.
        let drag = null;
        const at = (e) => {
            const r = strip.getBoundingClientRect();
            return Math.max(0, Math.min(1, (e.clientX - r.left) / r.width)) * duration;
        };
        strip.addEventListener('pointerdown', (e) => {
            if (!duration) return;
            const v = at(e);
            drag = Math.abs(v - st.start) <= Math.abs(v - st.end) ? 'a' : 'b';
            strip.setPointerCapture(e.pointerId);
            remember();
            move(v);
        });
        strip.addEventListener('pointermove', (e) => drag && move(at(e)));
        strip.addEventListener('pointerup', () => { drag = null; });
        function move(v) {
            if (drag === 'a') setRange(Math.min(v, st.end - 0.5), st.end);
            else setRange(st.start, Math.max(v, st.start + 0.5));
            video.pause();
            video.currentTime = drag === 'a' ? st.start : st.end;
        }

        for (const [input, key] of [[inStart, 'start'], [inEnd, 'end']]) {
            input.addEventListener('change', () => {
                const v = parseClock(input.value);
                if (!isFinite(v)) return paint();
                remember();
                if (key === 'start') setRange(v, st.end);
                else setRange(st.start, v);
            });
        }

        async function makeThumbs() {
            if (isAudio || !duration) return;
            const box = el.querySelector('.ed-thumbs');
            const probe = document.createElement('video');
            probe.muted = true;
            probe.src = url;
            await new Promise((r) => { probe.onloadeddata = r; probe.onerror = r; });
            const n = 10;
            const canvas = document.createElement('canvas');
            canvas.height = 60;
            canvas.width = Math.round(60 * ((probe.videoWidth || 16) / (probe.videoHeight || 9)));
            const ctx = canvas.getContext('2d');
            for (let k = 0; k < n; k++) {
                if (!el.isConnected) return;
                probe.currentTime = ((k + 0.5) / n) * duration;
                await new Promise((r) => { probe.onseeked = r; setTimeout(r, 3000); });
                try {
                    ctx.drawImage(probe, 0, 0, canvas.width, canvas.height);
                    const span = document.createElement('span');
                    span.style.backgroundImage = `url(${canvas.toDataURL('image/jpeg', 0.6)})`;
                    box.appendChild(span);
                } catch (_) { return; }
            }
            probe.removeAttribute('src');
        }

        function progress(p, text) {
            const box = el.querySelector('.ed-progress');
            box.classList.toggle('hidden', p === null);
            if (p === null) return;
            box.querySelector('.stage-bar div').style.width = `${Math.max(0, Math.min(1, p)) * 100}%`;
            box.querySelector('span').textContent = text;
        }

        /** Bir aralığı seçili seçeneklerle üretir. */
        async function produce(a, b, out = st.out) {
            const audioOnly = out === 'audio';
            if (info && st.lossless) {
                const r = await editMp4(blob, { start: a, end: b, mute: st.mute, audioOnly, rotate: audioOnly ? null : st.rotate }, info);
                return { blob: r.blob, ext: audioOnly ? '.m4a' : '.mp4' };
            }
            progress(0, 'Yeniden kodlanıyor…');
            const result = await reencode(blob, {
                start: a, end: b, mute: st.mute, audioOnly, rotate: st.rotate,
                onProgress: (p) => progress(p, `Yeniden kodlanıyor · %${Math.round(p * 100)}`),
                isCancelled: () => cancelled
            });
            return { blob: result, ext: result.type.includes('mp4') ? (audioOnly ? '.m4a' : '.mp4') : (audioOnly ? '.weba' : '.webm') };
        }

        async function save(kind = 'save') {
            if (busy) return;
            busy = true;
            cancelled = false;
            video.pause();
            el.classList.add('busy');
            const base = baseName(item.name);
            const meta = { page: item.page, media: item.media, edited: true, from: item.id };
            try {
                if (kind === 'split') {
                    const t = video.currentTime;
                    if (t <= st.start + 0.5 || t >= st.end - 0.5) throw new Error('Bölmek için videoyu aralığın içinde bir yere getir');
                    const one = await produce(st.start, t);
                    const two = await produce(t, st.end);
                    await libAdd(one.blob, { ...meta, name: `${base}-1${one.ext}` });
                    await libAdd(two.blob, { ...meta, name: `${base}-2${two.ext}` });
                    toast('İki parça kitaplığa eklendi');
                } else if (st.out === 'frames') {
                    const frames = await grabFrames(blob, {
                        start: st.start, end: st.end,
                        onProgress: (p) => progress(p, `Kareler alınıyor · %${Math.round(p * 100)}`)
                    });
                    for (const f of frames) {
                        await libAdd(f.blob, { ...meta, name: `${base}-${clock(f.t).replace(/:/g, '.')}.jpg` });
                    }
                    toast(`${frames.length} kare kitaplığa eklendi`);
                } else {
                    const r = await produce(st.start, st.end);
                    await libAdd(r.blob, { ...meta, name: `${base}-duzenlendi${r.ext}` });
                    toast('Kopya kitaplığa kaydedildi');
                }
                close();
                onSaved();
            } catch (err) {
                toast(err.message);
            } finally {
                busy = false;
                el.classList.remove('busy');
                progress(null);
            }
        }

        async function frame() {
            if (!video.videoWidth) return;
            const turned = st.rotate === 90 || st.rotate === 270;
            const canvas = document.createElement('canvas');
            canvas.width = turned ? video.videoHeight : video.videoWidth;
            canvas.height = turned ? video.videoWidth : video.videoHeight;
            const ctx = canvas.getContext('2d');
            ctx.translate(canvas.width / 2, canvas.height / 2);
            ctx.rotate((st.rotate * Math.PI) / 180);
            ctx.drawImage(video, -video.videoWidth / 2, -video.videoHeight / 2);
            const png = await new Promise((r) => canvas.toBlob(r, 'image/png'));
            await libAdd(png, { name: `${baseName(item.name)}-${clock(video.currentTime).replace(/:/g, '.')}.png`, page: item.page, edited: true, from: item.id });
            toast('Kare kitaplığa eklendi');
        }

        function close() {
            cancelled = true;
            video.pause();
            URL.revokeObjectURL(url);
            document.removeEventListener('keydown', onKey);
            closeOverlay(el);
        }

        el.addEventListener('click', (e) => {
            const btn = e.target.closest('[data-e]');
            if (!btn || btn.disabled) return;
            const a = btn.dataset.e;
            if (a === 'close') return close();
            if (a === 'cancel') {
                cancelled = true;
                return;
            }
            if (busy) return;
            if (a === 'undo') {
                if (history.length > 1) future.push(history.pop());
                const prev = history[history.length - 1];
                if (prev) Object.assign(st, JSON.parse(prev));
                return paint();
            }
            if (a === 'redo') {
                const next = future.pop();
                if (next) {
                    history.push(next);
                    Object.assign(st, JSON.parse(next));
                }
                return paint();
            }
            if (a === 'save') return save();
            if (a === 'split') return save('split');
            if (a === 'frame') return frame();
            remember();
            if (a === 'extract') st.out = 'audio';
            if (a === 'mute') st.mute = !st.mute;
            if (a === 'rotate') st.rotate = (st.rotate + 90) % 360;
            if (a === 'lossless') st.lossless = !st.lossless;
            if (a === 'out') st.out = btn.dataset.v;
            remember();
            paint();
        });

        const onKey = (e) => {
            if (e.target.matches('input')) return;
            if (e.key === 'Escape') close();
            if (e.key === ' ' || e.key === 'k') {
                e.preventDefault();
                video.paused ? video.play() : video.pause();
            }
            if (e.key === 'j') video.currentTime = Math.max(0, video.currentTime - 5);
            if (e.key === 'l') video.currentTime += 5;
            if (e.key === 's') save('split');
            if (e.key === 'i') { remember(); setRange(video.currentTime, st.end); }
            if (e.key === 'o') { remember(); setRange(st.start, video.currentTime); }
            if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'z') el.querySelector(e.shiftKey ? '[data-e="redo"]' : '[data-e="undo"]').click();
            if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'y') el.querySelector('[data-e="redo"]').click();
        };
        document.addEventListener('keydown', onKey);
        if (info) {
            st.end = duration;
            remember();
            paint();
        }
    }

    /* ---------------- Fotoğraf düzenleyici ---------------- */

    const FILTERS = [
        ['Yok', []],
        ['Sıcak', [['sepia', 0.35], ['saturate', 1.2]]],
        ['Soğuk', [['hue', 20], ['saturate', 0.9]]],
        ['S/B', [['grayscale', 1], ['contrast', 1.15]]],
        ['Canlı', [['saturate', 1.6], ['contrast', 1.1]]]
    ];
    const RATIOS = [['Serbest', 0], ['1:1', 1], ['4:5', 4 / 5], ['16:9', 16 / 9], ['9:16', 9 / 16]];
    const FORMATS = [['jpg', 'JPG', 'image/jpeg', 'Küçük dosya · şeffaflık yok'], ['png', 'PNG', 'image/png', 'Kayıpsız · büyük dosya'],
        ['webp', 'WEBP', 'image/webp', 'En küçük, kaliteli · önerilen']];

    const cssOf = (ops) => ops.map(([k, v]) => (k === 'hue' ? `hue-rotate(${v}deg)` : `${k}(${v})`)).join(' ');

    /** CSS filtre işlemlerini tek bir 4×5 renk matrisine çevirir (dışa aktarmada piksel piksel uygulanır). */
    function matrixOf(ops) {
        let m = [1, 0, 0, 0, 0, 0, 1, 0, 0, 0, 0, 0, 1, 0, 0];
        const mul = (a) => {
            // a ∘ m (önce m, sonra a)
            const out = [];
            for (let r = 0; r < 3; r++) {
                for (let c = 0; c < 5; c++) {
                    let v = c === 4 ? a[r * 5 + 4] : 0;
                    for (let k = 0; k < 3; k++) v += a[r * 5 + k] * m[k * 5 + c];
                    out.push(v);
                }
            }
            m = out;
        };
        for (const [k, v] of ops) {
            if (k === 'brightness') mul([v, 0, 0, 0, 0, 0, v, 0, 0, 0, 0, 0, v, 0, 0]);
            if (k === 'contrast') {
                const o = 0.5 - 0.5 * v;
                mul([v, 0, 0, 0, o, 0, v, 0, 0, o, 0, 0, v, 0, o]);
            }
            if (k === 'saturate') {
                const s = v;
                mul([0.213 + 0.787 * s, 0.715 - 0.715 * s, 0.072 - 0.072 * s, 0, 0,
                    0.213 - 0.213 * s, 0.715 + 0.285 * s, 0.072 - 0.072 * s, 0, 0,
                    0.213 - 0.213 * s, 0.715 - 0.715 * s, 0.072 + 0.928 * s, 0, 0]);
            }
            if (k === 'grayscale') {
                const g = 1 - v;
                mul([0.2126 + 0.7874 * g, 0.7152 - 0.7152 * g, 0.0722 - 0.0722 * g, 0, 0,
                    0.2126 - 0.2126 * g, 0.7152 + 0.2848 * g, 0.0722 - 0.0722 * g, 0, 0,
                    0.2126 - 0.2126 * g, 0.7152 - 0.7152 * g, 0.0722 + 0.9278 * g, 0, 0]);
            }
            if (k === 'sepia') {
                const g = 1 - v;
                mul([0.393 + 0.607 * g, 0.769 - 0.769 * g, 0.189 - 0.189 * g, 0, 0,
                    0.349 - 0.349 * g, 0.686 + 0.314 * g, 0.168 - 0.168 * g, 0, 0,
                    0.272 - 0.272 * g, 0.534 - 0.534 * g, 0.131 + 0.869 * g, 0, 0]);
            }
            if (k === 'hue') {
                const a = (v * Math.PI) / 180;
                const c = Math.cos(a);
                const s = Math.sin(a);
                mul([0.213 + c * 0.787 - s * 0.213, 0.715 - c * 0.715 - s * 0.715, 0.072 - c * 0.072 + s * 0.928, 0, 0,
                    0.213 - c * 0.213 + s * 0.143, 0.715 + c * 0.285 + s * 0.140, 0.072 - c * 0.072 - s * 0.283, 0, 0,
                    0.213 - c * 0.213 - s * 0.787, 0.715 - c * 0.715 + s * 0.715, 0.072 + c * 0.928 + s * 0.072, 0, 0]);
            }
        }
        return m;
    }

    function applyMatrix(ctx, w, h, m) {
        const img = ctx.getImageData(0, 0, w, h);
        const d = img.data;
        const o = [m[4] * 255, m[9] * 255, m[14] * 255];
        for (let i = 0; i < d.length; i += 4) {
            const r = d[i];
            const g = d[i + 1];
            const b = d[i + 2];
            d[i] = m[0] * r + m[1] * g + m[2] * b + o[0];
            d[i + 1] = m[5] * r + m[6] * g + m[7] * b + o[1];
            d[i + 2] = m[10] * r + m[11] * g + m[12] * b + o[2];
        }
        ctx.putImageData(img, 0, 0);
    }

    async function openPhoto(item, list = []) {
        const el = overlay('ed-photo');
        el.innerHTML = '<div class="vw-loading">Açılıyor…</div>';
        let bitmap;
        try {
            bitmap = await createImageBitmap(await libFile(item.id));
        } catch (err) {
            el.innerHTML = `<div class="vw-loading">Resim açılamadı<br><button class="btn-ghost" data-e="close">Kapat</button></div>`;
            el.addEventListener('click', (e) => e.target.closest('[data-e="close"]') && closeOverlay(el));
            return;
        }
        const ext = (item.name.split('.').pop() || '').toLowerCase();
        const fresh = () => ({
            tab: 'adjust', b: 1, c: 1, s: 1, filter: 0, ratio: 0, rotate: 0, flip: false,
            crop: null, width: 0, height: 0, lockSize: true, cmp: null,
            fmt: ext === 'png' ? 'png' : ext === 'webp' ? 'webp' : 'jpg'
        });
        let st = fresh();

        // Döndürülmüş/çevrilmiş tam resim (önizleme ve dışa aktarma bunun üzerinden).
        const base = document.createElement('canvas');
        function drawBase() {
            const turned = st.rotate === 90 || st.rotate === 270;
            base.width = turned ? bitmap.height : bitmap.width;
            base.height = turned ? bitmap.width : bitmap.height;
            const ctx = base.getContext('2d');
            ctx.save();
            ctx.translate(base.width / 2, base.height / 2);
            ctx.rotate((st.rotate * Math.PI) / 180);
            if (st.flip) ctx.scale(-1, 1);
            ctx.drawImage(bitmap, -bitmap.width / 2, -bitmap.height / 2);
            ctx.restore();
            if (!st.crop) st.crop = { x: 0, y: 0, w: base.width, h: base.height };
        }

        function fitCrop(ratio) {
            const W = base.width;
            const H = base.height;
            if (!ratio) return { x: 0, y: 0, w: W, h: H };
            let w = W;
            let h = w / ratio;
            if (h > H) {
                h = H;
                w = h * ratio;
            }
            return { x: (W - w) / 2, y: (H - h) / 2, w, h };
        }

        const ops = () => [['brightness', st.b], ['contrast', st.c], ['saturate', st.s], ...FILTERS[st.filter][1]];

        const others = list.filter((p) => p.id !== item.id && p.kind === 'photo').slice(0, 30);
        const batch = new Set();
        el.innerHTML = `
            <div class="ed ed-p">
                <div class="ed-top"><button class="back-btn" data-e="close" aria-label="Kapat">←</button>
                    <span class="ed-title"><span class="ed-mob">Düzenle</span><span class="ed-desk">${escapeHtml(item.name)}</span></span>
                    <span class="ph-cmp-hint">Karşılaştırmak için resme dokun</span>
                    <button class="link-btn" data-e="reset">Sıfırla</button></div>
                <div class="ph-ed-stage"><div class="ph-ed-wrap"><canvas class="ph-ed-canvas"></canvas><canvas class="ph-ed-before"></canvas>
                    <span class="ph-cmp-line"><i>⇔</i></span><span class="ph-tag before">ÖNCE</span><span class="ph-tag after">SONRA</span>
                    <div class="ph-ed-crop"><i></i><i></i><i></i><i></i></div></div></div>
                <div class="ed-side">
                    <div class="seg" data-tabs>${[['crop', 'Kırp'], ['adjust', 'Ayarla'], ['filter', 'Filtre'], ['size', 'Boyut']].map(([k, l]) =>
                        `<button data-e="tab" data-v="${k}">${l}</button>`).join('')}</div>
                    <div class="ph-ed-panel"></div>
                    <button class="btn-ghost ph-batch-btn hidden" data-e="batch"></button>
                    <div class="ed-bar"><button class="btn-ghost" data-e="close">Vazgeç</button><button class="btn-big" data-e="save">Kopya olarak kaydet</button></div>
                </div>
                ${others.length ? `<div class="ph-batch ed-desk"><div class="ph-batch-list">${others.map((p) =>
                    `<button data-e="pick" data-id="${escapeHtml(p.id)}" style="${p.thumb ? `background-image:url('${p.thumb}')` : ''}"></button>`).join('')}</div>
                    <span class="ph-batch-n"><b>0</b> seçili · <kbd>Ctrl</kbd>+tık</span></div>` : ''}
            </div>`;
        const canvas = el.querySelector('.ph-ed-canvas');
        const before = el.querySelector('.ph-ed-before');
        const cropBox = el.querySelector('.ph-ed-crop');
        const panel = el.querySelector('.ph-ed-panel');

        function drawPreview() {
            // Önizleme küçük tuvalde; renk ayarları CSS filtresiyle (hızlı).
            const max = 1400;
            const scale = Math.min(1, max / Math.max(base.width, base.height));
            canvas.width = Math.round(base.width * scale);
            canvas.height = Math.round(base.height * scale);
            canvas.getContext('2d').drawImage(base, 0, 0, canvas.width, canvas.height);
            before.width = canvas.width;
            before.height = canvas.height;
            before.getContext('2d').drawImage(canvas, 0, 0);
            canvas.style.filter = cssOf(ops());
            paintCrop();
            paintCompare();
        }

        function paintCompare() {
            const on = st.cmp !== null && st.tab !== 'crop';
            el.querySelector('.ph-ed-wrap').classList.toggle('cmp', on);
            if (!on) return;
            before.style.clipPath = `inset(0 ${100 - st.cmp}% 0 0)`;
            el.querySelector('.ph-cmp-line').style.left = `${st.cmp}%`;
        }

        // Önce/sonra: resme dokununca çizgi oraya gelir; çizginin üstüne dokununca kapanır.
        el.querySelector('.ph-ed-wrap').addEventListener('click', (e) => {
            if (st.tab === 'crop' || e.target.closest('.ph-ed-crop')) return;
            const r = canvas.getBoundingClientRect();
            const x = Math.max(4, Math.min(96, ((e.clientX - r.left) / r.width) * 100));
            st.cmp = st.cmp !== null && Math.abs(st.cmp - x) < 4 ? null : x;
            paintCompare();
        });

        function paintCrop() {
            const c = st.crop;
            cropBox.classList.toggle('on', st.tab === 'crop');
            cropBox.style.left = `${(c.x / base.width) * 100}%`;
            cropBox.style.top = `${(c.y / base.height) * 100}%`;
            cropBox.style.width = `${(c.w / base.width) * 100}%`;
            cropBox.style.height = `${(c.h / base.height) * 100}%`;
        }

        function outSize() {
            const c = st.crop;
            if (!st.width || !st.height) return { w: Math.round(c.w), h: Math.round(c.h) };
            return { w: st.width, h: st.height };
        }

        function slider(key, label, min, max) {
            const v = st[key];
            const shown = Math.round((v - 1) * 100);
            return `<div class="ph-sl"><div class="ph-sl-top"><span>${label}</span><b>${shown > 0 ? '+' : ''}${shown}</b></div>
                <input type="range" min="${min}" max="${max}" step="0.01" value="${v}" data-e-sl="${key}"></div>`;
        }

        function drawPanel() {
            el.querySelectorAll('[data-e="tab"]').forEach((b) => b.classList.toggle('on', b.dataset.v === st.tab));
            const size = outSize();
            if (st.tab === 'crop') {
                panel.innerHTML = `<div class="ph-ratios">${RATIOS.map(([l], i) => `<button class="lib-chip${st.ratio === i ? ' on' : ''}" data-e="ratio" data-v="${i}">${l}</button>`).join('')}</div>
                    <div class="ph-btns"><button class="btn-ghost" data-e="rotate">⟲ Döndür</button><button class="btn-ghost" data-e="flip">⇋ Çevir</button></div>
                    <p class="wz-note">Kırpma alanını sürükleyerek kaydır; köşelerden boyutlandır.</p>`;
            } else if (st.tab === 'adjust') {
                panel.innerHTML = slider('b', 'Parlaklık', 0.5, 1.5) + slider('c', 'Kontrast', 0.5, 1.5) + slider('s', 'Doygunluk', 0, 2);
            } else if (st.tab === 'filter') {
                const thumb = canvas.toDataURL('image/jpeg', 0.5);
                panel.innerHTML = `<div class="ph-filters">${FILTERS.map(([l, f], i) => `<button class="${st.filter === i ? 'on' : ''}" data-e="filter" data-v="${i}">
                    <span style="background-image:url(${thumb});filter:${cssOf(f) || 'none'}"></span>${l}</button>`).join('')}</div>`;
            } else {
                const f = FORMATS.find(([k]) => k === st.fmt);
                panel.innerHTML = `<div class="ed-boxes two">
                        <label class="range-box"><span>Genişlik</span><input data-e-size="w" inputmode="numeric" value="${size.w}"></label>
                        <label class="range-box"><span>Yükseklik</span><input data-e-size="h" inputmode="numeric" value="${size.h}"></label></div>
                    <div class="seg">${FORMATS.map(([k, l]) => `<button class="${st.fmt === k ? 'on' : ''}" data-e="fmt" data-v="${k}">${l}</button>`).join('')}</div>
                    <p class="wz-note">${f[3]}</p>`;
            }
        }

        function render() {
            drawBase();
            drawPreview();
            drawPanel();
        }

        // Kırpma kutusu: içinden sürükle = kaydır, köşeden = boyutlandır.
        let drag = null;
        cropBox.addEventListener('pointerdown', (e) => {
            if (st.tab !== 'crop') return;
            const r = canvas.getBoundingClientRect();
            const k = base.width / r.width;
            const c = { ...st.crop };
            const px = (e.clientX - r.left) * k;
            const py = (e.clientY - r.top) * k;
            const near = (x, y) => Math.hypot(px - x, py - y) < 30 * k;
            let mode = 'move';
            if (near(c.x, c.y)) mode = 'nw';
            else if (near(c.x + c.w, c.y)) mode = 'ne';
            else if (near(c.x, c.y + c.h)) mode = 'sw';
            else if (near(c.x + c.w, c.y + c.h)) mode = 'se';
            drag = { mode, px, py, c, k, r };
            cropBox.setPointerCapture(e.pointerId);
            e.preventDefault();
        });
        cropBox.addEventListener('pointermove', (e) => {
            if (!drag) return;
            const W = base.width;
            const H = base.height;
            const dx = (e.clientX - drag.r.left) * drag.k - drag.px;
            const dy = (e.clientY - drag.r.top) * drag.k - drag.py;
            const c = { ...drag.c };
            const ratio = RATIOS[st.ratio][1];
            if (drag.mode === 'move') {
                c.x = Math.max(0, Math.min(W - c.w, c.x + dx));
                c.y = Math.max(0, Math.min(H - c.h, c.y + dy));
            } else {
                const left = drag.mode.includes('w');
                const top = drag.mode.includes('n');
                let x1 = left ? c.x + dx : c.x;
                let x2 = left ? c.x + c.w : c.x + c.w + dx;
                let y1 = top ? c.y + dy : c.y;
                let y2 = top ? c.y + c.h : c.y + c.h + dy;
                x1 = Math.max(0, Math.min(x1, x2 - 40));
                x2 = Math.min(W, Math.max(x2, x1 + 40));
                y1 = Math.max(0, Math.min(y1, y2 - 40));
                y2 = Math.min(H, Math.max(y2, y1 + 40));
                c.x = x1;
                c.y = y1;
                c.w = x2 - x1;
                c.h = y2 - y1;
                if (ratio) {
                    c.h = Math.min(c.w / ratio, top ? drag.c.y + drag.c.h : H - c.y);
                    c.w = c.h * ratio;
                    if (top) c.y = drag.c.y + drag.c.h - c.h;
                    if (left) c.x = drag.c.x + drag.c.w - c.w;
                }
            }
            st.crop = c;
            st.width = 0;
            st.height = 0;
            paintCrop();
        });
        cropBox.addEventListener('pointerup', () => { drag = null; });

        el.addEventListener('input', (e) => {
            const sl = e.target.dataset.eSl;
            if (sl) {
                st[sl] = Number(e.target.value);
                canvas.style.filter = cssOf(ops());
                const b = e.target.closest('.ph-sl').querySelector('b');
                const shown = Math.round((st[sl] - 1) * 100);
                b.textContent = `${shown > 0 ? '+' : ''}${shown}`;
            }
            const sz = e.target.dataset.eSize;
            if (sz) {
                const v = Math.max(1, Math.round(Number(e.target.value) || 0));
                const c = st.crop;
                const other = el.querySelector(`[data-e-size="${sz === 'w' ? 'h' : 'w'}"]`);
                if (sz === 'w') {
                    st.width = v;
                    st.height = Math.max(1, Math.round((v * c.h) / c.w));
                    other.value = st.height;
                } else {
                    st.height = v;
                    st.width = Math.max(1, Math.round((v * c.w) / c.h));
                    other.value = st.width;
                }
            }
        });

        /** Kaynak (döndürülmüş) tuvalden kırpıp boyutlandırır, renkleri uygular, dosyaya çevirir. */
        async function exportFrom(src, c, w, h) {
            const out = document.createElement('canvas');
            out.width = w;
            out.height = h;
            const ctx = out.getContext('2d', { willReadFrequently: true });
            ctx.imageSmoothingQuality = 'high';
            const f = FORMATS.find(([k]) => k === st.fmt);
            if (f[0] === 'jpg') {
                ctx.fillStyle = '#fff';
                ctx.fillRect(0, 0, w, h);
            }
            ctx.drawImage(src, c.x, c.y, c.w, c.h, 0, 0, w, h);
            const m = matrixOf(ops());
            const identity = m.every((v, i) => Math.abs(v - [1, 0, 0, 0, 0, 0, 1, 0, 0, 0, 0, 0, 1, 0, 0][i]) < 1e-6);
            if (!identity) applyMatrix(ctx, w, h, m);
            const blob = await new Promise((r) => out.toBlob(r, f[2], 0.9));
            if (!blob) throw new Error('Kaydedilemedi');
            return { blob, ext: f[0] };
        }

        /** Aynı ayarları (renk, filtre, döndürme, oran, biçim) seçili diğer fotoğraflara uygular. */
        async function applyBatch() {
            el.classList.add('busy');
            let n = 0;
            try {
                for (const id of batch) {
                    const other = others.find((p) => p.id === id);
                    if (!other) continue;
                    const bmp = await createImageBitmap(await libFile(id));
                    const turned = st.rotate === 90 || st.rotate === 270;
                    const src = document.createElement('canvas');
                    src.width = turned ? bmp.height : bmp.width;
                    src.height = turned ? bmp.width : bmp.height;
                    const g = src.getContext('2d');
                    g.translate(src.width / 2, src.height / 2);
                    g.rotate((st.rotate * Math.PI) / 180);
                    if (st.flip) g.scale(-1, 1);
                    g.drawImage(bmp, -bmp.width / 2, -bmp.height / 2);
                    bmp.close();
                    const ratio = RATIOS[st.ratio][1];
                    let c = { x: 0, y: 0, w: src.width, h: src.height };
                    if (ratio) {
                        let w = src.width;
                        let h = w / ratio;
                        if (h > src.height) {
                            h = src.height;
                            w = h * ratio;
                        }
                        c = { x: (src.width - w) / 2, y: (src.height - h) / 2, w, h };
                    }
                    const r = await exportFrom(src, c, Math.round(c.w), Math.round(c.h));
                    await libAdd(r.blob, { name: `${baseName(other.name)}-duzenlendi.${r.ext}`, page: other.page, edited: true, from: other.id });
                    n++;
                }
                toast(`${n} fotoğrafa uygulandı · kopyalar kitaplıkta`);
                batch.clear();
                paintBatch();
            } catch (err) {
                toast(err.message);
            } finally {
                el.classList.remove('busy');
            }
        }

        function paintBatch() {
            el.querySelectorAll('[data-e="pick"]').forEach((b) => b.classList.toggle('on', batch.has(b.dataset.id)));
            const n = el.querySelector('.ph-batch-n b');
            if (n) n.textContent = batch.size;
            const btn = el.querySelector('.ph-batch-btn');
            btn.classList.toggle('hidden', !batch.size);
            btn.textContent = `Ayarları seçili ${batch.size} fotoğrafa uygula`;
        }

        async function save() {
            el.classList.add('busy');
            try {
                const { w, h } = outSize();
                const { blob, ext: outExt } = await exportFrom(base, st.crop, w, h);
                await libAdd(blob, { name: `${baseName(item.name)}-duzenlendi.${outExt}`, page: item.page, edited: true, from: item.id });
                toast('Kopya kitaplığa kaydedildi');
                close();
                onSaved();
            } catch (err) {
                toast(err.message);
            } finally {
                el.classList.remove('busy');
            }
        }

        function close() {
            bitmap.close();
            document.removeEventListener('keydown', onKey);
            closeOverlay(el);
        }

        el.addEventListener('click', (e) => {
            const btn = e.target.closest('[data-e]');
            if (!btn) return;
            const a = btn.dataset.e;
            if (a === 'close') return close();
            if (a === 'save') return save();
            if (a === 'batch') return applyBatch();
            if (a === 'pick') {
                const id = btn.dataset.id;
                if (batch.has(id)) batch.delete(id);
                else batch.add(id);
                return paintBatch();
            }
            if (a === 'reset') {
                st = fresh();
                return render();
            }
            if (a === 'tab') st.tab = btn.dataset.v;
            if (a === 'ratio') {
                st.ratio = Number(btn.dataset.v);
                st.crop = fitCrop(RATIOS[st.ratio][1]);
                st.width = 0;
                st.height = 0;
            }
            if (a === 'rotate' || a === 'flip') {
                if (a === 'rotate') st.rotate = (st.rotate + 270) % 360; // sola döndür
                else st.flip = !st.flip;
                st.crop = null;
                st.width = 0;
                st.height = 0;
                drawBase();
                st.crop = fitCrop(RATIOS[st.ratio][1]);
                drawPreview();
                return drawPanel();
            }
            if (a === 'filter') {
                st.filter = Number(btn.dataset.v);
                canvas.style.filter = cssOf(ops());
            }
            if (a === 'fmt') st.fmt = btn.dataset.v;
            paintCrop();
            paintCompare();
            drawPanel();
        });
        const onKey = (e) => {
            if (e.key === 'Escape' && !e.target.matches('input')) close();
        };
        document.addEventListener('keydown', onKey);
        render();
    }

    return {
        open(item, list = []) {
            if (item.kind === 'photo') return openPhoto(item, list);
            if (item.kind === 'video' || item.kind === 'audio') return openVideo(item);
            toast('Bu dosya düzenlenemiyor');
        }
    };
}
