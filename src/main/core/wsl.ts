// Helpers for WSL: decoding `wsl.exe` output and mapping paths.

/**
 * `wsl.exe -l -q` writes UTF-16LE (usually without a BOM). Newer builds honour
 * WSL_UTF8=1 and write UTF-8, so detect the encoding instead of assuming it.
 */
export function decodeWslOutput(buf: Uint8Array): string {
  if (buf.length === 0) return ''
  const utf16 = (buf.length >= 2 && buf[0] === 0xff && buf[1] === 0xfe) || looksLikeUtf16(buf)
  const text = new TextDecoder(utf16 ? 'utf-16le' : 'utf-8').decode(buf)
  return text.replace(/^\uFEFF/, '').replace(/\0/g, '')
}

/** Plain ASCII text in UTF-16LE has a zero in (nearly) every odd byte. */
function looksLikeUtf16(buf: Uint8Array): boolean {
  let zeros = 0
  const n = Math.min(buf.length, 200)
  for (let i = 1; i < n; i += 2) if (buf[i] === 0) zeros++
  return zeros > 0 && zeros >= Math.floor(n / 2) * 0.6
}

/** Parse the distro list printed by `wsl.exe -l -q`. */
export function parseDistroList(buf: Uint8Array): string[] {
  const seen = new Set<string>()
  for (const raw of decodeWslOutput(buf).split(/\r?\n/)) {
    const name = raw.trim()
    if (name && !seen.has(name)) seen.add(name)
  }
  return [...seen]
}

/** Distros that are WSL infrastructure rather than user Linux installs. */
export function isInfrastructureDistro(name: string): boolean {
  return /^docker-desktop(-data)?$/i.test(name) || /^rancher-desktop(-data)?$/i.test(name)
}

const DISTRO_NAME_RE = /^[A-Za-z0-9._-]+$/

export function isValidDistroName(name: string): boolean {
  return DISTRO_NAME_RE.test(name)
}

/** UNC roots for a distro, preferred first. */
export function wslRoots(distro: string): string[] {
  return [`\\\\wsl.localhost\\${distro}`, `\\\\wsl$\\${distro}`]
}

/** `\\wsl.localhost\Ubuntu` + `/home/me/x` → `\\wsl.localhost\Ubuntu\home\me\x`. */
export function linuxToUnc(root: string, linuxPath: string): string {
  const rel = linuxPath.replace(/^\/+/, '').split('/').filter(Boolean).join('\\')
  return rel ? `${root}\\${rel}` : root
}

/** Parse `\\wsl.localhost\<distro>\rest` or `\\wsl$\<distro>\rest`. */
export function parseWslUnc(
  p: string
): { distro: string; linuxPath: string; root: string } | undefined {
  const m = /^([\\/]{2}(?:wsl\.localhost|wsl\$)[\\/]([^\\/]+))(?:[\\/](.*))?$/i.exec(p)
  if (!m) return undefined
  const rest = (m[3] ?? '')
    .split(/[\\/]+/)
    .filter(Boolean)
    .join('/')
  return { distro: m[2], linuxPath: `/${rest}`, root: m[1] }
}

/**
 * Convert a folder picked in a Windows dialog into a path usable inside WSL:
 * WSL UNC paths map back to Linux paths, drive paths map to /mnt/<drive>/….
 */
export function windowsPathToWsl(p: string, distro?: string): string | undefined {
  const unc = parseWslUnc(p)
  if (unc) {
    if (distro && unc.distro.toLowerCase() !== distro.toLowerCase()) return undefined
    return unc.linuxPath
  }
  const drive = /^([a-zA-Z]):[\\/]?(.*)$/.exec(p)
  if (drive) {
    const rest = drive[2]
      .split(/[\\/]+/)
      .filter(Boolean)
      .join('/')
    return `/mnt/${drive[1].toLowerCase()}${rest ? `/${rest}` : ''}`
  }
  if (p.startsWith('/')) return p
  return undefined
}
