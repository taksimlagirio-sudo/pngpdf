// Canlı ekran: sunucudaki tarayıcı sayfasını telefonda "kendi ekranın gibi" göstermek ve kullanmak.
// "Kendim dokunayım" oturumu (server.mjs) ve "aç ve kaydet"in kendin başlat ekranı (capture.mjs) kullanır.
//
// `h` (ekran tutucusu): { context, page, viewport: {width, height, dpr}, viewers: Set, frame }.
// - Görüntü: tarayıcının ekran yayını (screencast); sayfa değiştikçe kare, saniyede en fazla ~12.
//   Sayfa durunca ekranın gerçek yoğunluğunda net bir kare çekilir. Boşta kare gönderilmez.
// - Dokunmatik: parmak hareketleri gerçek dokunmatik olay olarak gider (kaydırma, savurma tarayıcının).
// - Klavye: telefon klavyesinden gelen metin olduğu gibi yazılır.

const KEYS = new Set(['Enter', 'Backspace', 'Escape', 'Tab', 'Delete', 'Space', 'ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown']);

export async function startCast(h, force = false) {
    const page = h.page;
    if (!page || (h.castPage === page && !force) || page.isClosed()) return;
    h.castPage = page;
    if (h.cast) {
        const old = h.cast;
        h.cast = null;
        old.send('Page.stopScreencast').catch(() => {});
        old.detach().catch(() => {});
    }
    const cdp = await h.context.newCDPSession(page);
    if (h.castPage !== page) return cdp.detach().catch(() => {});
    h.cast = cdp;
    let lastAck = 0;
    let settle = 0;
    let shooting = false;
    let movedWhileShooting = false;
    let quietUntil = 0;
    const dpr = () => (h.viewport && h.viewport.dpr) || 1;
    const sharp = async () => {
        if (shooting || h.castPage !== page || page.isClosed() || !h.viewers.size) return;
        shooting = true;
        movedWhileShooting = false;
        const image = await page.screenshot({ type: 'jpeg', quality: 70, timeout: 5000 }).catch(() => null);
        shooting = false;
        quietUntil = Date.now() + 600; // çekimin tetiklediği kareler net kareyi ezmesin
        if (!image || movedWhileShooting || h.castPage !== page) return;
        h.frame = image;
        for (const send of h.viewers) send(image);
    };
    h.sharpen = () => {
        clearTimeout(settle);
        if (dpr() > 1) settle = setTimeout(sharp, 200);
    };
    let lastInput = 0;
    h.noteInput = () => { lastInput = Date.now(); };
    cdp.on('Page.screencastFrame', ({ data, sessionId }) => {
        // Net kare çekilirken gelen kare çekimin kendisinden olabilir: dokunuş yoksa yok sayılır.
        if ((shooting || Date.now() < quietUntil) && Date.now() - lastInput > 300) {
            cdp.send('Page.screencastFrameAck', { sessionId }).catch(() => {});
            return;
        }
        if (shooting) movedWhileShooting = true;
        h.frame = Buffer.from(data, 'base64');
        for (const send of h.viewers) send(h.frame);
        clearTimeout(settle);
        if (dpr() > 1) settle = setTimeout(sharp, 350);
        const wait = Math.max(0, 80 - (Date.now() - lastAck));
        setTimeout(() => {
            lastAck = Date.now();
            cdp.send('Page.screencastFrameAck', { sessionId }).catch(() => {});
        }, wait);
    });
    const size = page.viewportSize() || { width: 1280, height: 720 };
    await cdp.send('Page.startScreencast', {
        format: 'jpeg', quality: 60, everyNthFrame: 1,
        maxWidth: Math.round(size.width * dpr()), maxHeight: Math.round(size.height * dpr())
    });
}

export function stopCast(h) {
    for (const send of h.viewers || []) send.end();
    if (h.viewers) h.viewers.clear();
    if (h.cast) h.cast.detach().catch(() => {});
    h.cast = null;
    h.castPage = null;
}

/** MJPEG görüntü akışı: <img src> ile gösterilir, her yeni kare hemen gider. */
export function serveStream(h, req, res, headers = {}, onAlive = () => {}) {
    res.writeHead(200, { ...headers, 'content-type': 'multipart/x-mixed-replace; boundary=kare', 'cache-control': 'no-store', connection: 'keep-alive' });
    const send = (buf) => {
        res.write(`--kare\r\nContent-Type: image/jpeg\r\nContent-Length: ${buf.length}\r\n\r\n`);
        res.write(buf);
        res.write('\r\n');
    };
    send.end = () => res.end();
    if (h.frame) send(h.frame);
    h.viewers.add(send);
    if (h.sharpen) h.sharpen();
    else startCast(h).catch(() => {});
    const alive = setInterval(() => {
        onAlive(); // görüntü açık oldukça oturum kapanmasın
        if (h.frame) send(h.frame); // bazı tarayıcılar son kareyi bir sonraki gelince gösterir
    }, 4000);
    req.on('close', () => {
        clearInterval(alive);
        h.viewers.delete(send);
    });
}

/**
 * Ekrandaki ortak işlemler. Sonuç: işlem yapıldıysa {done: true, ...}; tanınmadıysa null
 * (çağıran kendi işlemlerine bakar).
 */
export async function liveAction(h, action) {
    const page = h.page;
    if (h.noteInput) h.noteInput(); // bu andan sonra gelen kareler gerçek değişikliktir
    const { width, height } = page.viewportSize() || { width: 1280, height: 720 };
    const fraction = (value) => Math.min(1, Math.max(0, Number(value) || 0));
    switch (action.type) {
        case 'touch': {
            const types = { start: 'touchStart', move: 'touchMove', end: 'touchEnd', cancel: 'touchCancel' };
            const type = types[action.phase];
            if (!type) throw new Error('Bilinmeyen dokunuş');
            const points = (Array.isArray(action.points) ? action.points : []).slice(0, 5)
                .map((pt, i) => ({ x: fraction(pt.x) * width, y: fraction(pt.y) * height, id: Number.isInteger(pt.id) ? pt.id : i, radiusX: 8, radiusY: 8, force: 1 }));
            if (!h.cast || h.castPage !== page) await startCast(h, true);
            await h.cast.send('Input.dispatchTouchEvent', { type, touchPoints: type === 'touchEnd' || type === 'touchCancel' ? [] : points });
            return { done: true };
        }
        case 'text':
            await page.keyboard.insertText(String(action.text || '').slice(0, 2000));
            return { done: true };
        case 'tap':
            await page.touchscreen.tap(fraction(action.x) * width, fraction(action.y) * height).catch(() =>
                page.mouse.click(fraction(action.x) * width, fraction(action.y) * height));
            return { done: true };
        case 'wheel': {
            const dx = Math.max(-4000, Math.min(4000, Number(action.dx) || 0));
            const dy = Math.max(-4000, Math.min(4000, Number(action.dy) || 0));
            await page.mouse.move(fraction(action.x) * width, fraction(action.y) * height);
            await page.mouse.wheel(dx, dy);
            return { done: true };
        }
        case 'scroll':
            await page.mouse.move(width / 2, height / 2);
            await page.mouse.wheel(0, Math.max(-3, Math.min(3, Number(action.dy) || 0)) * height);
            return { done: true };
        case 'type':
            await page.keyboard.type(String(action.text || '').slice(0, 500), { delay: 20 });
            return { done: true };
        case 'key':
            if (!KEYS.has(action.key)) throw new Error('Desteklenmeyen tuş');
            // Enter giriş penceresini kapatabilir (giriş bitti); kapanan sayfa hata sayılmaz.
            await page.keyboard.press(action.key === 'Space' ? ' ' : action.key).catch((err) => { if (!page.isClosed()) throw err; });
            return { done: true };
        case 'forward':
            await page.goForward({ timeout: 10000 }).catch(() => {});
            return { done: true };
        case 'reload':
            await page.reload({ waitUntil: 'domcontentloaded', timeout: 20000 }).catch(() => {});
            return { done: true };
        case 'back': {
            const went = await page.goBack({ timeout: 10000 }).catch(() => null);
            return { done: true, went: Boolean(went) };
        }
        default:
            return null;
    }
}

/**
 * Odaktaki kutucuk: uygulama şifre kutusunda yazılanı gizler, e-postada uygun klavyeyi açar.
 * Önce ana sayfaya bakılır; odak bir çerçevedeyse yalnızca ilk birkaç çerçeveye, kısa süreyle.
 */
export async function liveFocus(page) {
    const probe = () => {
        const el = document.activeElement;
        if (!el || el === document.body) return null;
        if (el.tagName === 'IFRAME') return { frame: el.src || el.name || true };
        const editable = el.isContentEditable || /^(INPUT|TEXTAREA)$/.test(el.tagName);
        if (!editable) return null;
        return { type: (el.getAttribute('type') || el.tagName).toLowerCase(), label: el.getAttribute('aria-label') || el.getAttribute('placeholder') || el.name || '' };
    };
    const quick = (frame) => Promise.race([frame.evaluate(probe).catch(() => null), new Promise((r) => setTimeout(() => r(null), 400))]);
    const top = await quick(page.mainFrame());
    if (!top || !top.frame) return top;
    for (const frame of page.mainFrame().childFrames().slice(0, 6)) {
        const focus = await quick(frame);
        if (focus && !focus.frame) return focus;
    }
    return null;
}

/**
 * Sayfada oynayan videolar (tüm pencereler ve çerçeveler): "Bu videoyu yakala" için.
 * Reklam oynatıcısındakiler ve çok küçükler atlanır. src blob ise video parça parça yükleniyordur.
 */
export async function playingVideos(context) {
    const out = [];
    for (const page of context.pages()) {
        for (const frame of page.frames()) {
            const list = await Promise.race([
                frame.evaluate(() => [...document.querySelectorAll('video')].map((v) => {
                    const r = v.getBoundingClientRect();
                    return {
                        src: v.currentSrc || v.src || '', time: v.currentTime || 0, duration: isFinite(v.duration) ? v.duration : 0,
                        live: v.duration === Infinity, paused: v.paused, w: v.videoWidth, h: v.videoHeight, area: r.width * r.height,
                        poster: v.poster || '', frameUrl: location.href
                    };
                })).catch(() => []),
                new Promise((r) => setTimeout(() => r([]), 800))
            ]);
            for (const v of list) if (v.area > 2000 || v.w > 0) out.push(v);
        }
    }
    return out.sort((a, b) => (Number(b.time > 0) - Number(a.time > 0)) || (b.area - a.area));
}
