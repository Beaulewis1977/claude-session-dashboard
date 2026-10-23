import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { analyzeEvents, parseJsonl } from '@shared/jsonl'
import {
  addHints,
  ASK_MARKER,
  detectSource,
  emptyHints,
  type SourceContext
} from '@shared/source-label'

const fixture = (name: string) =>
  analyzeEvents(
    parseJsonl(readFileSync(join(__dirname, '..', 'fixtures', 'sources', name), 'utf8')).events
  )

/** Hints from a list of real-format events. */
function hints(...events: Record<string, unknown>[]) {
  const h = emptyHints()
  for (const e of events) addHints(h, e)
  return h
}
const line = (entrypoint?: string, extra: Record<string, unknown> = {}) => ({
  parentUuid: null,
  isSidechain: false,
  userType: 'external',
  ...(entrypoint ? { entrypoint } : {}),
  cwd: 'C:\\Users\\beau\\code\\acme-web',
  sessionId: 's1',
  version: '2.1.300',
  type: 'user',
  message: { role: 'user', content: 'hi' },
  ...extra
})
const win: SourceContext = { env: 'windows', cwd: 'C:\\Users\\beau\\code\\acme-web' }

describe('source labels', () => {
  it('uses the entrypoint field when present', () => {
    expect(detectSource(hints(line('cli')), win).label).toBe('terminal-windows')
    expect(detectSource(hints(line('cli')), { ...win, env: 'wsl' }).label).toBe('terminal-wsl')
    expect(detectSource(hints(line('claude-vscode')), win)).toEqual({
      label: 'vscode',
      reason: 'entrypoint "claude-vscode"'
    })
    expect(detectSource(hints(line('claude-desktop')), win).label).toBe('desktop')
    expect(detectSource(hints(line('local-agent')), win).label).toBe('desktop')
    expect(detectSource(hints(line('sdk-cli')), win).label).toBe('sdk')
    expect(detectSource(hints(line('sdk-py')), win).label).toBe('sdk')
    expect(detectSource(hints(line('something-new')), win).label).toBe('unknown')
  })

  it('recognises a cloud session teleported here (real line shapes)', () => {
    const a = fixture('teleported-cloud.jsonl')
    expect(a.sourceHints.entrypoints).toEqual(['remote_mobile', 'cli'])
    expect(a.sourceHints.remote).toBe(true)
    expect(detectSource(a.sourceHints, { env: 'wsl', cwd: a.cwd }).label).toBe('cloud')
    // A claude.ai/code link alone is enough.
    const link = hints(
      line('cli', {
        type: 'attachment',
        attachment: { type: 'remote_session_change', url: 'https://claude.ai/code/session_x' }
      })
    )
    expect(detectSource(link, win)).toMatchObject({
      label: 'cloud',
      reason: 'Linked to a claude.ai/code cloud session'
    })
  })

  it('tells JetBrains from IDE context attached to a CLI session', () => {
    const a = fixture('jetbrains-cli.jsonl')
    expect(a.sourceHints).toMatchObject({ ide: true, ideName: 'jetbrains' })
    expect(detectSource(a.sourceHints, win).label).toBe('jetbrains')
    // IDE context without a name stays a terminal session, with a note.
    const ide = hints(
      line('cli', {
        message: {
          role: 'user',
          content: '<ide_opened_file>The user opened a.ts</ide_opened_file> fix it'
        }
      })
    )
    expect(ide.ide).toBe(true)
    expect(detectSource(ide, win)).toMatchObject({ label: 'terminal-windows' })
    expect(detectSource(ide, win).reason).toMatch(/IDE/)
    // Talking about VS Code in a prompt is not a hint.
    expect(
      hints(line('cli', { message: { role: 'user', content: 'set up VS Code tasks' } })).ideName
    ).toBeUndefined()
  })

  it('falls back to how the app launched it, then cwd, then unknown', () => {
    const old = hints(line(undefined, { version: '1.0.98' }))
    expect(detectSource(old, win).label).toBe('unknown')
    expect(detectSource(old, { ...win, launchedByApp: true })).toEqual({
      label: 'terminal-windows',
      reason: 'Launched from this app in a terminal'
    })
    expect(
      detectSource(old, { env: 'wsl', cwd: '/home/user/repo', sourceUser: 'beau' }).label
    ).toBe('cloud')
    expect(
      detectSource(old, { env: 'wsl', cwd: '/home/user/repo', sourceUser: 'user' }).label
    ).toBe('unknown')
  })

  it('labels the dashboard’s own Ask Claude runs and imports', () => {
    expect(
      detectSource(hints(line('sdk-cli')), {
        ...win,
        firstPrompt: `${ASK_MARKER} Have my limits dropped?`
      }).label
    ).toBe('ask-claude')
    expect(detectSource(undefined, { ...win, imported: true }).label).toBe('claude-ai')
  })

  it('collects hints in analyzeEvents for every fixture format', () => {
    const legacy = analyzeEvents([{ type: 'user', message: { role: 'user', content: 'x' } }])
    expect(legacy.sourceHints).toEqual({ entrypoints: [], remote: false, ide: false })
  })
})
