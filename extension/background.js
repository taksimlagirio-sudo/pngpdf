// Arka plan servis çalışanı: yalnızca kullanıcının AÇIK OLDUĞU SEKMELERDEKİ ağ isteklerini
// izler (DevTools'un Ağ sekmesinin gördüğünün aynısı) — başka uygulamaları veya ekranı okumaz.
// Her sekme için bulunan medya adreslerini tutar; indirme/kalite seçimi popup.js'te yapılır.

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

// tabId -> Map(dedupKey -> item). HLS/DASH playlistleri sürekli yeniden istendiği için
// (canlı yayın ilerledikçe) sorgu dizesi hariç yol ile tekilleştiriliyor; diğerlerinde tam adres kullanılır.
const tabItems = new Map();

function header(headers, name) {
    const h = (headers || []).find((x) => x.name.toLowerCase() === name);
    return h ? h.value : '';
}

function classify(url, contentType) {
    for (const [re, kind] of MIME_KIND) {
        if (re.test(contentType)) return kind;
    }
    const match = url.split('?')[0].split('#')[0].match(/\.([a-z0-9]{2,5})$/i);
    if (match) return EXT_KIND[match[1].toLowerCase()] || null;
    return null;
}

// HLS/DASH parçaları (.ts, .m4s, CMAF) tek başına anlamsız ve oynatıcı saniyede bir yenisini
// istediği için listeyi doldurur; playlist'in kendisi listelenir, parçalar atlanır.
function isSegment(url, contentType) {
    if (/video\/mp2t|video\/iso\.segment|audio\/mp2t/i.test(contentType)) return true;
    const match = url.split('?')[0].split('#')[0].match(/\.([a-z0-9]{2,5})$/i);
    return Boolean(match) && ['ts', 'm4s', 'cmfv', 'cmfa'].includes(match[1].toLowerCase());
}

function dedupKey(url, kind) {
    if (kind === 'hls' || kind === 'dash') {
        try {
            const u = new URL(url);
            return u.origin + u.pathname;
        } catch (_) { /* geçersiz adres */ }
    }
    return url;
}

function addItem(tabId, entry) {
    if (!tabItems.has(tabId)) tabItems.set(tabId, new Map());
    const map = tabItems.get(tabId);
    const key = dedupKey(entry.url, entry.kind);
    const existing = map.get(key);
    if (existing) {
        existing.url = entry.url; // en güncel sorgu dizesiyle adresi tazele (canlı yayın vb.)
        existing.size = entry.size || existing.size;
        existing.lastSeen = entry.lastSeen;
        existing.seenCount += 1;
    } else {
        map.set(key, { ...entry, seenCount: 1 });
    }
}

chrome.webRequest.onCompleted.addListener(
    (details) => {
        if (details.tabId < 0) return; // sekmeyle ilişkisiz istek (uzantının kendi isteği vb.)

        const contentType = header(details.responseHeaders, 'content-type');
        const length = header(details.responseHeaders, 'content-length');
        if (isSegment(details.url, contentType)) return;
        const kind = classify(details.url, contentType);
        if (!kind) return;

        addItem(details.tabId, {
            url: details.url,
            kind,
            mime: contentType || '',
            size: Number(length) || 0,
            lastSeen: Date.now()
        });
    },
    { urls: ['http://*/*', 'https://*/*'] },
    ['responseHeaders']
);

// Sayfanın kendi script'i CORS izni olmayan bir adresi fetch ederse (sayfa JS'i gövdeyi okuyamaz,
// ama ağ isteği gerçekleşmiş olur) Chrome bunu onCompleted yerine onErrorOccurred ile bildirir.
// Başlık okuyamadığımız için yalnızca adres uzantısına göre sınıflandırıyoruz; en azından
// kullanıcı adresi görüp uzantının kendi sekmesinden (host_permissions sayesinde CORS'suz) açabilsin.
chrome.webRequest.onErrorOccurred.addListener(
    (details) => {
        if (details.tabId < 0 || details.error !== 'net::ERR_FAILED') return;
        if (isSegment(details.url, '')) return;
        const kind = classify(details.url, '');
        if (!kind) return;
        addItem(details.tabId, { url: details.url, kind, mime: '', size: 0, lastSeen: Date.now() });
    },
    { urls: ['http://*/*', 'https://*/*'] }
);

// Yeni bir üst çerçeve gezintisi başladığında önceki sayfanın bulduklarını temizle.
// webNavigation.onBeforeNavigate, o navigasyona ait ağ isteklerinden ÖNCE garanti ateşlenir;
// tabs.onUpdated('loading') ise adres doğrudan bir medya dosyasına gidiyorsa (ör. .png'yi
// sekmede açmak) isteğin TAMAMLANMASINDAN SONRA gelebiliyor ve az önce eklenen kaydı siliyordu.
chrome.webNavigation.onBeforeNavigate.addListener((details) => {
    if (details.frameId === 0) tabItems.delete(details.tabId);
});

chrome.tabs.onRemoved.addListener((tabId) => tabItems.delete(tabId));

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
    if (msg.type === 'get-items') {
        const map = tabItems.get(msg.tabId);
        sendResponse({ items: map ? [...map.values()] : [] });
        return;
    }
    if (msg.type === 'clear-items') {
        tabItems.delete(msg.tabId);
        sendResponse({ ok: true });
        return;
    }
});
