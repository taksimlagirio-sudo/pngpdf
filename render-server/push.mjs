// Web Push: telefon kilitliyken bile bildirim ("Yayın başladı", "3 yeni video indi").
// Harici paket yok: VAPID imzası (ES256) ve içerik şifrelemesi (RFC 8291, aes128gcm) Node'un
// kendi crypto modülüyle yapılır. Anahtarlar ve abonelikler sunucunun klasöründe saklanır.
import fs from 'node:fs';
import { createECDH, createPrivateKey, generateKeyPairSync, hkdfSync, randomBytes, sign, createCipheriv } from 'node:crypto';

const b64u = (buf) => Buffer.from(buf).toString('base64url');
const fromB64u = (s) => Buffer.from(String(s), 'base64url');

export function createPush({ keyFile, subsFile, subject = 'mailto:indirici@localhost' }) {
    let keys;
    try {
        keys = JSON.parse(fs.readFileSync(keyFile, 'utf8'));
    } catch (_) {
        const { privateKey } = generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
        const jwk = privateKey.export({ format: 'jwk' });
        keys = { jwk, publicKey: b64u(Buffer.concat([Buffer.from([4]), fromB64u(jwk.x), fromB64u(jwk.y)])) };
        try {
            fs.writeFileSync(keyFile, JSON.stringify(keys), { mode: 0o600 });
        } catch (_) { /* yazılamadı: anahtar bu çalışmada geçerli */ }
    }
    const privateKey = createPrivateKey({ key: keys.jwk, format: 'jwk' });

    let subs = [];
    try {
        subs = JSON.parse(fs.readFileSync(subsFile, 'utf8'));
    } catch (_) { /* henüz abonelik yok */ }
    const save = () => {
        try {
            fs.writeFileSync(subsFile, JSON.stringify(subs), { mode: 0o600 });
        } catch (_) { /* disk */ }
    };

    function vapidHeader(endpoint) {
        const aud = new URL(endpoint).origin;
        const header = b64u(JSON.stringify({ typ: 'JWT', alg: 'ES256' }));
        const claims = b64u(JSON.stringify({ aud, exp: Math.floor(Date.now() / 1000) + 12 * 3600, sub: subject }));
        const data = `${header}.${claims}`;
        const sig = sign('sha256', Buffer.from(data), { key: privateKey, dsaEncoding: 'ieee-p1363' });
        return `vapid t=${data}.${b64u(sig)}, k=${keys.publicKey}`;
    }

    /** RFC 8291: yükü aboneliğin anahtarlarıyla şifreler. */
    function encrypt(sub, payload) {
        const uaPublic = fromB64u(sub.keys.p256dh);
        const auth = fromB64u(sub.keys.auth);
        const ecdh = createECDH('prime256v1');
        const asPublic = ecdh.generateKeys();
        const shared = ecdh.computeSecret(uaPublic);
        const keyInfo = Buffer.concat([Buffer.from('WebPush: info\0'), uaPublic, asPublic]);
        const ikm = Buffer.from(hkdfSync('sha256', shared, auth, keyInfo, 32));
        const salt = randomBytes(16);
        const cek = Buffer.from(hkdfSync('sha256', ikm, salt, Buffer.from('Content-Encoding: aes128gcm\0'), 16));
        const nonce = Buffer.from(hkdfSync('sha256', ikm, salt, Buffer.from('Content-Encoding: nonce\0'), 12));
        const cipher = createCipheriv('aes-128-gcm', cek, nonce);
        const body = Buffer.concat([cipher.update(Buffer.concat([Buffer.from(payload), Buffer.from([2])])), cipher.final(), cipher.getAuthTag()]);
        const rs = Buffer.alloc(4);
        rs.writeUInt32BE(4096);
        return Buffer.concat([salt, rs, Buffer.from([asPublic.length]), asPublic, body]);
    }

    async function sendOne(sub, message) {
        const res = await fetch(sub.endpoint, {
            method: 'POST',
            headers: {
                authorization: vapidHeader(sub.endpoint),
                'content-encoding': 'aes128gcm',
                'content-type': 'application/octet-stream',
                ttl: '86400',
                urgency: 'high'
            },
            body: encrypt(sub, JSON.stringify(message)),
            signal: AbortSignal.timeout(15000)
        });
        return res.status;
    }

    // Bildirim akışı: Android uygulaması (APK) Web Push alamaz; bildirimleri bu kısa listeden dinler
    // (sunucu aynı telefonda olduğundan uzun bekleyen bir istekle, anında). Kimlikler zaman damgası:
    // sunucu yeniden başlasa da sıra bozulmaz.
    const feed = [];
    const waiters = new Set();
    let lastId = 0;
    let lastPoll = 0;
    function addFeed(message) {
        lastId = Math.max(Date.now(), lastId + 1);
        feed.push({ id: lastId, at: Date.now(), ...message });
        if (feed.length > 50) feed.shift();
        for (const wake of waiters) wake();
        waiters.clear();
    }

    return {
        publicKey: keys.publicKey,
        count: () => subs.length,
        /** APK son 90 sn içinde dinlediyse bildirimleri alıyor demektir. */
        listening: () => Date.now() - lastPoll < 90000,
        /**
         * after'dan sonraki bildirimler; yoksa wait ms'ye kadar beklenir. after < 0: yalnızca güncel
         * kimlik döner (ilk bağlantıda eski bildirimler yeniden gösterilmesin).
         */
        feed(after, wait = 0, signal = null) {
            lastPoll = Date.now();
            const pick = () => ({ last: lastId, items: after < 0 ? [] : feed.filter((i) => i.id > after) });
            const now = pick();
            if (after < 0 || now.items.length || !wait) return Promise.resolve(now);
            return new Promise((resolve) => {
                let timer = null;
                const wake = () => {
                    clearTimeout(timer);
                    waiters.delete(wake);
                    lastPoll = Date.now();
                    resolve(pick());
                };
                timer = setTimeout(wake, wait);
                waiters.add(wake);
                if (signal) signal.addEventListener('abort', wake, { once: true });
            });
        },
        subscribe(sub) {
            if (!sub || !/^https:\/\//.test(sub.endpoint || '') || !sub.keys || !sub.keys.p256dh || !sub.keys.auth) {
                throw new Error('Geçersiz abonelik');
            }
            subs = subs.filter((s) => s.endpoint !== sub.endpoint);
            subs.push({ endpoint: sub.endpoint, keys: { p256dh: sub.keys.p256dh, auth: sub.keys.auth }, at: Date.now() });
            if (subs.length > 20) subs = subs.slice(-20);
            save();
        },
        unsubscribe(endpoint) {
            subs = subs.filter((s) => s.endpoint !== endpoint);
            save();
        },
        /** Tüm aboneliklere gönderir; süresi dolmuş abonelikler (404/410) silinir. */
        async send(message) {
            addFeed(message);
            const results = await Promise.allSettled(subs.map((s) => sendOne(s, message)));
            const dead = subs.filter((_, i) => results[i].status === 'fulfilled' && [404, 410].includes(results[i].value));
            if (dead.length) {
                subs = subs.filter((s) => !dead.includes(s));
                save();
            }
            return results.filter((r) => r.status === 'fulfilled' && r.value < 300).length;
        }
    };
}
