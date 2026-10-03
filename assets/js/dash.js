// DASH (.mpd): bildirimi ayrıştırır, her kaliteyi HLS indiricinin anladığı "medya listesi"ne çevirir
// (parça adresi + bayt aralığı + init segmenti). İndirme, birleştirme ve aralık seçimi hls.js'teki
// VOD indiricisiyle yapılır; ayrı görüntü ve ses tek MP4'te birleşir. Yalnızca MP4 (fMP4) akışlar.
import { smartFetch } from './util.js';

/** ISO 8601 süre ("PT1H2M3.5S") → saniye. */
export function parseDuration(text) {
    if (!text) return 0;
    const m = /^P(?:(\d+(?:\.\d+)?)Y)?(?:(\d+(?:\.\d+)?)M)?(?:(\d+(?:\.\d+)?)D)?(?:T(?:(\d+(?:\.\d+)?)H)?(?:(\d+(?:\.\d+)?)M)?(?:(\d+(?:\.\d+)?)S)?)?$/.exec(text.trim());
    if (!m) return 0;
    const [, y, mo, d, h, mi, s] = m.map((x) => Number(x) || 0);
    return (((y * 365 + mo * 30 + d) * 24 + h) * 60 + mi) * 60 + s;
}

const children = (el, name) => (el ? [...el.children].filter((c) => c.localName === name) : []);
const child = (el, name) => children(el, name)[0] || null;

/** Üst düzeylerden gelen BaseURL zinciri. */
function resolveBase(base, el) {
    const b = child(el, 'BaseURL');
    if (!b || !b.textContent.trim()) return base;
    try {
        return new URL(b.textContent.trim(), base).href;
    } catch (_) {
        return base;
    }
}

/** Aynı adlı öğenin özniteliklerini üstten alta birleştirir (Representation > AdaptationSet > Period). */
function inherited(levels, name) {
    const found = levels.map((el) => child(el, name)).filter(Boolean);
    if (!found.length) return null;
    const attrs = {};
    for (const el of found) for (const a of el.attributes) attrs[a.name] = a.value;
    const deepest = found[found.length - 1];
    // Alt öğeler (SegmentTimeline, Initialization, SegmentURL) en alttaki tanımdan; yoksa üsttekinden.
    const pick = (n) => found.slice().reverse().map((el) => child(el, n)).find(Boolean) || null;
    return { attrs, timeline: pick('SegmentTimeline'), init: pick('Initialization'), urls: children(deepest, 'SegmentURL').length
        ? children(deepest, 'SegmentURL') : found.slice().reverse().map((el) => children(el, 'SegmentURL')).find((l) => l.length) || [] };
}

function fillTemplate(template, { id, bandwidth, number, time }) {
    return template.replace(/\$(RepresentationID|Number|Bandwidth|Time)(?:%0(\d+)d)?\$|\$\$/g, (all, key, width) => {
        if (all === '$$') return '$';
        const value = { RepresentationID: id, Number: number, Bandwidth: bandwidth, Time: time }[key];
        if (value === undefined) return all;
        return width ? String(value).padStart(Number(width), '0') : String(value);
    });
}

function parseRange(text) {
    const m = /^(\d+)-(\d+)$/.exec(String(text || '').trim());
    return m ? { offset: Number(m[1]), length: Number(m[2]) - Number(m[1]) + 1 } : null;
}

/**
 * MPD metnini ayrıştırır.
 * @returns {{live: boolean, duration: number, drm: string, variants: object[], audios: object[], periods: object[]}}
 */
export function parseMpd(text, mpdUrl) {
    const doc = new DOMParser().parseFromString(text, 'application/xml');
    const mpd = doc.documentElement;
    if (!mpd || mpd.localName !== 'MPD') throw new Error('Geçerli bir DASH bildirimi değil');
    const live = (mpd.getAttribute('type') || 'static') === 'dynamic';
    const total = parseDuration(mpd.getAttribute('mediaPresentationDuration'));
    const mpdBase = resolveBase(mpdUrl, mpd);

    const periods = [];
    let periodStart = 0;
    const periodEls = children(mpd, 'Period');
    periodEls.forEach((period, pi) => {
        const start = mpd.getAttribute('type') !== 'dynamic' && period.getAttribute('start') ? parseDuration(period.getAttribute('start')) : periodStart;
        const next = periodEls[pi + 1];
        const nextStart = next && next.getAttribute('start') ? parseDuration(next.getAttribute('start')) : 0;
        const duration = parseDuration(period.getAttribute('duration')) || (nextStart ? nextStart - start : Math.max(0, total - start));
        periodStart = start + duration;
        const periodBase = resolveBase(mpdBase, period);
        const sets = children(period, 'AdaptationSet').map((set) => {
            const setBase = resolveBase(periodBase, set);
            const drm = children(set, 'ContentProtection').map((c) => c.getAttribute('schemeIdUri') || '');
            const reps = children(set, 'Representation').map((rep) => {
                const attr = (n) => rep.getAttribute(n) || set.getAttribute(n) || '';
                const mime = attr('mimeType');
                const contentType = set.getAttribute('contentType') || (mime.split('/')[0]) ||
                    (/^(avc|hev|hvc|vp0|av01)/.test(attr('codecs')) ? 'video' : /^(mp4a|opus|ac-3|ec-3)/.test(attr('codecs')) ? 'audio' : '');
                return {
                    id: rep.getAttribute('id') || '',
                    bandwidth: Number(rep.getAttribute('bandwidth')) || 0,
                    width: Number(attr('width')) || 0,
                    height: Number(attr('height')) || 0,
                    codecs: attr('codecs'),
                    mime,
                    type: contentType,
                    lang: set.getAttribute('lang') || '',
                    base: resolveBase(setBase, rep),
                    drm: [...drm, ...children(rep, 'ContentProtection').map((c) => c.getAttribute('schemeIdUri') || '')],
                    template: inherited([period, set, rep], 'SegmentTemplate'),
                    list: inherited([period, set, rep], 'SegmentList'),
                    single: inherited([period, set, rep], 'SegmentBase'),
                    periodIndex: pi
                };
            });
            return { type: reps[0] ? reps[0].type : '', reps };
        });
        periods.push({ start, duration, sets });
    });

    const first = periods[0] || { sets: [] };
    const all = first.sets.flatMap((s) => s.reps);
    const isMp4 = (r) => /mp4/.test(r.mime) || (!r.mime && !/vp8|vorbis/.test(r.codecs));
    const videosAll = all.filter((r) => r.type === 'video');
    const variants = videosAll.filter(isMp4)
        .sort((a, b) => (b.height - a.height) || (b.bandwidth - a.bandwidth))
        .filter((r, i, list) => list.findIndex((x) => x.height === r.height && x.codecs.slice(0, 4) === r.codecs.slice(0, 4)) === i)
        .map((r) => ({ ...r, resolution: r.width && r.height ? `${r.width}x${r.height}` : '' }));
    const audios = all.filter((r) => r.type === 'audio' && isMp4(r))
        .sort((a, b) => (/mp4a/.test(b.codecs) - /mp4a/.test(a.codecs)) || (b.bandwidth - a.bandwidth));
    const drmList = [...variants, ...audios].flatMap((r) => r.drm).filter((s) => !/urn:mpeg:dash:mp4protection/i.test(s));
    const drmAny = [...variants, ...audios].some((r) => r.drm.length);
    return {
        live,
        duration: total || periods.reduce((n, p) => n + p.duration, 0),
        drm: drmAny ? (drmSystem(drmList[0]) || 'şifreli') : '',
        variants,
        audios,
        webmOnly: !variants.length && videosAll.length > 0,
        periods
    };
}

function drmSystem(scheme) {
    const s = String(scheme || '').toLowerCase();
    if (s.includes('edef8ba9')) return 'Widevine';
    if (s.includes('9a04f079')) return 'PlayReady';
    if (s.includes('94ce86fb')) return 'FairPlay';
    return s ? 'DRM' : '';
}

/** Her dönemde (Period) seçilen kaliteye en yakın temsili bulur (reklam/bölüm dönemleri için). */
function matchInPeriod(period, wanted) {
    const reps = period.sets.flatMap((s) => s.reps).filter((r) => r.type === wanted.type && (/mp4/.test(r.mime) || !r.mime));
    return reps.find((r) => r.id === wanted.id && r.height === wanted.height) ||
        reps.slice().sort((a, b) => Math.abs(a.bandwidth - wanted.bandwidth) - Math.abs(b.bandwidth - wanted.bandwidth))[0] || null;
}

/** sidx kutusundan parçaların bayt aralıkları ve süreleri. */
function parseSidx(bytes, sidxOffset) {
    const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    let p = 0;
    while (p + 8 <= bytes.length) {
        const size = dv.getUint32(p);
        const type = String.fromCharCode(bytes[p + 4], bytes[p + 5], bytes[p + 6], bytes[p + 7]);
        if (type === 'sidx') break;
        if (size < 8) return null;
        p += size;
    }
    if (p + 8 > bytes.length) return null;
    const boxStart = p;
    const boxSize = dv.getUint32(p);
    const version = bytes[p + 8];
    let q = p + 12 + 4; // version/flags + reference_ID
    const timescale = dv.getUint32(q);
    q += 4;
    let firstOffset;
    if (version === 0) {
        q += 4;
        firstOffset = dv.getUint32(q);
        q += 4;
    } else {
        q += 8;
        firstOffset = Number(dv.getBigUint64(q));
        q += 8;
    }
    q += 2;
    const count = dv.getUint16(q);
    q += 2;
    const refs = [];
    let offset = sidxOffset + boxStart + boxSize + firstOffset;
    for (let i = 0; i < count; i++) {
        const sizeWord = dv.getUint32(q);
        const duration = dv.getUint32(q + 4);
        q += 12;
        const length = sizeWord & 0x7fffffff;
        refs.push({ range: { offset, length }, duration: duration / timescale });
        offset += length;
    }
    return refs;
}

async function fetchRange(url, range, { mode, signal }) {
    const init = { signal };
    if (range) init.headers = { Range: `bytes=${range.offset}-${range.offset + range.length - 1}` };
    const res = await smartFetch(url, { mode, init });
    return new Uint8Array(await res.arrayBuffer());
}

/** Bir dönemdeki temsilin parçaları (başlangıç saniyesi dönem başına göre). */
async function segmentsOf(rep, period, { mode, signal }) {
    const t = rep.template;
    if (t && t.attrs.media) {
        const a = t.attrs;
        const timescale = Number(a.timescale) || 1;
        const startNumber = a.startNumber !== undefined ? Number(a.startNumber) : 1;
        const pto = Number(a.presentationTimeOffset) || 0;
        const vars = { id: rep.id, bandwidth: rep.bandwidth };
        const map = a.initialization
            ? { url: new URL(fillTemplate(a.initialization, vars), rep.base).href, range: null }
            : t.init && t.init.getAttribute('sourceURL')
                ? { url: new URL(t.init.getAttribute('sourceURL'), rep.base).href, range: parseRange(t.init.getAttribute('range')) }
                : null;
        const out = [];
        if (t.timeline) {
            let time = 0;
            let number = startNumber;
            const items = children(t.timeline, 'S');
            items.forEach((s, i) => {
                if (s.getAttribute('t') !== null) time = Number(s.getAttribute('t'));
                const d = Number(s.getAttribute('d')) || 0;
                let r = Number(s.getAttribute('r')) || 0;
                if (r < 0) {
                    const next = items[i + 1];
                    const end = next && next.getAttribute('t') !== null ? Number(next.getAttribute('t')) : pto + period.duration * timescale;
                    r = Math.max(0, Math.ceil((end - time) / d) - 1);
                }
                for (let k = 0; k <= r; k++) {
                    out.push({
                        url: new URL(fillTemplate(a.media, { ...vars, number, time }), rep.base).href,
                        range: null, map, start: (time - pto) / timescale, duration: d / timescale
                    });
                    time += d;
                    number++;
                }
            });
        } else {
            const d = Number(a.duration) || 0;
            if (!d) throw new Error('DASH parça süresi bilinmiyor');
            const count = Math.ceil((period.duration * timescale) / d);
            for (let i = 0; i < count; i++) {
                out.push({
                    url: new URL(fillTemplate(a.media, { ...vars, number: startNumber + i, time: i * d }), rep.base).href,
                    range: null, map, start: (i * d) / timescale, duration: d / timescale
                });
            }
        }
        return out;
    }

    const l = rep.list;
    if (l && l.urls.length) {
        const a = l.attrs;
        const timescale = Number(a.timescale) || 1;
        const d = (Number(a.duration) || 0) / timescale;
        const map = l.init ? { url: new URL(l.init.getAttribute('sourceURL') || '', rep.base).href, range: parseRange(l.init.getAttribute('range')) } : null;
        return l.urls.map((u, i) => ({
            url: new URL(u.getAttribute('media') || '', rep.base).href,
            range: parseRange(u.getAttribute('mediaRange')),
            map, start: i * d, duration: d || period.duration / l.urls.length
        }));
    }

    // Tek dosya (SegmentBase): sidx'ten parçalara bölünür; yoksa dosyanın tamamı tek parça.
    const sb = rep.single;
    const initRange = sb && sb.init ? parseRange(sb.init.getAttribute('range')) : null;
    const indexRange = sb ? parseRange(sb.attrs.indexRange) : null;
    if (indexRange) {
        const head = await fetchRange(rep.base, { offset: indexRange.offset, length: indexRange.length }, { mode, signal });
        const refs = parseSidx(head, indexRange.offset);
        if (refs && refs.length) {
            const map = { url: rep.base, range: initRange || { offset: 0, length: indexRange.offset } };
            let start = 0;
            return refs.map((ref) => {
                const seg = { url: rep.base, range: ref.range, map, start, duration: ref.duration };
                start += ref.duration;
                return seg;
            });
        }
    }
    return [{ url: rep.base, range: null, map: { url: rep.base, range: null }, start: 0, duration: period.duration }];
}

/**
 * Seçilen temsilin (tüm dönemleriyle) HLS indiricisinin anladığı medya listesi.
 * @returns {Promise<{type: 'media', segments: object[], totalDuration: number, isLive: false}>}
 */
export async function dashPlaylist(mpd, rep, { mode = 'auto', signal } = {}) {
    const segments = [];
    for (const period of mpd.periods) {
        const match = period === mpd.periods[rep.periodIndex] ? rep : matchInPeriod(period, rep);
        if (!match) continue;
        for (const seg of await segmentsOf(match, period, { mode, signal })) {
            segments.push({ ...seg, start: seg.start + period.start, seq: segments.length });
        }
    }
    if (!segments.length) throw new Error('DASH bildiriminde parça bulunamadı');
    const last = segments[segments.length - 1];
    return { type: 'media', segments, totalDuration: last.start + last.duration, isLive: false };
}
