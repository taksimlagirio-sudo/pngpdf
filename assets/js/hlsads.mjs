// HLS'te videonun içine gömülmüş (yayıncının sunucusunda eklenmiş) reklam parçalarını ayıklar.
// Bu tür reklam ayrı bir istek olmadığı için reklam engelleyici göremez; parça listesinde durur.
// Uygulama (hls.js) ve sunucu (recorder.mjs, capture.mjs) aynı kuralı kullanır.
//
// İşaretler, güvenilirden tahmine:
//   1) Reklam arası etiketleri: #EXT-X-CUE-OUT … #EXT-X-CUE-IN, SCTE-35 (#EXT-X-SCTE35, DATERANGE).
//   2) Reklam sınıflı ya da SCTE35-OUT'lu DATERANGE (ör. "twitch-stitched-ad"): yalnızca başlangıç ve
//      süresi verilen aralıktaki parçalar (PROGRAM-DATE-TIME saatine göre).
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
 *
 * Reklam arası yalnızca sınırı belli olunca sayılır (canlı yayında sınırsız bir "reklam başladı"
 * işareti yayının geri kalanını silmesin):
 * - #EXT-X-CUE-OUT[:DURATION] … #EXT-X-CUE-IN (süre verildiyse o kadar parça sonra kendiliğinden biter)
 * - DATERANGE (SCTE35-OUT ya da reklam sınıfı) yalnızca START-DATE + DURATION ile ve parçaların
 *   PROGRAM-DATE-TIME saatine göre.
 * @returns {{ line(l: string): void, tag(): object, ranges: Array<[number, number]> }}
 */
export function createAdTracker() {
    let inCue = false;
    let cueLeft = Infinity;
    let disc = 0;
    let title = '';
    let dur = 0;
    let pdt = NaN;
    const ranges = [];
    const attr = (l, name) => {
        const m = new RegExp(`(?:^|[:,])${name}=("([^"]*)"|[^,]*)`, 'i').exec(l);
        return m ? (m[2] !== undefined ? m[2] : m[1]) : '';
    };
    return {
        ranges,
        line(l) {
            const up = l.toUpperCase();
            if (up.startsWith('#EXT-X-CUE-OUT-CONT')) inCue = true;
            else if (up.startsWith('#EXT-X-CUE-OUT')) {
                inCue = true;
                const d = parseFloat((/DURATION=([\d.]+)/i.exec(l) || /CUE-OUT:([\d.]+)/i.exec(l) || [])[1]);
                cueLeft = d > 0 ? d : Infinity;
            } else if (up.startsWith('#EXT-X-CUE-IN')) inCue = false;
            else if (up.startsWith('#EXT-X-SCTE35')) {
                if (/CUE-OUT=YES/.test(up)) { inCue = true; cueLeft = Infinity; }
                if (/CUE-IN=YES/.test(up)) inCue = false;
            } else if (up.startsWith('#EXT-X-DATERANGE')) {
                const cls = attr(l, 'CLASS') || '';
                const isAd = /SCTE35-OUT=/i.test(l) || (AD_CLASS.test(cls) && !/interstitial|quartile/i.test(cls));
                const start = Date.parse(attr(l, 'START-DATE') || '');
                const len = parseFloat(attr(l, 'DURATION') || attr(l, 'PLANNED-DURATION') || '');
                if (isAd && Number.isFinite(start) && len > 0) ranges.push([start, start + len * 1000]);
            } else if (up.startsWith('#EXT-X-PROGRAM-DATE-TIME')) {
                pdt = Date.parse(l.slice(l.indexOf(':') + 1).trim());
            } else if (up.startsWith('#EXT-X-DISCONTINUITY') && !up.startsWith('#EXT-X-DISCONTINUITY-SEQUENCE')) {
                disc++;
            } else if (up.startsWith('#EXTINF')) {
                dur = parseFloat(l.split(':')[1]) || 0;
                title = l.slice(l.indexOf(',') + 1).trim();
            }
        },
        tag() {
            const t = { cue: inCue && cueLeft > 0, disc, title, pdt };
            if (inCue && cueLeft !== Infinity) {
                cueLeft -= dur;
                if (cueLeft <= 0.05) inCue = false;
            }
            if (Number.isFinite(pdt)) pdt += dur * 1000;
            title = '';
            dur = 0;
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
export function dropAds(segments, { live, base = '', ranges = [] }) {
    const total = segments.reduce((n, s) => n + (s.duration || 0), 0);
    const inRange = (t) => Number.isFinite(t) && ranges.some(([a, b]) => t >= a - 50 && t < b - 50);
    const sure = segments.map((s) => Boolean(s.ad && (s.ad.cue || inRange(s.ad.pdt))));
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
