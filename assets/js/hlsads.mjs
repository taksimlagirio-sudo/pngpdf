// HLS'te videonun içine gömülmüş (yayıncının sunucusunda eklenmiş) reklam parçalarını ayıklar.
// Bu tür reklam ayrı bir istek olmadığı için reklam engelleyici göremez; parça listesinde durur.
// Uygulama (hls.js) ve sunucu (recorder.mjs, capture.mjs) aynı kuralı kullanır.
//
// İşaretler, güvenilirden tahmine:
//   1) Reklam arası etiketleri: #EXT-X-CUE-OUT … #EXT-X-CUE-IN, SCTE-35 (#EXT-X-SCTE35, DATERANGE).
//   2) Reklam sınıflı DATERANGE (ör. "twitch-stitched-ad"): sonraki kesintiye (DISCONTINUITY) kadar.
//   3) Parça adresi ya da başlığı reklam diyor (/ads/, preroll, stitched-ad...).
//   4) Yalnızca bitmiş videoda: kesintilerle ayrılmış kısa bir bölüm, hem videonun geri kalanından
//      hem parça listesinin kendisinden farklı bir sunucudan geliyor.
// 3 ve 4 tahmin olduğundan videonun yarısından fazlasını silmezler; öyle görünürse hiçbiri uygulanmaz.

const AD_PATH = /(?:^|[/_.-])(?:ads?|adverts?|advertising|adbreak|commercials?|preroll|midroll|postroll|stitched-ad)(?:[/_.-]|$)/i;
const AD_TITLE = /(?:^|\W)(?:ads?|advert|advertisement|commercial|reklam|stitched-ad)(?:\W|$)/i;
const AD_CLASS = /(?:^|[-_.])ads?(?:[-_.]|$)|stitched-ad|advert/i;
const MAX_GUESS_SHARE = 0.5;
const MAX_HOST_BLOCK_SEC = 180;

/**
 * parsePlaylist'in parça döngüsünde her satıra çağrılır; parçaya eklenecek reklam bilgisini tutar.
 * @returns {{ line(l: string): void, tag(): {cue: boolean, disc: number, title: string, classAd: boolean} }}
 */
export function createAdTracker() {
    let inCue = false;
    let classAd = false;
    let disc = 0;
    let title = '';
    return {
        line(l) {
            const up = l.toUpperCase();
            if (up.startsWith('#EXT-X-CUE-OUT')) inCue = true; // CUE-OUT ve CUE-OUT-CONT
            else if (up.startsWith('#EXT-X-CUE-IN')) inCue = false;
            else if (up.startsWith('#EXT-X-SCTE35')) {
                if (/CUE-OUT=YES/.test(up)) inCue = true;
                if (/CUE-IN=YES/.test(up)) inCue = false;
            } else if (up.startsWith('#EXT-X-DATERANGE')) {
                if (/SCTE35-OUT=/.test(up)) inCue = true;
                if (/SCTE35-IN=/.test(up)) inCue = false;
                const cls = /CLASS="([^"]*)"/i.exec(l);
                if (cls && AD_CLASS.test(cls[1]) && !/interstitial/i.test(cls[1])) classAd = true;
            } else if (up.startsWith('#EXT-X-DISCONTINUITY') && !up.startsWith('#EXT-X-DISCONTINUITY-SEQUENCE')) {
                disc++;
                classAd = false;
            } else if (up.startsWith('#EXTINF')) {
                title = l.slice(l.indexOf(',') + 1).trim();
            }
        },
        tag() {
            const t = { cue: inCue, disc, title, classAd };
            title = '';
            return t;
        }
    };
}

/**
 * Reklam parçalarını çıkarır. Parçalar sıra numarasını (seq) korur; çıkarılan reklamlar bir sonraki
 * parçanın `adsBefore` değerine yazılır ki canlı kayıt bunları "kaçan parça" saymasın.
 * @param {Array<{url: string, duration: number, ad?: object}>} segments
 * @param {{ live: boolean, base?: string }} o  base: parça listesinin adresi
 * @returns {{ segments: Array, adCount: number, adSeconds: number }}
 */
export function dropAds(segments, { live, base = '' }) {
    const total = segments.reduce((n, s) => n + (s.duration || 0), 0);
    const sure = segments.map((s) => Boolean(s.ad && (s.ad.cue || s.ad.classAd)));
    const guess = segments.map((s) => {
        let p = s.url;
        try { p = new URL(s.url).pathname; } catch (_) { /* göreli */ }
        return AD_PATH.test(p) || Boolean(s.ad && s.ad.title && AD_TITLE.test(s.ad.title));
    });

    if (!live && segments.some((s) => s.ad && s.ad.disc)) {
        // Kesintilerle ayrılmış bölümler; videonun çoğunu taşıyan sunucu "asıl" sayılır.
        const hostOf = (s) => { try { return new URL(s.url).host; } catch (_) { return ''; } };
        let listHost = '';
        try { listHost = new URL(base).host; } catch (_) { /* adres yok */ }
        const byHost = new Map();
        for (const s of segments) byHost.set(hostOf(s), (byHost.get(hostOf(s)) || 0) + (s.duration || 0));
        const [mainHost, mainSec] = [...byHost].sort((a, b) => b[1] - a[1])[0] || ['', 0];
        if (byHost.size > 1 && mainSec >= total * 0.6) {
            const blocks = new Map();
            segments.forEach((s, i) => {
                const d = s.ad ? s.ad.disc : 0;
                if (!blocks.has(d)) blocks.set(d, []);
                blocks.get(d).push(i);
            });
            for (const idx of blocks.values()) {
                const sec = idx.reduce((n, i) => n + (segments[i].duration || 0), 0);
                if (sec <= MAX_HOST_BLOCK_SEC && idx.every((i) => hostOf(segments[i]) !== mainHost && hostOf(segments[i]) !== listHost)) {
                    idx.forEach((i) => { guess[i] = true; });
                }
            }
        }
    }

    const guessSec = segments.reduce((n, s, i) => n + (guess[i] && !sure[i] ? s.duration || 0 : 0), 0);
    const useGuess = total > 0 && guessSec <= total * MAX_GUESS_SHARE;
    const out = [];
    let adCount = 0;
    let adSeconds = 0;
    let pending = 0;
    segments.forEach((s, i) => {
        if (sure[i] || (useGuess && guess[i])) {
            adCount++;
            adSeconds += s.duration || 0;
            pending++;
            return;
        }
        const kept = { ...s };
        delete kept.ad;
        if (pending) kept.adsBefore = pending;
        pending = 0;
        out.push(kept);
    });
    return { segments: out, adCount, adSeconds };
}
