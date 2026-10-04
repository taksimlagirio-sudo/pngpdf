// Düzenleyiciler: video (kes, böl, kare al, sesi çıkar, sessiz, döndür) ve fotoğraf (kırp, ayarla,
// filtre, boyut/biçim). Sonuç her zaman kitaplığa "kopya" olarak eklenir; asıl dosyaya dokunulmaz.
import { escapeHtml, formatSize, clock, getRenderServer, renderApi, checkRenderServer } from './util.js';
import { uploadItem } from './sync.js';
import { libFile, libAdd } from './library.js';
import { encodeGif, encodeWebp } from './anim.js';
import { readMp4, editMp4, estimateSize, snapStart, toProgressive, rotationOf, checkConcat, concatMp4 } from './mp4edit.js';

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
async function reencode(blob, { start, end, mute, audioOnly, rotate, onProgress, isCancelled, maxWidth = 0, fps = 30 }) {
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
            const k = maxWidth && video.videoWidth > maxWidth ? maxWidth / video.videoWidth : 1;
            const w = Math.round((video.videoWidth * k) / 2) * 2;
            const h = Math.round((video.videoHeight * k) / 2) * 2;
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
            tracks.push(...canvas.captureStream(fps).getVideoTracks());
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
                    <button data-e="clip"${isAudio ? ' disabled' : ''}><b>GIF</b>Klip</button>
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
            if (a === 'extract') {
                close();
                return openAudio(item);
            }
            if (a === 'clip') {
                close();
                return openClip(item, { start: st.start, end: Math.min(st.end, st.start + 60) });
            }
            if (a === 'frame') return frame();
            remember();
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

    /* ---------------- Klip (GIF / WebP / sessiz MP4) ---------------- */

    const CLIP_FORMATS = [['gif', 'GIF'], ['webp', 'WebP'], ['mp4', 'Sessiz MP4']];
    const CLIP_HINTS = {
        gif: 'GIF her yerde oynar ama en büyük dosya olur.',
        webp: 'WebP çok daha küçük; tarayıcılar ve mesajlaşma uygulamaları gösterir.',
        mp4: 'Sessiz MP4 en küçüğü; sosyal medyada GIF yerine kullanılır.'
    };
    const MAX_CLIP = 60;

    async function openClip(item, range = null) {
        const el = overlay('ed-clip');
        let blob;
        try {
            blob = await libFile(item.id);
        } catch (err) {
            toast(err.message);
            return closeOverlay(el);
        }
        const url = URL.createObjectURL(blob);
        const st = { start: range ? range.start : 0, end: range ? range.end : 6, fmt: 'gif', width: 480, fps: 15, loop: true, busy: false, cancelled: false };
        let duration = item.duration || 0;
        const history = [];
        el.innerHTML = `<div class="ed clip">
            <div class="ed-top"><button class="back-btn" data-k="close" aria-label="Kapat">←</button><span class="ed-title">Klip oluştur</span>
                <button class="link-btn" data-k="undo">Geri al</button></div>
            <div class="ed-stage"><video playsinline muted src="${url}"></video>
                <span class="clip-badge loop">↻ DÖNGÜ</span><span class="clip-badge fmt"></span><span class="clip-prog"><i></i></span></div>
            <div class="ed-strip" data-strip><div class="ed-thumbs"></div><div class="ed-sel"></div></div>
            <div class="clip-times"><span data-k-a></span><b data-k-len></b><span data-k-b></span></div>
            <div class="rows filled clip-rows"></div>
            <div class="clip-est"><span>Tahmini boyut</span><b data-k-est></b></div>
            <p class="wz-note" data-k-hint></p>
            <div class="ed-progress hidden"><div class="stage-bar"><div></div></div><span></span><button class="link-btn" data-k="cancel">İptal</button></div>
            <div class="ed-bar"><button class="btn-big" data-k="go" style="flex:1">Klip oluştur</button></div></div>`;
        const video = el.querySelector('video');
        const strip = el.querySelector('[data-strip]');

        function estimate() {
            const len = st.end - st.start;
            const h = Math.round(st.width * ((video.videoHeight || 9) / (video.videoWidth || 16)));
            const px = st.width * h;
            const frames = len * st.fps;
            if (st.fmt === 'gif') return px * frames * 0.1;
            if (st.fmt === 'webp') return px * frames * 0.025;
            return (st.width >= 720 ? 2.5e6 : 1.2e6) / 8 * len;
        }

        function paint() {
            const d = duration || 1;
            const sel = el.querySelector('.ed-sel');
            sel.style.left = `${(st.start / d) * 100}%`;
            sel.style.width = `${((st.end - st.start) / d) * 100}%`;
            el.querySelector('[data-k-a]').textContent = clock(st.start);
            el.querySelector('[data-k-b]').textContent = clock(st.end);
            el.querySelector('[data-k-len]').textContent = `${Math.round(st.end - st.start)} sn · en fazla ${MAX_CLIP} sn`;
            el.querySelector('.clip-badge.fmt').textContent = `${CLIP_FORMATS.find(([k]) => k === st.fmt)[1].toUpperCase()} · ${st.width} px`;
            el.querySelector('.clip-badge.loop').classList.toggle('hidden', !st.loop);
            const seg = (key, opts) => `<div class="seg seg-fit">${opts.map(([v, l]) => `<button class="${String(st[key]) === String(v) ? 'on' : ''}" data-k="set" data-key="${key}" data-v="${v}">${l}</button>`).join('')}</div>`;
            el.querySelector('.clip-rows').innerHTML = `
                <div class="row"><span class="row-value" style="font-weight:400">Biçim</span>${seg('fmt', CLIP_FORMATS)}</div>
                <div class="row"><span class="row-value" style="font-weight:400">Boyut</span>${seg('width', [[480, '480 px'], [720, '720 px']])}</div>
                <div class="row"><span class="row-value" style="font-weight:400">Kare hızı</span>${seg('fps', [[10, '10'], [15, '15'], [24, '24']])}</div>
                <button class="row" data-k="loop"><span class="row-value" style="font-weight:400">Döngü önizlemesi<span class="muted row-sub">Başa sarıp tekrar oynar</span></span><span class="toggle${st.loop ? ' on' : ''}"></span></button>`;
            el.querySelector('[data-k-est]').textContent = `~${formatSize(estimate())}`;
            el.querySelector('[data-k-hint]').textContent = CLIP_HINTS[st.fmt];
        }

        const setRange = (a, b) => {
            st.start = Math.max(0, Math.min(a, duration - 0.5));
            st.end = Math.max(st.start + 0.5, Math.min(b, duration, st.start + MAX_CLIP));
            paint();
        };

        video.addEventListener('loadedmetadata', () => {
            if (!duration) duration = video.duration || 0;
            setRange(st.start, Math.min(st.end, duration));
            video.currentTime = st.start;
            video.play().catch(() => {});
            thumbs();
        });
        video.addEventListener('timeupdate', () => {
            const p = (video.currentTime - st.start) / Math.max(0.1, st.end - st.start);
            el.querySelector('.clip-prog i').style.width = `${Math.max(0, Math.min(1, p)) * 100}%`;
            if (video.currentTime >= st.end || video.currentTime < st.start - 0.5) {
                if (st.loop) video.currentTime = st.start;
                else video.pause();
            }
        });

        let drag = null;
        const at = (e) => {
            const r = strip.getBoundingClientRect();
            return Math.max(0, Math.min(1, (e.clientX - r.left) / r.width)) * duration;
        };
        strip.addEventListener('pointerdown', (e) => {
            if (!duration) return;
            history.push([st.start, st.end]);
            const v = at(e);
            drag = Math.abs(v - st.start) <= Math.abs(v - st.end) ? 'a' : 'b';
            strip.setPointerCapture(e.pointerId);
            move(v);
        });
        strip.addEventListener('pointermove', (e) => drag && move(at(e)));
        strip.addEventListener('pointerup', () => {
            drag = null;
            video.currentTime = st.start;
            video.play().catch(() => {});
        });
        function move(v) {
            if (drag === 'a') setRange(Math.min(v, st.end - 0.5), Math.min(st.end, v + MAX_CLIP));
            else setRange(Math.max(st.start, v - MAX_CLIP), Math.max(v, st.start + 0.5));
            video.currentTime = drag === 'a' ? st.start : st.end;
        }

        async function thumbs() {
            const box = el.querySelector('.ed-thumbs');
            const probe = document.createElement('video');
            probe.muted = true;
            probe.src = url;
            await new Promise((r) => { probe.onloadeddata = r; probe.onerror = r; });
            const c = document.createElement('canvas');
            c.height = 60;
            c.width = Math.round(60 * ((probe.videoWidth || 16) / (probe.videoHeight || 9)));
            for (let k = 0; k < 10 && el.isConnected; k++) {
                probe.currentTime = ((k + 0.5) / 10) * duration;
                await new Promise((r) => { probe.onseeked = r; setTimeout(r, 3000); });
                try {
                    c.getContext('2d').drawImage(probe, 0, 0, c.width, c.height);
                    const span = document.createElement('span');
                    span.style.backgroundImage = `url(${c.toDataURL('image/jpeg', 0.6)})`;
                    box.appendChild(span);
                } catch (_) { return; }
            }
        }

        function progress(p, text) {
            const box = el.querySelector('.ed-progress');
            box.classList.toggle('hidden', p === null);
            if (p === null) return;
            box.querySelector('.stage-bar div').style.width = `${Math.max(0, Math.min(1, p)) * 100}%`;
            box.querySelector('span').textContent = text;
        }

        /** Kareleri sırayla (atlayarak) yakalar. */
        async function captureFrames(kind) {
            const grab = document.createElement('video');
            grab.muted = true;
            grab.src = url;
            await new Promise((r, j) => { grab.onloadeddata = r; grab.onerror = () => j(new Error('Video açılamadı')); });
            const w = Math.min(st.width, grab.videoWidth) & ~1;
            const h = Math.round((w * grab.videoHeight) / grab.videoWidth) & ~1;
            const c = document.createElement('canvas');
            c.width = w;
            c.height = h;
            const ctx = c.getContext('2d', { willReadFrequently: kind === 'gif' });
            const frames = [];
            const count = Math.max(1, Math.round((st.end - st.start) * st.fps));
            for (let n = 0; n < count; n++) {
                if (st.cancelled) throw new Error('İptal edildi');
                grab.currentTime = st.start + n / st.fps;
                await new Promise((r) => { grab.onseeked = r; setTimeout(r, 4000); });
                ctx.drawImage(grab, 0, 0, w, h);
                frames.push(kind === 'gif' ? ctx.getImageData(0, 0, w, h) : await new Promise((r) => c.toBlob(r, 'image/webp', 0.8)));
                progress((n + 1) / count * 0.7, `Kareler alınıyor · ${n + 1}/${count}`);
            }
            return { frames, w, h };
        }

        async function create() {
            st.busy = true;
            st.cancelled = false;
            video.pause();
            el.classList.add('busy');
            const base = baseName(item.name);
            try {
                let out;
                let ext;
                if (st.fmt === 'mp4') {
                    progress(0, 'Kaydediliyor…');
                    out = await reencode(blob, {
                        start: st.start, end: st.end, mute: true, audioOnly: false, rotate: 0, maxWidth: st.width, fps: st.fps,
                        onProgress: (p) => progress(p, `Kaydediliyor · %${Math.round(p * 100)}`), isCancelled: () => st.cancelled
                    });
                    ext = out.type.includes('mp4') ? 'mp4' : 'webm';
                } else {
                    const { frames, w, h } = await captureFrames(st.fmt);
                    const delay = 1000 / st.fps;
                    progress(0.7, 'Kodlanıyor…');
                    await new Promise((r) => setTimeout(r, 30));
                    out = st.fmt === 'gif'
                        ? encodeGif(frames, delay, { onProgress: (p) => progress(0.7 + p * 0.3, 'GIF kodlanıyor…') })
                        : await encodeWebp(frames, w, h, delay, { onProgress: (p) => progress(0.7 + p * 0.3, 'WebP birleştiriliyor…') });
                    ext = st.fmt;
                }
                await libAdd(out, { name: `${base}-klip.${ext}`, page: item.page, edited: true, from: item.id });
                toast(`Klip kitaplıkta · ${formatSize(out.size)}`);
                close();
                onSaved();
            } catch (err) {
                toast(err.message);
            } finally {
                st.busy = false;
                el.classList.remove('busy');
                progress(null);
            }
        }

        function close() {
            st.cancelled = true;
            video.pause();
            URL.revokeObjectURL(url);
            closeOverlay(el);
        }

        el.addEventListener('click', (e) => {
            const b = e.target.closest('[data-k]');
            if (!b) return;
            const k = b.dataset.k;
            if (k === 'close') return close();
            if (k === 'cancel') {
                st.cancelled = true;
                return;
            }
            if (st.busy) return;
            if (k === 'go') return create();
            if (k === 'undo') {
                const prev = history.pop();
                if (prev) setRange(prev[0], prev[1]);
                return;
            }
            if (k === 'loop') {
                st.loop = !st.loop;
                if (st.loop) video.play().catch(() => {});
            }
            if (k === 'set') st[b.dataset.key] = b.dataset.key === 'fmt' ? b.dataset.v : Number(b.dataset.v);
            paint();
        });
        paint();
    }

    /* ---------------- Ses araçları ---------------- */

    async function openAudio(item) {
        const el = overlay('ed-audio');
        const st = { normalize: true, trim: true, format: 'mp3', bitrate: 192, info: null, source: '', ffmpeg: false, busy: false, status: 'Hazırlanıyor…' };
        const isVideo = item.kind === 'video';
        const draw = () => {
            const i = st.info;
            const dur = (i && i.duration) || item.duration || 0;
            const lead = st.trim && i ? i.lead : 0;
            const tail = st.trim && i ? i.tail : 0;
            const keep = Math.max(0, dur - lead - tail);
            const size = st.ffmpeg ? (st.bitrate * 1000 / 8) * keep : item.size * (isVideo ? 0.1 : 1);
            const bars = i && i.peaks ? i.peaks : [];
            const cutA = dur ? lead / dur : 0;
            const cutB = dur ? 1 - tail / dur : 1;
            el.innerHTML = `<div class="ed au">
                <div class="ed-top"><button class="back-btn" data-a="close" aria-label="Kapat">←</button><span class="ed-title">Ses araçları</span></div>
                <div><div class="au-name">${escapeHtml(baseName(item.name))}</div>
                    <div class="au-meta">${[dur ? clock(dur) : '', i && i.channels, i && i.codec ? `kaynak ${(item.name.split('.').pop() || '').toUpperCase()}` : ''].filter(Boolean).join(' · ')}</div></div>
                <div class="au-wave">${bars.length ? bars.map((v, k) => {
                    const x = k / bars.length;
                    return `<i class="${x < cutA || x > cutB ? 'cut' : ''}" style="height:${Math.max(4, v * 100)}%"></i>`;
                }).join('') : `<span class="au-wait">${escapeHtml(st.status)}</span>`}</div>
                ${i ? `<div class="au-times"><span>−${clock(lead)} baştan</span><span>${clock(keep)} kalır</span><span>−${clock(tail)} sondan</span></div>` : ''}
                <div class="rows filled">
                    <button class="row" data-a="normalize"${st.ffmpeg ? '' : ' disabled'}><span class="row-value" style="font-weight:400">Ses seviyesini eşitle<span class="muted row-sub">Kısık yerler yükselir, bağırışlar kısılır</span></span><span class="toggle${st.normalize && st.ffmpeg ? ' on' : ''}"></span></button>
                    <button class="row" data-a="trim"${st.ffmpeg ? '' : ' disabled'}><span class="row-value" style="font-weight:400">Baştaki ve sondaki sessizliği kırp<span class="muted row-sub">${i ? `Baştan ${Math.round(i.lead)} sn, sondan ${Math.round(i.tail)} sn kırpılacak` : 'Sessizlik aranıyor'}</span></span><span class="toggle${st.trim && st.ffmpeg ? ' on' : ''}"></span></button>
                    <div class="row"><span class="row-value" style="font-weight:400">Biçim</span><div class="seg seg-fit">${[['mp3', 'MP3'], ['m4a', 'M4A']].map(([k, l]) => `<button class="${st.format === k ? 'on' : ''}" data-a="format" data-v="${k}"${!st.ffmpeg && k === 'mp3' ? ' disabled' : ''}>${l}</button>`).join('')}</div></div>
                    <div class="row"><span class="row-value" style="font-weight:400">Kalite</span><div class="seg seg-fit">${[128, 192, 320].map((k) => `<button class="${st.bitrate === k ? 'on' : ''}" data-a="bitrate" data-v="${k}"${st.ffmpeg ? '' : ' disabled'}>${k}${k === 320 ? ' kbps' : ''}</button>`).join('')}</div></div>
                </div>
                <p class="wz-note">${!st.ffmpeg ? 'Eşitleme, kırpma ve MP3 için sunucunda ffmpeg kurulu olmalı (Termux: pkg install ffmpeg). Şimdilik ses kayıpsız M4A olarak çıkarılır.'
                    : st.format === 'mp3' ? 'MP3 her cihazda ve arabada çalar.' : 'M4A aynı kalitede daha küçük; telefonlarda yerleşik çalar.'}</p>
                <div class="ed-progress hidden"><div class="stage-bar"><div></div></div><span></span></div>
                <div class="ed-bar"><span data-e-size>~${formatSize(size)} · ${st.ffmpeg ? st.format.toUpperCase() : 'M4A'}</span><button class="btn-big" data-a="go"${st.busy ? ' disabled' : ''}>Sesi dışa aktar</button></div></div>`;
        };
        const progress = (p, text) => {
            const box = el.querySelector('.ed-progress');
            box.classList.toggle('hidden', p === null);
            if (p === null) return;
            box.querySelector('.stage-bar div').style.width = `${p * 100}%`;
            box.querySelector('span').textContent = text;
        };
        const close = () => closeOverlay(el);

        draw();
        // Sunucuda ffmpeg varsa dosya oraya gönderilip incelenir.
        (async () => {
            const server = getRenderServer();
            if (!server) {
                st.status = 'Dalga biçimi için kendi sunucun gerekli';
                return draw();
            }
            try {
                const health = await checkRenderServer(server);
                st.ffmpeg = Boolean(health && health.ffmpeg);
                if (!st.ffmpeg) {
                    st.format = 'm4a';
                    st.status = 'Sunucuda ffmpeg yok';
                    return draw();
                }
                st.status = 'Sunucuna gönderiliyor…';
                draw();
                st.source = item.server && item.serverKind ? `${item.serverKind}:${item.serverId}` : (await uploadItem(item), `library:${item.id}`);
                st.status = 'İnceleniyor…';
                draw();
                st.info = await renderApi('/audio/analyze', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ source: st.source }) }, 300000);
                draw();
            } catch (err) {
                st.status = err.message;
                draw();
            }
        })();

        async function exportAudio() {
            st.busy = true;
            draw();
            const name = baseName(item.name);
            try {
                if (!st.ffmpeg) {
                    // Sunucusuz: ses izi kayıpsız ayrılır.
                    const src = await toProgressive(await libFile(item.id));
                    const r = await editMp4(src, { audioOnly: true });
                    await libAdd(r.blob, { name: `${name}.m4a`, page: item.page, edited: true, from: item.id });
                } else {
                    const i = st.info || {};
                    const job0 = await renderApi('/audio/export', {
                        method: 'POST', headers: { 'content-type': 'application/json' },
                        body: JSON.stringify({ source: st.source, duration: i.duration || item.duration || 0, normalize: st.normalize, lead: st.trim ? i.lead || 0 : 0, tail: st.trim ? i.tail || 0 : 0, format: st.format, bitrate: st.bitrate, name })
                    }, 30000);
                    let job = job0;
                    while (job.state === 'running') {
                        progress(job.progress, `Hazırlanıyor · %${Math.round(job.progress * 100)}`);
                        await new Promise((r) => setTimeout(r, 1000));
                        job = await renderApi(`/audio/job/${job0.id}`, {}, 10000);
                    }
                    if (job.state !== 'done') throw new Error(job.error || 'Ses hazırlanamadı');
                    progress(1, 'Telefona alınıyor…');
                    const server = getRenderServer();
                    const res = await fetch(`${server.url}/audio/job/${job0.id}/file?token=${encodeURIComponent(server.token)}`);
                    if (!res.ok) throw new Error(`Alınamadı (HTTP ${res.status})`);
                    const blob = await res.blob();
                    await libAdd(new Blob([blob], { type: st.format === 'mp3' ? 'audio/mpeg' : 'audio/mp4' }), { name: `${name}.${st.format}`, page: item.page, edited: true, from: item.id });
                    renderApi(`/audio/job/${job0.id}`, { method: 'DELETE' }, 10000).catch(() => {});
                }
                toast('Ses kitaplığa kaydedildi');
                close();
                onSaved();
            } catch (err) {
                toast(err.message);
                st.busy = false;
                progress(null);
                draw();
            }
        }

        el.addEventListener('click', (e) => {
            const b = e.target.closest('[data-a]');
            if (!b || b.disabled) return;
            const a = b.dataset.a;
            if (a === 'close') return close();
            if (st.busy) return;
            if (a === 'go') return exportAudio();
            if (a === 'normalize') st.normalize = !st.normalize;
            if (a === 'trim') st.trim = !st.trim;
            if (a === 'format') st.format = b.dataset.v;
            if (a === 'bitrate') st.bitrate = Number(b.dataset.v);
            draw();
        });
    }

    /* ---------------- Birleştir ---------------- */

    function openMerge(items) {
        const el = overlay('ed-merge');
        // Parçalar adlarına göre (…-1, …-2) sıralanır; sürükleyerek değiştirilebilir.
        const sorted = [...items].sort((a, b) => a.name.localeCompare(b.name, 'tr', { numeric: true }));
        const rows = sorted.map((item) => ({ item, on: true }));
        const firstName = baseName(items[0].name).replace(/[-_ ]*(\d+|kısım|part)\s*$/i, '');
        const st = { name: `${firstName || 'birlesik'}-tamami`, check: null, checking: false, busy: false, seq: 0 };
        const ext = (it) => ((it.name.split('.').pop() || '').toUpperCase());
        const meta = (it) => [it.duration ? clock(it.duration) : '', it.height ? `${it.height}p` : '', ext(it)].filter(Boolean).join(' · ');
        const picked = () => rows.filter((r) => r.on);

        async function verify() {
            const my = ++st.seq;
            st.checking = true;
            st.check = null;
            draw();
            const list = picked();
            if (list.length < 2) {
                st.checking = false;
                return draw();
            }
            try {
                const blobs = await Promise.all(list.map((r) => libFile(r.item.id)));
                const c = await checkConcat(blobs);
                if (my !== st.seq) return;
                st.check = c;
            } catch (err) {
                if (my !== st.seq) return;
                st.check = { ok: false, reason: /MP4/.test(err.message) ? 'Yalnızca MP4 parçalar birleştirilebilir' : err.message };
            }
            st.checking = false;
            draw();
        }

        function draw() {
            const list = picked();
            const total = list.reduce((n, r) => n + (r.item.duration || 0), 0);
            const h = list[0] && list[0].item.height;
            const card = st.checking ? '<div class="mg-card idle">Parçalar inceleniyor…</div>'
                : list.length < 2 ? '<div class="mg-card idle">Birleştirmek için en az iki parça seç.</div>'
                : st.check && st.check.ok ? `<div class="mg-card ok">✓ <span><b>Kayıpsız birleştirilebilir</b>Hepsi ${h ? `${h}p · ` : ''}${ext(list[0].item)}. Yeniden kodlanmaz, saniyeler sürer.</span></div>`
                : st.check ? `<div class="mg-card warn">! <span><b>Kayıpsız birleştirilemiyor</b>${escapeHtml(st.check.reason || '')}. Aynı kaynaktan, aynı kalitede kaydedilmiş parçalar birleştirilebilir.</span></div>` : '';
            el.innerHTML = `<div class="ed mg">
                <div class="ed-top"><button class="back-btn" data-m="close" aria-label="Kapat">←</button><span class="ed-title">Birleştir</span></div>
                <div class="mg-head"><b>${list.length} parça · sürükleyerek sırala</b><span class="mono">${clock(total)}</span></div>
                <div class="mg-list">${rows.map((r, i) => `<div class="mg-row${r.on ? '' : ' off'}" data-i="${i}">
                    <span class="mg-grip" data-m="grip">⋮⋮</span><span class="mg-n">${i + 1}</span>
                    <span class="mg-th" style="${r.item.thumb ? `background-image:url('${r.item.thumb}')` : ''}"></span>
                    <span class="mg-main"><b>${escapeHtml(r.item.name)}</b><small>${escapeHtml(meta(r.item))}</small></span>
                    <span class="mg-arrows"><button data-m="up" data-i="${i}"${i === 0 ? ' disabled' : ''}>▲</button><button data-m="down" data-i="${i}"${i === rows.length - 1 ? ' disabled' : ''}>▼</button></span>
                    <button class="mg-check${r.on ? ' on' : ''}" data-m="toggle" data-i="${i}">${r.on ? '✓' : ''}</button></div>`).join('')}</div>
                <div class="mg-bar">${list.map((r, k) => `<span style="flex:${Math.max(1, r.item.duration || 1)}" title="${escapeHtml(r.item.name)}">${k + 1} · ${clock(r.item.duration)}</span>`).join('')}</div>
                ${card}
                <label class="mg-name"><span>Dosya adı</span><input data-m-name value="${escapeHtml(st.name)}" spellcheck="false"><span>.mp4</span></label>
                <div class="ed-bar"><span data-e-size>${list.length} parça · ${clock(total)}</span>
                    <button class="btn-big" data-m="go"${st.check && st.check.ok && !st.busy ? '' : ' disabled'}>${st.busy ? 'Birleştiriliyor…' : 'Birleştir'}</button></div>
            </div>`;
        }

        function close() {
            st.seq++;
            closeOverlay(el);
        }

        // Sürükleyerek sıralama
        let drag = null;
        el.addEventListener('pointerdown', (e) => {
            if (!e.target.closest('[data-m="grip"]')) return;
            const row = e.target.closest('.mg-row');
            drag = { from: Number(row.dataset.i), row };
            row.classList.add('drag');
            el.setPointerCapture(e.pointerId);
            e.preventDefault();
        });
        el.addEventListener('pointermove', (e) => {
            if (!drag) return;
            const over = document.elementFromPoint(e.clientX, e.clientY);
            const target = over && over.closest('.mg-row');
            if (!target || target === drag.row) return;
            const to = Number(target.dataset.i);
            const [moved] = rows.splice(drag.from, 1);
            rows.splice(to, 0, moved);
            drag.from = to;
            draw();
            drag.row = el.querySelector(`.mg-row[data-i="${to}"]`);
            drag.row.classList.add('drag');
        });
        el.addEventListener('pointerup', () => {
            if (!drag) return;
            drag = null;
            verify();
        });

        el.addEventListener('input', (e) => {
            if (e.target.matches('[data-m-name]')) st.name = e.target.value;
        });
        el.addEventListener('click', async (e) => {
            const b = e.target.closest('[data-m]');
            if (!b || b.disabled) return;
            const m = b.dataset.m;
            const i = Number(b.dataset.i);
            if (m === 'close') return close();
            if (m === 'up' || m === 'down') {
                const j = m === 'up' ? i - 1 : i + 1;
                [rows[i], rows[j]] = [rows[j], rows[i]];
                return verify();
            }
            if (m === 'toggle') {
                rows[i].on = !rows[i].on;
                return verify();
            }
            if (m === 'go') {
                st.busy = true;
                draw();
                try {
                    const blobs = await Promise.all(picked().map((r) => libFile(r.item.id)));
                    const r = await concatMp4(blobs);
                    const name = (st.name.trim() || 'birlesik').replace(/[\\/:*?"<>|]+/g, '_');
                    await libAdd(r.blob, { name: `${name}.mp4`, page: items[0].page, edited: true, from: items[0].id });
                    toast(`Birleştirildi · ${clock(r.duration)} · kitaplıkta`);
                    close();
                    onSaved();
                } catch (err) {
                    toast(err.message);
                    st.busy = false;
                    draw();
                }
            }
        });
        draw();
        verify();
    }

    return {
        merge: openMerge,
        audio: openAudio,
        clip: openClip,
        open(item, list = []) {
            if (item.kind === 'photo') return openPhoto(item, list);
            if (item.kind === 'audio') return openAudio(item);
            if (item.kind === 'video') return openVideo(item);
            toast('Bu dosya düzenlenemiyor');
        }
    };
}
