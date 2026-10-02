// Uzantının arayüz mantığı: liste, önizleme, kalite/format seçimi, indirme, canlı yakalama.
// Sadece ana uygulamadaki saf (DOM'a dokunmayan) yardımcıları yeniden kullanıyoruz.
import { formatSize, escapeHtml, fileNameFromUrl, loadImage, drawToCanvas, canvasToBlob } from './lib/util.js';
import { parsePlaylist, findDrmSegment, hexToBytes, ivFromSequence } from './lib/playlist.js';

const KIND_META = {
    hls: { icon: '📡', label: 'HLS yayını' },
    dash: { icon: '📺', label: 'DASH (desteklenmiyor)' },
    video: { icon: '🎬', label: 'Video' },
    audio: { icon: '🎵', label: 'Ses' },
    image: { icon: '🖼️', label: 'Resim' }
};

const listEl = document.getElementById('list');
const detailEl = document.getElementById('detail');
const focusWarn = document.getElementById('focusWarn');

let tabId = null;
let items = [];
let liveCapture = null; // aktif canlı yakalama durumu (varsa)

const params = new URLSearchParams(location.search);
const isStandalone = params.has('standalone');
if (isStandalone) {
    document.body.classList.add('standalone');
    focusWarn.classList.add('hidden'); // ayrı pencere zaten odak kaybından etkilenmiyor
}

async function resolveTabId() {
    const fromParam = params.get('tabId');
    if (fromParam) return Number(fromParam);
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    return tab ? tab.id : null;
}

async function refresh() {
    tabId = await resolveTabId();
    if (!tabId) return;
    const res = await chrome.runtime.sendMessage({ type: 'get-items', tabId });
    items = (res?.items || []).sort((a, b) => b.lastSeen - a.lastSeen);
    renderList();
}

function renderList() {
    detailEl.classList.add('hidden');
    detailEl.innerHTML = '';

    if (items.length === 0) {
        listEl.innerHTML = '<div class="empty">Bu sekmede henüz medya görülmedi.<br>Sayfayı oynatın/kaydırın veya yenileyin — istekler aktığa göre burada belirecek.</div>';
        return;
    }

    listEl.innerHTML = items.map((item, i) => {
        const meta = KIND_META[item.kind] || { icon: '📄', label: item.kind };
        const sizeText = item.size ? formatSize(item.size) : '';
        return `
            <div class="item" data-i="${i}">
                <div class="item-icon">${meta.icon}</div>
                <div class="item-main">
                    <div class="item-url">${escapeHtml(shortUrl(item.url))}</div>
                    <div class="item-meta">${meta.label}${sizeText ? ' • ' + sizeText : ''}${item.seenCount > 1 ? ' • ' + item.seenCount + ' kez görüldü' : ''}</div>
                </div>
            </div>`;
    }).join('');

    listEl.querySelectorAll('.item').forEach((el) => {
        el.addEventListener('click', () => openDetail(items[Number(el.dataset.i)]));
    });
}

function shortUrl(url) {
    try {
        const u = new URL(url);
        const file = u.pathname.split('/').filter(Boolean).pop() || u.pathname;
        return `${u.hostname}/…/${decodeURIComponent(file).slice(0, 60)}`;
    } catch (_) {
        return url.slice(0, 80);
    }
}

function showDetail(html) {
    listEl.style.display = 'none';
    detailEl.classList.remove('hidden');
    detailEl.innerHTML = `<button class="detail-back" id="backBtn">← Listeye dön</button>${html}`;
    document.getElementById('backBtn').addEventListener('click', () => {
        listEl.style.display = '';
        detailEl.classList.add('hidden');
    });
}

async function openDetail(item) {
    if (item.kind === 'image') return openImageDetail(item);
    if (item.kind === 'video' || item.kind === 'audio') return openDirectMediaDetail(item);
    if (item.kind === 'dash') {
        showDetail(`
            <div class="detail-url">${escapeHtml(item.url)}</div>
            <div class="notice">📺 DASH (.mpd) yayınları bu araçta desteklenmiyor.</div>`);
        return;
    }
    if (item.kind === 'hls') return openHlsDetail(item.url);
}

/* ---------------- Doğrudan dosya (video/ses) ---------------- */

function openDirectMediaDetail(item) {
    const isVideo = item.kind === 'video';
    const name = fileNameFromUrl(item.url);
    showDetail(`
        ${isVideo
            ? `<video class="detail-preview" src="${escapeHtml(item.url)}" controls muted></video>`
            : `<audio style="width:100%" src="${escapeHtml(item.url)}" controls></audio>`}
        <div class="detail-url">${escapeHtml(item.url)}</div>
        <div class="field"><label>${item.size ? formatSize(item.size) : 'Boyut bilinmiyor'}</label></div>
        <button class="btn btn-primary" id="dlBtn">⬇️ ${escapeHtml(name)} indir</button>
        <div class="progress" id="prog"></div>
    `);
    document.getElementById('dlBtn').addEventListener('click', async () => {
        setProg('İndiriliyor (tarayıcının indirme yöneticisiyle)...');
        try {
            await chrome.downloads.download({ url: item.url, filename: name, saveAs: false });
            setProg('✅ İndirme başlatıldı — Chrome indirmelerinden takip edebilirsiniz.');
        } catch (err) {
            setProg('❌ ' + err.message);
        }
    });
}

/* ---------------- Resim: orijinal veya dönüştürülmüş indirme ---------------- */

async function openImageDetail(item) {
    showDetail(`
        <img class="detail-preview" src="${escapeHtml(item.url)}">
        <div class="detail-url">${escapeHtml(item.url)}</div>
        <button class="btn btn-secondary" id="origBtn">⬇️ Orijinali indir</button>
        <div class="field" style="margin-top:12px">
            <label>📤 Format</label>
            <select id="fmt">
                <option value="jpg">JPG</option>
                <option value="png">PNG (şeffaflık korunur)</option>
                <option value="webp">WEBP</option>
            </select>
        </div>
        <div class="field" id="qField">
            <label>🎚️ Kalite: <span id="qVal">85%</span></label>
            <input type="range" id="quality" min="10" max="100" value="85" step="5">
        </div>
        <button class="btn btn-primary" id="convBtn">🎨 Dönüştür ve indir</button>
        <div class="progress" id="prog"></div>
    `);

    const name = fileNameFromUrl(item.url);
    document.getElementById('origBtn').addEventListener('click', async () => {
        setProg('İndiriliyor...');
        await chrome.downloads.download({ url: item.url, filename: name, saveAs: false });
        setProg('✅ İndirme başlatıldı.');
    });

    const fmtSel = document.getElementById('fmt');
    const qField = document.getElementById('qField');
    const qInput = document.getElementById('quality');
    const qVal = document.getElementById('qVal');
    fmtSel.addEventListener('change', () => {
        qField.style.display = fmtSel.value === 'png' ? 'none' : 'block';
    });
    qInput.addEventListener('input', () => { qVal.textContent = qInput.value + '%'; });

    document.getElementById('convBtn').addEventListener('click', async () => {
        setProg('Dönüştürülüyor...');
        try {
            const res = await fetch(item.url); // uzantının host_permissions'ı sayesinde CORS'a takılmaz
            const blob = await res.blob();
            const img = await loadImage(blob);
            const canvas = drawToCanvas(img, 0);
            const format = fmtSel.value;
            const mime = format === 'jpg' ? 'image/jpeg' : format === 'png' ? 'image/png' : 'image/webp';

            if (mime === 'image/jpeg') {
                const ctx = canvas.getContext('2d');
                ctx.globalCompositeOperation = 'destination-over';
                ctx.fillStyle = '#ffffff';
                ctx.fillRect(0, 0, canvas.width, canvas.height);
            }

            const outBlob = await canvasToBlob(canvas, mime, format === 'png' ? undefined : Number(qInput.value) / 100);
            const outName = fileNameFromUrl(item.url, format);
            const url = URL.createObjectURL(outBlob);
            await chrome.downloads.download({ url, filename: outName, saveAs: false });
            setProg(`✅ ${formatSize(outBlob.size)} • ${canvas.width}x${canvas.height}`);
        } catch (err) {
            setProg('❌ ' + err.message);
        }
    });
}

/* ---------------- HLS: kalite seçimi, VOD indirme, canlı yakalama ---------------- */

async function openHlsDetail(url) {
    showDetail('<div class="progress">Playlist okunuyor...</div>');
    try {
        const res = await fetch(url);
        const text = await res.text();
        const playlist = parsePlaylist(text, url);

        if (playlist.type === 'master') {
            showDetail(`
                <div class="detail-url">${escapeHtml(url)}</div>
                <p style="font-size:12px;font-weight:600;margin-bottom:8px">Kalite seçin:</p>
                ${playlist.variants.map((v, i) => `
                    <button class="variant" data-i="${i}">
                        <span><strong>${escapeHtml(v.resolution || 'bilinmeyen')}</strong>${v.bandwidth ? ' • ' + (v.bandwidth / 1e6).toFixed(2) + ' Mbps' : ''}</span>
                        <span>⬇️</span>
                    </button>`).join('')}
            `);
            detailEl.querySelectorAll('.variant').forEach((el) => {
                el.addEventListener('click', () => openHlsDetail(playlist.variants[Number(el.dataset.i)].url));
            });
            return;
        }

        renderHlsMedia(url, playlist);
    } catch (err) {
        showDetail(`<div class="notice">❌ Playlist okunamadı: ${escapeHtml(err.message)}</div>`);
    }
}

function renderHlsMedia(url, playlist) {
    const drm = findDrmSegment(playlist.segments);
    const isFmp4 = Boolean(playlist.map);
    const encrypted = playlist.segments.some((s) => s.key);

    const rows = [
        ['Parça sayısı', String(playlist.segments.length)],
        ['Kapsayıcı', isFmp4 ? 'fMP4 (.mp4)' : 'MPEG-TS (.ts)'],
        ['Şifreleme', drm ? drm.key.method : encrypted ? 'AES-128 (çözülebilir)' : 'yok'],
        ['Yayın tipi', playlist.isLive ? 'Canlı' : 'VOD (tamamlanmış)']
    ];

    let actions = '';
    if (drm) {
        actions = `<div class="notice">🔒 Bu yayın DRM korumalı (${escapeHtml(drm.key.method)}); indirilemez.</div>`;
    } else if (playlist.isLive) {
        actions = `
            <div class="notice" style="background:#eef2ff;border-color:#c7d2fe;color:#3730a3">
                🔴 Canlı yayın. "Şu andan itibaren kaydet" bastığınız andan itibaren yeni parçaları toplar;
                durdurduğunuzda o ana kadar kaydedileni indirir. Geçmişe dönük kayıt alamaz.
            </div>
            <button class="btn btn-primary" id="liveBtn">🔴 Şu andan itibaren kaydet</button>`;
    } else {
        actions = `<button class="btn btn-primary" id="vodBtn">⬇️ İndir (${isFmp4 ? 'mp4' : 'ts'})</button>`;
    }

    showDetail(`
        <div class="detail-url">${escapeHtml(url)}</div>
        ${rows.map(([k, v]) => `<div class="item-meta" style="margin-bottom:4px"><strong>${k}:</strong> ${escapeHtml(v)}</div>`).join('')}
        ${actions}
        <div class="progress" id="prog"></div>
    `);

    const vodBtn = document.getElementById('vodBtn');
    if (vodBtn) vodBtn.addEventListener('click', () => downloadHlsVod(url, playlist));

    const liveBtn = document.getElementById('liveBtn');
    if (liveBtn) liveBtn.addEventListener('click', () => toggleLiveCapture(url, liveBtn));
}

async function fetchSegmentBytes(segment, keyCache) {
    const init = {};
    if (segment.range) {
        init.headers = { Range: `bytes=${segment.range.offset}-${segment.range.offset + segment.range.length - 1}` };
    }
    let lastError;
    for (let attempt = 1; attempt <= 3; attempt++) {
        try {
            const res = await fetch(segment.url, init);
            const buf = new Uint8Array(await res.arrayBuffer());
            if (!segment.key) return buf;
            return await decryptSegment(buf, segment, keyCache);
        } catch (err) {
            lastError = err;
            await new Promise((r) => setTimeout(r, 350 * attempt));
        }
    }
    throw new Error('Parça indirilemedi: ' + (lastError ? lastError.message : 'bilinmeyen hata'));
}

async function decryptSegment(buffer, segment, keyCache) {
    const { key } = segment;
    if (!keyCache.has(key.uri)) {
        const res = await fetch(key.uri);
        const raw = new Uint8Array(await res.arrayBuffer());
        keyCache.set(key.uri, await crypto.subtle.importKey('raw', raw, 'AES-CBC', false, ['decrypt']));
    }
    const iv = key.iv ? hexToBytes(key.iv) : ivFromSequence(segment.seq);
    const plain = await crypto.subtle.decrypt({ name: 'AES-CBC', iv }, keyCache.get(key.uri), buffer);
    return new Uint8Array(plain);
}

async function downloadHlsVod(sourceUrl, playlist) {
    const prog = document.getElementById('prog');
    const isFmp4 = Boolean(playlist.map);
    const ext = isFmp4 ? 'mp4' : 'ts';
    const mime = isFmp4 ? 'video/mp4' : 'video/mp2t';
    const keyCache = new Map();
    const parts = new Array(playlist.segments.length);
    let done = 0;
    let cursor = 0;

    prog.textContent = `0/${playlist.segments.length} parça...`;

    const initPart = playlist.map ? await fetchSegmentBytes({ url: playlist.map.url, range: playlist.map.range, key: null }, keyCache) : null;

    const worker = async () => {
        for (;;) {
            const i = cursor++;
            if (i >= playlist.segments.length) return;
            parts[i] = await fetchSegmentBytes(playlist.segments[i], keyCache);
            done++;
            prog.textContent = `${done}/${playlist.segments.length} parça...`;
        }
    };
    await Promise.all(Array.from({ length: Math.min(4, playlist.segments.length) }, worker));

    const blobParts = initPart ? [initPart, ...parts] : parts;
    const blob = new Blob(blobParts, { type: mime });
    const name = fileNameFromUrl(sourceUrl, ext);
    await chrome.downloads.download({ url: URL.createObjectURL(blob), filename: name, saveAs: false });
    prog.textContent = `✅ ${formatSize(blob.size)} indirildi.`;
}

function toggleLiveCapture(mediaUrl, button) {
    if (liveCapture) {
        stopLiveCapture('Kullanıcı durdurdu');
        return;
    }

    const isFmp4Ref = { current: false };
    liveCapture = {
        mediaUrl,
        keyCache: new Map(),
        parts: [],
        initDone: false,
        lastSeq: -1,
        bytes: 0,
        timer: null,
        isFmp4Ref
    };
    button.textContent = '⏹️ Kaydı bitir ve indir';
    button.classList.remove('btn-primary');
    button.classList.add('btn-danger');
    pollLive();
}

async function pollLive() {
    const state = liveCapture;
    if (!state) return;
    const prog = document.getElementById('prog');

    try {
        const res = await fetch(state.mediaUrl);
        const text = await res.text();
        const playlist = parsePlaylist(text, state.mediaUrl);

        if (playlist.type === 'media') {
            const drm = findDrmSegment(playlist.segments);
            if (drm) return stopLiveCapture(`DRM algılandı (${drm.key.method}), durduruldu`);

            state.isFmp4Ref.current = Boolean(playlist.map);
            if (!state.initDone && playlist.map) {
                const initPart = await fetchSegmentBytes({ url: playlist.map.url, range: playlist.map.range, key: null }, state.keyCache);
                state.parts.push(initPart);
                state.bytes += initPart.length;
                state.initDone = true;
            }

            for (const seg of playlist.segments) {
                if (seg.seq <= state.lastSeq) continue;
                const data = await fetchSegmentBytes(seg, state.keyCache);
                state.parts.push(data);
                state.bytes += data.length;
                state.lastSeq = seg.seq;
            }
        }

        if (prog) prog.textContent = `🔴 Kaydediliyor... ${formatSize(state.bytes)} toplandı.`;

        const intervalMs = Math.min(15000, Math.max(2000, (playlist.targetDuration || 4) * 1000));
        state.timer = setTimeout(pollLive, intervalMs);
    } catch (err) {
        if (prog) prog.textContent = `⚠️ Geçici hata, tekrar denenecek: ${err.message}`;
        state.timer = setTimeout(pollLive, 4000);
    }
}

async function stopLiveCapture(reason) {
    const state = liveCapture;
    if (!state) return;
    liveCapture = null;
    if (state.timer) clearTimeout(state.timer);

    const prog = document.getElementById('prog');
    if (state.parts.length === 0) {
        if (prog) prog.textContent = `⏹️ ${reason} — kaydedilen veri yok.`;
        return;
    }

    const ext = state.isFmp4Ref.current ? 'mp4' : 'ts';
    const mime = state.isFmp4Ref.current ? 'video/mp4' : 'video/mp2t';
    const blob = new Blob(state.parts, { type: mime });
    const name = `canli-yakalama-${Date.now()}.${ext}`;
    await chrome.downloads.download({ url: URL.createObjectURL(blob), filename: name, saveAs: false });
    if (prog) prog.textContent = `✅ ${reason} — ${formatSize(blob.size)} indirildi.`;
}

function setProg(text) {
    const el = document.getElementById('prog');
    if (el) el.textContent = text;
}

/* ---------------- Üst çubuk düğmeleri ---------------- */

document.getElementById('refreshBtn').addEventListener('click', refresh);
document.getElementById('clearBtn').addEventListener('click', async () => {
    await chrome.runtime.sendMessage({ type: 'clear-items', tabId });
    items = [];
    renderList();
});
document.getElementById('openWindowBtn').addEventListener('click', async () => {
    const id = tabId || await resolveTabId();
    chrome.windows.create({
        url: chrome.runtime.getURL(`popup.html?standalone=1&tabId=${id}`),
        type: 'popup',
        width: 440,
        height: 680
    });
    if (!isStandalone) window.close();
});

refresh();
