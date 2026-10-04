// Service worker: çevrimdışı kabuk + arka plan indirmeleri (Background Fetch)
const VERSION = 'v53';
const SHELL_CACHE = `shell-${VERSION}`;
const BG_CACHE = 'bg-downloads';
const META_PREFIX = '/__bg-meta__/';

const SHELL_FILES = [
    './',
    './index.html',
    './manifest.webmanifest',
    './assets/css/style.css',
    './assets/js/app.js',
    './assets/js/prefs.js',
    './assets/js/util.js',
    './assets/js/downloads.js',
    './assets/js/detect.js',
    './assets/js/detect-tab.js',
    './assets/js/recent.js',
    './assets/js/setup.js',
    './assets/js/library.js',
    './assets/js/library-tab.js',
    './assets/js/viewer.js',
    './assets/js/follow.js',
    './assets/js/bulk.js',
    './assets/js/subs.js',
    './assets/js/sync.js',
    './assets/js/cast.js',
    './assets/js/editor.js',
    './assets/js/anim.js',
    './assets/js/icons.js',
    './assets/js/sitesettings.js',
    './assets/js/servertools.js',
    './assets/js/mp4edit.js',
    './assets/js/images.js',
    './assets/js/settings.js',
    './assets/js/serverrec.js',
    './assets/js/zip.js',
    './assets/js/remote.js',
    './assets/js/floatbar.js',
    './assets/js/video.js',
    './assets/js/hls.js',
    './assets/js/merge.js',
    './assets/js/dash.js',
    './assets/js/mp4mux.mjs',
    './assets/js/preview.js',
    './assets/vendor/mux-mp4.min.js',
    './assets/icons/icon.svg',
    './assets/icons/icon-192.png',
    './assets/icons/icon-512.png'
];

self.addEventListener('install', (event) => {
    event.waitUntil((async () => {
        const cache = await caches.open(SHELL_CACHE);
        // Tek bir dosya 404 verirse kurulumun tamamı düşmesin.
        // cache:'reload' → tarayıcının HTTP önbelleğindeki eski kopyalar değil, sunucudaki güncel dosya.
        await Promise.all(SHELL_FILES.map((file) =>
            cache.add(new Request(file, { cache: 'reload' })).catch(() => null)));
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
    // Yalnızca uygulamanın kendi dosyaları ele alınır. Dış kaynaklar ve (uygulama kendi sunucundan
    // açıldığında) sunucunun /fetch, /sniff, /local-config gibi uç noktaları asla önbelleğe girmez.
    if (url.origin !== self.location.origin) return;
    const isAppPage = url.pathname === '/' || url.pathname.endsWith('/index.html');
    const isAppFile = (request.mode === 'navigate' && isAppPage) ||
        url.pathname.startsWith('/assets/') || url.pathname.endsWith('.webmanifest');
    if (!isAppFile) return;

    if (request.mode === 'navigate') {
        event.respondWith((async () => {
            try {
                return await fetch(request, { cache: 'no-cache' });
            } catch (_) {
                const cache = await caches.open(SHELL_CACHE);
                return (await cache.match('./index.html')) || Response.error();
            }
        })());
        return;
    }

    // Önce ağ: sayfa ile JS/CSS her zaman aynı sürümden gelsin (önbellekten eski JS + yeni sayfa
    // karışımı hatalara yol açıyordu). Çevrimdışıyken önbellekteki kopya kullanılır.
    event.respondWith((async () => {
        const cache = await caches.open(SHELL_CACHE);
        try {
            // no-cache: HTTP önbelleğinde kopya olsa bile sunucuya doğrulat (eski JS kalmasın).
            const response = await fetch(request, { cache: 'no-cache' });
            if (response.ok) cache.put(request, response.clone());
            return response;
        } catch (_) {
            return (await cache.match(request, { ignoreSearch: true })) || Response.error();
        }
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

/* ---- Takip bildirimleri (kendi sunucundan Web Push) ---- */
self.addEventListener('push', (event) => {
    let data = {};
    try {
        data = event.data ? event.data.json() : {};
    } catch (_) {
        data = { title: 'İndirici', body: event.data ? event.data.text() : '' };
    }
    event.waitUntil(self.registration.showNotification(data.title || 'İndirici', {
        body: data.body || '',
        tag: data.tag || undefined,
        renotify: Boolean(data.tag),
        icon: './assets/icons/icon-192.png',
        badge: './assets/icons/icon-192.png',
        data: { url: data.url || '#follow' }
    }));
});

self.addEventListener('notificationclick', (event) => {
    event.notification.close();
    const hash = (event.notification.data && event.notification.data.url) || '#follow';
    event.waitUntil((async () => {
        const all = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
        const client = all.find((c) => c.url.startsWith(self.registration.scope));
        if (client) {
            await client.focus();
            client.navigate(self.registration.scope + hash).catch(() => {});
        } else {
            await self.clients.openWindow('./' + hash);
        }
    })());
});
