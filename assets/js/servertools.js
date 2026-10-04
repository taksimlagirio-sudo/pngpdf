// Kendi sunucunla ilgili ekranlar: "Bilgisayardan gönder" (yer imi düğmesi), gelen bağlantılar ve
// "Sunucu durumu" (disk, süren kayıt, takipler, son hatalar, bakım, yeniden başlatma).
import { escapeHtml, formatSize, clock, getRenderServer, renderApi } from './util.js';
import { icon } from './icons.js';

function overlay(cls) {
    const el = document.createElement('div');
    el.className = `remote-overlay ${cls}`;
    document.body.appendChild(el);
    document.documentElement.classList.add('remote-open');
    return el;
}

function closeOverlay(el) {
    el.remove();
    if (!document.querySelector('.remote-overlay')) document.documentElement.classList.remove('remote-open');
}

async function copy(text) {
    try {
        await navigator.clipboard.writeText(text);
        return true;
    } catch (_) {
        return false;
    }
}

/* ---------------- S15 · Bilgisayardan gönder ---------------- */

export function openBookmarklet({ toast = () => {} } = {}) {
    const el = overlay('bm');
    const close = () => closeOverlay(el);
    let address = '';
    let note = '';
    let copied = false;

    function draw() {
        let shown = address;
        try {
            const u = new URL(address);
            shown = `${u.host}${u.pathname}`;
        } catch (_) { /* bekleniyor */ }
        el.innerHTML = `<div class="bm-wrap">
            <div class="wz-top"><button class="back-btn" data-b="close" aria-label="Kapat">${icon('back')}</button><span>Bilgisayardan gönder</span></div>
            <p class="bm-lead">Bilgisayarda bir video sayfasındayken tek tıkla İndirici'ye gönder. Bağlantı bu telefonda ve masaüstü uygulamada algılanır.</p>
            <div class="bm-demo"><div class="bm-bar"><span>Haberler</span><span>E-posta</span><span class="bm-chip">⇩ İndirici'ye gönder</span></div>
                <div class="bm-page"><i></i><i></i><i></i></div></div>
            <ol class="bm-steps">
                <li><b>1</b><span>Yer imleri çubuğunu aç<small>Chrome / Edge'de <kbd>Ctrl</kbd> <kbd>Shift</kbd> <kbd>B</kbd></small></span></li>
                <li><b>2</b><span>Düğmeyi çubuğa sürükle<small>Bilgisayarda aşağıdaki adresi açınca düğme orada</small></span></li>
                <li><b>3</b><span>Video sayfasında düğmeye tıkla<small>Bağlantı İndirici'de açılır, algılama başlar</small></span></li>
            </ol>
            <div class="bm-addr"><div><small>Bilgisayarda bu adresi aç</small><b>${escapeHtml(shown || 'Hazırlanıyor…')}</b></div>
                ${address ? `<button data-b="copy">${copied ? 'Kopyalandı ✓' : 'Kopyala'}</button>` : ''}</div>
            ${note ? `<p class="bm-note">${escapeHtml(note)}</p>` : ''}
            ${address ? '<button class="btn-ghost" data-b="open" style="height:44px">Bu cihazda aç</button>' : ''}
        </div>`;
    }

    (async () => {
        const server = getRenderServer();
        if (!server) {
            note = 'Bunun için kendi sunucun gerekli (Ayarlar → Kendi sunucum).';
            return draw();
        }
        try {
            const r = await renderApi('/inbox?after=' + Date.now() + '&bases=1', {}, 10000);
            const local = (u) => /\/\/(127\.0\.0\.1|localhost|\[::1\])[:/]/.test(u + '/');
            const bases = (r.bases || []).map((b) => b.url);
            const base = !local(server.url) ? server.url : bases.find((u) => !local(u)) || server.url;
            address = `${base}/yerimi?k=${r.key}`;
            if (local(base)) note = 'Sunucu yalnızca bu cihazdan erişilebilir. Bilgisayardan açmak için sunucuyu HOST=0.0.0.0 ile başlat (aynı Wi-Fi) ya da Tailscale kullan.';
        } catch (err) {
            note = err.status === 404 ? 'Sunucun eski; güncelleyip (git pull) yeniden başlat.' : err.message;
        }
        draw();
    })();

    el.addEventListener('click', async (e) => {
        const b = e.target.closest('[data-b]');
        if (!b) return;
        if (b.dataset.b === 'close') return close();
        if (b.dataset.b === 'open') return window.open(address, '_blank', 'noopener');
        if (b.dataset.b === 'copy') {
            copied = await copy(address);
            if (!copied) toast('Kopyalanamadı');
            draw();
        }
    });
    draw();
    return { close };
}

/** Bilgisayardan gönderilen bağlantıları alır (uygulama açıkken birkaç saniyede bir bakılır). */
export function startInbox({ onLink }) {
    const KEY = 'indirici.inboxSeen';
    let seen = 0;
    try {
        seen = Number(localStorage.getItem(KEY)) || 0;
    } catch (_) { /* depolama kapalı */ }
    if (!seen) seen = Date.now();
    let busy = false;
    const check = async () => {
        if (busy || document.visibilityState !== 'visible' || !getRenderServer()) return;
        busy = true;
        try {
            const r = await renderApi(`/inbox?after=${seen}`, {}, 8000);
            const items = r.items || [];
            if (items.length) {
                seen = Math.max(...items.map((i) => i.at));
                try {
                    localStorage.setItem(KEY, String(seen));
                } catch (_) { /* depolama kapalı */ }
                // Son 10 dakikada gönderilen en yeni bağlantı açılır.
                if (Date.now() - items[0].at < 10 * 60 * 1000) onLink(items[0].url, items[0].title);
            }
        } catch (_) { /* eski sunucu ya da ağ yok */ }
        busy = false;
    };
    setInterval(check, 6000);
    document.addEventListener('visibilitychange', check);
    setTimeout(check, 1500);
}

/* ---------------- S18 · Sunucu durumu ---------------- */

function since(sec) {
    const d = Math.floor(sec / 86400);
    const h = Math.floor(sec / 3600) % 24;
    const m = Math.floor(sec / 60) % 60;
    if (d) return `${d} gün ${h} sa`;
    if (h) return `${h} sa ${m} dk`;
    return `${Math.max(1, m)} dk`;
}

function when(at) {
    const d = new Date(at);
    const t = d.toLocaleTimeString('tr-TR', { hour: '2-digit', minute: '2-digit' });
    const days = Math.floor((new Date().setHours(0, 0, 0, 0) - new Date(at).setHours(0, 0, 0, 0)) / 86400000);
    return days === 0 ? t : days === 1 ? `dün ${t}` : `${d.toLocaleDateString('tr-TR', { day: 'numeric', month: 'short' })} ${t}`;
}

const ago = (at) => {
    const d = Math.floor((Date.now() - at) / 86400000);
    return d < 1 ? 'bugün' : `${d} gün`;
};

const KEEP = [[0, 'Kapalı'], [7, '7 gün'], [30, '30 gün'], [90, '90 gün']];
const BOOT_CMD = 'sh render-server/kur-otomatik.sh';

export function openServerStatus({ toast = () => {} } = {}) {
    const el = overlay('sv');
    let st = null;
    let error = '';
    let bootOpen = false;
    let restarting = false;
    let timer = null;
    let tick = null;
    const close = () => {
        clearInterval(timer);
        clearInterval(tick);
        closeOverlay(el);
    };

    const load = async () => {
        try {
            st = await renderApi('/status', {}, 10000);
            error = '';
            if (restarting) {
                restarting = false;
                toast('Sunucu yeniden başladı');
            }
        } catch (err) {
            error = restarting ? 'Yeniden başlıyor…' : err.status === 404 ? 'Sunucun eski; güncelleyip (git pull) yeniden başlat.' : err.message;
        }
        draw();
    };

    const card = (title, body, cls = '') => `<div class="sv-card ${cls}"><span class="sv-label">${title}</span>${body}</div>`;

    function diskHtml() {
        const d = st.disk;
        const s = st.sizes;
        if (!d) return card('Disk', `<b class="sv-big">${formatSize(s.records + s.library + s.other)}</b><small class="sv-sub">İndirici'nin kullandığı</small>`);
        const used = d.total - d.free;
        const pct = (n) => `${Math.max(0, Math.min(100, (n / d.total) * 100))}%`;
        const rest = Math.max(0, used - s.records - s.library - s.other);
        const gb = (n) => (n / 1e9).toLocaleString('tr-TR', { maximumFractionDigits: n > 1e10 ? 0 : 1 });
        return card('Disk', `<div class="sv-disk-head"><b>${gb(used)} / ${gb(d.total)} GB</b><small>${formatSize(d.free)} boş</small></div>
            <div class="sv-bar"><i class="a" style="width:${pct(s.records)}"></i><i class="b" style="width:${pct(s.library)}"></i><i class="c" style="width:${pct(s.other)}"></i><i class="d" style="width:${pct(rest)}"></i></div>
            <div class="sv-legend"><span><i class="a"></i>Kayıtlar ${formatSize(s.records)}</span><span><i class="b"></i>Kitaplık ${formatSize(s.library)}</span><span><i class="c"></i>Diğer ${formatSize(s.other)}</span></div>`, 'sv-disk');
    }

    function recHtml() {
        const r = st.running[0];
        return card('Süren kayıt', r
            ? `<b class="sv-big mono" data-rec-t="${r.startedAt}">${clock((Date.now() - r.startedAt) / 1000)}</b><small class="sv-sub">${escapeHtml([r.name.replace(/\.[a-z0-9]+$/i, ''), r.quality].filter(Boolean).join(' · '))}${st.running.length > 1 ? ` · +${st.running.length - 1}` : ''}</small>`
            : '<b class="sv-big sv-dim">—</b><small class="sv-sub">Şu an kayıt yok</small>', r ? 'sv-live' : '');
    }

    function pendingHtml() {
        const p = st.pending;
        const left = p.nextCheck ? Math.max(0, (p.nextCheck - Date.now()) / 1000) : 0;
        return card('Bekleyen takip', `<b class="sv-big">${p.count}</b><small class="sv-sub" data-next="${p.nextCheck || 0}">${p.count ? (p.nextCheck ? `sonraki bakış ${clock(left)}` : 'şimdi bakılıyor') : 'Takip yok'}</small>`);
    }

    function errorsHtml() {
        return `<div class="sv-sec"><span class="sec-label">Son hatalar</span>${st.errors.length
            ? `<div class="sv-list">${st.errors.map((e) => `<div class="sv-err"><span class="sv-err-ic">${icon('alert')}</span><span><b>${escapeHtml(e.title)}</b><small>${escapeHtml([e.where, when(e.at)].filter(Boolean).join(' · '))}</small></span></div>`).join('')}</div>`
            : `<div class="sv-list"><div class="sv-err ok"><span class="sv-err-ic">${icon('check')}</span><span><b>Hata yok</b><small>Son zamanlarda sorun çıkmadı</small></span></div></div>`}</div>`;
    }

    function maintHtml() {
        const keep = st.settings.keepDays;
        const del = (st.deletable || []).find((x) => x.days === keep);
        const hint = !keep ? 'Kayıtlar sen silene kadar kalır.'
            : `${keep} günden eski kayıtlar her gece silinir${del ? ` · şu an ${del.count} dosya, ${formatSize(del.bytes)}` : ''}.`;
        return `<div class="sv-sec"><span class="sec-label">Bakım</span><div class="sv-maint">
            <div class="sv-row"><span>Eski kayıtları sil</span><div class="seg seg-fit">${KEEP.map(([d, l]) => `<button class="${keep === d ? 'on' : ''}" data-v="keep" data-d="${d}">${l}</button>`).join('')}</div></div>
            <p class="sv-hint">${hint}</p>
            <button class="sv-row" data-v="boot"><span>Telefon açılınca kendiliğinden başlat<small>Termux ile çalışıyorsa</small></span><span class="toggle${bootOpen ? ' on' : ''}"></span></button>
            ${bootOpen ? `<div class="sv-boot"><small>1 · Play Store'dan "Termux:Boot" uygulamasını kur ve bir kez aç</small><small>2 · Termux'ta bu satırı çalıştır</small>
                <div class="sv-code"><code>${BOOT_CMD}</code><button data-v="copy-boot">Kopyala</button></div></div>` : ''}
        </div></div>`;
    }

    function biggestHtml() {
        if (!st.biggest.length) return '';
        return `<div class="sv-sec sv-wide"><span class="sec-label">En büyük kayıtlar</span><div class="sv-list">${st.biggest.map((b) =>
            `<div class="sv-err"><span class="sv-err-ic file">${icon('film')}</span><span><b>${escapeHtml(b.name)}</b><small>${formatSize(b.bytes)} · ${ago(b.endedAt)}</small></span></div>`).join('')}</div></div>`;
    }

    function draw() {
        if (!st) {
            el.innerHTML = `<div class="sv-wrap"><div class="wz-top"><button class="back-btn" data-v="close" aria-label="Kapat">${icon('back')}</button><span>Sunucu durumu</span></div>
                <p class="sv-hint">${escapeHtml(error || 'Yükleniyor…')}</p></div>`;
            return;
        }
        const ab = st.adblock || {};
        const abWeek = Date.now() - ab.since < 7 * 86400000;
        el.innerHTML = `<div class="sv-wrap">
            <div class="wz-top"><button class="back-btn" data-v="close" aria-label="Kapat">${icon('back')}</button><span>Sunucu durumu</span>
                <button class="btn-ghost sv-restart" data-v="restart"${restarting ? ' disabled' : ''}>${restarting ? 'Başlıyor…' : 'Yeniden başlat'}</button></div>
            <div class="sv-head${error ? ' off' : ''}"><i></i><div><b>${error ? 'Ulaşılamıyor' : 'Çalışıyor'}</b>
                <small>${escapeHtml(error || [since(st.uptime), `v${st.version}`, st.host].join(' · '))}</small></div></div>
            <div class="sv-grid">
                ${diskHtml()}
                <div class="sv-pair">${recHtml()}${pendingHtml()}</div>
                <div class="sv-pair sv-wide">${card('Bu hafta indi', `<b class="sv-big">${st.week.count}</b><small class="sv-sub">${formatSize(st.week.bytes)}</small>`)}
                    ${card('Engellenen reklam', `<b class="sv-big">${(ab.blocked || 0).toLocaleString('tr-TR')}</b><small class="sv-sub">${ab.enabled === false ? 'kapalı' : abWeek ? 'açılıştan beri' : 'bu hafta'}</small>`)}</div>
                ${biggestHtml()}
                ${errorsHtml()}
                ${maintHtml()}
            </div></div>`;
    }

    el.addEventListener('click', async (e) => {
        const b = e.target.closest('[data-v]');
        if (!b || b.disabled) return;
        const v = b.dataset.v;
        if (v === 'close') return close();
        if (v === 'boot') {
            bootOpen = !bootOpen;
            return draw();
        }
        if (v === 'copy-boot') {
            if (await copy(BOOT_CMD)) b.textContent = 'Kopyalandı ✓';
            return;
        }
        if (v === 'keep') {
            try {
                st = await renderApi('/status/settings', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ keepDays: Number(b.dataset.d) }) }, 10000);
            } catch (err) {
                toast(err.message);
            }
            return draw();
        }
        if (v === 'restart') {
            if (st && st.running.length && !confirm('Süren kayıt yarıda kalır. Yine de yeniden başlatılsın mı?')) return;
            restarting = true;
            draw();
            try {
                await renderApi('/status/restart', { method: 'POST' }, 10000);
            } catch (err) {
                restarting = false;
                toast(err.message);
                draw();
            }
        }
    });

    // Sayaçlar her saniye, veriler 5 sn'de bir tazelenir.
    tick = setInterval(() => {
        const t = el.querySelector('[data-rec-t]');
        if (t) t.textContent = clock((Date.now() - Number(t.dataset.recT)) / 1000);
        const n = el.querySelector('[data-next]');
        const at = n ? Number(n.dataset.next) : 0;
        if (at) n.textContent = at > Date.now() ? `sonraki bakış ${clock((at - Date.now()) / 1000)}` : 'şimdi bakılıyor';
    }, 1000);
    timer = setInterval(load, 5000);
    draw();
    load();
    return { close };
}
