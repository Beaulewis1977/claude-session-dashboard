// Where the companion server may listen, and which Host names it answers.
//
// Tailscale mode: 127.0.0.1 only. `tailscale serve` reaches it there and
// publishes it over HTTPS to the tailnet; nothing else on the network can.
// Home Wi-Fi mode: one private IPv4 address of this PC that the user picked
// (10/8, 172.16/12, 192.168/16), never 0.0.0.0, a public address or a
// Tailscale (100.64/10) address.

import { networkInterfaces, type NetworkInterfaceInfo } from 'node:os'
import { isIPv4 } from 'node:net'
import type { LanAddress, MobileSettings } from '@shared/mobile'

export const LOOPBACK = '127.0.0.1'

export function isPrivateIPv4(ip: string): boolean {
  if (!isIPv4(ip)) return false
  const [a, b] = ip.split('.').map(Number)
  return a === 10 || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168)
}

type Interfaces = NodeJS.Dict<NetworkInterfaceInfo[]>

/** This PC's private LAN addresses (for the home Wi-Fi picker). */
export function lanAddresses(ifaces: Interfaces = networkInterfaces()): LanAddress[] {
  const out: LanAddress[] = []
  for (const [name, list] of Object.entries(ifaces)) {
    for (const i of list ?? []) {
      if (i.family !== 'IPv4' || i.internal || !isPrivateIPv4(i.address)) continue
      // Hyper-V / WSL / Docker virtual switches aren't reachable from a phone.
      if (/vEthernet|WSL|Hyper-V|Docker|VirtualBox|VMware/i.test(name)) continue
      out.push({ address: i.address, interface: name })
    }
  }
  return out
}

export class BindError extends Error {}

/** The one address the server may listen on, or a BindError explaining why not. */
export function bindAddress(
  s: Pick<MobileSettings, 'mode' | 'lanAddress'>,
  ifaces: Interfaces = networkInterfaces()
): string {
  if (s.mode === 'tailscale') return LOOPBACK
  const ip = s.lanAddress ?? ''
  if (!isPrivateIPv4(ip))
    throw new BindError(
      'Home Wi-Fi mode needs one of this PC’s private network addresses (like 192.168.1.20).'
    )
  if (!lanAddresses(ifaces).some((a) => a.address === ip))
    throw new BindError(
      `${ip} isn't one of this PC's network addresses right now. Pick the address again in Settings → Phone.`
    )
  return ip
}

/** Host header values the server answers (anything else gets 421: no DNS rebinding). */
export function allowedHosts(opts: {
  bind: string
  port: number
  tailscaleName?: string
  httpsPort?: number
}): Set<string> {
  const hosts = new Set<string>()
  const add = (h: string): void => {
    hosts.add(h.toLowerCase())
  }
  add(`${opts.bind}:${opts.port}`)
  if (opts.bind === LOOPBACK) add(`localhost:${opts.port}`)
  if (opts.tailscaleName) {
    const name = opts.tailscaleName.replace(/\.$/, '')
    const https = opts.httpsPort ?? 443
    add(https === 443 ? name : `${name}:${https}`)
    if (https === 443) add(`${name}:443`)
  }
  return hosts
}

/**
 * Browsers send an Origin with WebSocket upgrades: it must be one of the
 * server's own hosts (a page on any other site can't connect).
 */
export function originAllowed(origin: string | undefined, hosts: Set<string>): boolean {
  if (!origin) return false
  try {
    const u = new URL(origin)
    if (u.protocol !== 'https:' && u.protocol !== 'http:') return false
    const port = u.port || (u.protocol === 'https:' ? '443' : '80')
    return hosts.has(u.host.toLowerCase()) || hosts.has(`${u.hostname.toLowerCase()}:${port}`)
  } catch {
    return false
  }
}
