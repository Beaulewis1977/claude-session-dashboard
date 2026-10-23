// Service worker for the phone companion: makes it installable, and keeps the
// app shell for when the PC can't be reached. API calls are never cached.

const CACHE = 'csd-shell-v1'

self.addEventListener('install', () => self.skipWaiting())

self.addEventListener('activate', (e) => {
  e.waitUntil(
    caches
      .keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim())
  )
})

self.addEventListener('fetch', (e) => {
  const url = new URL(e.request.url)
  if (
    e.request.method !== 'GET' ||
    url.origin !== location.origin ||
    url.pathname.startsWith('/api/')
  )
    return
  const shell =
    url.pathname === '/' ||
    url.pathname.startsWith('/assets/') ||
    url.pathname.startsWith('/icons/')
  e.respondWith(
    fetch(e.request)
      .then((res) => {
        if (shell && res.ok) {
          const copy = res.clone()
          void caches.open(CACHE).then((c) => c.put(e.request, copy))
        }
        return res
      })
      .catch(() => caches.match(e.request).then((r) => r || Response.error()))
  )
})
