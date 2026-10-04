// Altyazılar: WebVTT (tek dosya ya da HLS parça listesi) indirilir, çözümlenir; .srt'ye çevrilir
// ya da MP4'e (3GPP metin izi, tx3g) gömülmek üzere ipuçlarına (cue) dönüştürülür.
import { smartFetch } from './util.js';
import { parsePlaylist } from './hls.js';

let names = null;
/** "tr" → "Türkçe"; otomatik altyazılar "Otomatik (İngilizce)". */
export function subLabel(sub) {
    const code = String(sub.language || '').replace(/-orig$/, '');
    try {
        names = names || new Intl.DisplayNames(['tr'], { type: 'language' });
    } catch (_) { /* eski tarayıcı */ }
    let label = sub.name && !/^[a-z]{2,3}(-[A-Za-z]+)?$/.test(sub.name) ? sub.name : '';
    if (!label && code) {
        try {
            label = names ? names.of(code) : code;
        } catch (_) {
            label = code;
        }
    }
    label = label ? label[0].toLocaleUpperCase('tr') + label.slice(1) : 'Altyazı';
    return sub.auto ? `Otomatik (${label})` : label;
}

/** Kısa dil kodu (dosya adı ve oynatıcı için). */
export const subCode = (sub) => (String(sub.language || '').split('-')[0] || 'und').toLowerCase();

const time = (t) => {
    const m = /(?:(\d+):)?(\d{1,2}):(\d{2})[.,](\d{1,3})/.exec(t);
    if (!m) return NaN;
    return (Number(m[1] || 0) * 3600) + Number(m[2]) * 60 + Number(m[3]) + Number(m[4].padEnd(3, '0')) / 1000;
};

/** WebVTT (ve SRT) metnini ipuçlarına çevirir: [{start, end, text}] */
export function parseCues(text) {
    const cues = [];
    const blocks = String(text).replace(/\r/g, '').split(/\n{2,}/);
    for (const block of blocks) {
        const lines = block.split('\n');
        const i = lines.findIndex((l) => l.includes('-->'));
        if (i < 0) continue;
        const [a, b] = lines[i].split('-->');
        const start = time(a);
        const end = time(b);
        if (!isFinite(start) || !isFinite(end)) continue;
        const body = lines.slice(i + 1).join('\n')
            .replace(/<\d{2}:\d{2}[:.\d]*>/g, '') // karaoke zaman işaretleri
            .replace(/<\/?(c|v|i|b|u|lang|ruby|rt)[^>]*>/g, '')
            .replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&nbsp;/g, ' ')
            .trim();
        if (body) cues.push({ start, end: Math.max(end, start + 0.1), text: body });
    }
    cues.sort((x, y) => x.start - y.start);
    // Otomatik altyazılarda ardışık ipuçları aynı satırı tekrarlar; tekrarlar birleştirilir.
    const out = [];
    for (const c of cues) {
        const prev = out[out.length - 1];
        if (prev && prev.text === c.text && c.start - prev.end < 0.05) prev.end = Math.max(prev.end, c.end);
        else out.push({ ...c });
    }
    return out;
}

const stamp = (t, sep) => {
    const ms = Math.round(t * 1000);
    const h = Math.floor(ms / 3600000);
    const m = Math.floor(ms / 60000) % 60;
    const s = Math.floor(ms / 1000) % 60;
    return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}${sep}${String(ms % 1000).padStart(3, '0')}`;
};

export function toSrt(cues) {
    return cues.map((c, i) => `${i + 1}\n${stamp(c.start, ',')} --> ${stamp(c.end, ',')}\n${c.text}\n`).join('\n');
}

export function toVtt(cues) {
    return `WEBVTT\n\n${cues.map((c) => `${stamp(c.start, '.')} --> ${stamp(c.end, '.')}\n${c.text}\n`).join('\n')}`;
}

/** Aralık kesildiyse ipuçlarını kaydırır/kırpar. */
export function shiftCues(cues, start = 0, end = Infinity) {
    return cues.filter((c) => c.end > start && c.start < end)
        .map((c) => ({ ...c, start: Math.max(0, c.start - start), end: Math.min(end, c.end) - start }));
}

/** Altyazıyı indirip ipuçlarını döndürür (HLS altyazı listesinde tüm parçalar birleştirilir). */
export async function loadCues(sub, { mode = 'auto', signal } = {}) {
    const res = await smartFetch(sub.url, { mode, init: { signal } });
    const text = await res.text();
    if (/^#EXTM3U/.test(text.trim())) {
        const list = parsePlaylist(text, sub.url);
        const parts = [];
        for (const seg of list.segments || []) {
            const r = await smartFetch(seg.url, { mode, init: { signal } });
            parts.push(await r.text());
        }
        return parseCues(parts.join('\n\n'));
    }
    if (/^\s*{/.test(text)) {
        // YouTube json3 biçimi
        try {
            const data = JSON.parse(text);
            return (data.events || []).filter((e) => e.segs).map((e) => ({
                start: e.tStartMs / 1000, end: (e.tStartMs + (e.dDurationMs || 2000)) / 1000,
                text: e.segs.map((s) => s.utf8).join('').trim()
            })).filter((c) => c.text);
        } catch (_) { /* çözümlenemedi */ }
    }
    return parseCues(text);
}
