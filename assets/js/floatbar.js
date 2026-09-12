// Diğer uygulamaların üstünde duran mini çubuk.
// Web sayfaları sistem üzerine çizim yapamaz; en yakın yol resim-içinde-resim (PiP):
// indirme durumu bir canvas'a çizilir, canvas video akışına çevrilip PiP penceresinde
// gösterilir. Android Chrome'da bu pencere diğer uygulamaların üstünde yüzer.
import { subscribeDownloads } from './downloads.js';
import { formatSize } from './util.js';

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

    ctx.fillStyle = '#181828';
    ctx.fillRect(0, 0, W, H);

    ctx.fillStyle = '#a5b4fc';
    ctx.font = '600 18px system-ui, sans-serif';
    ctx.fillText('İndirici', 20, 32);

    ctx.textAlign = 'right';
    ctx.fillStyle = '#8a8fa3';
    ctx.font = '16px system-ui, sans-serif';
    ctx.fillText(
        active.length ? `${active.length} sürüyor` : pending.length ? `${pending.length} bekliyor` : `${done.length} bitti`,
        W - 20,
        32
    );
    ctx.textAlign = 'left';

    const job = active[0] || pending[0] || lastJobs[lastJobs.length - 1];
    if (!job) {
        ctx.fillStyle = '#6b7089';
        ctx.font = '17px system-ui, sans-serif';
        ctx.fillText('İndirme yok', 20, 88);
        return;
    }

    const ratio = job.total ? Math.min(1, job.received / job.total) : null;

    ctx.fillStyle = '#ffffff';
    ctx.font = '600 19px system-ui, sans-serif';
    ctx.fillText(ellipsize(job.name, W - 130), 20, 70);

    ctx.textAlign = 'right';
    ctx.fillStyle = job.status === 'active' ? '#a5b4fc' : job.status === 'error' ? '#ff6b6b' : '#34d399';
    ctx.font = '600 22px system-ui, sans-serif';
    ctx.fillText(
        job.status === 'active' ? (ratio === null ? '…' : Math.round(ratio * 100) + '%')
            : job.status === 'done' ? '✓' : job.status === 'pending-save' ? 'Kaydet' : '!',
        W - 20,
        70
    );
    ctx.textAlign = 'left';

    // İlerleme çubuğu
    const barY = 90;
    ctx.fillStyle = 'rgba(255,255,255,0.14)';
    roundRect(20, barY, W - 40, 10, 5);
    ctx.fill();

    const fillWidth = job.status === 'active'
        ? (ratio === null ? (W - 40) * 0.35 : (W - 40) * ratio)
        : W - 40;
    const gradient = ctx.createLinearGradient(20, 0, W - 20, 0);
    if (job.status === 'active') {
        gradient.addColorStop(0, '#667eea');
        gradient.addColorStop(1, '#a5b4fc');
    } else {
        gradient.addColorStop(0, '#10b981');
        gradient.addColorStop(1, '#34d399');
    }
    ctx.fillStyle = job.status === 'error' ? '#ff6b6b' : gradient;
    roundRect(20, barY, Math.max(6, fillWidth), 10, 5);
    ctx.fill();

    ctx.fillStyle = '#b9bdd4';
    ctx.font = '15px system-ui, sans-serif';
    const detail = job.detail || (job.total ? `${formatSize(job.received)} / ${formatSize(job.total)}` : formatSize(job.received));
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
