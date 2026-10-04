// Bilgisayardan gönder: tarayıcının yer imleri çubuğuna sürüklenen "İndirici'ye gönder" düğmesi
// (bookmarklet), açık sayfanın adresini sunucuya bırakır; telefondaki ve masaüstündeki uygulama
// bunu alıp algılamayı başlatır. Düğme yalnızca bağlantı bırakabilen ayrı bir anahtar taşır
// (sunucu token'ı yer imine yazılmaz).
import fs from 'node:fs';
import { randomBytes } from 'node:crypto';

const MAX = 30;
const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);

export function createInbox({ file, push = null }) {
    let data = { key: '', items: [] };
    try {
        data = { ...data, ...JSON.parse(fs.readFileSync(file, 'utf8')) };
    } catch (_) { /* ilk açılış */ }
    if (!/^[A-Za-z0-9_-]{16,}$/.test(data.key || '')) data.key = randomBytes(12).toString('base64url');
    const save = () => {
        try {
            fs.writeFileSync(file, JSON.stringify(data), { mode: 0o600 });
        } catch (_) { /* disk */ }
    };
    save();

    return {
        get key() {
            return data.key;
        },
        checkKey: (k) => typeof k === 'string' && k === data.key,
        add({ url, title = '' }) {
            if (!/^https?:\/\//i.test(url || '')) throw new Error('Geçersiz adres');
            const item = { id: randomBytes(6).toString('hex'), at: Date.now(), url: String(url).slice(0, 4000), title: String(title).slice(0, 200) };
            data.items = [item, ...data.items.filter((i) => i.url !== item.url)].slice(0, MAX);
            save();
            if (push) {
                push.send({ title: 'Bilgisayardan bağlantı geldi', body: item.title || item.url, tag: 'inbox', url: `?url=${encodeURIComponent(item.url)}#detect`, kind: 'inbox' })
                    .catch(() => {});
            }
            return item;
        },
        list(after = 0) {
            return data.items.filter((i) => i.at > after);
        },
        /** Bilgisayarda açılan yer imi sayfası. base: bilgisayarın sunucuya ulaştığı adres. */
        page(base) {
            const send = `${base}/gonder?k=${data.key}`;
            const js = `javascript:(function(){window.open('${send}&u='+encodeURIComponent(location.href)+'&t='+encodeURIComponent(document.title),'indirici','width=440,height=260');})()`;
            return `<!doctype html><html lang="tr"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>İndirici'ye gönder</title>
<style>body{margin:0;background:#121110;color:#F2EFE9;font:16px/1.5 system-ui,sans-serif;display:flex;justify-content:center}
main{max-width:620px;padding:48px 24px;display:flex;flex-direction:column;gap:22px}h1{margin:0;font-size:28px;letter-spacing:-.02em}
p{margin:0;color:#A29D93}.bm{align-self:flex-start;display:inline-flex;align-items:center;gap:10px;padding:14px 22px;border-radius:14px;background:#D4F04A;color:#15140F;font-weight:700;text-decoration:none;cursor:grab;font-size:17px}
ol{margin:0;padding:0;list-style:none;display:flex;flex-direction:column;gap:12px}li{display:flex;gap:14px;align-items:flex-start;padding:14px;border:1px solid #2E2C28;border-radius:14px;background:#1A1917}
li b{flex:none;width:28px;height:28px;border-radius:14px;background:#23221F;display:flex;align-items:center;justify-content:center;font-size:14px}
kbd{font:600 13px/1 ui-monospace,monospace;padding:3px 7px;border-radius:6px;border:1px solid #2E2C28;background:#23221F}
form{display:flex;gap:8px}input{flex:1;min-width:0;padding:12px 14px;border-radius:12px;border:1px solid #2E2C28;background:#1A1917;color:inherit;font:inherit}
button{padding:0 18px;border-radius:12px;border:0;background:#23221F;color:inherit;font:600 15px/1 inherit;cursor:pointer}#ok{color:#D4F04A;min-height:24px}</style></head><body><main>
<h1>İndirici'ye gönder</h1>
<p>Bilgisayarda bir video sayfasındayken tek tıkla telefondaki ve masaüstündeki İndirici'ye gönder.</p>
<a class="bm" href="${esc(js)}" onclick="event.preventDefault();alert('Bu düğmeyi yer imleri çubuğuna sürükle.')">⇩ İndirici'ye gönder</a>
<ol><li><b>1</b><span>Yer imleri çubuğunu aç<br><small style="color:#A29D93">Chrome / Edge / Firefox'ta <kbd>Ctrl</kbd> <kbd>Shift</kbd> <kbd>B</kbd></small></span></li>
<li><b>2</b><span>Yukarıdaki sarı düğmeyi çubuğa sürükle</span></li>
<li><b>3</b><span>Video sayfasında düğmeye tıkla<br><small style="color:#A29D93">Bağlantı İndirici'de açılır, algılama başlar</small></span></li></ol>
<p>Ya da bağlantıyı buraya yapıştır:</p>
<form id="f"><input id="u" type="url" placeholder="https://…" required><button>Gönder</button></form><p id="ok"></p>
<script>document.getElementById('f').onsubmit=function(e){e.preventDefault();var u=document.getElementById('u');
fetch('${send}&json=1&u='+encodeURIComponent(u.value)).then(function(r){return r.json();}).then(function(j){document.getElementById('ok').textContent=j.error||'Gönderildi ✓';if(!j.error)u.value='';});};</script>
</main></body></html>`;
        },
        /** Düğmeye tıklayınca açılan küçük pencere. */
        sentPage(item, error = '') {
            return `<!doctype html><html lang="tr"><head><meta charset="utf-8"><title>İndirici</title>
<style>body{margin:0;height:100vh;display:flex;flex-direction:column;align-items:center;justify-content:center;gap:8px;background:#121110;color:#F2EFE9;font:16px/1.4 system-ui,sans-serif;text-align:center;padding:0 20px;box-sizing:border-box}
b{font-size:20px;color:${error ? '#F2555A' : '#D4F04A'}}span{color:#A29D93;font-size:14px;max-width:380px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}</style></head><body>
<b>${error ? 'Gönderilemedi' : "İndirici'ye gönderildi ✓"}</b><span>${esc(error || item.title || item.url)}</span>
${error ? '' : '<script>setTimeout(function(){window.close();},1600);</script>'}</body></html>`;
        }
    };
}
