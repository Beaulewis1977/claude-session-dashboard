import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import {
  createFixturesDisplay,
  createPathMasker,
  fixturesDisplayRules,
  maskDeep,
  SAMPLE_CHECKOUT,
  SAMPLE_DATA_DIR,
  SAMPLE_HOME
} from '../src/main/fixtures-display'
import { setOutgoingFilter, toRenderer } from '../src/main/outgoing'

// A checkout under some other user's profile, written as Windows writes it.
const ROOT = 'C:\\Users\\someone\\my checkout'
const RULES = [
  { from: `${ROOT}\\.fixtures-data\\sources\\windows\\Users\\alex`, to: SAMPLE_HOME },
  { from: `${ROOT}\\.fixtures-data\\sources\\wsl`, to: '\\\\wsl.localhost' },
  { from: `${ROOT}\\.fixtures-data\\appdata`, to: SAMPLE_DATA_DIR },
  { from: ROOT, to: SAMPLE_CHECKOUT }
]
const mask = createPathMasker(RULES)

describe('fixtures display paths', () => {
  it('shows the sample home, data folder and WSL root instead of the checkout', () => {
    expect(
      mask(`${ROOT}\\.fixtures-data\\sources\\windows\\Users\\alex\\.claude\\projects\\a.jsonl`)
    ).toBe('C:\\Users\\alex\\.claude\\projects\\a.jsonl')
    expect(mask(`Archive: ${ROOT}\\.fixtures-data\\appdata\\archive (125 sessions)`)).toBe(
      `Archive: ${SAMPLE_DATA_DIR}\\archive (125 sessions)`
    )
    expect(mask(`${ROOT}\\.fixtures-data\\sources\\wsl\\Ubuntu\\home\\alex\\.claude`)).toBe(
      '\\\\wsl.localhost\\Ubuntu\\home\\alex\\.claude'
    )
    expect(mask(`${ROOT}\\fixtures\\usage`)).toBe(`${SAMPLE_CHECKOUT}\\fixtures\\usage`)
    expect(mask(ROOT)).toBe(SAMPLE_CHECKOUT)
  })

  it('matches forward slashes, JSON-escaped backslashes, /mnt paths and any letter case', () => {
    expect(
      mask('"C:/Users/someone/my checkout/.fixtures-data/sources/windows/Users/alex/bin/x.ps1"')
    ).toBe('"C:/Users/alex/bin/x.ps1"')
    expect(
      mask('{"dir":"C:\\\\Users\\\\someone\\\\my checkout\\\\.fixtures-data\\\\appdata\\\\x"}')
    ).toBe('{"dir":"C:\\\\Users\\\\alex\\\\AppData\\\\Roaming\\\\ClaudeSessionDashboard\\\\x"}')
    expect(mask('/mnt/c/Users/someone/my checkout/.fixtures-data/appdata/handoffs/a.md')).toBe(
      '/mnt/c/Users/alex/AppData/Roaming/ClaudeSessionDashboard/handoffs/a.md'
    )
    expect(mask('c:\\users\\SOMEONE\\my checkout\\.fixtures-data\\appdata')).toBe(SAMPLE_DATA_DIR)
  })

  it('leaves longer names, sample paths and other text alone', () => {
    expect(mask(`${ROOT}2\\x`)).toBe(`${ROOT}2\\x`)
    expect(mask(`${ROOT}\\.fixtures-data\\appdata2`)).toBe(
      `${SAMPLE_CHECKOUT}\\.fixtures-data\\appdata2`
    )
    for (const s of ['C:\\Users\\alex\\code\\acme-web', '/home/alex/dotfiles', 'plain text', ''])
      expect(mask(s)).toBe(s)
  })

  it('masks paths inside a PowerShell -EncodedCommand', () => {
    const script = `& "${ROOT}\\.fixtures-data\\sources\\windows\\Users\\alex\\.claude-session-dashboard\\bin\\hook.ps1"`
    const enc = Buffer.from(script, 'utf16le').toString('base64')
    const out = mask(`powershell -NoProfile -EncodedCommand ${enc}`)
    const b64 = /-EncodedCommand (\S+)/.exec(out)![1]
    expect(Buffer.from(b64, 'base64').toString('utf16le')).toBe(
      '& "C:\\Users\\alex\\.claude-session-dashboard\\bin\\hook.ps1"'
    )
    const other = Buffer.from('Write-Output hi', 'utf16le').toString('base64')
    expect(mask(`-EncodedCommand ${other}`)).toBe(`-EncodedCommand ${other}`)
  })

  it('copies arrays and plain objects, and passes everything else through untouched', () => {
    const buf = Buffer.from('x')
    const date = new Date(0)
    const value = { a: [ROOT, 1, null, { b: `${ROOT}\\x` }], buf, date, n: 2, t: true }
    const out = maskDeep(value, mask)
    expect(out).toEqual({
      a: [SAMPLE_CHECKOUT, 1, null, { b: `${SAMPLE_CHECKOUT}\\x` }],
      buf,
      date,
      n: 2,
      t: true
    })
    expect(out.buf).toBe(buf)
    expect(value.a[0]).toBe(ROOT)
  })

  it("builds its rules from the checkout's fixtures layout", () => {
    const root = process.platform === 'win32' ? 'C:\\Users\\someone\\repo' : '/home/someone/repo'
    const rules = fixturesDisplayRules(root)
    expect(rules.map((r) => r.from)).toEqual([
      join(root, '.fixtures-data', 'sources', 'windows', 'Users', 'alex'),
      join(root, '.fixtures-data', 'sources', 'wsl'),
      join(root, '.fixtures-data', 'appdata'),
      root
    ])
    const show = createFixturesDisplay(root)
    expect(show({ p: join(root, '.fixtures-data', 'appdata', 'archive') }).p).toMatch(
      /^C:[\\/]Users[\\/]alex[\\/]AppData[\\/]Roaming[\\/]ClaudeSessionDashboard[\\/]archive$/
    )
  })

  it('toRenderer passes values through until a filter is set', () => {
    const v = { p: ROOT }
    expect(toRenderer(v)).toBe(v)
    setOutgoingFilter((x) => maskDeep(x, mask))
    try {
      expect(toRenderer(v)).toEqual({ p: SAMPLE_CHECKOUT })
    } finally {
      setOutgoingFilter((x) => x)
    }
  })
})
