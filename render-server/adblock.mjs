// Sunucudaki tarayıcı için reklam engelleme + istek yönlendirme.
//
// Reklamlar videoları karıştırıyor: oynatıcı önce reklamı oynatıyor, sayfa taramasında reklam
// videoları listeye düşüyor, kayıtta yanlış video yakalanabiliyor. Burada her istek tek bir
// yönlendiriciden geçer:
//   1) reklam/izleme adresleri engellenir — @ghostery/adblocker kuruluysa EasyList tabanlı hazır
//      listelerle (video reklam SDK'ları dahil), değilse yerleşik alan adı listesiyle;
//   2) "video aç ve kaydet" oynatıcı sayfasında, başka kökenden gelen yayın istekleri sunucu
//      tarafında alınıp CORS izniyle sayfaya verilir (sitenin kendi oynatıcısı gibi oynasın diye).

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

let enginePromise = null;
/** Ghostery motoru (kuruluysa); listeler sunucu açılışında bir kez indirilir. */
function getEngine() {
    if (process.env.ADBLOCK === '0') return Promise.resolve(null);
    if (!enginePromise) {
        enginePromise = (async () => {
            try {
                const { FiltersEngine, Request } = await import('@ghostery/adblocker');
                const engine = await FiltersEngine.fromPrebuiltAdsAndTracking(fetch);
                console.log('Reklam engelleyici hazır (EasyList tabanlı listeler).');
                return (url, sourceUrl, type) => engine.match(Request.fromRawDetails({ url, sourceUrl, type })).match;
            } catch (err) {
                console.log(`Reklam engelleyici: hazır listeler yüklenemedi (${err.code || err.message}); yerleşik liste kullanılıyor.`);
                return null;
            }
        })();
    }
    return enginePromise;
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
        let frameUrl = '';
        let isTopDocument = false;
        try {
            const frame = request.frame();
            frameUrl = frame.url();
            isTopDocument = request.isNavigationRequest() && frame === frame.page().mainFrame();
        } catch (_) { /* servis çalışanı isteği */ }

        if (!isTopDocument && await isAdRequest(url, frameUrl, request.resourceType())) {
            onBlocked(url);
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
