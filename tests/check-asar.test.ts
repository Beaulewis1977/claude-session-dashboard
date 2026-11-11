// The packaging check (scripts/check-asar.cjs, electron-builder's afterPack
// hook): only the built app may end up in app.asar.

import { createRequire } from 'node:module'
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

const require = createRequire(import.meta.url)
const check = require('../scripts/check-asar.cjs') as {
  unexpectedEntries(list: string[]): string[]
}

describe('app.asar contents', () => {
  it('accepts the built app, its package.json and resources', () => {
    expect(
      check.unexpectedEntries([
        '\\package.json',
        '\\out',
        '\\out\\main',
        '\\out\\main\\index.js',
        '\\out\\main\\chunks\\worker-1.js',
        '\\out\\preload\\index.cjs',
        '\\out\\renderer\\index.html',
        '\\out\\renderer\\assets\\index-abc.js',
        '\\resources',
        '\\resources\\icon.png',
        '\\resources\\bridge\\statusline.ps1',
        '/out/renderer/mobile.html'
      ])
    ).toEqual([])
  })

  it('refuses anything else (the stray files 1.10.0-1.16.2 shipped, node_modules, maps)', () => {
    expect(
      check.unexpectedEntries([
        '\\out\\check.log',
        '\\out\\pr30-body.md',
        '\\out\\main\\index.js.map',
        '\\node_modules\\ws\\index.js',
        '\\src\\main\\index.ts',
        '\\resources\\other.txt',
        '\\out\\mainx\\a.js'
      ])
    ).toEqual([
      '/out/check.log',
      '/out/pr30-body.md',
      '/out/main/index.js.map',
      '/node_modules/ws/index.js',
      '/src/main/index.ts',
      '/resources/other.txt',
      '/out/mainx/a.js'
    ])
  })

  it('is the build’s afterPack hook, and the build packs only those folders', async () => {
    const yml = await readFile(join(__dirname, '..', 'electron-builder.yml'), 'utf8')
    expect(yml).toMatch(/^afterPack: scripts\/check-asar\.cjs$/m)
    const files = /^files:\n((?: {2}- .+\n)+)/m.exec(yml)?.[1]
    expect(
      files
        ?.split('\n')
        .filter(Boolean)
        .map((l) => l.trim().slice(2))
    ).toEqual([
      'out/main/**',
      'out/preload/**',
      'out/renderer/**',
      'resources/icon.png',
      'resources/bridge/**',
      'package.json',
      "'!**/*.map'"
    ])
    expect(yml).toMatch(/^electronLanguages:\n {2}- en-US$/m)
  })
})
