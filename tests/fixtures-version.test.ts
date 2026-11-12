import { existsSync } from 'node:fs'
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { FIXTURES_DATA_VERSION, retireOldFixtureData } from '../src/main/fixtures'

let root: string
let base: string
beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'csd-fixtures-version-'))
  base = join(root, '.fixtures-data')
})
afterEach(async () => {
  await rm(root, { recursive: true, force: true })
})

async function oldData(version?: number): Promise<void> {
  await mkdir(join(base, 'sources', 'wsl', 'Ubuntu', 'home', 'alex'), { recursive: true })
  await writeFile(join(base, 'sources', 'wsl', 'Ubuntu', 'home', 'alex', 'a.jsonl'), '{}\n')
  await mkdir(join(base, 'appdata'), { recursive: true })
  await writeFile(join(base, 'appdata', '.hooks-seeded'), '')
  await writeFile(join(base, 'appdata', 'metadata.json'), '{"mine":true}')
  if (version !== undefined) await writeFile(join(base, 'fixtures-version'), `${version}\n`)
}

describe('fixtures data version', () => {
  it('a fresh checkout only gets the version marker', async () => {
    expect(retireOldFixtureData(root)).toBeUndefined()
    expect((await readFile(join(base, 'fixtures-version'), 'utf8')).trim()).toBe(
      String(FIXTURES_DATA_VERSION)
    )
    expect(await readdir(base)).toEqual(['fixtures-version'])
  })

  it('data from before the marker existed is moved aside whole, never deleted', async () => {
    await oldData()
    const dest = retireOldFixtureData(root, FIXTURES_DATA_VERSION, 'T1')
    expect(dest).toBe(join(base, 'previous', 'v1-T1'))
    expect(existsSync(join(base, 'sources'))).toBe(false)
    expect(existsSync(join(base, 'appdata'))).toBe(false)
    // Everything is still there, seeding markers included.
    expect(await readFile(join(dest!, 'appdata', 'metadata.json'), 'utf8')).toBe('{"mine":true}')
    expect(existsSync(join(dest!, 'appdata', '.hooks-seeded'))).toBe(true)
    expect(existsSync(join(dest!, 'sources', 'wsl', 'Ubuntu', 'home', 'alex', 'a.jsonl'))).toBe(
      true
    )
    expect((await readFile(join(base, 'fixtures-version'), 'utf8')).trim()).toBe(
      String(FIXTURES_DATA_VERSION)
    )
  })

  it('an older marked version is moved aside under its own version', async () => {
    await oldData(1)
    expect(retireOldFixtureData(root, 3, 'T2')).toBe(join(base, 'previous', 'v1-T2'))
  })

  it('data of the current version is left alone', async () => {
    await oldData(FIXTURES_DATA_VERSION)
    expect(retireOldFixtureData(root)).toBeUndefined()
    expect(await readFile(join(base, 'appdata', 'metadata.json'), 'utf8')).toBe('{"mine":true}')
    expect(existsSync(join(base, 'previous'))).toBe(false)
  })

  it('earlier moved-aside data is kept when it happens again', async () => {
    await oldData()
    retireOldFixtureData(root, 2, 'A')
    await oldData(2)
    retireOldFixtureData(root, 3, 'B')
    expect((await readdir(join(base, 'previous'))).sort()).toEqual(['v1-A', 'v2-B'])
  })
})
