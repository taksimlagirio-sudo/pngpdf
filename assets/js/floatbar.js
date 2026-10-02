// Diğer uygulamaların üstünde duran mini çubuk.
// Web sayfaları sistem üzerine çizim yapamaz; en yakın yol resim-içinde-resim (PiP):
// indirme durumu bir canvas'a çizilir, canvas video akışına çevrilip PiP penceresinde
// gösterilir. Android Chrome'da bu pencere diğer uygulamaların üstünde yüzer.
import { subscribeDownloads } from './downloads.js';
import { formatSize, hms } from './util.js';

const W = 480;
const H = 150;

export const canFloat = typeof document !== 'undefined' &&
    'pictureInPictureEnabled' in document &&
    document.pictureInPictureEnabled &&
    'captureStream' in HTMLCanvasElement.prototype;

let canvas = null;
let ctx = null;
let video = null;
let stream = null;
let ticker = null;
let unsubscribe = null;
let lastJobs = [];
let onStateChange = () => {};

export function isFloating() {
    return Boolean(document.pictureInPictureElement) && document.pictureInPictureElement === video;
}

export function onFloatStateChange(fn) {
    onStateChange = fn;
}

/** Yüzen pencereyi açar/kapatır. Tarayıcı izni gereği kullanıcı hareketinden çağrılmalı. */
export async function toggleFloatingBar() {
    if (!canFloat) throw new Error('Bu tarayıcı yüzen mini pencereyi desteklemiyor.');

    if (isFloating()) {
        await document.exitPictureInPicture();
        return false;
    }

    setup();
    draw();
    await video.play();
    await video.requestPictureInPicture();
    return true;
}

function setup() {
    if (canvas) return;

    canvas = document.createElement('canvas');
    canvas.width = W;
    canvas.height = H;
    ctx = canvas.getContext('2d');

    video = document.createElement('video');
    video.muted = true;
    video.playsInline = true;
    video.autoplay = true;
    // PiP için video belgede ve oynatılabilir olmalı; görünürde yer kaplamasın.
    video.style.cssText = 'position:fixed;left:-9999px;bottom:0;width:2px;height:2px;opacity:0.01;pointer-events:none';
    document.body.appendChild(video);

    stream = canvas.captureStream(10);
    video.srcObject = stream;

    unsubscribe = subscribeDownloads((jobs) => {
        lastJobs = jobs;
        if (isFloating() || video) draw();
    });

    // Hız/kalan süre yazıları indirme olayı gelmese de tazelensin.
    ticker = setInterval(() => {
        if (isFloating()) draw();
    }, 1000);

    video.addEventListener('leavepictureinpicture', () => {
        onStateChange(false);
    });
    video.addEventListener('enterpictureinpicture', () => {
        onStateChange(true);
    });
}

export function destroyFloatingBar() {
    if (ticker) clearInterval(ticker);
    if (unsubscribe) unsubscribe();
    if (stream) stream.getTracks().forEach((t) => t.stop());
    if (video) video.remove();
    canvas = ctx = video = stream = ticker = unsubscribe = null;
}

function ellipsize(text, maxWidth) {
    if (ctx.measureText(text).width <= maxWidth) return text;
    let cut = text;
    while (cut.length > 4 && ctx.measureText(cut + '…').width > maxWidth) {
        cut = cut.slice(0, -1);
    }
    return cut + '…';
}

function draw() {
    if (!ctx) return;

    const active = lastJobs.filter((j) => j.status === 'active');
    const pending = lastJobs.filter((j) => j.status === 'pending-save');
    const done = lastJobs.filter((j) => j.status === 'done');
    const rec = active.find((j) => j.rec);
    const others = active.filter((j) => j !== rec);
    const mono = '"JetBrains Mono", ui-monospace, monospace';

    ctx.fillStyle = '#121110';
    ctx.fillRect(0, 0, W, H);

    if (rec) {
        // Üstte kayıt: yanıp sönen nokta, süre, boyut; altta diğer indirmeler.
        const blink = Math.floor(Date.now() / 1000) % 2 === 0;
        ctx.fillStyle = blink ? '#F2555A' : 'rgba(242,85,90,.3)';
        ctx.beginPath();
        ctx.arc(26, 26, 6, 0, Math.PI * 2);
        ctx.fill();
        ctx.fillStyle = '#F2555A';
        ctx.font = `600 15px ${mono}`;
        ctx.fillText(ellipsize(`KAYIT · ${rec.name}`, W - 60), 42, 31);

        ctx.fillStyle = '#F2EFE9';
        ctx.font = `500 40px ${mono}`;
        ctx.fillText(hms(rec.rec.elapsed), 20, 84);
        ctx.textAlign = 'right';
        ctx.fillStyle = '#A29D93';
        ctx.font = `500 16px ${mono}`;
        ctx.fillText(rec.rec.mode === 'capture' && rec.rec.duration ? `/ ${hms(rec.rec.duration)}`
            : rec.rec.limitSec ? `${hms(rec.rec.limitSec - rec.rec.elapsed)} kaldı` : formatSize(rec.bytes || 0), W - 20, 84);
        ctx.textAlign = 'left';

        ctx.fillStyle = 'rgba(255,255,255,.08)';
        ctx.fillRect(0, 102, W, 1);
        ctx.fillStyle = '#C9CCD6';
        ctx.font = '15px system-ui, sans-serif';
        const speed = others.reduce((sum, j) => sum + (j.speed || 0), 0);
        ctx.fillText(others.length ? `+${others.length} indirme` : 'Başka indirme yok', 20, 130);
        if (speed) {
            ctx.textAlign = 'right';
            ctx.fillStyle = '#D4F04A';
            ctx.font = `500 15px ${mono}`;
            ctx.fillText(`${formatSize(speed)}/sn`, W - 20, 130);
            ctx.textAlign = 'left';
        }
        return;
    }

    ctx.fillStyle = '#D4F04A';
    ctx.font = '600 18px system-ui, sans-serif';
    ctx.fillText('İndirici', 20, 32);

    ctx.textAlign = 'right';
    ctx.fillStyle = '#A29D93';
    ctx.font = '16px system-ui, sans-serif';
    ctx.fillText(
        active.length ? `${active.length} sürüyor` : pending.length ? `${pending.length} bekliyor` : `${done.length} bitti`,
        W - 20,
        32
    );
    ctx.textAlign = 'left';

    const job = active[0] || pending[0] || lastJobs[lastJobs.length - 1];
    if (!job) {
        ctx.fillStyle = '#A29D93';
        ctx.font = '17px system-ui, sans-serif';
        ctx.fillText('İndirme yok', 20, 88);
        return;
    }

    const ratio = job.total ? Math.min(1, job.received / job.total) : null;

    ctx.fillStyle = '#F2EFE9';
    ctx.font = '600 19px system-ui, sans-serif';
    ctx.fillText(ellipsize(job.name, W - 130), 20, 70);

    ctx.textAlign = 'right';
    ctx.fillStyle = job.status === 'error' ? '#F2555A' : '#D4F04A';
    ctx.font = `500 22px ${mono}`;
    ctx.fillText(
        job.status === 'active' ? (ratio === null ? '…' : Math.round(ratio * 100) + '%')
            : job.status === 'done' ? '✓' : job.status === 'pending-save' ? 'Kaydet' : '!',
        W - 20,
        70
    );
    ctx.textAlign = 'left';

    const barY = 90;
    ctx.fillStyle = 'rgba(255,255,255,0.14)';
    roundRect(20, barY, W - 40, 8, 4);
    ctx.fill();
    const fillWidth = job.status === 'active'
        ? (ratio === null ? (W - 40) * 0.35 : (W - 40) * ratio)
        : W - 40;
    ctx.fillStyle = job.status === 'error' ? '#F2555A' : '#D4F04A';
    roundRect(20, barY, Math.max(6, fillWidth), 8, 4);
    ctx.fill();

    ctx.fillStyle = '#C9CCD6';
    ctx.font = '15px system-ui, sans-serif';
    const speed = active.reduce((sum, j) => sum + (j.speed || 0), 0);
    const detail = [active.length > 1 ? `+${active.length - 1} indirme` : '', speed ? `${formatSize(speed)}/sn` : '', job.detail || '']
        .filter(Boolean).join(' · ') || (job.total ? `${formatSize(job.received)} / ${formatSize(job.total)}` : formatSize(job.received));
    ctx.fillText(ellipsize(detail, W - 40), 20, 128);
}

function roundRect(x, y, width, height, radius) {
    ctx.beginPath();
    ctx.moveTo(x + radius, y);
    ctx.arcTo(x + width, y, x + width, y + height, radius);
    ctx.arcTo(x + width, y + height, x, y + height, radius);
    ctx.arcTo(x, y + height, x, y, radius);
    ctx.arcTo(x, y, x + width, y, radius);
    ctx.closePath();
}
