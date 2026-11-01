// Service worker for the phone companion: makes it installable, keeps the
// app shell for when the PC can't be reached (API calls are never cached),
// and shows push alerts (opt-in per phone).
//
// A push only says what kind of thing happened, plus an opaque reference: no
// session names, projects, paths or message text. Tapping it opens the app,
// which loads the details from the PC over Tailscale.

const CACHE = 'csd-shell-v2'

/** Same wording as PUSH_TEXT in src/shared/mobile.ts. */
const PUSH_TEXT = {
  approval: 'A session needs your approval',
  finished: 'A session finished',
  waiting: 'A session is waiting for you',
  exited: 'A session ended',
  failed: 'A session stopped with an error',
  test: 'Push alerts work on this phone'
}
const REF_RE = /^[A-Za-z0-9_-]{8,64}$/

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

/** Only `{v: 1, kind, ref?}` is accepted; anything else gets a generic text. */
function readNotice(data) {
  let n
  try {
    n = data ? data.json() : undefined
  } catch {
    return undefined
  }
  if (!n || typeof n !== 'object' || n.v !== 1 || !Object.hasOwn(PUSH_TEXT, n.kind))
    return undefined
  const ref = typeof n.ref === 'string' && REF_RE.test(n.ref) ? n.ref : undefined
  return { kind: n.kind, ref }
}

self.addEventListener('push', (e) => {
  const n = readNotice(e.data)
  // A push must always show something (browsers require it).
  e.waitUntil(
    self.registration.showNotification('Claude Session Dashboard', {
      body: n ? PUSH_TEXT[n.kind] : 'Something on your PC needs a look',
      tag: (n && (n.ref || n.kind)) || 'csd',
      icon: '/icons/icon-192.png',
      badge: '/icons/icon-192.png',
      data: n ? { kind: n.kind, ref: n.ref } : {}
    })
  )
})

self.addEventListener('notificationclick', (e) => {
  e.notification.close()
  const data = e.notification.data || {}
  const ref = typeof data.ref === 'string' && REF_RE.test(data.ref) ? data.ref : undefined
  e.waitUntil(
    self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then((list) => {
      const open = list.find((c) => new URL(c.url).origin === location.origin)
      if (open) {
        open.postMessage({ type: 'csd-open-live', ref })
        return open.focus()
      }
      return self.clients.openWindow(ref ? `/#live=${encodeURIComponent(ref)}` : '/#live')
    })
  )
})
