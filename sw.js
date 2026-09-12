// Service worker: çevrimdışı kabuk + arka plan indirmeleri (Background Fetch)
const VERSION = 'v3';
const SHELL_CACHE = `shell-${VERSION}`;
const BG_CACHE = 'bg-downloads';
const META_PREFIX = '/__bg-meta__/';

const SHELL_FILES = [
    './',
    './index.html',
    './manifest.webmanifest',
    './assets/css/style.css',
    './assets/js/app.js',
    './assets/js/util.js',
    './assets/js/downloads.js',
    './assets/js/detect.js',
    './assets/js/detect-tab.js',
    './assets/js/floatbar.js',
    './assets/js/pdf.js',
    './assets/js/image.js',
    './assets/js/video.js',
    './assets/js/hls.js',
    './assets/icons/icon-192.png',
    './assets/icons/icon-512.png'
];

self.addEventListener('install', (event) => {
    event.waitUntil((async () => {
        const cache = await caches.open(SHELL_CACHE);
        // Tek bir dosya 404 verirse kurulumun tamamı düşmesin.
        await Promise.all(SHELL_FILES.map((file) => cache.add(file).catch(() => null)));
        await self.skipWaiting();
    })());
});

self.addEventListener('activate', (event) => {
    event.waitUntil((async () => {
        const names = await caches.keys();
        await Promise.all(
            names.filter((n) => n.startsWith('shell-') && n !== SHELL_CACHE).map((n) => caches.delete(n))
        );
        await self.clients.claim();
    })());
});

self.addEventListener('message', (event) => {
    if (event.data === 'SKIP_WAITING') self.skipWaiting();
});

self.addEventListener('fetch', (event) => {
    const { request } = event;
    if (request.method !== 'GET') return;

    const url = new URL(request.url);
    // Proxy ve dış kaynaklar asla önbelleğe alınmaz (indirilen videolar kotayı doldurur).
    if (url.origin !== self.location.origin || url.pathname.startsWith('/api/')) return;

    if (request.mode === 'navigate') {
        event.respondWith((async () => {
            try {
                return await fetch(request);
            } catch (_) {
                const cache = await caches.open(SHELL_CACHE);
                return (await cache.match('./index.html')) || Response.error();
            }
        })());
        return;
    }

    event.respondWith((async () => {
        const cache = await caches.open(SHELL_CACHE);
        const cached = await cache.match(request, { ignoreSearch: true });
        const network = fetch(request)
            .then((response) => {
                if (response.ok) cache.put(request, response.clone());
                return response;
            })
            .catch(() => null);
        return cached || (await network) || Response.error();
    })());
});

/* ---------------- Arka plan indirme ---------------- */

async function notifyClients(message) {
    const clients = await self.clients.matchAll({ includeUncontrolled: true, type: 'window' });
    clients.forEach((client) => client.postMessage(message));
}

self.addEventListener('backgroundfetchsuccess', (event) => {
    const bgFetch = event.registration;
    event.waitUntil((async () => {
        try {
            const cache = await caches.open(BG_CACHE);
            const records = await bgFetch.matchAll();
            const urls = [];

            for (const record of records) {
                const response = await record.responseReady;
                await cache.put(record.request.url, response.clone());
                urls.push(record.request.url);
            }

            const meta = {
                id: bgFetch.id,
                name: bgFetch.id.split('::').slice(1).join('::') || 'indirilen-dosya',
                urls,
                size: bgFetch.downloaded,
                finishedAt: Date.now()
            };
            await cache.put(
                META_PREFIX + encodeURIComponent(bgFetch.id),
                new Response(JSON.stringify(meta), { headers: { 'content-type': 'application/json' } })
            );

            // updateUI yalnızca olay nesnesinde bulunur ve her sürümde olmayabilir.
            if (typeof event.updateUI === 'function') {
                await event.updateUI({ title: `İndirildi: ${meta.name} — kaydetmek için dokunun` });
            }
            await notifyClients({ type: 'bg-download-ready', meta });
        } catch (err) {
            await notifyClients({ type: 'bg-download-failed', id: bgFetch.id, error: String(err) });
        }
    })());
});

self.addEventListener('backgroundfetchfail', (event) => {
    event.waitUntil(notifyClients({ type: 'bg-download-failed', id: event.registration.id }));
});

self.addEventListener('backgroundfetchabort', (event) => {
    event.waitUntil(notifyClients({ type: 'bg-download-aborted', id: event.registration.id }));
});

// Sistem çubuğundaki indirmeye dokunulduğunda uygulamayı öne getir.
self.addEventListener('backgroundfetchclick', (event) => {
    event.waitUntil((async () => {
        const clients = await self.clients.matchAll({ includeUncontrolled: true, type: 'window' });
        const client = clients.find((c) => c.url.includes(self.location.origin));
        if (client) {
            await client.focus();
        } else {
            await self.clients.openWindow('./');
        }
    })());
});
