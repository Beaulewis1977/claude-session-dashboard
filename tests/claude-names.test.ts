// Names given in Claude Code (`/rename`, Remote Control): parsing, the title
// order, live updates, "Use name from Claude Code" and the one-time backfill.

import { appendFile, cp, mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { analyzeEvents, parseJsonl } from '@shared/jsonl'
import { canUseClaudeName, computeTitle, titleSourceLabel } from '@shared/title'
import { prepareFixtures, seedFixtureData, fixturesLayout } from '../src/main/fixtures'
import { createFixturesPlatform } from '../src/main/platform'
import { SessionService } from '../src/main/services/sessions'
import { appPaths, createMetadataStore, createSettingsStore } from '../src/main/services/store'
import { FIXTURES, line } from './helpers'

const SID = '3c1e9b7a-52d4-4f0e-9a6b-8d2c4e6f1a30'

/** What `/rename <name>` writes, in the order Claude Code writes it. */
function rename(name: string, at: string, sessionId = SID): string[] {
  return [
    line({ type: 'custom-title', customTitle: name, sessionId }),
    line({ type: 'agent-name', agentName: name, sessionId }),
    line({
      type: 'system',
      subtype: 'local_command',
      content: `<command-name>/rename</command-name>\n<command-args>${name}</command-args>`,
      timestamp: at,
      sessionId,
      commandRun: { command: 'rename', args: name }
    })
  ]
}

function prompt(text: string, at: string): string {
  return line({
    type: 'user',
    uuid: `u-${at}`,
    timestamp: at,
    sessionId: SID,
    message: { role: 'user', content: text }
  })
}

const analyze = (lines: string[]) =>
  analyzeEvents(parseJsonl(lines.join('\n')).events, { sessionId: SID })

describe('parsing names given in Claude Code', () => {
  it('takes the last of several renames, with the time of its /rename command', () => {
    const a = analyze([
      prompt('hello', '2026-10-31T10:00:00.000Z'),
      ...rename('first', '2026-10-31T10:01:00.000Z'),
      prompt('more', '2026-10-31T10:02:00.000Z'),
      ...rename('second', '2026-10-31T10:03:00.000Z'),
      ...rename('third', '2026-10-31T10:04:00.000Z')
    ])
    expect(a.claudeName).toBe('third')
    expect(a.claudeNameAt).toBe('2026-10-31T10:04:00.000Z')
  })

  it("doesn't count the same name written again as a rename", () => {
    // Claude Code writes the current name again now and then (e.g. on resume).
    const a = analyze([
      ...rename('kept', '2026-10-31T10:01:00.000Z'),
      prompt('later', '2026-10-31T11:00:00.000Z'),
      line({ type: 'custom-title', customTitle: 'kept', sessionId: SID }),
      line({ type: 'agent-name', agentName: 'kept', sessionId: SID }),
      prompt('much later', '2026-10-31T12:00:00.000Z')
    ])
    expect(a.claudeName).toBe('kept')
    expect(a.claudeNameAt).toBe('2026-10-31T10:01:00.000Z')
  })

  it('times a rename by its /rename command, even when the name comes first in the file', () => {
    // As in a real file: the name entry is written before the command entry.
    const a = analyze([
      line({ type: 'custom-title', customTitle: 'early', sessionId: SID }),
      prompt('unrelated', '2026-10-31T08:00:00.000Z'),
      ...rename('early', '2026-10-31T09:00:00.000Z').slice(2),
      prompt('later', '2026-10-31T10:00:00.000Z')
    ])
    expect(a.claudeName).toBe('early')
    expect(a.claudeNameAt).toBe('2026-10-31T09:00:00.000Z')
  })

  it('times a name without a /rename command by the entry before it, never one after', () => {
    const lines = [
      prompt('hi', '2026-10-31T09:00:00.000Z'),
      line({ type: 'custom-title', customTitle: 'no command', sessionId: SID })
    ]
    expect(analyze(lines).claudeNameAt).toBe('2026-10-31T09:00:00.000Z')
    // More messages later don't move it.
    const more = analyze([...lines, prompt('next', '2026-10-31T11:00:00.000Z')])
    expect(more.claudeName).toBe('no command')
    expect(more.claudeNameAt).toBe('2026-10-31T09:00:00.000Z')
    // Nothing before it: no time (so a dashboard name keeps winning).
    const first = analyze([
      line({ type: 'custom-title', customTitle: 'first line', sessionId: SID }),
      prompt('hi', '2026-10-31T09:00:00.000Z')
    ])
    expect(first.claudeNameAt).toBeUndefined()
    const none = analyze([line({ type: 'custom-title', customTitle: 'timeless' })])
    expect(none.claudeName).toBe('timeless')
    expect(none.claudeNameAt).toBeUndefined()
  })

  it('an old name stays old when messages are added after a dashboard rename', () => {
    const lines = [
      prompt('hi', '2026-10-31T10:00:00.000Z'),
      line({ type: 'custom-title', customTitle: 'Old title', sessionId: SID })
    ]
    const mine = { name: 'Mine', nameAt: '2026-10-31T10:30:00.000Z' }
    const title = (l: string[]) => {
      const a = analyze(l)
      return computeTitle(mine, { name: a.claudeName, at: a.claudeNameAt }, undefined, 'hi')
    }
    expect(title(lines).title).toBe('Mine')
    // A normal message at 11:00, then the file is read again.
    expect(title([...lines, prompt('more', '2026-10-31T11:00:00.000Z')])).toEqual({
      title: 'Mine',
      titleSource: 'name'
    })
  })

  it('an explicit /rename to an earlier name is a new rename', () => {
    // Claude Code name "Old" at 10:00, dashboard "Mine" at 11:00, /rename Old at 12:00.
    const a = analyze([
      prompt('hi', '2026-10-31T09:59:00.000Z'),
      ...rename('Old', '2026-10-31T10:00:00.000Z'),
      prompt('more', '2026-10-31T11:30:00.000Z'),
      ...rename('Old', '2026-10-31T12:00:00.000Z')
    ])
    expect(a.claudeName).toBe('Old')
    expect(a.claudeNameAt).toBe('2026-10-31T12:00:00.000Z')
    expect(
      computeTitle(
        { name: 'Mine', nameAt: '2026-10-31T11:00:00.000Z' },
        { name: a.claudeName, at: a.claudeNameAt },
        undefined,
        'hi'
      )
    ).toEqual({ title: 'Old', titleSource: 'claude-name' })
  })

  it('reads /rename without a name from what Claude Code says it picked', () => {
    const at = '2026-10-31T10:00:00.000Z'
    const a = analyze([
      prompt('hi', '2026-10-31T09:00:00.000Z'),
      line({ type: 'custom-title', customTitle: 'auto-picked', sessionId: SID }),
      line({
        type: 'system',
        subtype: 'local_command',
        content: '<command-name>/rename</command-name>\n<command-args></command-args>',
        timestamp: at,
        sessionId: SID
      }),
      line({
        type: 'system',
        subtype: 'local_command',
        content: '<local-command-stdout>Session renamed to: auto-picked</local-command-stdout>',
        commandRun: { command: 'rename', args: '' },
        timestamp: at,
        sessionId: SID
      })
    ])
    expect(a.claudeName).toBe('auto-picked')
    expect(a.claudeNameAt).toBe(at)
  })

  it("doesn't take a rename from text that only mentions one", () => {
    const a = analyze([
      prompt('hi', '2026-10-31T09:00:00.000Z'),
      line({ type: 'custom-title', customTitle: 'quoted', sessionId: SID }),
      prompt(
        'Session renamed to: quoted <command-name>/rename</command-name>',
        '2026-10-31T12:00:00.000Z'
      ),
      line({
        type: 'api-request-blob',
        timestamp: '2026-10-31T13:00:00.000Z',
        message: {
          role: 'user',
          content: '<local-command-stdout>Session renamed to: quoted</local-command-stdout>'
        }
      }),
      // A /rename command for a name that was never set (no name entry).
      ...rename('never set', '2026-10-31T14:00:00.000Z').slice(2)
    ])
    expect(a.claudeName).toBe('quoted')
    expect(a.claudeNameAt).toBe('2026-10-31T09:00:00.000Z')
  })

  it('skips malformed lines and bad values', () => {
    const text = [
      prompt('hi', '2026-10-31T09:00:00.000Z'),
      ...rename('good', '2026-10-31T09:01:00.000Z'),
      '{"type":"custom-title","customTitle":"trunc',
      'not json',
      line({ type: 'custom-title', customTitle: 42, sessionId: SID }),
      line({ type: 'custom-title', customTitle: '   ', sessionId: SID }),
      line({ type: 'custom-title', sessionId: SID }),
      line({ type: 'agent-name', agentName: null, sessionId: SID })
    ].join('\n')
    const { events, malformedLines } = parseJsonl(text)
    expect(malformedLines).toBe(2)
    const a = analyzeEvents(events, { sessionId: SID })
    expect(a.claudeName).toBe('good')
    expect(a.claudeNameAt).toBe('2026-10-31T09:01:00.000Z')
  })

  it('cleans names: one line, trimmed, capped', () => {
    const a = analyze([
      line({ type: 'custom-title', customTitle: '  two\n  lines\t here ', sessionId: SID })
    ])
    expect(a.claudeName).toBe('two lines here')
    const long = analyze([line({ type: 'custom-title', customTitle: 'x'.repeat(1000) })])
    expect(long.claudeName).toHaveLength(300)
  })

  it('prefers /rename (custom-title) over the Remote Control name (agent-name)', () => {
    const a = analyze([
      ...rename('renamed', '2026-10-31T09:01:00.000Z'),
      line({ type: 'agent-name', agentName: 'remote only', sessionId: SID }),
      prompt('x', '2026-10-31T09:02:00.000Z')
    ])
    expect(a.claudeName).toBe('renamed')
    // Only a Remote Control name: that's the name.
    const rc = analyze([
      prompt('x', '2026-10-31T09:00:00.000Z'),
      line({ type: 'agent-name', agentName: 'phone session', sessionId: SID }),
      prompt('y', '2026-10-31T09:05:00.000Z')
    ])
    expect(rc.claudeName).toBe('phone session')
    expect(rc.claudeNameAt).toBe('2026-10-31T09:00:00.000Z')
  })

  it("ignores a name copied from another session's file", () => {
    const a = analyze([
      ...rename(
        'the other one',
        '2026-10-31T09:01:00.000Z',
        'aaaaaaaa-0000-4000-8000-000000000000'
      ),
      prompt('x', '2026-10-31T09:02:00.000Z')
    ])
    expect(a.claudeName).toBeUndefined()
  })

  it("reads Claude's automatic title from ai-title (newer) and summary (older) lines", () => {
    expect(
      analyze([line({ type: 'ai-title', aiTitle: 'Auto title', sessionId: SID })]).summary
    ).toBe('Auto title')
    expect(analyze([line({ type: 'summary', summary: 'Old summary' })]).summary).toBe('Old summary')
    // Neither is a name given in Claude Code.
    expect(analyze([line({ type: 'ai-title', aiTitle: 'Auto' })]).claudeName).toBeUndefined()
  })
})

describe('title order', () => {
  const claude = { name: 'From Claude', at: '2026-10-31T12:00:00.000Z' }

  it('uses the newer of my dashboard name and the Claude Code name', () => {
    expect(
      computeTitle({ name: 'Mine', nameAt: '2026-10-31T11:00:00.000Z' }, claude, 'S', 'P')
    ).toEqual({ title: 'From Claude', titleSource: 'claude-name' })
    expect(
      computeTitle({ name: 'Mine', nameAt: '2026-10-31T13:00:00.000Z' }, claude, 'S', 'P')
    ).toEqual({ title: 'Mine', titleSource: 'name' })
  })

  it('keeps my name when either time is unknown', () => {
    expect(computeTitle({ name: 'Mine' }, claude, 'S', 'P').titleSource).toBe('name')
    expect(
      computeTitle({ name: 'Mine', nameAt: '2026-10-31T11:00:00.000Z' }, { name: 'C' }, 'S', 'P')
        .titleSource
    ).toBe('name')
    expect(computeTitle({ name: 'Mine', nameAt: 'garbage' }, claude, 'S', 'P').titleSource).toBe(
      'name'
    )
  })

  it('treats the same text as my name', () => {
    expect(
      computeTitle({ name: 'From Claude', nameAt: '2026-10-31T11:00:00.000Z' }, claude, 'S', 'P')
        .titleSource
    ).toBe('name')
  })

  it("then the Claude Code name, Claude's summary, the first message", () => {
    expect(computeTitle(undefined, claude, 'S', 'P')).toEqual({
      title: 'From Claude',
      titleSource: 'claude-name'
    })
    expect(computeTitle({}, { name: '  ' }, 'Summary', 'P')).toEqual({
      title: 'Summary',
      titleSource: 'summary'
    })
    expect(computeTitle({}, undefined, undefined, 'Prompt')).toEqual({
      title: 'Prompt',
      titleSource: 'first-prompt'
    })
  })

  it('labels where the name came from', () => {
    expect(titleSourceLabel('claude-name')).toBe('From Claude Code')
    expect(titleSourceLabel('name')).toBe('Set in dashboard')
    expect(titleSourceLabel('summary')).toMatch(/^Auto/)
    expect(titleSourceLabel('first-prompt')).toMatch(/^Auto/)
    expect(titleSourceLabel('fallback')).toBe('Auto')
  })

  it('offers "Use name from Claude Code" only when my name hides a Claude Code name', () => {
    expect(canUseClaudeName({ meta: { name: 'Mine' }, claudeName: 'C', titleSource: 'name' })).toBe(
      true
    )
    expect(canUseClaudeName({ meta: { name: 'Mine' }, titleSource: 'name' })).toBe(false)
    expect(canUseClaudeName({ meta: {}, claudeName: 'C', titleSource: 'claude-name' })).toBe(false)
  })
})

// ---------------------------------------------------------------------------
// The session service, on a copy of the fixtures.

const SAFARI = '7f3c9a12-4b8e-4d21-9c6a-1e2f3a4b5c6d' // seeded dashboard name, no time
const ORDERS = 'e9a1b2c3-d4e5-4f60-8172-839405a6b7c8' // WSL, no dashboard name

let root: string
let busy: SessionService[] = []

async function setup() {
  await cp(FIXTURES, join(root, 'fixtures'), { recursive: true })
  await prepareFixtures(root)
  const layout = fixturesLayout(root)
  const platform = createFixturesPlatform(layout.fixturesDir, layout.sourcesDir)
  const paths = appPaths(layout.dataDir)
  const metadata = createMetadataStore(paths)
  const settings = createSettingsStore(paths)
  await metadata.load()
  await settings.load()
  await seedFixtureData(root, paths.archiveDir, metadata)
  const sessions = new SessionService(platform, paths, metadata, settings)
  busy.push(sessions)
  return { sessions, metadata, paths }
}

const byId = (s: SessionService, id: string) => s.list().find((x) => x.sessionId === id)!

/** Append a /rename to a session file, as Claude Code would (timestamps "now"). */
async function renameInClaude(path: string, sessionId: string, name: string, at: string) {
  await appendFile(path, rename(name, at, sessionId).join('\n') + '\n')
}

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'csd-names-'))
})
afterEach(async () => {
  await Promise.all(busy.map((b) => b.idle().catch(() => undefined)))
  busy = []
  await rm(root, { recursive: true, force: true, maxRetries: 5 })
})

describe('SessionService and Claude Code names', () => {
  it('backfill: Claude Code names show for sessions I never named, mine stay', async () => {
    const { sessions, metadata, paths } = await setup()
    // Both renamed in Claude Code before this version ran.
    const before = '2026-10-30T10:00:00.000Z'
    await sessions.start()
    const safari = byId(sessions, SAFARI)
    const orders = byId(sessions, ORDERS)
    expect(safari.titleSource).toBe('name')
    await renameInClaude(safari.filePath, SAFARI, 'claude name for safari', before)
    await renameInClaude(orders.filePath, ORDERS, 'Orders API from WSL', before)
    // A fresh start of a new version on the same data (no backfill flag yet).
    delete metadata.value.claudeNamesSince
    for (const m of Object.values(metadata.value.sessions)) delete m.nameAt
    await metadata.flush()
    const metadata2 = createMetadataStore(paths)
    await metadata2.load()
    const settings2 = createSettingsStore(paths)
    await settings2.load()
    const layout = fixturesLayout(root)
    const s2 = new SessionService(
      createFixturesPlatform(layout.fixturesDir, layout.sourcesDir),
      paths,
      metadata2,
      settings2
    )
    busy.push(s2)
    await s2.start()

    const safari2 = byId(s2, SAFARI)
    expect(safari2.title).toBe('Safari login loop')
    expect(safari2.titleSource).toBe('name')
    expect(safari2.claudeName).toBe('claude name for safari')
    expect(metadata2.value.sessions[SAFARI].name).toBe('Safari login loop')
    expect(metadata2.value.sessions[SAFARI].nameAt).toBeTruthy()
    expect(metadata2.value.claudeNamesSince).toBeTruthy()

    const orders2 = byId(s2, ORDERS)
    expect(orders2.title).toBe('Orders API from WSL')
    expect(orders2.titleSource).toBe('claude-name')
    expect(orders2.env).toBe('wsl')
    // The name isn't copied into my metadata: it stays Claude Code's.
    expect(metadata2.value.sessions[ORDERS]?.name).toBeUndefined()
  })

  it('backfill runs once and never overwrites my names', async () => {
    const { sessions, metadata } = await setup()
    await sessions.start()
    const since = metadata.value.claudeNamesSince
    const stamped = metadata.value.sessions[SAFARI].nameAt
    expect(since).toBeTruthy()
    expect(stamped).toBe(since)
    await sessions.start()
    expect(metadata.value.claudeNamesSince).toBe(since)
    expect(metadata.value.sessions[SAFARI]).toMatchObject({
      name: 'Safari login loop',
      nameAt: stamped
    })
  })

  it('live: a rename in Claude Code updates the title and the search index', async () => {
    const { sessions } = await setup()
    await sessions.start()
    const orders = byId(sessions, ORDERS)
    expect(orders.titleSource).not.toBe('claude-name')
    let changed = 0
    sessions.on('changed', () => changed++)

    await renameInClaude(orders.filePath, ORDERS, 'Zebrafish pagination', new Date().toISOString())
    await sessions.fileChanged(orders.sourceId, orders.filePath)
    expect(sessions.get(orders.key)).toMatchObject({
      title: 'Zebrafish pagination',
      titleSource: 'claude-name',
      claudeName: 'Zebrafish pagination'
    })
    expect(sessions.searchKeys('zebrafish').map((h) => h.key)).toContain(orders.key)

    // Renamed again: the last one wins.
    await renameInClaude(orders.filePath, ORDERS, 'Quokka cursor', new Date().toISOString())
    await sessions.fileChanged(orders.sourceId, orders.filePath)
    expect(sessions.get(orders.key)?.title).toBe('Quokka cursor')
    expect(sessions.searchKeys('quokka').map((h) => h.key)).toContain(orders.key)
    await new Promise((r) => setTimeout(r, 200))
    expect(changed).toBeGreaterThan(0)
  })

  it('a later rename in Claude Code beats my older dashboard name, and mine beats an older one', async () => {
    const { sessions, metadata } = await setup()
    await sessions.start()
    const safari = byId(sessions, SAFARI)
    // My name was set before the rename.
    metadata.value.sessions[SAFARI].nameAt = '2026-10-31T10:00:00.000Z'
    await renameInClaude(
      safari.filePath,
      SAFARI,
      'Renamed in Claude Code',
      '2026-10-31T11:00:00.000Z'
    )
    await sessions.fileChanged(safari.sourceId, safari.filePath)
    expect(sessions.get(safari.key)).toMatchObject({
      title: 'Renamed in Claude Code',
      titleSource: 'claude-name'
    })
    // Renaming in the dashboard now makes mine the newest.
    const updated = sessions.updateMeta(safari.key, { name: 'Mine again' })
    expect(updated).toMatchObject({ title: 'Mine again', titleSource: 'name' })
    expect(Date.parse(metadata.value.sessions[SAFARI].nameAt!)).toBeGreaterThan(
      Date.parse('2026-10-31T11:00:00.000Z')
    )
  })

  it('"Use name from Claude Code" clears my override, and only where there is a Claude Code name', async () => {
    const { sessions, metadata } = await setup()
    await sessions.start()
    const safari = byId(sessions, SAFARI)
    const orders = byId(sessions, ORDERS)
    sessions.updateMeta(orders.key, { name: 'My orders name' })
    await renameInClaude(safari.filePath, SAFARI, 'Claude says Safari', '2026-10-01T00:00:00.000Z')
    await sessions.fileChanged(safari.sourceId, safari.filePath)
    expect(sessions.get(safari.key)?.titleSource).toBe('name')

    // ORDERS has no Claude Code name: it keeps mine.
    expect(sessions.applyClaudeNames([safari.key, orders.key, safari.key, 'nope:x'])).toBe(1)
    expect(sessions.get(safari.key)).toMatchObject({
      title: 'Claude says Safari',
      titleSource: 'claude-name'
    })
    expect(metadata.value.sessions[SAFARI].name).toBeUndefined()
    expect(metadata.value.sessions[SAFARI].nameAt).toBeUndefined()
    // Description and tags are untouched.
    expect(metadata.value.sessions[SAFARI].tags).toEqual(['bug', 'auth'])
    expect(sessions.get(orders.key)?.title).toBe('My orders name')
  })

  it("never writes names into Claude's session files", async () => {
    const { sessions } = await setup()
    await sessions.start()
    const orders = byId(sessions, ORDERS)
    await renameInClaude(orders.filePath, ORDERS, 'In Claude', new Date().toISOString())
    await sessions.fileChanged(orders.sourceId, orders.filePath)
    const before = await readFile(orders.filePath, 'utf8')
    sessions.updateMeta(orders.key, { name: 'Dashboard only' })
    sessions.applyClaudeNames([orders.key])
    await sessions.idle()
    expect(await readFile(orders.filePath, 'utf8')).toBe(before)
  })
})
