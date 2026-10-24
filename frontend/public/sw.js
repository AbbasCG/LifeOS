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
