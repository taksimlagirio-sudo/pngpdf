// Ağ isteğini medya türüne göre sınıflandırma (uzantıdaki background.js ile aynı kurallar).

const MIME_KIND = [
    [/mpegurl/i, 'hls'],
    [/dash\+xml/i, 'dash'],
    [/^video\//i, 'video'],
    [/^audio\//i, 'audio'],
    [/^image\//i, 'image']
];

const EXT_KIND = {
    m3u8: 'hls', mpd: 'dash',
    mp4: 'video', m4v: 'video', webm: 'video', mov: 'video', mkv: 'video', flv: 'video',
    mp3: 'audio', m4a: 'audio', aac: 'audio', ogg: 'audio', oga: 'audio', wav: 'audio', flac: 'audio',
    jpg: 'image', jpeg: 'image', png: 'image', webp: 'image', gif: 'image', avif: 'image', bmp: 'image'
};

function extOf(url) {
    const match = url.split('?')[0].split('#')[0].match(/\.([a-z0-9]{2,5})$/i);
    return match ? match[1].toLowerCase() : '';
}

export function classify(url, contentType = '') {
    for (const [re, kind] of MIME_KIND) {
        if (re.test(contentType)) return kind;
    }
    return EXT_KIND[extOf(url)] || null;
}

/**
 * HLS/DASH parçaları (.ts, .m4s, CMAF) tek başına anlamsız; oynatıcı saniyede bir yenisini
 * istediği için listeyi doldururlar. Playlist'in kendisi listelenir, parçalar atlanır.
 */
export function isSegment(url, contentType = '') {
    if (/video\/mp2t|video\/iso\.segment|audio\/mp2t/i.test(contentType)) return true;
    return ['ts', 'm4s', 'cmfv', 'cmfa'].includes(extOf(url));
}

// Canlı yayında playlist sürekli farklı sorgu dizesiyle istenir; yol ile tekilleştir.
export function dedupKey(url, kind) {
    if (kind === 'hls' || kind === 'dash') {
        try {
            const u = new URL(url);
            return u.origin + u.pathname;
        } catch (_) { /* geçersiz adres */ }
    }
    return url;
}
