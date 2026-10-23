// The phone companion: types shared by the main process, the desktop
// settings screen and the mobile web app.
//
// The companion server is off by default and listens on 127.0.0.1 only.
// Tailscale (`tailscale serve`) publishes it over HTTPS to your own tailnet;
// the optional home Wi-Fi mode listens on one private LAN address instead.

import type { AppSettings } from './types'

export type MobileMode = 'tailscale' | 'lan'

export interface MobileSettings {
  /** The companion server is running (or should start with the app, see autoStart). */
  enabled: boolean
  mode: MobileMode
  /** Local port of the companion server (127.0.0.1, or the LAN address in Wi-Fi mode). */
  port: number
  /** HTTPS port `tailscale serve` publishes on the tailnet. */
  httpsPort: number
  /** Home Wi-Fi mode: the private address to listen on. */
  lanAddress?: string
  /** Phones can look but not change or launch anything. */
  readOnly: boolean
  /** Ask on the PC before each launch from a phone. */
  confirmOnPc: boolean
  /** Start the companion when the app starts (if it was on). */
  autoStart: boolean
}

export const DEFAULT_MOBILE: MobileSettings = {
  enabled: false,
  mode: 'tailscale',
  port: 47821,
  httpsPort: 8443,
  readOnly: false,
  confirmOnPc: false,
  autoStart: true
}

/** A paired phone, as shown in Settings (the token's hash never leaves the main process). */
export interface MobileDevice {
  id: string
  name: string
  createdAt: string
  lastSeenAt: string
  /** Browser, from the pairing request (for recognising it). */
  agent?: string
  /** Has a live connection right now. */
  connected?: boolean
}

export interface ActivityEntry {
  at: string
  deviceId?: string
  device?: string
  /** e.g. "pair", "launch", "rename", "settings", "revoke", "denied". */
  action: string
  detail?: string
  ok: boolean
}

export type ServeState = 'on' | 'off' | 'conflict' | 'unknown'

export interface TailscaleStatus {
  installed: boolean
  version?: string
  /** "Running", "NeedsLogin", "Stopped", "NoState"… */
  backendState?: string
  loggedIn: boolean
  /** This PC's MagicDNS name, without the trailing dot. */
  dnsName?: string
  tailnet?: string
  /** HTTPS certificates are turned on for the tailnet (needed by `tailscale serve`). */
  httpsEnabled?: boolean
  /** Phones and tablets on the tailnet (to confirm the phone has Tailscale). */
  phones?: { name: string; os: string; online: boolean }[]
  /** Our `tailscale serve` rule. */
  serve: ServeState
  serveUrl?: string
  error?: string
}

export interface LanAddress {
  address: string
  interface: string
}

export interface PairingInfo {
  /** One-time code, e.g. "K7QM-2XRA". */
  code: string
  /** What the QR code holds: the companion URL with the code. */
  url: string
  expiresAt: string
}

export interface MobileStatus {
  settings: MobileSettings
  running: boolean
  /** Where the server listens, e.g. "127.0.0.1:47821". */
  listening?: string
  /** The address a phone opens (https://…), when there is one. */
  url?: string
  error?: string
  tailscale?: TailscaleStatus
  firewallRule?: boolean
  devices: MobileDevice[]
  pairing?: PairingInfo
  /** The built web app is missing (development without `npm run build`). */
  webAppMissing?: boolean
}

export interface ClaudeCheck {
  found: boolean
  version?: string
  /** At least REMOTE_CONTROL_MIN_VERSION. */
  versionOk: boolean
  loggedIn?: boolean
  /** "claude.ai" for a subscription login. */
  authMethod?: string
  subscriptionType?: string
  /** Remote Control can't work with these set (names only, never values). */
  blockingEnv: string[]
  /** Set in the app's environment; launches from the app remove them. */
  apiKeyEnv: string[]
  error?: string
}

/** What a phone asks the PC to launch. Only these three, only for known sessions. */
export interface RemoteLaunchRequest {
  key: string
  kind: 'resume' | 'fork' | 'branch'
  branch?: { at: string; mode: 'include' | 'before' }
}

export interface RemoteLaunchPreview {
  ok: boolean
  error?: string
  title: string
  cwd?: string
  terminal: string
  remoteControlName?: string
  /** Will ask on the PC first. */
  confirmOnPc: boolean
  willRestore: boolean
}

export interface RemoteLaunchResult {
  ok: boolean
  error?: string
  /** The session that was launched (for a branch, the new one). */
  key?: string
  /** Fixtures mode / not Windows: nothing was started. */
  simulated?: boolean
  /** Waiting for, or denied by, the confirmation on the PC. */
  denied?: boolean
}

/** What a paired phone learns about itself and the PC on connecting. */
export interface MobileMe {
  device: MobileDevice
  readOnly: boolean
  confirmOnPc: boolean
  mode: MobileMode
  appVersion: string
}

/** Settings a phone may change. Never security, pairing, API keys, Tailscale or the server. */
export const MOBILE_SAFE_SETTINGS = [
  'terminal',
  'remoteControlDefault',
  'alertsEnabled',
  'alertThresholds',
  'weekStart'
] as const satisfies readonly (keyof AppSettings)[]

export type MobileSafeSetting = (typeof MOBILE_SAFE_SETTINGS)[number]

/** Server → phone messages on the WebSocket. */
export type MobileEvent =
  | { type: 'ready' }
  | { type: 'event'; channel: 'sessions' | 'usage' | 'limits' | 'credits' | 'settings' }
  | { type: 'toast'; title: string; body?: string }
  | { type: 'revoked' }

export const APP_STORE_URL = 'https://apps.apple.com/app/tailscale/id1470499037'
export const PLAY_STORE_URL = 'https://play.google.com/store/apps/details?id=com.tailscale.ipn'
export const TAILSCALE_DOWNLOAD_URL = 'https://tailscale.com/download/windows'
export const CLAUDE_CODE_WEB_URL = 'https://claude.ai/code'

/** Compare dotted versions ("2.1.51" ≤ "2.1.309"). */
export function versionAtLeast(version: string | undefined, min: string): boolean {
  if (!version) return false
  const a =
    version
      .match(/\d+(\.\d+)*/)?.[0]
      .split('.')
      .map(Number) ?? []
  const b = min.split('.').map(Number)
  for (let i = 0; i < Math.max(a.length, b.length); i++) {
    const d = (a[i] ?? 0) - (b[i] ?? 0)
    if (d) return d > 0
  }
  return true
}
