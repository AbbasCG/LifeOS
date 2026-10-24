/* LifeOS service worker.
 * Security: never caches /api, /sanctum or any non-GET request, so authenticated data is never stored here.
 * Caches only the public app shell (index.html), hashed build assets, fonts and icons.
 * The version comes from the registration URL (?v=<build id>); a new build installs a new worker,
 * which waits until the page asks it to take over (update prompt), then old caches are removed. */
const VERSION = new URL(self.location.href).searchParams.get('v') || 'dev'
const SHELL_CACHE = `lifeos-shell-${VERSION}`
const ASSET_CACHE = `lifeos-assets-${VERSION}`
const SHELL_URLS = ['/', '/offline.html', '/manifest.webmanifest', '/icons/icon-192.png', '/icons/icon.svg']

self.addEventListener('install', event => {
  event.waitUntil(caches.open(SHELL_CACHE).then(cache => cache.addAll(SHELL_URLS)))
})

self.addEventListener('activate', event => {
  event.waitUntil((async () => {
    const keep = new Set([SHELL_CACHE, ASSET_CACHE])
    for (const key of await caches.keys()) {
      if (key.startsWith('lifeos-') && !keep.has(key)) await caches.delete(key)
    }
    await self.clients.claim()
  })())
})

self.addEventListener('message', event => {
  if (event.data && event.data.type === 'SKIP_WAITING') self.skipWaiting()
})

function isPrivate(url) {
  return url.pathname.startsWith('/api') || url.pathname.startsWith('/sanctum') || url.pathname.startsWith('/up')
}

self.addEventListener('fetch', event => {
  const request = event.request
  const url = new URL(request.url)
  if (request.method !== 'GET' || url.origin !== self.location.origin || isPrivate(url)) return

  if (request.mode === 'navigate') {
    // Network first so users always get the latest shell; fall back to the cached shell, then the offline page.
    event.respondWith((async () => {
      try {
        const response = await fetch(request)
        if (response.ok) (await caches.open(SHELL_CACHE)).put('/', response.clone())
        return response
      } catch {
        return (await caches.match('/')) || (await caches.match('/offline.html')) || Response.error()
      }
    })())
    return
  }

  if (url.pathname.startsWith('/assets/') || url.pathname.startsWith('/icons/') || /\.(woff2?|svg|png|webmanifest)$/.test(url.pathname)) {
    // Hashed or static files: cache first.
    event.respondWith((async () => {
      const cached = await caches.match(request)
      if (cached) return cached
      const response = await fetch(request)
      if (response.ok && response.type === 'basic') (await caches.open(ASSET_CACHE)).put(request, response.clone())
      return response
    })())
  }
})

/* Browser push. The payload is encrypted end-to-end by the server (RFC 8291); it contains only a title, short
 * body and an in-app link. Links are restricted to this origin. */
self.addEventListener('push', event => {
  let data = {}
  try { data = event.data ? event.data.json() : {} } catch { data = { title: event.data ? event.data.text() : 'LifeOS' } }
  const title = typeof data.title === 'string' && data.title ? data.title : 'LifeOS'
  event.waitUntil(self.registration.showNotification(title, {
    body: typeof data.body === 'string' ? data.body : '',
    tag: typeof data.tag === 'string' ? data.tag : undefined,
    icon: '/icons/icon-192.png',
    badge: '/icons/icon-192.png',
    data: { link: typeof data.link === 'string' && data.link.startsWith('/') && !data.link.startsWith('//') ? data.link : '/' },
  }))
})

self.addEventListener('notificationclick', event => {
  event.notification.close()
  const target = new URL(event.notification.data && event.notification.data.link || '/', self.location.origin).href
  event.waitUntil((async () => {
    const windows = await self.clients.matchAll({ type: 'window', includeUncontrolled: true })
    const existing = windows.find(client => new URL(client.url).origin === self.location.origin)
    if (existing) { await existing.focus(); if ('navigate' in existing) await existing.navigate(target); return }
    await self.clients.openWindow(target)
  })())
})

self.addEventListener('pushsubscriptionchange', event => {
  // The browser rotated the subscription; the app re-registers it the next time it opens.
  event.waitUntil(Promise.resolve())
})
