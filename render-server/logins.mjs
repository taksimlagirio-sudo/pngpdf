// Sunucudaki tarayıcının giriş bilgileri (çerezler + localStorage) burada saklanır: kullanıcı
// "Kendim dokunayım" ekranında bir siteye bir kez giriş yaptığında sonraki açılışlarda, otomatik
// koklamada ve "açıp kaydet"te de oturum açık kalır. Dosya yalnızca bu sunucuda durur.
import fs from 'node:fs';
import path from 'node:path';

export function createLoginStore(file, { enabled = true } = {}) {
    let state = { cookies: [], origins: [] };
    try {
        const raw = JSON.parse(fs.readFileSync(file, 'utf8'));
        if (Array.isArray(raw.cookies)) state.cookies = raw.cookies;
        if (Array.isArray(raw.origins)) state.origins = raw.origins;
    } catch (_) { /* henüz yok ya da bozuk */ }

    const cookieKey = (c) => `${c.name}|${c.domain}|${c.path}`;
    const live = (c) => !(c.expires > 0 && c.expires * 1000 < Date.now());
    let timer = null;
    // Çıkış yapılınca artar: o anda açık olan sayfalar kapanırken girişi geri yazmasın.
    let generation = 0;
    const contextGen = new WeakMap();

    function write() {
        clearTimeout(timer);
        timer = setTimeout(() => {
            try {
                fs.mkdirSync(path.dirname(file), { recursive: true });
                fs.writeFileSync(file + '.tmp', JSON.stringify(state), { mode: 0o600 });
                fs.renameSync(file + '.tmp', file);
            } catch (err) {
                console.warn('Girişler kaydedilemedi:', err.message);
            }
        }, 300);
        timer.unref?.();
    }

    return {
        get enabled() { return enabled; },

        /** newContext({ storageState }) için; kayıtlı bir şey yoksa undefined. */
        storageState() {
            if (!enabled) return undefined;
            const cookies = state.cookies.filter(live);
            if (!cookies.length && !state.origins.length) return undefined;
            return { cookies, origins: state.origins };
        },

        /** Bağlamı izlemeye alır (oluşturulduktan hemen sonra çağrılır). */
        attach(context) {
            contextGen.set(context, generation);
            return context;
        },

        /** Bağlamın güncel çerezlerini/localStorage'ını kayıtlılarla birleştirir. */
        async save(context) {
            if (!enabled || !context || contextGen.get(context) !== generation) return;
            let snap;
            try {
                snap = await context.storageState();
            } catch (_) {
                return; // bağlam kapanmış
            }
            const cookies = new Map(state.cookies.filter(live).map((c) => [cookieKey(c), c]));
            for (const c of snap.cookies || []) {
                // Oturum çerezleri (expires -1) de saklanır: giriş çoğu sitede bunlarla tutulur.
                if (live(c)) cookies.set(cookieKey(c), c);
                else cookies.delete(cookieKey(c));
            }
            const origins = new Map(state.origins.map((o) => [o.origin, o]));
            for (const o of snap.origins || []) {
                if (o.localStorage?.length) origins.set(o.origin, o);
            }
            const next = { cookies: [...cookies.values()], origins: [...origins.values()] };
            if (JSON.stringify(next) === JSON.stringify(state)) return;
            state = next;
            write();
        },

        /** Kayıtlı siteler (çerez alan adına göre gruplanmış). */
        sites() {
            const map = new Map();
            const site = (domain) => domain.replace(/^\./, '').replace(/^www\./, '');
            for (const c of state.cookies.filter(live)) {
                const name = site(c.domain);
                map.set(name, (map.get(name) || 0) + 1);
            }
            for (const o of state.origins) {
                try {
                    const name = site(new URL(o.origin).hostname);
                    if (!map.has(name)) map.set(name, 0);
                } catch (_) { /* geçersiz köken */ }
            }
            return [...map].map(([domain, cookies]) => ({ domain, cookies })).sort((a, b) => a.domain.localeCompare(b.domain));
        },

        /** Bir sitenin (alt alan adlarıyla) ya da hepsinin girişini siler. */
        clear(domain = '') {
            generation++;
            if (!domain) {
                state = { cookies: [], origins: [] };
            } else {
                const match = (host) => {
                    const h = host.replace(/^\./, '');
                    return h === domain || h.endsWith('.' + domain);
                };
                state = {
                    cookies: state.cookies.filter((c) => !match(c.domain)),
                    origins: state.origins.filter((o) => {
                        try { return !match(new URL(o.origin).hostname); } catch (_) { return false; }
                    })
                };
            }
            write();
        }
    };
}
