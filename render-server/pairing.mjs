// QR ile bağlanma: sunucunun çalıştığı cihazda açılan "/baglan" sayfası adresleri, token'ı ve
// 10 dakika geçerli bir eşleştirme kodu içeren QR'ı gösterir. Telefon QR'ı okuyunca kodu
// "/pair"e verir ve token'ı alır; token QR'a hiç yazılmaz.
import os from 'node:os';
import { spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import qrcode from './vendor/qrcode.mjs';

const CODE_TTL_MS = 10 * 60 * 1000;
const codes = new Map(); // kod -> bitiş zamanı
let failures = [];

/** Yeni (ya da hâlâ geçerli olan) eşleştirme kodu. */
export function currentCode() {
    const now = Date.now();
    for (const [code, until] of codes) {
        if (until <= now) codes.delete(code);
        else if (until - now > 60 * 1000) return { code, until };
    }
    const code = randomBytes(6).toString('base64url').replace(/[-_]/g, 'x').slice(0, 8).toUpperCase();
    const until = now + CODE_TTL_MS;
    codes.set(code, until);
    return { code, until };
}

/** Kod geçerliyse true (tek kullanımlık). Çok sayıda yanlış denemede bir süre hep false. */
export function redeemCode(code) {
    const now = Date.now();
    failures = failures.filter((t) => now - t < 60 * 1000);
    if (failures.length >= 10) return false;
    const key = String(code || '').trim().toUpperCase();
    const until = codes.get(key);
    if (!until || until <= now) {
        failures.push(now);
        return false;
    }
    codes.delete(key);
    return true;
}

/** Bu ağdaki IPv4 adresleri (Tailscale'in 100.64/10 adresleri ayrı). */
export function networkAddresses() {
    const lan = [];
    const tailnet = [];
    for (const list of Object.values(os.networkInterfaces())) {
        for (const a of list || []) {
            if (a.family !== 'IPv4' || a.internal) continue;
            const [x, y] = a.address.split('.').map(Number);
            if (x === 100 && y >= 64 && y < 128) tailnet.push(a.address);
            else lan.push(a.address);
        }
    }
    return { lan, tailnet };
}

let tsCache = null;
/** Tailscale kuruluysa bu cihazın ts.net adı (yoksa ''). */
export function tailscaleName() {
    if (tsCache && Date.now() - tsCache.at < 60 * 1000) return Promise.resolve(tsCache.name);
    return new Promise((resolve) => {
        let out = '';
        let child;
        try {
            child = spawn('tailscale', ['status', '--json'], { stdio: ['ignore', 'pipe', 'ignore'] });
        } catch (_) {
            return resolve('');
        }
        const timer = setTimeout(() => child.kill(), 2000);
        child.stdout.on('data', (d) => { out += d; });
        child.on('error', () => resolve(''));
        child.on('close', () => {
            clearTimeout(timer);
            let name = '';
            try {
                name = (JSON.parse(out).Self.DNSName || '').replace(/\.$/, '');
            } catch (_) { /* tailscale yok ya da kapalı */ }
            tsCache = { name, at: Date.now() };
            resolve(name);
        });
    });
}

function qrSvg(text) {
    const qr = qrcode(0, 'M');
    qr.addData(text);
    qr.make();
    return qr.createSvgTag({ cellSize: 6, margin: 2, scalable: true });
}

const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);

/** "/baglan" sayfası. */
export async function pairPage({ host, port, token, version, stats }) {
    const { lan, tailnet } = networkAddresses();
    const listening = host === '0.0.0.0' || host === '::';
    const ts = listening && !process.env.PUBLIC_URL ? await tailscaleName() : '';
    const { code, until } = currentCode();
    const targets = [];
    if (listening && lan[0]) targets.push(['Bu ağda', `http://${lan[0]}:${port}`]);
    // PUBLIC_URL: sunucuya https ile ulaşılan adres (ör. tailscale serve → https://ad.tailnet.ts.net).
    const publicUrl = (process.env.PUBLIC_URL || '').replace(/\/+$/, '');
    if (publicUrl) targets.push(['Uzaktan', publicUrl, /\.ts\.net$/i.test(publicUrl) ? 'Tailscale' : 'https']);
    else if (listening && (ts || tailnet[0])) targets.push(['Uzaktan', `http://${ts || tailnet[0]}:${port}`, 'Tailscale']);
    const qrs = targets.map(([, url]) => qrSvg(`${url}/?pair=${code}`));
    const mins = Math.round((until - Date.now()) / 60000);

    const rows = targets.map(([label, url, tag]) => `
        <div class="row"><span class="k">${label}</span><span class="v">${esc(url)}</span>${tag ? `<span class="tag">${tag}</span>` : ''}</div>`).join('');
    const tabs = targets.length > 1 ? `<div class="tabs">${targets.map(([label], i) =>
        `<button class="${i ? '' : 'on'}" data-i="${i}">${label}</button>`).join('')}</div>` : '';

    return `<!doctype html><html lang="tr"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1"><title>İndirici sunucusu</title>
<style>
:root{--bg:#121110;--sf:#1A1917;--sf2:#23221F;--ln:#2E2C28;--tx:#F2EFE9;--mt:#A29D93;--ac:#D4F04A;--mono:'JetBrains Mono',ui-monospace,Menlo,monospace}
*{box-sizing:border-box}body{margin:0;background:var(--bg);color:var(--tx);font:15px/1.45 system-ui,-apple-system,'Segoe UI',sans-serif}
main{max-width:1000px;margin:0 auto;padding:40px 20px;display:grid;grid-template-columns:minmax(0,1fr) 340px;gap:40px;align-items:start}
@media (max-width:760px){main{grid-template-columns:1fr}}
.brand{display:flex;align-items:center;gap:10px;font-weight:600}.brand img{width:32px;height:32px;border-radius:8px}
.ok{font:500 12px/1 var(--mono);color:var(--ac);background:rgba(212,240,74,.12);padding:5px 8px;border-radius:6px}
h1{font-size:30px;letter-spacing:-.02em;margin:28px 0 8px}p{color:var(--mt);margin:0 0 24px}
.box{border:1px solid var(--ln);border-radius:16px;background:var(--sf);overflow:hidden}
.row{display:flex;align-items:center;gap:10px;min-height:48px;padding:6px 14px;border-bottom:1px solid var(--ln)}.row:last-child{border:0}
.k{width:90px;font-size:13px;color:var(--mt);flex:none}.v{flex:1;min-width:0;font:13px/1.3 var(--mono);overflow-wrap:anywhere}
.tag{font:600 10.5px/1 var(--mono);padding:4px 6px;border-radius:5px;background:var(--sf2);color:var(--mt)}
button{font:inherit;color:var(--tx);background:var(--sf2);border:1px solid var(--ln);border-radius:10px;padding:6px 12px;cursor:pointer}
.stats{display:flex;gap:18px;flex-wrap:wrap;margin-top:16px;font-size:13px;color:var(--mt)}
.qr{background:#fff;border-radius:20px;padding:18px}.qr svg{display:block;width:100%;height:auto}
.qr-link{display:block;margin-top:12px;font-size:12px;color:var(--mt);text-align:center}.qr-link b{font:500 12px/1.4 var(--mono);color:var(--tx);overflow-wrap:anywhere}
.qr-note{display:block;text-align:center;font-size:12.5px;color:var(--mt);margin-top:12px}
.tabs{display:flex;gap:6px;margin-bottom:12px}.tabs button.on{background:var(--ac);color:#15140F;border-color:var(--ac)}
.warn{border:1px solid #E5B04B;color:#E5B04B;border-radius:14px;padding:14px;font-size:13.5px}
code{font-family:var(--mono);background:var(--sf2);padding:2px 6px;border-radius:5px;color:var(--tx)}
</style></head><body><main>
<section>
  <div class="brand"><img src="/assets/icons/icon-192.png" alt=""><span>İndirici sunucusu</span><span class="ok">Çalışıyor · v${esc(version)}</span></div>
  <h1>Telefonunla okut, bağlansın</h1>
  <p>İndirici'de Ayarlar → Kendi sunucum → QR ile bağlan. Ya da telefonun kamerasıyla okut; adres ve token kendiliğinden girilir.</p>
  <div class="box">${rows}
    <div class="row"><span class="k">Token</span><span class="v" id="tok" data-t="${esc(token)}">••••••••••••</span><button id="show">Göster</button></div>
  </div>
  <div class="stats">${stats.map(esc).map((s) => `<span>${s}</span>`).join('')}</div>
</section>
<aside>
  ${targets.length ? `${tabs}${qrs.map((svg, i) => `<div data-q="${i}"${i ? ' hidden' : ''}><div class="qr">${svg}</div>
    <span class="qr-link">Kamera yoksa bu adresi uygulamadaki "elle" kutusuna yaz:<br><b>${esc(targets[i][1])}/?pair=${code}</b></span></div>`).join('')}
  <span class="qr-note">Bu QR yalnızca bu ağda geçerli · ${mins} dk · tek kullanımlık</span>`
    : `<div class="warn">Sunucu yalnızca bu cihazdan erişilebilir (HOST=${esc(host)}). Başka cihazdan bağlanmak için
       <code>HOST=0.0.0.0 npm start</code> ile yeniden başlat; sonra bu sayfayı yenile.</div>`}
</aside>
</main>
<script>
document.getElementById('show').onclick = function () {
  var t = document.getElementById('tok'); var on = this.textContent === 'Göster';
  t.textContent = on ? t.dataset.t : '••••••••••••'; this.textContent = on ? 'Gizle' : 'Göster';
};
document.querySelectorAll('.tabs button').forEach(function (b) {
  b.onclick = function () {
    document.querySelectorAll('.tabs button').forEach(function (x) { x.classList.toggle('on', x === b); });
    document.querySelectorAll('[data-q]').forEach(function (q) { q.hidden = q.dataset.q !== b.dataset.i; });
  };
});
setTimeout(function () { location.reload(); }, ${Math.max(60, mins * 60 - 30)} * 1000);
</script></body></html>`;
}
