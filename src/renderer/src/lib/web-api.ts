// The phone's transport: the same CsdApi the desktop window gets over IPC,
// here over HTTPS (JSON) and a WebSocket for live updates. The PC only answers
// what its allow-list permits; desktop-only features say so instead.

import type { CsdApi } from '@shared/api'
import type {
  MobileEvent,
  MobileMe,
  RemoteLaunchPreview,
  RemoteLaunchRequest,
  RemoteLaunchResult
} from '@shared/mobile'
import type { SessionsPayload } from '@shared/types'
import { sessionToMarkdown } from '@shared/markdown'
import { writeClipboard } from './clipboard'

const TOKEN_KEY = 'csd.mobile.token'

function readToken(): string | null {
  try {
    return localStorage.getItem(TOKEN_KEY)
  } catch {
    return null
  }
}

let token = readToken()

function saveToken(t: string | null): void {
  token = t
  try {
    if (t) localStorage.setItem(TOKEN_KEY, t)
    else localStorage.removeItem(TOKEN_KEY)
  } catch {
    // Private mode: stays paired until the tab closes.
  }
}

export class HttpError extends Error {
  constructor(
    readonly status: number,
    message: string
  ) {
    super(message)
  }
}

type Channel = Extract<MobileEvent, { type: 'event' }>['channel']
type Conn = 'connecting' | 'live' | 'offline'

const listeners = new Map<Channel, Set<() => void>>()
const toastListeners = new Set<(t: { title: string; body?: string }) => void>()
const authListeners = new Set<(paired: boolean) => void>()
const connListeners = new Set<(c: Conn) => void>()
let conn: Conn = 'offline'

function setConn(c: Conn): void {
  conn = c
  connListeners.forEach((cb) => cb(c))
}

function unpaired(): void {
  saveToken(null)
  ws?.close()
  authListeners.forEach((cb) => cb(false))
}

async function request<T>(path: string, body?: unknown): Promise<T> {
  const res = await fetch(path, {
    method: body === undefined ? 'GET' : 'POST',
    headers: {
      ...(body === undefined ? {} : { 'Content-Type': 'application/json' }),
      ...(token ? { Authorization: `Bearer ${token}` } : {})
    },
    body: body === undefined ? undefined : JSON.stringify(body),
    cache: 'no-store',
    credentials: 'omit'
  })
  if (!res.ok) {
    const msg = await res
      .json()
      .then((j: { error?: string }) => j.error)
      .catch(() => undefined)
    if (res.status === 401) unpaired()
    throw new HttpError(res.status, msg ?? `The PC answered ${res.status}`)
  }
  return (await res.json()) as T
}

function rpc<T>(method: string, ...args: unknown[]): Promise<T> {
  return request<T>('/api/rpc', { method, args })
}

const onPc = (what: string) => (): Promise<never> =>
  Promise.reject(new Error(`${what} is only available in the app on your PC.`))

function subscribe(channel: Channel, cb: () => void): () => void {
  const set = listeners.get(channel) ?? new Set()
  set.add(cb)
  listeners.set(channel, set)
  return () => set.delete(cb)
}

function fire(channel?: Channel): void {
  for (const [ch, set] of listeners) if (!channel || ch === channel) set.forEach((cb) => cb())
}

// ------------------------------------------------------------ WebSocket

let ws: WebSocket | undefined
let retry = 0
let retryTimer: number | undefined
let pollTimer: number | undefined

function connect(): void {
  if (!token || ws) return
  window.clearTimeout(retryTimer)
  setConn('connecting')
  const url = `${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}/api/ws`
  let socket: WebSocket
  try {
    socket = new WebSocket(url)
  } catch {
    scheduleReconnect()
    return
  }
  ws = socket
  socket.onopen = () => socket.send(JSON.stringify({ type: 'auth', token }))
  socket.onmessage = (m) => {
    let ev: MobileEvent
    try {
      ev = JSON.parse(String(m.data)) as MobileEvent
    } catch {
      return
    }
    if (ev.type === 'ready') {
      retry = 0
      window.clearInterval(pollTimer)
      pollTimer = undefined
      setConn('live')
      // Catch up on anything missed while disconnected.
      fire()
    } else if (ev.type === 'event') fire(ev.channel)
    else if (ev.type === 'toast') toastListeners.forEach((cb) => cb(ev))
    else if (ev.type === 'revoked') unpaired()
  }
  socket.onclose = (e) => {
    ws = undefined
    if (e.code === 4401 || e.code === 4403) {
      // The token isn't valid: check with a normal request (401 unpairs).
      void request('/api/me').catch(() => undefined)
      setConn('offline')
      return
    }
    scheduleReconnect()
  }
}

function scheduleReconnect(): void {
  setConn('offline')
  if (!token) return
  retry++
  // WebSockets can be blocked (e.g. a self-signed certificate on iOS): poll instead.
  if (retry >= 3 && !pollTimer) pollTimer = window.setInterval(() => fire(), 20_000)
  retryTimer = window.setTimeout(connect, Math.min(30_000, 1000 * 2 ** Math.min(retry, 5)))
}

document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'visible' && token && !ws) {
    retry = 0
    connect()
  }
})

// ------------------------------------------------------------ the API

let sessionsLoading: Promise<SessionsPayload> | undefined
function loadSessions(): Promise<SessionsPayload> {
  sessionsLoading ??= rpc<SessionsPayload>('getSessions').finally(() => {
    sessionsLoading = undefined
  })
  return sessionsLoading
}

function download(name: string, text: string, type: string): void {
  const url = URL.createObjectURL(new Blob([text], { type }))
  const a = document.createElement('a')
  a.href = url
  a.download = name
  a.click()
  setTimeout(() => URL.revokeObjectURL(url), 5000)
}

export const webApi: CsdApi = {
  remote: true,
  getInfo: () => rpc('getInfo'),
  getSessions: () => loadSessions(),
  onSessionsChanged: (cb) => subscribe('sessions', () => void loadSessions().then(cb)),
  getSession: (key) => rpc('getSession', key),
  search: (q) => rpc('search', q),
  updateMeta: (key, patch) => rpc('updateMeta', key, patch),
  // One name at a time, through the same checks as any other edit from a phone.
  applyClaudeNames: async (keys) => {
    let n = 0
    for (const key of keys) if (await rpc('updateMeta', key, { name: '' })) n++
    return n
  },
  rescan: async () => fire('sessions'),

  getSettings: () => rpc('getSettings'),
  updateSettings: (patch) => rpc('updateSettings', patch),
  addExtraFolder: onPc('Adding folders'),
  removeExtraFolder: onPc('Removing folders'),
  getArchiveStats: onPc('The archive'),
  importClaudeAi: onPc('Importing'),
  openArchiveFolder: onPc('Opening folders'),
  showSessionFile: onPc('Showing files'),
  openClaudeSettings: onPc('Opening folders'),

  previewLaunch: onPc('This launch dialog'),
  launch: onPc('This launch dialog'),
  pickCwd: onPc('Choosing a folder'),

  exportMarkdown: async (key) => {
    const d = await rpc<Parameters<typeof sessionToMarkdown>[0] | null>('getSession', key)
    if (!d) return { saved: false, error: 'Session not found' }
    const name = (d.summary.title || 'session').replace(/[<>:"/\\|?*]+/g, ' ').slice(0, 80)
    download(`${name}.md`, sessionToMarkdown(d), 'text/markdown')
    return { saved: true }
  },
  copyText: (text) => writeClipboard(text),
  setTheme: async () => undefined,
  openExternal: async (url) => {
    if (/^https:\/\//i.test(url)) window.open(url, '_blank', 'noopener,noreferrer')
  },

  getUsageReport: (q) => rpc('getUsageReport', q),
  getSessionUsage: (key) => rpc('getSessionUsage', key),
  getUsageStatus: () => rpc('getUsageStatus'),
  onUsageChanged: (cb) => subscribe('usage', cb),
  recalculateUsage: onPc('Recalculating usage'),
  exportUsageCsv: onPc('CSV export'),
  verifyCcusage: onPc('ccusage'),
  getTrends: (g) => rpc('getTrends', g),
  compareTrends: (a, b) => rpc('compareTrends', a, b),

  getLimits: () => rpc('getLimits'),
  compareHealth: (k, a, b) => rpc('compareHealth', k, a, b),
  onLimitsChanged: (cb) => subscribe('limits', cb),
  planBridge: onPc('Live limits setup'),
  applyBridge: onPc('Live limits setup'),
  openBackupFolder: onPc('Opening folders'),

  getCredits: () => rpc('getCredits'),
  onCreditsChanged: (cb) => subscribe('credits', cb),
  addAccount: onPc('API keys'),
  renameAccount: onPc('API keys'),
  removeAccount: onPc('API keys'),
  addGrant: onPc('Credits'),
  removeGrant: onPc('Credits'),
  refreshAdmin: onPc('Admin reports'),

  askStatus: async () => ({ available: false, simulated: false }),
  askPreview: onPc('Ask Claude'),
  askRun: onPc('Ask Claude'),
  askCancel: async () => undefined,
  askHistory: async () => [],

  toggleMiniMeter: onPc('The mini meter'),
  rescanLimits: onPc('Rescanning'),
  closeMiniMeter: async () => undefined,
  setTrayImage: async () => undefined,
  onShowUsage: () => () => undefined,

  mobileStatus: onPc('Phone settings'),
  mobileUpdate: onPc('Phone settings'),
  mobileStart: onPc('Phone settings'),
  mobileStop: onPc('Phone settings'),
  mobileRetryServe: onPc('Phone settings'),
  mobilePair: onPc('Pairing'),
  mobileCancelPair: onPc('Pairing'),
  mobileRevoke: onPc('Phone settings'),
  mobileRenameDevice: onPc('Phone settings'),
  mobileActivity: onPc('The activity log'),
  mobileSendTest: onPc('Phone settings'),
  mobileLanAddresses: onPc('Phone settings'),
  mobileClaudeCheck: onPc('Phone settings'),
  mobileDiagnostics: onPc('Phone settings'),
  mobileFirewallAdd: onPc('Phone settings'),
  mobileFirewallRemove: onPc('Phone settings'),
  tailscaleInstall: onPc('Tailscale setup'),
  tailscaleLogin: onPc('Tailscale setup'),
  openTailscaleLink: onPc('Tailscale setup'),
  onMobileChanged: () => () => undefined,

  terminalStatus: onPc('Terminal access setup'),
  terminalPrepare: onPc('Terminal access setup'),
  terminalApply: onPc('Terminal access setup'),
  terminalHistory: onPc('The terminal access log'),
  terminalListen: onPc('Terminal access setup'),
  terminalRejectKey: onPc('Terminal access setup'),
  terminalDiagnostics: onPc('Terminal access setup'),
  terminalOpenBackups: onPc('Opening folders'),
  onTerminalChanged: () => () => undefined,
  getTerminalAccess: () => rpc('getTerminalAccess'),
  openTerminalHere: onPc('Opening a terminal on the PC'),

  getLive: () => rpc('getLive'),
  onLiveChanged: (cb) => subscribe('live', cb),
  // A tapped push alert arrives through phone.onOpenLive instead.
  onShowLive: () => () => undefined,
  focusTerminal: onPc('Focusing a terminal'),
  planHooks: onPc('Session alerts setup'),
  applyHooks: onPc('Session alerts setup'),
  mobilePushOff: onPc('Phone settings'),
  mobilePushTest: onPc('Phone settings')
}

function pushSupported(): boolean {
  return (
    window.isSecureContext &&
    'serviceWorker' in navigator &&
    'PushManager' in window &&
    'Notification' in window
  )
}

function base64UrlBytes(s: string): Uint8Array<ArrayBuffer> {
  const bin = atob(
    s
      .replace(/-/g, '+')
      .replace(/_/g, '/')
      .padEnd(Math.ceil(s.length / 4) * 4, '=')
  )
  const out = new Uint8Array(bin.length)
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i)
  return out
}

function sameKey(a: ArrayBuffer | null | undefined, b: Uint8Array): boolean {
  if (!a || a.byteLength !== b.length) return false
  const x = new Uint8Array(a)
  return x.every((v, i) => v === b[i])
}

/** What only the phone app needs: pairing, its own device, and launches. */
export const phone = {
  paired: (): boolean => !!token,
  connection: (): Conn => conn,
  async pair(code: string, name: string): Promise<void> {
    const r = await request<{ token: string }>('/api/pair', { code, name })
    saveToken(r.token)
    authListeners.forEach((cb) => cb(true))
    retry = 0
    connect()
  },
  me: (): Promise<MobileMe> => request<MobileMe>('/api/me'),
  async unpair(): Promise<void> {
    await request('/api/unpair', {}).catch(() => undefined)
    unpaired()
  },
  renameDevice: (name: string): Promise<void> => request('/api/rename-device', { name }),
  previewLaunch: (req: RemoteLaunchRequest): Promise<RemoteLaunchPreview> =>
    request('/api/launch/preview', req),
  launch: (req: RemoteLaunchRequest): Promise<RemoteLaunchResult> => request('/api/launch', req),
  /** Offer this phone's public SSH key to the PC (shown there; added only if allowed there). */
  sendSshKey: (key: string): Promise<{ ok: boolean; error?: string; fingerprint?: string }> =>
    request('/api/ssh-key', { key }),
  connect,

  // Push alerts (opt-in per phone). The PC sends only the kind of alert and
  // an opaque reference; details load from the PC when the alert is tapped.

  /** This browser can do Web Push at all (iOS: only when added to the home screen). */
  pushSupported,
  /**
   * 'on' only when this browser has a subscription AND the PC holds that same
   * one for this phone (it may have dropped it, or registering may have
   * failed): otherwise 'off', so turning it on registers again. 'unknown':
   * the PC can't be reached to check.
   */
  async pushState(): Promise<'on' | 'off' | 'denied' | 'unsupported' | 'unknown'> {
    if (!pushSupported()) return 'unsupported'
    if (Notification.permission === 'denied') return 'denied'
    const reg = await navigator.serviceWorker.getRegistration()
    const sub = await reg?.pushManager.getSubscription()
    if (!sub || Notification.permission !== 'granted') return 'off'
    try {
      const pc = await request<{ on: boolean; matches: boolean }>('/api/push/check', {
        endpoint: sub.endpoint
      })
      return pc.on && pc.matches ? 'on' : 'off'
    } catch {
      return 'unknown'
    }
  },
  /** Call from a tap: asks for permission, subscribes, and hands the subscription to the PC. */
  async enablePush(): Promise<{ ok: boolean; error?: string }> {
    if (!pushSupported()) {
      const ios = /iPhone|iPad|iPod/.test(navigator.userAgent)
      const standalone =
        window.matchMedia?.('(display-mode: standalone)').matches ||
        (navigator as Navigator & { standalone?: boolean }).standalone === true
      return {
        ok: false,
        error:
          ios && !standalone
            ? 'On iPhone and iPad, push alerts only work after adding this app to the Home Screen (Share → Add to Home Screen). Open it from there and try again.'
            : "This browser can't receive push alerts here."
      }
    }
    try {
      const permission = await Notification.requestPermission()
      if (permission !== 'granted')
        return {
          ok: false,
          error:
            permission === 'denied'
              ? 'Notifications are blocked for this site. Allow them in the browser settings, then try again.'
              : 'Notifications were not allowed.'
        }
      const reg = await navigator.serviceWorker.ready
      const { publicKey } = await request<{ publicKey: string }>('/api/push/key', {})
      const key = base64UrlBytes(publicKey)
      let sub = await reg.pushManager.getSubscription()
      // A subscription made for another key (e.g. the PC made new keys) must be replaced.
      if (sub && !sameKey(sub.options.applicationServerKey, key)) {
        await sub.unsubscribe()
        sub = null
      }
      sub ??= await reg.pushManager.subscribe({
        userVisibleOnly: true,
        applicationServerKey: key
      })
      await request('/api/push/subscribe', { subscription: sub.toJSON() })
      return { ok: true }
    } catch (err) {
      return { ok: false, error: (err as Error).message }
    }
  },
  /**
   * Off only once the PC says so: if it can't be reached, this throws and push
   * stays on (the PC would keep sending), so the phone never claims it's off.
   */
  async disablePush(): Promise<void> {
    await request('/api/push/unsubscribe', {})
    if (!pushSupported()) return
    const reg = await navigator.serviceWorker.getRegistration()
    await (await reg?.pushManager.getSubscription())?.unsubscribe()
  },
  /** Which session a tapped push alert means: works once, for this phone only. */
  resolveLiveRef: async (ref: string): Promise<string | null> =>
    (await request<{ key: string | null }>('/api/live/resolve', { ref })).key,
  /** Ask the PC for a test push to this phone. Resolves with how many were sent (0 or 1). */
  testPush: async (): Promise<number> =>
    (await request<{ sent: number }>('/api/push/test', {})).sent,
  /**
   * A push alert was tapped: `ref` names the session (resolved on the PC), or
   * is undefined for an alert without one. Also fires once for a `#live=…`
   * address the app was opened with.
   */
  onOpenLive(cb: (ref: string | undefined) => void): () => void {
    const fromHash = (): void => {
      const m = /^#live(?:=([A-Za-z0-9_-]{8,64}))?$/.exec(location.hash)
      if (!m) return
      history.replaceState(null, '', location.pathname + location.search)
      cb(m[1])
    }
    fromHash()
    const onMessage = (e: MessageEvent): void => {
      const d = e.data as { type?: unknown; ref?: unknown } | undefined
      if (d?.type !== 'csd-open-live') return
      cb(typeof d.ref === 'string' && /^[A-Za-z0-9_-]{8,64}$/.test(d.ref) ? d.ref : undefined)
    }
    navigator.serviceWorker?.addEventListener('message', onMessage)
    window.addEventListener('hashchange', fromHash)
    return () => {
      navigator.serviceWorker?.removeEventListener('message', onMessage)
      window.removeEventListener('hashchange', fromHash)
    }
  },
  /** Live-update notices from the PC (e.g. 'settings'). */
  on: (channel: Channel, cb: () => void): (() => void) => subscribe(channel, cb),
  onToast(cb: (t: { title: string; body?: string }) => void): () => void {
    toastListeners.add(cb)
    return () => toastListeners.delete(cb)
  },
  onAuth(cb: (paired: boolean) => void): () => void {
    authListeners.add(cb)
    return () => authListeners.delete(cb)
  },
  onConnection(cb: (c: Conn) => void): () => void {
    connListeners.add(cb)
    return () => connListeners.delete(cb)
  }
}
