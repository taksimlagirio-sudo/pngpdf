// Sunucudaki tarayıcının giriş bilgileri (çerezler + localStorage) burada saklanır: kullanıcı
// "Kendim dokunayım" ekranında bir siteye bir kez giriş yaptığında sonraki açılışlarda, otomatik
// koklamada ve "açıp kaydet"te de oturum açık kalır. Dosya yalnızca bu sunucuda durur.
import fs from 'node:fs';
import path from 'node:path';

/** Çerezin alan adı bu siteye (ya da alt alan adına) mı ait? */
export function sameSite(cookieDomain, domain) {
    const h = String(cookieDomain || '').replace(/^\./, '');
    return h === domain || h.endsWith('.' + domain) || domain.endsWith('.' + h);
}

/** Bilinen siteler: giriş sayfası ve girişi taşıyan çerezler. */
export const KNOWN_SITES = [
    { domain: 'instagram.com', name: 'Instagram', login: 'https://www.instagram.com/accounts/login/', auth: ['sessionid'] },
    { domain: 'x.com', name: 'X (Twitter)', login: 'https://x.com/i/flow/login', auth: ['auth_token'], alias: ['twitter.com'] },
    { domain: 'tiktok.com', name: 'TikTok', login: 'https://www.tiktok.com/login', auth: ['sessionid', 'sessionid_ss'] },
    { domain: 'youtube.com', name: 'YouTube', login: 'https://accounts.google.com/ServiceLogin?service=youtube&continue=https%3A%2F%2Fwww.youtube.com%2F', auth: ['LOGIN_INFO', 'SAPISID', '__Secure-3PSID'] },
    { domain: 'facebook.com', name: 'Facebook', login: 'https://m.facebook.com/login/', auth: ['c_user'] },
    { domain: 'twitch.tv', name: 'Twitch', login: 'https://www.twitch.tv/login', auth: ['auth-token'] },
    { domain: 'reddit.com', name: 'Reddit', login: 'https://www.reddit.com/login/', auth: ['reddit_session'] },
    { domain: 'kick.com', name: 'Kick', login: 'https://kick.com/', auth: [] },
    { domain: 'vimeo.com', name: 'Vimeo', login: 'https://vimeo.com/log_in', auth: [] }
];

export function knownSite(domain) {
    return KNOWN_SITES.find((k) => k.domain === domain || (k.alias || []).includes(domain)) || null;
}

/** Girişe benzeyen çerez adı (oturum, kimlik, anahtar); izleme çerezleri sayılmaz. */
export function authLike(name) {
    if (/^(_ga|_gid|_gat|_fbp|_fbc|__utm|_hj|_cl|_uet|_pin|_tt_|ttwid|__cf|cf_|_dd_s|AMP_|OptanonConsent|euconsent|consent)/i.test(name)) return false;
    return /(sess|session|sid$|^sid|auth|token|login|logged|remember|jwt|user_?id|^uid|^c_user)/i.test(name);
}

function accountStatus(a, cookies) {
    if (!a.loginAt) return 'never';
    if (a.lostAt > a.loginAt) return 'lost';
    const known = knownSite(a.domain);
    const names = known && known.auth.length ? known.auth : a.auth || [];
    if (!names.length) return cookies.length ? 'on' : 'lost';
    return cookies.some((c) => names.includes(c.name)) ? 'on' : 'lost';
}

export function createLoginStore(file, { enabled = true } = {}) {
    let state = { cookies: [], origins: [], accounts: [] };
    try {
        const raw = JSON.parse(fs.readFileSync(file, 'utf8'));
        if (Array.isArray(raw.cookies)) state.cookies = raw.cookies;
        if (Array.isArray(raw.origins)) state.origins = raw.origins;
        if (Array.isArray(raw.accounts)) state.accounts = raw.accounts;
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
            const next = { cookies: [...cookies.values()], origins: [...origins.values()], accounts: state.accounts };
            if (JSON.stringify(next) === JSON.stringify(state)) return;
            state = next;
            write();
        },

        /** Bir sitenin şu an kayıtlı (süresi dolmamış) çerezleri. */
        cookiesFor(domain) {
            return state.cookies.filter(live).filter((c) => sameSite(c.domain, domain));
        },

        /** Hesaplar: kullanıcının giriş yaptığı (ya da girmek için eklediği) siteler, durumlarıyla. */
        accounts() {
            return state.accounts.map((a) => ({ ...a, status: accountStatus(a, this.cookiesFor(a.domain)) }));
        },

        account(domain) {
            return state.accounts.find((a) => a.domain === domain) || null;
        },

        /** Hesap ekler (girişi beklenir); varsa olduğu gibi döner. */
        addAccount(domain, name) {
            let a = this.account(domain);
            if (!a) {
                a = { domain, name: name || domain, addedAt: Date.now(), loginAt: 0, lostAt: 0, auth: [] };
                state.accounts.push(a);
                write();
            }
            return a;
        },

        /** Giriş algılandı: girişi taşıyan çerezlerin adları saklanır (durum bunlarla anlaşılır). */
        markLoggedIn(domain, authNames = [], name = '') {
            const a = this.addAccount(domain, name);
            a.loginAt = Date.now();
            a.lostAt = 0;
            if (authNames.length) a.auth = [...new Set(authNames)].slice(0, 12);
            write();
        },

        /** Site giriş sayfası gösterdi: kayıtlı giriş artık geçmiyor. */
        markLost(domain) {
            const a = this.account(domain);
            if (!a || !a.loginAt || a.lostAt > a.loginAt) return;
            a.lostAt = Date.now();
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
                state = { cookies: [], origins: [], accounts: [] };
            } else {
                const match = (host) => {
                    const h = host.replace(/^\./, '');
                    return h === domain || h.endsWith('.' + domain);
                };
                state = {
                    accounts: state.accounts.filter((a) => a.domain !== domain),
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
