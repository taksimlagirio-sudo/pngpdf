// Sunucudaki tarayıcı için reklam engelleme + istek yönlendirme.
//
// Reklamlar videoları karıştırıyor: oynatıcı önce reklamı oynatıyor, sayfa taramasında reklam
// videoları listeye düşüyor, kayıtta yanlış video yakalanabiliyor. Burada her istek tek bir
// yönlendiriciden geçer:
//   1) reklam/izleme adresleri engellenir — @ghostery/adblocker kuruluysa EasyList tabanlı hazır
//      listelerle (video reklam SDK'ları dahil), değilse yerleşik alan adı listesiyle;
//   2) "video aç ve kaydet" oynatıcı sayfasında, başka kökenden gelen yayın istekleri sunucu
//      tarafında alınıp CORS izniyle sayfaya verilir (sitenin kendi oynatıcısı gibi oynasın diye).

import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// Hazır listeler bir kez indirilip derlenmiş halde diske yazılır: sunucu her açılışta GitHub'dan
// indirmek zorunda kalmaz, internet o an yoksa da engelleyici çalışır. 3 günde bir tazelenir.
const ENGINE_CACHE = process.env.ADBLOCK_CACHE || path.join(path.dirname(fileURLToPath(import.meta.url)), '.adblock-engine.bin');
const ENGINE_MAX_AGE_MS = 3 * 24 * 60 * 60 * 1000;
// Bölgesel liste: Türk sitelerindeki yerli reklam ağları (hosts biçimi; kurala çevrilir).
const EXTRA_HOST_LISTS = ['https://raw.githubusercontent.com/bkrucarci/turk-adlist/master/hosts'];

// Yerleşik liste: en yaygın reklam ağları ve video reklam (VAST/IMA) sunucuları.
const AD_HOSTS = [
    'doubleclick.net', 'googlesyndication.com', 'googleadservices.com', 'adservice.google.com',
    'imasdk.googleapis.com', 'pubads.g.doubleclick.net', 'google-analytics.com', 'googletagmanager.com',
    'googletagservices.com', 'amazon-adsystem.com', 'adnxs.com', 'adsrvr.org', 'criteo.com', 'criteo.net',
    'taboola.com', 'outbrain.com', 'pubmatic.com', 'rubiconproject.com', 'openx.net', 'casalemedia.com',
    'smartadserver.com', 'teads.tv', 'spotxchange.com', 'spotx.tv', 'springserve.com', 'adform.net',
    'yieldmo.com', 'sharethrough.com', 'media.net', 'moatads.com', 'scorecardresearch.com',
    'popads.net', 'popcash.net', 'propellerads.com', 'adsterra.com', 'exoclick.com', 'exosrv.com',
    'juicyads.com', 'trafficjunky.net', 'hilltopads.net', 'adcash.com', 'admaven.com', 'onclickads.net',
    'clickadu.com', 'a-ads.com', 'mgid.com', 'revcontent.com', 'zedo.com', 'yandexadexchange.net',
    'an.yandex.ru', 'mc.yandex.ru', 'adfox.ru', 'betweendigital.com', 'admatic.com.tr', 'adtelligent.com',
    'vidoomy.com', 'aniview.com', 'connatix.com', 'jwpltx.com', 'ads.jwpsrv.com', 'innovid.com',
    'serving-sys.com', 'flashtalking.com', 'adition.com', 'ad.gt', 'hotjar.com', 'facebook.net'
];

const hostOf = (url) => {
    try {
        return new URL(url).hostname.toLowerCase();
    } catch (_) {
        return '';
    }
};

/** Yerleşik listeye göre reklam adresi mi? */
export function isAdHost(url) {
    const host = hostOf(url);
    return Boolean(host) && AD_HOSTS.some((d) => host === d || host.endsWith('.' + d));
}

let engineKind = process.env.ADBLOCK === '0' ? 'off' : 'loading';
let enginePromise = null;
let rawEngine = null; // kozmetik (sayfadaki reklam alanlarını gizleme) kuralları için

/** Uygulamada gösterilecek durum: kapalı / hazır listeler / yerleşik liste. */
// Sunucu açıldığından beri sayaçlar (Ayarlar'da gösterilir).
const stats = { blocked: 0, videoAds: 0, since: Date.now() };
const VIDEO_AD = /\.(mp4|webm|m3u8|mpd)(\?|$)|vast|vmap|ima3|imasdk|preroll|videoad/i;

export function adblockStatus() {
    return { enabled: engineKind !== 'off', engine: engineKind, builtinHosts: AD_HOSTS.length,
        blocked: stats.blocked, videoAds: stats.videoAds, since: stats.since };
}

/** Sayfadan ayıklanan (reklam olduğu anlaşılan) video sayılır. */
export function countVideoAd(n = 1) {
    stats.videoAds += n;
}
/** Ghostery motoru (kuruluysa); listeler sunucu açılışında bir kez indirilir. */
function getEngine() {
    if (process.env.ADBLOCK === '0') return Promise.resolve(null);
    if (!enginePromise) {
        enginePromise = (async () => {
            try {
                const lib = await import('@ghostery/adblocker');
                const { Request } = lib;
                const engine = await loadEngine(lib);
                rawEngine = engine;
                engineKind = 'lists';
                console.log('Reklam engelleyici hazır (EasyList, uBlock Origin ve Türk reklam listeleri).');
                return (url, sourceUrl, type) => engine.match(Request.fromRawDetails({ url, sourceUrl, type })).match;
            } catch (err) {
                engineKind = 'builtin';
                console.log(`Reklam engelleyici: hazır listeler yüklenemedi (${err.code || err.message}); yerleşik liste kullanılıyor.`);
                return null;
            }
        })();
    }
    return enginePromise;
}

/** hosts dosyasını ("0.0.0.0 alan.adi") ağ kuralına ("||alan.adi^") çevirir. */
function hostsToFilters(text) {
    const out = [];
    for (const line of String(text).split(/\r?\n/)) {
        const m = /^\s*(?:0\.0\.0\.0|127\.0\.0\.1|::1?)\s+([a-z0-9.-]+\.[a-z]{2,})\s*(?:#.*)?$/i.exec(line);
        if (m && m[1] !== 'localhost') out.push(`||${m[1].toLowerCase()}^`);
    }
    return out.join('\n');
}

async function buildEngine({ FiltersEngine, adsAndTrackingLists, fetchLists, fetchResources }) {
    const [lists, resources, extra] = await Promise.all([
        fetchLists(fetch, adsAndTrackingLists),
        fetchResources(fetch),
        Promise.all(EXTRA_HOST_LISTS.map((url) => fetch(url).then((r) => (r.ok ? r.text() : '')).catch(() => '')))
    ]);
    const engine = FiltersEngine.parse([...lists, ...extra.map(hostsToFilters)].join('\n'));
    if (resources) engine.updateResources(resources, String(resources.length));
    return engine;
}

/** Diskteki derlenmiş motor tazeyse onu kullanır; değilse listeleri indirir. İndirilemezse eskisi de olur. */
async function loadEngine(lib) {
    let cached = null;
    try {
        const [stat, buffer] = await Promise.all([fs.stat(ENGINE_CACHE), fs.readFile(ENGINE_CACHE)]);
        cached = { engine: lib.FiltersEngine.deserialize(new Uint8Array(buffer)), fresh: Date.now() - stat.mtimeMs < ENGINE_MAX_AGE_MS };
    } catch (_) { /* önbellek yok ya da eski sürüm */ }
    if (cached && cached.fresh) return cached.engine;
    try {
        const engine = await buildEngine(lib);
        fs.writeFile(ENGINE_CACHE, engine.serialize()).catch(() => {});
        return engine;
    } catch (err) {
        if (cached) return cached.engine;
        throw err;
    }
}

const TYPE_MAP = {
    document: 'main_frame', stylesheet: 'stylesheet', image: 'image', media: 'media', font: 'font',
    script: 'script', xhr: 'xmlhttprequest', fetch: 'xmlhttprequest', websocket: 'websocket', other: 'other'
};

/** Bir isteğin reklam olup olmadığı (ana sayfa belgesi asla engellenmez). */
export async function isAdRequest(url, sourceUrl = '', resourceType = 'other') {
    if (process.env.ADBLOCK === '0') return false;
    if (isAdHost(url)) return true;
    const match = await getEngine();
    if (!match) return false;
    try {
        return match(url, sourceUrl || url, TYPE_MAP[resourceType] || 'other');
    } catch (_) {
        return false;
    }
}

/** Sunucu açılırken listeleri önden indir (ilk sayfa beklemesin). */
export function warmAdblock() {
    getEngine();
}

/**
 * Bağlamdaki tüm istekleri yönlendirir.
 * @param {import('playwright-core').BrowserContext} context
 * @param {object} opts
 * @param {(url: string) => void} [opts.onBlocked]   engellenen her reklam isteği
 * @param {(request: any) => boolean} [opts.needsCors] bu istek sunucuda alınıp CORS izniyle verilsin mi
 */
export async function installRouting(context, { onBlocked = () => {}, needsCors = () => false } = {}) {
    await context.route('**/*', async (route) => {
        const request = route.request();
        const url = request.url();
        if (!/^https?:/i.test(url)) return route.fallback();
        if (url.startsWith(EARLY_URL)) {
            const pageUrl = new URL(url).searchParams.get('u') || '';
            return route.fulfill({ status: 200, contentType: 'application/javascript', headers: { 'access-control-allow-origin': '*' },
                body: earlyCode(request, pageUrl) }).catch(() => {});
        }
        let frameUrl = '';
        let isTopDocument = false;
        try {
            const frame = request.frame();
            frameUrl = frame.url();
            isTopDocument = request.isNavigationRequest() && frame === frame.page().mainFrame();
        } catch (_) { /* servis çalışanı isteği */ }

        // Ana sayfa geçişi: ilk açılış (ve onun yönlendirmeleri) serbest; sayfa zaten açıkken
        // bir reklam adresine gitmeye çalışırsa (tıklama ele geçirme) engellenir.
        const pageAlreadyOpen = isTopDocument && /^https?:/i.test(frameUrl);
        if ((!isTopDocument || pageAlreadyOpen) && await isAdRequest(url, frameUrl, isTopDocument ? 'document' : request.resourceType())) {
            stats.blocked++;
            if (request.resourceType() === 'media' || VIDEO_AD.test(url)) stats.videoAds++;
            onBlocked(url, isTopDocument);
            return route.abort('blockedbyclient').catch(() => {});
        }
        if (needsCors(request)) {
            try {
                const response = await route.fetch();
                const origin = request.headers().origin;
                const headers = {
                    ...response.headers(),
                    'access-control-allow-origin': origin || '*',
                    'access-control-allow-credentials': origin ? 'true' : 'false',
                    'access-control-expose-headers': '*'
                };
                return route.fulfill({ response, headers });
            } catch (_) {
                return route.abort().catch(() => {});
            }
        }
        return route.fallback();
    });
}

/** Kaba "aynı site" karşılaştırması: kayıtlı alan adı (ör. ornek.com, ornek.com.tr). */
function siteOf(url) {
    const host = hostOf(url).replace(/^www\./, '');
    const parts = host.split('.');
    if (parts.length <= 2) return host;
    const second = parts[parts.length - 2];
    const takeThree = parts[parts.length - 1].length === 2 && /^(co|com|net|org|gov|edu|ac|gen|bel|k12|biz|info|tv)$/.test(second);
    return parts.slice(takeThree ? -3 : -2).join('.');
}

/**
 * Tıklama ele geçirmeye karşı: sayfa açıldıktan sonra kendiliğinden başka bir siteye giderse
 * (oynat düğmesi yerine reklama yönlendirme) videonun sayfasına geri dönülür.
 * Kendi gittiğimiz adreslerden önce `expect()`, sonra `arm()` çağrılır.
 */
export function guardNavigation(page, { onReturn = () => {} } = {}) {
    let home = '';
    let armed = false;
    let returns = 0;
    page.on('framenavigated', (frame) => {
        if (!armed || frame !== page.mainFrame()) return;
        const url = frame.url();
        // Engellenen reklam geçişi tarayıcıyı hata sayfasına (chrome-error://) götürür; o da geri döndürülür.
        const errorPage = /^chrome-error:/i.test(url);
        if (returns >= 5 || (!errorPage && (!/^https?:/i.test(url) || siteOf(url) === siteOf(home)))) return;
        returns++;
        onReturn(url);
        armed = false;
        page.goto(home, { waitUntil: 'domcontentloaded', timeout: 25000 }).catch(() => {})
            .finally(() => { armed = true; });
    });
    return {
        expect() { armed = false; },
        arm(url = page.url()) {
            if (/^https?:/i.test(url)) {
                home = url;
                armed = true;
                // Sayfa içi kilit: yönlendirme hiç gerçekleşmesin (gerçekleşirse yukarıdaki geri dönüş devrede).
                page.evaluate(() => window.__indiriciSetLock && window.__indiriciSetLock()).catch(() => {});
            }
        }
    };
}

/**
 * Kullanıcının dokunduğu oturumda ("Kendim dokunayım"): kullanıcı başka sitelere gidebilir (giriş
 * sayfası gibi), ama ana sayfa bir reklam adresine giderse ya da engellenen reklam yüzünden hata
 * sayfasına düşerse son düzgün sayfaya dönülür.
 */
export function guardSession(page, { onReturn = () => {} } = {}) {
    let lastGood = '';
    let busy = false;
    let returns = 0;
    page.on('framenavigated', async (frame) => {
        if (frame !== page.mainFrame() || busy) return;
        const url = frame.url();
        const errorPage = /^chrome-error:/i.test(url);
        const ad = !errorPage && /^https?:/i.test(url) && await isAdRequest(url, lastGood, 'document');
        if (!errorPage && !ad) {
            if (/^https?:/i.test(url)) lastGood = url;
            returns = 0;
            return;
        }
        if (!lastGood || returns >= 5) return;
        returns++;
        busy = true;
        onReturn(url);
        page.goto(lastGood, { waitUntil: 'domcontentloaded', timeout: 25000 }).catch(() => {})
            .finally(() => { busy = false; });
    });
    // Yüklenen sayfada tıklamayı yutan görünmez katmanlar etkisizleştirilir.
    page.on('domcontentloaded', () => {
        setTimeout(() => disarmOverlays(page).catch(() => {}), 1500);
        setTimeout(() => disarmOverlays(page).catch(() => {}), 5000);
    });
}

/* ---------------- Pop-up, tıklama tuzağı ve kozmetik engelleme ---------------- */

// Her sayfaya (ve çerçeveye) ilk iş olarak eklenir:
// - window.open sahte bir pencere döndürür: reklam penceresi hiç açılmaz, sayfa "açıldı" sanır.
// - Başka siteye giden target=_blank bağlantılar (pop-under) tıklanınca açılmaz.
const POPUP_GUARD = `(() => {
    if (window.__indiriciGuard) return;
    window.__indiriciGuard = true;
    const fake = () => {
        const noop = () => {};
        const w = { closed: false, close() { this.closed = true; }, focus: noop, blur: noop, postMessage: noop,
            moveTo: noop, resizeTo: noop, document: { write: noop, writeln: noop, open: noop, close: noop, body: null },
            location: { href: 'about:blank', replace: noop, assign: noop } };
        w.window = w; w.self = w; w.opener = window;
        return w;
    };
    // "Kendim dokunayım"da pencere açmaya izin verilir: "Google/Apple ile giriş" gibi giriş pencereleri
    // açılabilsin. Açılan pencere sunucuda reklam mı diye bakılır (reklamsa kapatılır).
    const allowPopups = window.__indiriciAllowPopups === true;
    if (!allowPopups) {
        try {
            Object.defineProperty(window, 'open', { value: function () { return fake(); }, writable: false, configurable: false });
        } catch (_) {
            window.open = function () { return fake(); };
        }
    }
    // Otomatik tarama/kayıt sırasında sayfa başka bir siteye gitmeye kalkarsa (oynat düğmesine
    // basınca reklama yönlendirme) gitmeden iptal edilir. Kilit yalnızca sunucu "arm" deyince açılır.
    const site = (host) => {
        const p = String(host).replace(/^www\./, '').split('.');
        if (p.length <= 2) return p.join('.');
        const two = p[p.length - 1].length === 2 && /^(co|com|net|org|gov|edu|ac|gen|bel|k12|biz|info|tv)$/.test(p[p.length - 2]);
        return p.slice(two ? -3 : -2).join('.');
    };
    let locked = false;
    try { locked = sessionStorage.getItem('__indiriciLock') === '1'; } catch (_) {}
    window.__indiriciSetLock = () => {
        locked = true;
        try { sessionStorage.setItem('__indiriciLock', '1'); } catch (_) {}
    };
    if (window.top === window && window.navigation) {
        window.navigation.addEventListener('navigate', (e) => {
            if (!locked || !e.cancelable || e.hashChange || e.downloadRequest) return;
            try {
                const to = new URL(e.destination.url);
                if (/^https?:$/.test(to.protocol) && site(to.hostname) !== site(location.hostname)) {
                    e.preventDefault();
                    window.__indiriciBlockedNav = (window.__indiriciBlockedNav || 0) + 1;
                }
            } catch (_) {}
        });
    }
    if (!allowPopups) document.addEventListener('click', (e) => {
        const a = e.target && e.target.closest && e.target.closest('a[target]');
        if (!a || /^_(self|parent|top)$/i.test(a.target)) return;
        try {
            if (new URL(a.href, location.href).host !== location.host) e.preventDefault();
        } catch (_) { /* geçersiz adres */ }
    }, true);
})();`;

const domainOf = (host) => siteOf('http://' + host);

// Sitenin kendi betikleri çalışmadan önce: o siteye özel gizleme kuralları ve reklam karşıtı
// betikler (uBlock Origin scriptlet'leri, ör. reklam engelleyici tespitini bozanlar). Sayfa
// eklenen ilk betikte (EARLY) kuralları eşzamanlı bir istekle sorar; istek ağa çıkmaz, yönlendirici
// cevaplar. Belge yüklendikten sonra eklemek geç kalır; belge isteği sırasında betik eklemek ise
// tarayıcıyı kilitliyor.
const EARLY_URL = 'https://indirici-kurallar.invalid/early';
const earlyDone = new WeakMap(); // page → Set(hostname)

const EARLY = `(() => {
    if (window.__indiriciEarly || !/^https?:$/.test(location.protocol)) return;
    window.__indiriciEarly = true;
    try {
        const x = new XMLHttpRequest();
        x.open('GET', '${EARLY_URL}?u=' + encodeURIComponent(location.href), false);
        x.send();
        if (x.status === 200 && x.responseText) (0, eval)(x.responseText);
    } catch (_) {}
})();`;

function earlyCode(request, pageUrl) {
    const hostname = hostOf(pageUrl);
    if (!rawEngine || !hostname) return '';
    try {
        const page = request.frame().page();
        const done = earlyDone.get(page) || new Set();
        earlyDone.set(page, done);
        done.add(hostname);
    } catch (_) { /* çerçeve gitmiş */ }
    try {
        const { styles, scripts } = rawEngine.getCosmeticsFilters({
            url: pageUrl, hostname, domain: domainOf(hostname), getBaseRules: true, getInjectionRules: true,
            getExtendedRules: false, getRulesFromHostname: true, getRulesFromDOM: false
        });
        if (!styles && !(scripts && scripts.length)) return '';
        return `${(scripts || []).map((sc) => `try { ${sc}\n} catch (_) {}`).join('\n')}
            (() => {
                const css = ${JSON.stringify(styles || '')};
                if (!css) return;
                const add = () => {
                    const st = document.createElement('style');
                    st.textContent = css;
                    (document.head || document.documentElement).appendChild(st);
                };
                if (document.documentElement) return add();
                // Belge henüz boş: kök öğe oluşur oluşmaz eklenir (sayfanın ilk betiğinden önce).
                const mo = new MutationObserver(() => {
                    if (!document.documentElement) return;
                    mo.disconnect();
                    add();
                });
                mo.observe(document, { childList: true });
            })();`;
    } catch (_) {
        return '';
    }
}

/** Erken eklenmiş mi (sayfa yüklenince aynı kurallar yeniden çalıştırılmasın)? */
function earlyApplied(frame, hostname) {
    try {
        const set = earlyDone.get(frame.page());
        return Boolean(set && set.has(hostname));
    } catch (_) {
        return false;
    }
}

// Sayfaya sonradan eklenen öğeler (geç yüklenen reklam alanları) izlenir: yeni sınıf/kimlikler
// sunucuya bildirilir, onlara uyan gizleme kuralları sayfaya eklenir.
const DOM_WATCH = `(() => {
    if (window.__indiriciDomWatch || typeof window.__indiriciDom !== 'function') return;
    window.__indiriciDomWatch = true;
    const seen = new Set();
    let classes = [], ids = [], hrefs = [], timer = 0;
    const take = (el) => {
        if (!el || el.nodeType !== 1) return;
        if (el.classList) el.classList.forEach((c) => { if (!seen.has('.' + c)) { seen.add('.' + c); classes.push(c); } });
        if (el.id && !seen.has('#' + el.id)) { seen.add('#' + el.id); ids.push(el.id); }
        if (el.tagName === 'A' && el.href && hrefs.length < 200 && !seen.has(el.href)) { seen.add(el.href); hrefs.push(el.href); }
    };
    const flush = () => {
        timer = 0;
        if (!classes.length && !ids.length && !hrefs.length) return;
        const data = { classes, ids, hrefs };
        classes = []; ids = []; hrefs = [];
        try { window.__indiriciDom(data); } catch (_) {}
    };
    new MutationObserver((records) => {
        for (const r of records) {
            for (const node of r.addedNodes) {
                if (node.nodeType !== 1) continue;
                take(node);
                if (seen.size < 20000) node.querySelectorAll('[class], [id], a[href]').forEach(take);
            }
            if (r.type === 'attributes') take(r.target);
        }
        if (!timer) timer = setTimeout(flush, 400);
    }).observe(document, { childList: true, subtree: true, attributes: true, attributeFilter: ['class', 'id'] });
})();`;

async function cosmeticsForDom(frame, dom) {
    if (!rawEngine || !dom) return;
    let url;
    try {
        url = frame.url();
    } catch (_) {
        return;
    }
    if (!/^https?:/i.test(url)) return;
    const hostname = hostOf(url);
    try {
        const { styles } = rawEngine.getCosmeticsFilters({
            url, hostname, domain: domainOf(hostname),
            classes: (dom.classes || []).slice(0, 4000), ids: (dom.ids || []).slice(0, 4000), hrefs: (dom.hrefs || []).slice(0, 500),
            getBaseRules: false, getInjectionRules: false, getExtendedRules: false, getRulesFromHostname: false, getRulesFromDOM: true
        });
        if (styles) await frame.addStyleTag({ content: styles }).catch(() => {});
    } catch (_) { /* kural alınamadı */ }
}

/** Sayfadaki reklam alanlarını gizler (EasyList kozmetik kuralları); hazır listeler yoksa bir şey yapmaz. */
async function applyCosmetics(frame) {
    if (!rawEngine) return;
    let url;
    try {
        url = frame.url();
    } catch (_) {
        return;
    }
    if (!/^https?:/i.test(url)) return;
    const hostname = hostOf(url);
    const domain = domainOf(hostname);
    try {
        // Siteye özel kurallar belge isteğinde erken eklendiyse yeniden çalıştırılmaz.
        if (!earlyApplied(frame, hostname)) {
            const base = rawEngine.getCosmeticsFilters({
                url, hostname, domain, getBaseRules: true, getInjectionRules: true, getExtendedRules: false,
                getRulesFromHostname: true, getRulesFromDOM: false
            });
            if (base.styles) await frame.addStyleTag({ content: base.styles }).catch(() => {});
            for (const script of base.scripts || []) await frame.evaluate(script).catch(() => {});
        }
        const dom = await frame.evaluate(() => {
            const classes = new Set();
            const ids = new Set();
            const hrefs = new Set();
            for (const el of document.querySelectorAll('[class], [id], a[href]')) {
                if (classes.size > 4000) break;
                el.classList.forEach((c) => classes.add(c));
                if (el.id) ids.add(el.id);
                if (el.href && hrefs.size < 500) hrefs.add(el.href);
            }
            return { classes: [...classes], ids: [...ids], hrefs: [...hrefs] };
        }).catch(() => null);
        if (dom) {
            const extra = rawEngine.getCosmeticsFilters({
                url, hostname, domain, ...dom, getBaseRules: false, getInjectionRules: false, getExtendedRules: false,
                getRulesFromHostname: false, getRulesFromDOM: true
            });
            if (extra.styles) await frame.addStyleTag({ content: extra.styles }).catch(() => {});
        }
    } catch (err) { if (process.env.DEBUG_ADBLOCK) console.log("cosmetics", err); }
}

/**
 * Bağlamdaki her sayfaya pop-up korumasını ve kozmetik gizlemeyi kurar.
 * ADBLOCK=0 ile başlatılmışsa pop-up koruması yine kurulur (reklam penceresi işe yaramaz).
 */
export async function installPageGuards(context, { allowPopups = false } = {}) {
    if (allowPopups) await context.addInitScript('window.__indiriciAllowPopups = true;');
    await context.addInitScript(POPUP_GUARD);
    if (process.env.ADBLOCK === '0') return;
    await getEngine();
    await context.exposeBinding('__indiriciDom', (source, dom) => cosmeticsForDom(source.frame, dom)).catch(() => {});
    await context.addInitScript(EARLY);
    await context.addInitScript(DOM_WATCH);
    const hook = (page) => {
        page.on('domcontentloaded', () => applyCosmetics(page.mainFrame()));
        page.on('frameattached', (frame) => {
            frame.waitForLoadState('domcontentloaded').then(() => applyCosmetics(frame)).catch(() => {});
        });
    };
    context.pages().forEach(hook);
    context.on('page', hook);
}

/**
 * Tıklamayı yutan görünmez katmanlar ("ilk tıklama reklama gider" tuzağı) etkisizleştirilir:
 * ekranın büyük kısmını kaplayan, neredeyse saydam, içinde video/çerçeve olmayan sabit/mutlak
 * öğeler dokunuşu geçirir hale getirilir. Kaç öğe etkilendiği döner.
 */
export async function disarmOverlays(page) {
    let total = 0;
    for (const frame of page.frames()) {
        total += await frame.evaluate(() => {
            const vw = window.innerWidth;
            const vh = window.innerHeight;
            const alpha = (color) => {
                const m = /rgba?\(([^)]+)\)/.exec(color || '');
                if (!m) return color === 'transparent' ? 0 : 1;
                const parts = m[1].split(',').map(Number);
                return parts.length > 3 ? parts[3] : 1;
            };
            let n = 0;
            for (const el of document.querySelectorAll('body *')) {
                const cs = getComputedStyle(el);
                if (cs.position !== 'fixed' && cs.position !== 'absolute') continue;
                if (cs.pointerEvents === 'none' || cs.display === 'none' || cs.visibility === 'hidden') continue;
                const r = el.getBoundingClientRect();
                if (r.width * r.height < vw * vh * 0.35) continue;
                if (el.querySelector('video, iframe, canvas, img[src]')) continue;
                // Giriş formu, düğme ya da bağlantı içeren katman dokunulmaz yapılmaz (yazısız olsa da).
                if (el.matches('form, [role="dialog"]') || el.querySelector('input, textarea, select, button, a[href], form, [role="button"], [contenteditable="true"]')) continue;
                if (el.closest('video')) continue;
                const seeThrough = Number(cs.opacity) < 0.15 || (alpha(cs.backgroundColor) < 0.15 && cs.backgroundImage === 'none');
                const textless = (el.innerText || '').trim().length < 3;
                if (seeThrough && textless) {
                    el.style.setProperty('pointer-events', 'none', 'important');
                    n++;
                }
            }
            return n;
        }).catch(() => 0);
    }
    return total;
}
