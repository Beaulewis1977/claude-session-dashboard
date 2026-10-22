import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import {
  decodeWslOutput,
  isInfrastructureDistro,
  linuxToUnc,
  parseDistroList,
  parseWslUnc,
  windowsPathToWsl
} from '../src/main/core/wsl'
import { FIXTURES } from './helpers'

describe('parseDistroList', () => {
  it('decodes the UTF-16LE fixture and drops blank lines', () => {
    const buf = readFileSync(join(FIXTURES, 'wsl-list.utf16'))
    expect(parseDistroList(buf)).toEqual(['Ubuntu', 'Debian', 'docker-desktop'])
  })

  it('handles a BOM', () => {
    const buf = Buffer.concat([
      Buffer.from([0xff, 0xfe]),
      Buffer.from('Ubuntu-22.04\r\n', 'utf16le')
    ])
    expect(parseDistroList(buf)).toEqual(['Ubuntu-22.04'])
  })

  it('handles UTF-8 output (WSL_UTF8=1)', () => {
    expect(parseDistroList(Buffer.from('Ubuntu\nkali-linux\n\n'))).toEqual(['Ubuntu', 'kali-linux'])
  })

  it('strips stray null bytes and de-duplicates', () => {
    expect(parseDistroList(Buffer.from('Ubuntu\0\r\nUbuntu\r\n\0\0'))).toEqual(['Ubuntu'])
  })

  it('returns an empty list for empty output', () => {
    expect(parseDistroList(Buffer.alloc(0))).toEqual([])
    expect(decodeWslOutput(Buffer.from('\r\n', 'utf16le'))).toBe('\r\n')
  })
})

describe('WSL paths', () => {
  it('flags infrastructure distros', () => {
    expect(isInfrastructureDistro('docker-desktop')).toBe(true)
    expect(isInfrastructureDistro('docker-desktop-data')).toBe(true)
    expect(isInfrastructureDistro('Ubuntu')).toBe(false)
  })

  it('maps Linux paths to UNC paths', () => {
    expect(linuxToUnc('\\\\wsl.localhost\\Ubuntu', '/home/me/my app')).toBe(
      '\\\\wsl.localhost\\Ubuntu\\home\\me\\my app'
    )
    expect(linuxToUnc('\\\\wsl$\\Ubuntu', '/')).toBe('\\\\wsl$\\Ubuntu')
  })

  it('parses UNC paths', () => {
    expect(parseWslUnc('\\\\wsl.localhost\\Ubuntu\\home\\me')).toEqual({
      distro: 'Ubuntu',
      linuxPath: '/home/me',
      root: '\\\\wsl.localhost\\Ubuntu'
    })
    expect(parseWslUnc('\\\\wsl$\\Debian')).toMatchObject({ distro: 'Debian', linuxPath: '/' })
    expect(parseWslUnc('C:\\x')).toBeUndefined()
  })

  it('converts picked folders to WSL paths', () => {
    expect(windowsPathToWsl('\\\\wsl.localhost\\Ubuntu\\home\\me\\proj', 'Ubuntu')).toBe(
      '/home/me/proj'
    )
    expect(windowsPathToWsl('\\\\wsl.localhost\\Debian\\home\\me', 'Ubuntu')).toBeUndefined()
    expect(windowsPathToWsl('D:\\Work\\My Repo', 'Ubuntu')).toBe('/mnt/d/Work/My Repo')
    expect(windowsPathToWsl('C:\\', 'Ubuntu')).toBe('/mnt/c')
  })
})
