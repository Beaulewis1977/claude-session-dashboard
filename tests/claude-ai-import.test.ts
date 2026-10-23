import { createHash } from 'node:crypto'
import { mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { deflateRawSync } from 'node:zlib'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { convertClaudeAiExport } from '@shared/claude-ai'
import { listZip, readZipEntry } from '../src/main/core/zip'
import { importClaudeAiExport } from '../src/main/services/imports'
import { appPaths, createMetadataStore, createSettingsStore } from '../src/main/services/store'
import { SessionService } from '../src/main/services/sessions'
import { Launcher } from '../src/main/services/launcher'
import { createFixturesPlatform } from '../src/main/platform'

// CRC-32 for the test's zip writer.
const CRC = Array.from({ length: 256 }, (_, n) => {
  let c = n
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1
  return c >>> 0
})
function crc32(b: Buffer): number {
  let c = 0xffffffff
  for (const x of b) c = CRC[(c ^ x) & 0xff] ^ (c >>> 8)
  return (c ^ 0xffffffff) >>> 0
}

/** A minimal zip writer (stored or deflated), like a claude.ai export. */
function makeZip(files: { name: string; data: string; deflate?: boolean }[]): Buffer {
  const locals: Buffer[] = []
  const centrals: Buffer[] = []
  let offset = 0
  for (const f of files) {
    const raw = Buffer.from(f.data)
    const body = f.deflate ? deflateRawSync(raw) : raw
    const name = Buffer.from(f.name)
    const local = Buffer.alloc(30)
    local.writeUInt32LE(0x04034b50, 0)
    local.writeUInt16LE(20, 4)
    local.writeUInt16LE(0x800, 6)
    local.writeUInt16LE(f.deflate ? 8 : 0, 8)
    local.writeUInt32LE(crc32(raw), 14)
    local.writeUInt32LE(body.length, 18)
    local.writeUInt32LE(raw.length, 22)
    local.writeUInt16LE(name.length, 26)
    const central = Buffer.alloc(46)
    central.writeUInt32LE(0x02014b50, 0)
    central.writeUInt16LE(20, 4)
    central.writeUInt16LE(20, 6)
    central.writeUInt16LE(0x800, 8)
    central.writeUInt16LE(f.deflate ? 8 : 0, 10)
    central.writeUInt32LE(crc32(raw), 16)
    central.writeUInt32LE(body.length, 20)
    central.writeUInt32LE(raw.length, 24)
    central.writeUInt16LE(name.length, 28)
    central.writeUInt32LE(offset, 42)
    locals.push(local, name, body)
    centrals.push(central, name)
    offset += 30 + name.length + body.length
  }
  const cd = Buffer.concat(centrals)
  const end = Buffer.alloc(22)
  end.writeUInt32LE(0x06054b50, 0)
  end.writeUInt16LE(files.length, 8)
  end.writeUInt16LE(files.length, 10)
  end.writeUInt32LE(cd.length, 12)
  end.writeUInt32LE(offset, 16)
  return Buffer.concat([...locals, cd, end])
}

const CONVERSATIONS = [
  {
    uuid: 'f1e2d3c4-b5a6-4789-9abc-def012345678',
    name: 'Planning the kitchen remodel',
    created_at: '2026-09-14T18:20:00.000000Z',
    updated_at: '2026-09-14T18:31:00.000000Z',
    account: { uuid: 'acct' },
    chat_messages: [
      {
        uuid: 'm1',
        text: 'Help me plan a budget for a kitchen remodel',
        content: [{ type: 'text', text: 'Help me plan a budget for a kitchen remodel' }],
        sender: 'human',
        created_at: '2026-09-14T18:20:00.000000Z',
        attachments: [{ file_name: 'quotes.pdf', file_size: 1000 }],
        files: []
      },
      {
        uuid: 'm2',
        text: '',
        content: [
          { type: 'thinking', thinking: 'Break it down by category.' },
          { type: 'text', text: 'Start with **cabinets**, which are usually 30% of the budget.' }
        ],
        sender: 'assistant',
        created_at: '2026-09-14T18:20:30.000000Z'
      }
    ]
  },
  {
    // Older export shape: text only, no content blocks.
    uuid: 'a9b8c7d6-e5f4-4321-8765-0fedcba98765',
    name: '',
    created_at: '2026-08-02T08:00:00Z',
    chat_messages: [
      {
        uuid: 'o1',
        text: 'What rhymes with orange?',
        sender: 'human',
        created_at: '2026-08-02T08:00:00Z'
      },
      {
        uuid: 'o2',
        text: 'Almost nothing — "door hinge", loosely.',
        sender: 'assistant',
        created_at: '2026-08-02T08:00:05Z'
      }
    ]
  },
  { uuid: 'bad', name: 'no messages', chat_messages: [] },
  'not an object'
]

let root: string
beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'csd-import-'))
})
afterEach(async () => {
  await rm(root, { recursive: true, force: true })
})

describe('zip reader', () => {
  it('reads stored and deflated entries', () => {
    const zip = makeZip([
      { name: 'users.json', data: '[]' },
      { name: 'conversations.json', data: '{"a":1}'.repeat(200), deflate: true }
    ])
    const entries = listZip(zip)
    expect(entries.map((e) => [e.name, e.method])).toEqual([
      ['users.json', 0],
      ['conversations.json', 8]
    ])
    expect(readZipEntry(zip, entries[1]).toString()).toBe('{"a":1}'.repeat(200))
    expect(() => listZip(Buffer.from('not a zip at all, sorry'))).toThrow(/isn't a zip/)
  })
})

describe('claude.ai export import', () => {
  it('converts conversations into view-only transcripts, skipping bad entries', () => {
    const { conversations, skipped } = convertClaudeAiExport(CONVERSATIONS)
    expect(skipped).toBe(2)
    expect(conversations.map((c) => [c.name, c.messages])).toEqual([
      ['Planning the kitchen remodel', 2],
      ['Untitled conversation', 2]
    ])
    const lines = conversations[0].jsonl
      .trim()
      .split('\n')
      .map((l) => JSON.parse(l))
    expect(lines[0]).toMatchObject({ type: 'summary', summary: 'Planning the kitchen remodel' })
    expect(lines[1].message.content.at(-1)).toEqual({ type: 'text', text: 'Attached: quotes.pdf' })
    expect(lines[2].message.content[0]).toEqual({
      type: 'thinking',
      thinking: 'Break it down by category.'
    })
    // No token usage, no model: nothing to count.
    expect(conversations[0].jsonl).not.toContain('usage')
    expect(() => convertClaudeAiExport({ nope: true })).toThrow()
  })

  it('imports into the archive, never touches the zip, and shows the conversations view-only', async () => {
    const zipPath = join(root, 'data-2026-10-22.zip')
    const zip = makeZip([
      { name: 'users.json', data: '[{"uuid":"acct"}]' },
      { name: 'conversations.json', data: JSON.stringify(CONVERSATIONS), deflate: true }
    ])
    await writeFile(zipPath, zip)
    const before = await stat(zipPath)
    const hash = createHash('sha256')
      .update(await readFile(zipPath))
      .digest('hex')

    const dataDir = join(root, 'appdata')
    const paths = appPaths(dataDir)
    const metadata = createMetadataStore(paths)
    const settings = createSettingsStore(paths)
    await metadata.load()
    await settings.load()

    const res = await importClaudeAiExport(zipPath, paths, metadata)
    expect(res).toMatchObject({ ok: true, conversations: 2, added: 2, updated: 0, skipped: 2 })
    const again = await importClaudeAiExport(zipPath, paths, metadata)
    expect(again).toMatchObject({ ok: true, added: 0, unchanged: 2 })

    // Read-only: the zip is byte-for-byte the same and was never written.
    const after = await stat(zipPath)
    expect(after.mtimeMs).toBe(before.mtimeMs)
    expect(after.size).toBe(before.size)
    expect(
      createHash('sha256')
        .update(await readFile(zipPath))
        .digest('hex')
    ).toBe(hash)
    // Everything written is inside the app's archive.
    const rec = metadata.value.archive['claude-ai:f1e2d3c4-b5a6-4789-9abc-def012345678']
    expect(rec.archivePath.startsWith(paths.archiveDir)).toBe(true)
    expect(rec.origin).toBe('claude-ai')

    // The catalogue lists them as imported, searchable, labelled claude.ai.
    const fixtures = join(root, 'empty-sources')
    const platform = createFixturesPlatform(fixtures, fixtures)
    platform.listDistros = async () => []
    platform.listRunningDistros = async () => []
    const sessions = new SessionService(platform, paths, metadata, settings)
    await sessions.start()
    const s = sessions.get('claude-ai:f1e2d3c4-b5a6-4789-9abc-def012345678')!
    expect(s).toMatchObject({
      availability: 'imported',
      source: 'claude-ai',
      title: 'Planning the kitchen remodel',
      projectName: 'claude.ai',
      messageCount: 2
    })
    expect(sessions.searchKeys('cabinets').map((h) => h.key)).toContain(s.key)
    const detail = await sessions.detail(s.key)
    expect(detail?.messages.map((m) => m.role)).toEqual(['user', 'assistant'])
    // Can't be resumed.
    const launcher = new Launcher(platform, sessions, () => 'wt')
    const run = await launcher.launch({ key: s.key, fork: false, skipPermissions: false })
    expect(run.ok).toBe(false)
    expect(run.error).toMatch(/not resumed/)
    // ...or branched, from the preview on, and nothing is created.
    const branch = { at: detail!.messages[1].id, mode: 'include' as const, createOnly: true }
    const preview = await launcher.preview({
      key: s.key,
      fork: false,
      skipPermissions: false,
      branch
    })
    expect(preview.branch).toBeUndefined()
    expect(preview.branchError).toMatch(/not resumed or branched/)
    const count = sessions.list().length
    const made = await launcher.launch({ key: s.key, fork: false, skipPermissions: false, branch })
    expect(made.ok).toBe(false)
    expect(made.branch).toBeUndefined()
    expect(sessions.list()).toHaveLength(count)
    await sessions.idle()
  })

  it('reports a zip without conversations.json', async () => {
    const zipPath = join(root, 'other.zip')
    await writeFile(zipPath, makeZip([{ name: 'readme.txt', data: 'hi' }]))
    const paths = appPaths(join(root, 'appdata'))
    const metadata = createMetadataStore(paths)
    await metadata.load()
    const res = await importClaudeAiExport(zipPath, paths, metadata)
    expect(res.ok).toBe(false)
    expect(res.error).toMatch(/No conversations.json/)
  })
})
