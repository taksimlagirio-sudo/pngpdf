// "Kendi sunucunu kur": nerede çalışacağını seç, komutları kopyala, QR okutarak (ya da elle) bağlan.
import { escapeHtml, isHttpUrl } from './util.js';

const REPO = 'https://github.com/taksimlagirio-sudo/pngpdf';

const PLACES = [
    {
        key: 'pc', label: 'Bilgisayar', sub: 'Windows / Mac / Linux, en güçlüsü', head: 'Bilgisayarda terminal aç',
        cmds: [
            ['1 · İndir', `git clone ${REPO}`],
            ['2 · Kur', 'cd pngpdf/render-server && npm i && npx playwright-core install chromium'],
            ['3 · Başlat', 'HOST=0.0.0.0 npm start']
        ],
        note: 'Windows PowerShell\'de başlatma: $env:HOST="0.0.0.0"; npm start. Açılınca bilgisayarda ' +
            'http://127.0.0.1:8787/baglan sayfasındaki QR\'ı okut. Uzaktayken bağlanmak için iki cihaza da Tailscale kur.'
    },
    {
        key: 'android', label: 'Android', sub: 'Termux ile, ayrı cihaz gerekmez', head: 'Termux\'ta sırayla çalıştır',
        cmds: [
            ['1 · Hazırla', 'pkg install nodejs git x11-repo && pkg install chromium'],
            ['2 · İndir', `git clone ${REPO}`],
            ['3 · Başlat', 'sh pngpdf/render-server/start-termux.sh']
        ],
        note: 'Sunucu açılınca İndirici Chrome\'da kendiliğinden açılır ve bağlı gelir; QR gerekmez. ' +
            'Başka bir cihazdan bağlanacaksan HOST=0.0.0.0 ile başlatıp Termux\'ta 127.0.0.1:8787/baglan sayfasını aç.'
    }
];

/** QR'daki adresten (…/?pair=KOD) sunucu adresini ve kodu çıkarır. */
export function parsePairLink(text) {
    try {
        const url = new URL(String(text).trim());
        const code = url.searchParams.get('pair');
        if (!code || !/^https?:$/.test(url.protocol)) return null;
        return { url: url.origin, code };
    } catch (_) {
        return null;
    }
}

/**
 * https'teki uygulama http bir yerel adrese istek atamaz (karışık içerik). O durumda sunucunun
 * kendi sunduğu uygulamaya gidilir; orada kod kullanılıp bağlanılır.
 */
function needsRedirect({ url }) {
    if (location.protocol !== 'https:' || !url.startsWith('http:')) return false;
    return !/^http:\/\/(127\.0\.0\.1|localhost|\[::1\])(:|$)/.test(url);
}

/** Kodu sunucuya verip token'ı alır. */
export async function redeemPair({ url, code }) {
    const res = await fetch(`${url}/pair`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ code })
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok || !data.token) throw new Error(data.error || `Sunucu yanıt vermedi (HTTP ${res.status})`);
    return { url, token: data.token };
}

/**
 * Sihirbazı tam ekran açar.
 * @param {{ connect: (config: {url: string, token: string}) => Promise<any>, toast?: (t: string) => void, step?: number }} opts
 */
export function openSetup({ connect, toast = () => {}, step = 1 } = {}) {
    const el = document.createElement('div');
    el.className = 'remote-overlay setup-overlay';
    document.body.appendChild(el);
    document.documentElement.classList.add('remote-open');

    let place = 0;
    let stream = null;
    let scanning = false;
    let busy = false;

    function stepsHtml(active) {
        return `<div class="wz-steps">${['Yer', 'Kur', 'Bağla'].map((label, i) => `
            <div class="wz-step${i + 1 < active ? ' done' : ''}${i + 1 === active ? ' on' : ''}"><span>${i + 1 < active ? '✓' : i + 1}</span>${label}</div>`).join('')}</div>`;
    }

    function renderPlace() {
        stopCamera();
        const p = PLACES[place];
        el.innerHTML = `
            <div class="wz">
                <div class="wz-top"><button class="back-btn" data-w="close" aria-label="Kapat">←</button><span>Kendi sunucunu kur</span></div>
                ${stepsHtml(2)}
                <p class="wz-intro">Sunucu sayfaları gerçek bir tarayıcıda açar, kapalı sitelerden indirir ve telefon kilitliyken kaydeder.</p>
                <div class="wz-places">${PLACES.map((o, i) => `
                    <button class="wz-place${i === place ? ' on' : ''}" data-w="place" data-i="${i}">
                        <span class="wz-place-l">${o.label}</span><span class="wz-place-s">${o.sub}</span></button>`).join('')}</div>
                <span class="wz-head">${escapeHtml(p.head)}</span>
                ${p.cmds.map(([t, c]) => `
                    <div class="wz-cmd"><span class="wz-cmd-t">${escapeHtml(t)}</span>
                        <div class="wz-cmd-box"><code>${escapeHtml(c)}</code><button data-w="copy" data-c="${escapeHtml(c)}">Kopyala</button></div></div>`).join('')}
                <p class="wz-note">${escapeHtml(p.note)}</p>
                <button class="btn-big wz-next" data-w="next">Çalıştırdım, bağlan</button>
            </div>`;
    }

    function renderConnect() {
        const canScan = 'BarcodeDetector' in window && navigator.mediaDevices && navigator.mediaDevices.getUserMedia;
        el.innerHTML = `
            <div class="wz">
                <div class="wz-top"><button class="back-btn" data-w="back" aria-label="Geri">←</button><span>Kendi sunucunu kur</span></div>
                ${stepsHtml(3)}
                ${canScan ? `<div class="wz-cam"><video playsinline muted></video><span class="wz-frame"></span>
                    <button class="btn-ac wz-cam-start" data-w="scan">Kamerayı aç</button></div>
                    <p class="wz-intro">Sunucu açılınca ekranında bir QR çıkar (<code>…/baglan</code>). Okut — adres ve token kendiliğinden gelir.</p>`
                    : `<p class="wz-intro">Bu tarayıcı uygulama içinde QR okuyamıyor. Sunucunun <code>…/baglan</code> sayfasındaki QR'ı
                        telefonun kamerasıyla okut; açılan sayfa bağlı gelir. Ya da adresi ve token'ı elle gir.</p>`}
                <div class="wz-or"><span></span>ya da elle<span></span></div>
                <div class="wz-manual">
                    <input class="input" type="url" data-w-url placeholder="https://bilgisayarim.tailXXXX.ts.net" autocomplete="off">
                    <input class="input" type="password" data-w-token placeholder="Token" autocomplete="off">
                    <button class="btn-ac" data-w="manual">Bağlan</button>
                </div>
                <p class="wz-status" data-w-status></p>
                <p class="wz-note">Evden uzaktayken: sunucunun çalıştığı cihazda ve telefonda Tailscale açık olsun, adres <code>…ts.net</code> ile başlasın.</p>
            </div>`;
    }

    const setStatus = (text, error = false) => {
        const s = el.querySelector('[data-w-status]');
        if (!s) return;
        s.textContent = text;
        s.classList.toggle('error', error);
    };

    async function finish(config) {
        if (busy) return;
        busy = true;
        setStatus('Bağlanılıyor…');
        try {
            await connect(config);
            toast('Sunucuna bağlandı');
            close();
        } catch (err) {
            setStatus(`Bağlanılamadı: ${err.message}`, true);
        } finally {
            busy = false;
        }
    }

    async function startCamera() {
        try {
            stream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: 'environment' }, audio: false });
        } catch (err) {
            setStatus('Kamera açılamadı; izin verip yeniden dene ya da elle gir.', true);
            return;
        }
        const video = el.querySelector('.wz-cam video');
        if (!video) return stopCamera();
        el.querySelector('.wz-cam').classList.add('live');
        video.srcObject = stream;
        await video.play().catch(() => {});
        const detector = new window.BarcodeDetector({ formats: ['qr_code'] });
        scanning = true;
        while (scanning && stream) {
            try {
                const codes = await detector.detect(video);
                const link = codes.map((c) => parsePairLink(c.rawValue)).find(Boolean);
                if (link) {
                    stopCamera();
                    setStatus('QR okundu, bağlanılıyor…');
                    if (needsRedirect(link)) {
                        location.href = `${link.url}/?pair=${encodeURIComponent(link.code)}`;
                        return;
                    }
                    try {
                        await finish(await redeemPair(link));
                    } catch (err) {
                        setStatus(err.message, true);
                    }
                    return;
                }
                if (codes.length) setStatus('Bu QR bir İndirici sunucusuna ait değil.', true);
            } catch (_) { /* kare hazır değil */ }
            await new Promise((r) => setTimeout(r, 300));
        }
    }

    function stopCamera() {
        scanning = false;
        if (stream) stream.getTracks().forEach((t) => t.stop());
        stream = null;
    }

    function close() {
        stopCamera();
        el.remove();
        document.removeEventListener('keydown', onKey);
        if (!document.querySelector('.remote-overlay')) document.documentElement.classList.remove('remote-open');
    }

    const onKey = (e) => {
        if (e.key === 'Escape') close();
    };
    document.addEventListener('keydown', onKey);

    el.addEventListener('click', async (e) => {
        const btn = e.target.closest('[data-w]');
        if (!btn) return;
        const w = btn.dataset.w;
        if (w === 'close') return close();
        if (w === 'back') return renderPlace();
        if (w === 'place') {
            place = Number(btn.dataset.i);
            return renderPlace();
        }
        if (w === 'next') return renderConnect();
        if (w === 'scan') {
            btn.remove();
            return startCamera();
        }
        if (w === 'copy') {
            try {
                await navigator.clipboard.writeText(btn.dataset.c);
                btn.textContent = 'Kopyalandı';
                setTimeout(() => { btn.textContent = 'Kopyala'; }, 1500);
            } catch (_) {
                toast('Kopyalanamadı; komutu elle seçip kopyala');
            }
            return;
        }
        if (w === 'manual') {
            const urlText = el.querySelector('[data-w-url]').value.trim();
            const token = el.querySelector('[data-w-token]').value.trim();
            const link = parsePairLink(urlText);
            if (link && needsRedirect(link)) {
                location.href = `${link.url}/?pair=${encodeURIComponent(link.code)}`;
                return;
            }
            if (link) {
                try {
                    return await finish(await redeemPair(link));
                } catch (err) {
                    return setStatus(err.message, true);
                }
            }
            const url = urlText.replace(/\/+$/, '');
            if (!isHttpUrl(url) || !token) return setStatus('Adres (http/https) ve token gerekli.', true);
            return finish({ url, token });
        }
    });

    if (step === 3) renderConnect();
    else renderPlace();
    return { close };
}
