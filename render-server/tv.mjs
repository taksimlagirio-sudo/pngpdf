// TV'de oynat: sunucu, TV'nin (ya da başka bir bilgisayarın) tarayıcısında açılacak bir oynatıcı sayfası
// verir. Sayfa adresi oturuma özel gizli bir anahtar içerir (token gerekmez, yalnızca o dosyayı oynatır).
// Telefon "kumanda" olur: komutlar sunucuya gider, TV sayfası onları alıp uygular ve durumunu bildirir.
import { randomBytes } from 'node:crypto';

const TTL = 6 * 60 * 60 * 1000;
const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);

export function createTv() {
    const sessions = new Map();
    setInterval(() => {
        for (const [id, s] of sessions) if (Date.now() - s.createdAt > TTL) sessions.delete(id);
    }, 10 * 60 * 1000).unref();

    return {
        create({ source, title = '', subtitles = '' }) {
            const id = randomBytes(6).toString('hex');
            const secret = randomBytes(12).toString('base64url');
            const s = { id, secret, source, title: String(title).slice(0, 200), subtitles, createdAt: Date.now(), cmds: [], seq: 0, state: null, stateAt: 0, waiters: [] };
            sessions.set(id, s);
            return s;
        },
        get(id) {
            return sessions.get(id) || null;
        },
        check(id, secret) {
            const s = sessions.get(id);
            return s && s.secret === secret ? s : null;
        },
        command(id, action, value) {
            const s = sessions.get(id);
            if (!s) return null;
            s.cmds.push({ n: ++s.seq, action: String(action).slice(0, 20), value: Number.isFinite(Number(value)) ? Number(value) : null });
            s.cmds = s.cmds.slice(-30);
            s.waiters.splice(0).forEach((w) => w());
            return s;
        },
        /** TV sayfası yeni komutları bekler (en çok 20 sn). */
        async poll(s, after) {
            const pending = () => s.cmds.filter((c) => c.n > after);
            if (!pending().length) {
                await new Promise((resolve) => {
                    const t = setTimeout(resolve, 20000);
                    s.waiters.push(() => { clearTimeout(t); resolve(); });
                });
            }
            return pending();
        },
        report(s, state) {
            s.state = {
                t: Number(state.t) || 0, d: Number(state.d) || 0, paused: Boolean(state.paused),
                volume: Math.max(0, Math.min(1, Number(state.volume) || 0)), ended: Boolean(state.ended), error: String(state.error || '').slice(0, 200)
            };
            s.stateAt = Date.now();
        },
        publicState(s) {
            return { id: s.id, title: s.title, connected: Date.now() - s.stateAt < 6000, state: s.state };
        },
        remove(id) {
            sessions.delete(id);
        },
        /** TV'de açılan oynatıcı sayfası. */
        page(s) {
            const base = `/tv/${s.id}/${s.secret}`;
            return `<!doctype html><html lang="tr"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>${esc(s.title || 'İndirici')}</title>
<style>html,body{margin:0;height:100%;background:#000;color:#F2EFE9;font-family:system-ui,sans-serif;overflow:hidden}
video{width:100%;height:100%;object-fit:contain;background:#000}
#start{position:fixed;inset:0;display:flex;flex-direction:column;align-items:center;justify-content:center;gap:18px;background:#121110;cursor:pointer}
#start b{font-size:28px}#start span{color:#A29D93}#start button{font:600 22px/1 inherit;padding:18px 34px;border-radius:16px;border:0;background:#D4F04A;color:#15140F}
video::cue{font-size:5vh;background:rgba(0,0,0,.6)}</style></head><body>
<video id="v" playsinline src="${base}/file"></video>
<div id="start"><b>${esc(s.title || 'İndirici')}</b><span>Kumanda telefonunda. Başlamak için bir kez dokun ya da Tamam'a bas.</span><button autofocus>Oynat</button></div>
<script>
var v=document.getElementById('v'),st=document.getElementById('start'),after=0;
function go(){st.style.display='none';v.play().catch(function(){});if(v.requestFullscreen)v.requestFullscreen().catch(function(){});}
st.onclick=go;document.onkeydown=function(e){if(st.style.display!=='none'&&(e.key==='Enter'||e.key===' '))go();};
v.play().then(function(){st.style.display='none';}).catch(function(){});
function report(){fetch('${base}/state',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({t:v.currentTime,d:v.duration||0,paused:v.paused,volume:v.volume,ended:v.ended,error:v.error?String(v.error.message||v.error.code):''})}).catch(function(){});}
setInterval(report,1000);
function apply(c){if(c.action==='play'){st.style.display='none';v.play().catch(function(){});}
else if(c.action==='pause')v.pause();
else if(c.action==='seek')v.currentTime=Math.max(0,v.currentTime+c.value);
else if(c.action==='to')v.currentTime=c.value;
else if(c.action==='volume')v.volume=Math.max(0,Math.min(1,c.value));
else if(c.action==='subs'){for(var i=0;i<v.textTracks.length;i++)v.textTracks[i].mode=c.value>0?'showing':'disabled';}
else if(c.action==='close'){v.pause();document.body.innerHTML='<p style="padding:40px;font-size:24px">Bağlantı kesildi.</p>';}
report();}
function poll(){fetch('${base}/poll?after='+after).then(function(r){return r.json();}).then(function(list){list.forEach(function(c){after=Math.max(after,c.n);apply(c);});poll();}).catch(function(){setTimeout(poll,2000);});}
poll();
</script></body></html>`;
        }
    };
}
