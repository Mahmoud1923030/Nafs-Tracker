// =========================================================================
//  Nafs Tracker – Service Worker
//  Auto-update: skipWaiting immediately so new versions activate instantly.
//  ➜ Bump VERSION below whenever static files change to trigger an update.
// =========================================================================
const VERSION = 29;
const CACHE_NAME = `nafs-tracker-v${VERSION}`;
const CDN_CACHE = `nafs-cdn-v${VERSION}`;

const STATIC_ASSETS = [
    '/',
    '/index.html',
    '/app.js',
    '/js/constants/azkar-data.js',
    '/js/constants/quran-data.js',
    '/js/constants/islamic-data.js',
    '/styles.css',
    '/styles-tw.css',
    '/_mobile_fix.css',
    '/manifest.json',
    '/404.html',
    '/robots.txt',
    '/icons/icon-192.png',
    '/icons/icon-512.png'
];

const CDN_URLS = [
    'https://fonts.googleapis.com/css2?family=Tajawal:wght@400;500;700;900&family=Amiri:wght@400;700&family=Amiri+Quran&family=Scheherazade+New:wght@400;700&display=swap',
    'https://cdnjs.cloudflare.com/ajax/libs/font-awesome/6.0.0-beta3/css/all.min.css',
    'https://cdn.jsdelivr.net/npm/chart.js@4.4.0/dist/chart.umd.min.js'
];

// Hostnames that should always go to network (bypass cache)
const NETWORK_ONLY_HOSTS = [
    'firebaseapp.com',
    'firebaseio.com',
    'firestore.googleapis.com',
    'identitytoolkit.googleapis.com',
    'securetoken.googleapis.com',
    'googleapis.com',
    'firebase-settings.crashlytics.com',
    'alquran.cloud',
    'aladhan.com',
    'mp3quran.net',
    'tvquran.com',
    'cdn.islamic.network',
    'quranicaudio.com',
    'download.quranicaudio.com',
    'api.sunnah.com',
    'api.emailjs.com',
    'emailjs.com'
];

// Hostnames that should be cache-first (CDN assets)
const CDN_CACHE_HOSTS = [
    'cdnjs.cloudflare.com',
    'cdn.jsdelivr.net',
    'fonts.googleapis.com',
    'fonts.gstatic.com'
];

// ---- Install ----
self.addEventListener('install', event => {
    event.waitUntil(
        Promise.all([
            caches.open(CACHE_NAME).then(cache =>
                cache.addAll(STATIC_ASSETS).catch(err =>
                    console.warn('[SW] Static cache partial failure:', err)
                )
            ),
            caches.open(CDN_CACHE).then(cache =>
                Promise.allSettled(CDN_URLS.map(url =>
                    fetch(url, { mode: 'cors', credentials: 'omit' })
                        .then(res => { if (res.ok) cache.put(url, res); })
                        .catch(() => { /* CDN may be unreachable during install */ })
                ))
            )
        ]).then(() => {
            // Auto-activate new version immediately
            self.skipWaiting();
        })
    );
});

// ---- Activate: clean old caches, claim clients, notify them ----
self.addEventListener('activate', event => {
    event.waitUntil(
        caches.keys().then(keys =>
            Promise.all(
                keys.filter(k => k !== CACHE_NAME && k !== CDN_CACHE).map(k => caches.delete(k))
            )
        ).then(() => self.clients.claim())
            .then(() => {
                // Tell all clients the new SW is active → reload if needed
                self.clients.matchAll({ type: 'window' }).then(clients =>
                    clients.forEach(c => c.postMessage({ type: 'SW_ACTIVATED', version: VERSION }))
                );
            })
    );
});

// ---- Fetch strategy ----
self.addEventListener('fetch', event => {
    const url = new URL(event.request.url);

    // Skip non-GET requests
    if (event.request.method !== 'GET') return;

    // Skip non-http schemes
    if (!url.protocol.startsWith('http')) return;

    // Navigation requests (HTML pages) → always network-first, never serve stale
    if (event.request.mode === 'navigate') {
        event.respondWith(
            fetch(event.request).catch(() =>
                caches.match('/index.html').then(c => c || offlineFallback())
            )
        );
        return;
    }

    // fonts.gstatic.com → cache-first (check BEFORE general gstatic.com)
    if (url.hostname === 'fonts.gstatic.com') {
        event.respondWith(cdnCacheFirst(event.request));
        return;
    }

    // General gstatic.com (non-font) → network only
    if (url.hostname.includes('gstatic.com')) return;

    // Network-only hosts (Firebase, APIs, audio)
    for (const host of NETWORK_ONLY_HOSTS) {
        if (url.hostname.includes(host)) return;
    }

    // CDN assets → cache-first
    for (const host of CDN_CACHE_HOSTS) {
        if (url.hostname.includes(host)) {
            event.respondWith(cdnCacheFirst(event.request));
            return;
        }
    }

    // Local assets → network-first with offline fallback
    if (url.origin === self.location.origin) {
        event.respondWith(networkFirstLocal(event.request));
        return;
    }
});

// ---- Cache strategies ----
function cdnCacheFirst(request) {
    return caches.open(CDN_CACHE).then(cache =>
        cache.match(request).then(cached => {
            if (cached) return cached;
            return fetch(request).then(response => {
                if (response.ok) cache.put(request, response.clone());
                return response;
            }).catch(() => cached || offlineFallback());
        })
    );
}

function networkFirstLocal(request) {
    return fetch(request)
        .then(response => {
            if (response.ok) {
                const clone = response.clone();
                caches.open(CACHE_NAME).then(cache => cache.put(request, clone));
            }
            return response;
        })
        .catch(() =>
            caches.match(request).then(cached => cached || offlineFallback())
        );
}

function offlineFallback() {
    return caches.match('/index.html').then(cached => {
        if (cached) return cached;
        return new Response(
            '<html dir="rtl" lang="ar"><head><meta charset="utf-8"><title>غير متصل</title></head><body style="background:#081f16;color:#c9a84c;display:flex;align-items:center;justify-content:center;height:100vh;font-family:Tajawal,sans-serif;text-align:center"><div><h1 style="font-size:2rem">📵 غير متصل بالإنترنت</h1><p style="opacity:0.7">يرجى التحقق من اتصالك بالإنترنت</p></div></body></html>',
            { headers: { 'Content-Type': 'text/html; charset=utf-8' } }
        );
    });
}

// ---- Push Notifications ----
self.addEventListener('push', event => {
    let data = { title: 'Nafs Tracker', body: 'وقت الذكر 🤲', icon: '/icons/icon-192.png' };
    try {
        if (event.data) data = { ...data, ...event.data.json() };
    } catch (e) {
        if (event.data) data.body = event.data.text();
    }

    event.waitUntil(
        self.registration.showNotification(data.title, {
            body: data.body,
            icon: data.icon || '/icons/icon-192.png',
            badge: '/icons/icon-192.png',
            vibrate: [200, 100, 200],
            dir: 'rtl',
            lang: 'ar',
            tag: data.tag || 'nafs-notification',
            renotify: true,
            data: data.url || '/'
        })
    );
});

// ---- Notification Click ----
self.addEventListener('notificationclick', event => {
    event.notification.close();
    const targetUrl = event.notification.data || '/';

    event.waitUntil(
        self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then(clients => {
            for (const client of clients) {
                if (client.url.includes(self.location.origin) && 'focus' in client) {
                    return client.focus();
                }
            }
            return self.clients.openWindow(targetUrl);
        })
    );
});

// ---- Background Sync ----
self.addEventListener('sync', event => {
    if (event.tag === 'sync-data') {
        event.waitUntil(
            self.clients.matchAll().then(clients => {
                clients.forEach(client => client.postMessage({ type: 'SYNC_DATA' }));
            })
        );
    }
});

// ---- Message handler ----
self.addEventListener('message', event => {
    if (event.data && event.data.type === 'SKIP_WAITING') {
        self.skipWaiting();
    }
});
