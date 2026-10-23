// Regression tests for the PR #3 review findings (docs/PR3_REVIEW.md).

import { spawnSync } from 'node:child_process'
import { mkdtemp, rm } from 'node:fs/promises'
import { request as httpRequest } from 'node:http'
import { connect } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import WebSocket from 'ws'
import { DEFAULT_MOBILE } from '../src/shared/mobile'
import type { LaunchOptions, SessionSummary } from '../src/shared/types'
import type { LimitsState } from '../src/shared/usage/limits'
import { analyzeEvents, parseJsonl } from '../src/shared/jsonl'
import { JsonStore } from '../src/main/core/json-store'
import { buildLaunchCommand, claudeArgs } from '../src/main/core/launch'
import { DeviceRegistry, type MobileFile } from '../src/main/mobile/devices'
import { allowedHosts } from '../src/main/mobile/network'
import {
  RemoteLauncher,
  remoteLaunchOptions,
  type RemoteLaunchDeps
} from '../src/main/mobile/remote-launch'
import { phoneLimits, phoneSessions, phoneSettings } from '../src/main/mobile/rpc'
import { authToken, MobileServer } from '../src/main/mobile/server'
import { MobileService } from '../src/main/mobile/service'
import { fakeTailscale, TailscaleClient } from '../src/main/mobile/tailscale'
import { freshRemoteUrl } from '../src/renderer/src/lib/remote'
import { TOOLS } from './helpers'

const ID = '7f3c9a12-4b8e-4d21-9c6a-1e2f3a4b5c6d'
let dir: string
let now = Date.parse('2026-10-23T12:00:00Z')
const clock = (): number => now

const store = (): JsonStore<MobileFile> =>
  new JsonStore<MobileFile>(join(dir, 'mobile.json'), dir, () => ({
    version: 1,
    devices: [],
    activity: []
  }))

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'csd-review-'))
  now = Date.parse('2026-10-23T12:00:00Z')
})
afterEach(async () => {
  await rm(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 })
})

const SESSION = {
  key: `windows:${ID}`,
  sessionId: ID,
  sourceId: 'windows',
  title: 'Fix login',
  cwd: 'C:\\code\\app',
  env: 'windows',
  availability: 'live',
  meta: {}
} as unknown as SessionSummary

function remoteLauncher(over: Partial<RemoteLaunchDeps> = {}) {
  const launched: LaunchOptions[] = []
  const deps: RemoteLaunchDeps = {
    session: (k) => (k === SESSION.key ? SESSION : undefined),
    preview: async () => {
      throw new Error('unused')
    },
    launch: async (o) => {
      launched.push(o)
      return { ok: true, restored: false, commandLine: '' }
    },
    settings: () => ({
      terminal: 'wt',
      readOnly: false,
      confirmOnPc: false,
      branchConfirmed: true
    }),
    confirm: async () => true,
    deviceActive: () => true,
    log: () => undefined,
    now: clock,
    ...over
  }
  return { rl: new RemoteLauncher(deps), launched }
}
const DEVICE = { id: 'd1', name: 'Phone', tokenHash: '', createdAt: '', lastSeenAt: '' }

// ------------------------------------------------------------ PR3-01

describe('PR3-01: WebSocket messages never throw', () => {
  it('reads the token only from a well-formed auth message', () => {
    for (const bad of [
      'null',
      '[]',
      '1',
      '"x"',
      'true',
      '{"type":"auth"}',
      '{"type":"auth","token":5}',
      'nope'
    ])
      expect(authToken(bad)).toBeUndefined()
    expect(authToken('{"type":"auth","token":"abc"}')).toBe('abc')
  })

  it('refuses null and other JSON roots, and keeps serving', async () => {
    const reg = new DeviceRegistry(store())
    const server = new MobileServer({
      registry: reg,
      call: async () => null,
      launcher: remoteLauncher().rl,
      web: { file: async () => ({ body: Buffer.from('ok'), type: 'text/plain' }) },
      flags: () => ({ readOnly: false, confirmOnPc: false, mode: 'tailscale', appVersion: '1' }),
      hosts: () => allowedHosts({ bind: '127.0.0.1', port }),
      changed: () => undefined
    })
    let port = 0
    await server.start({ host: '127.0.0.1', port: 0 })
    port = server.address()!.port
    try {
      for (const frame of ['null', '[]', '0', '{"type":"auth","token":null}']) {
        const ws = new WebSocket(`ws://127.0.0.1:${port}/api/ws`, {
          headers: { origin: `http://127.0.0.1:${port}` }
        })
        const code = await new Promise<number>((resolve) => {
          ws.on('open', () => ws.send(frame))
          ws.on('close', (c) => resolve(c))
        })
        expect(code).toBe(4401)
      }
      expect(server.running).toBe(true)
    } finally {
      await server.stop()
    }
  })
})

// ------------------------------------------------------------ PR3-02

describe('PR3-02: phone launches ask before acting', () => {
  it('always passes --permission-mode default', () => {
    for (const kind of ['resume', 'fork', 'branch'] as const) {
      const o = remoteLaunchOptions(
        { key: SESSION.key, kind, branch: { at: 'm', mode: 'include' } },
        'wt'
      )
      expect(o.askPermissions).toBe(true)
      expect(o.skipPermissions).toBe(false)
    }
    for (const env of ['windows', 'wsl'] as const)
      for (const terminal of ['wt', 'powershell', 'cmd'] as const) {
        const c = buildLaunchCommand({
          env,
          distro: 'Ubuntu',
          cwd: env === 'wsl' ? '/home/me' : 'C:\\code',
          sessionId: ID,
          fork: false,
          skipPermissions: false,
          askPermissions: true,
          remoteControl: { name: 'Fix login' },
          terminal,
          tools: TOOLS
        })
        expect(c.claudeArgs.join(' ')).toContain('--permission-mode default --resume')
        expect(JSON.stringify(c.args)).toContain('--permission-mode default')
      }
    expect(() => claudeArgs(ID, true, false, false, undefined, true)).toThrow()
  })
})

// ------------------------------------------------------------ PR3-03

describe('PR3-03: checks again right before acting', () => {
  it('refuses a launch if the phone was revoked or read-only turned on meanwhile', async () => {
    const revoked = remoteLauncher({ deviceActive: () => false })
    expect((await revoked.rl.launch(DEVICE, { key: SESSION.key, kind: 'resume' })).ok).toBe(false)
    expect(revoked.launched).toHaveLength(0)

    let readOnly = false
    const flipped = remoteLauncher({
      settings: () => ({ terminal: 'wt', readOnly, confirmOnPc: true, branchConfirmed: true }),
      confirm: async () => {
        readOnly = true // turned on while the PC dialog was open
        return true
      }
    })
    const r = await flipped.rl.launch(DEVICE, { key: SESSION.key, kind: 'resume' })
    expect(r).toMatchObject({ ok: false })
    expect(flipped.launched).toHaveLength(0)
  })

  it('refuses an RPC whose phone was revoked while its body was arriving', async () => {
    const reg = new DeviceRegistry(store())
    const calls: string[] = []
    let port = 0
    const server = new MobileServer({
      registry: reg,
      call: async (c) => {
        calls.push(c)
        return null
      },
      launcher: remoteLauncher().rl,
      web: { file: async () => undefined },
      flags: () => ({ readOnly: false, confirmOnPc: false, mode: 'tailscale', appVersion: '1' }),
      hosts: () => allowedHosts({ bind: '127.0.0.1', port }),
      changed: () => undefined
    })
    await server.start({ host: '127.0.0.1', port: 0 })
    port = server.address()!.port
    try {
      const p = reg.pair(reg.startPairing('h').code, 'Phone')
      if (!p.ok) throw new Error('pairing failed')
      const body = JSON.stringify({ method: 'updateMeta', args: [SESSION.key, { name: 'x' }] })
      const status = await new Promise<number>((resolve, reject) => {
        const r = httpRequest(
          {
            host: '127.0.0.1',
            port,
            path: '/api/rpc',
            method: 'POST',
            headers: {
              host: `127.0.0.1:${port}`,
              'content-type': 'application/json',
              'content-length': Buffer.byteLength(body),
              authorization: `Bearer ${p.token}`
            }
          },
          (res) => {
            res.resume()
            resolve(res.statusCode ?? 0)
          }
        )
        r.on('error', reject)
        r.write(body.slice(0, 1))
        setTimeout(() => {
          reg.revoke(p.device.id)
          r.end(body.slice(1))
        }, 100)
      })
      expect(status).toBe(401)
      expect(calls).not.toContain('sessions:updateMeta')
    } finally {
      await server.stop()
    }
  })
})

// --------------------------------------------------------- PR3-04, PR3-12

function service(calls: string[][] = []) {
  let settings = { ...DEFAULT_MOBILE, port: 0 }
  const svc = new MobileService({
    store: store(),
    settings: () => settings,
    saveSettings: async (next) => {
      settings = next
    },
    call: async () => null,
    launch: {
      session: () => undefined,
      preview: async () => {
        throw new Error('unused')
      },
      launch: async () => ({ ok: false, restored: false, commandLine: '' }),
      settings: () => ({ terminal: 'wt', branchConfirmed: false }),
      confirm: async () => false
    },
    web: { file: async () => undefined },
    webAppFile: join(dir, 'mobile.html'),
    tailscale: fakeTailscale({ calls }),
    keys: { available: () => false, encrypt: (s) => Buffer.from(s), decrypt: (b) => b.toString() },
    appVersion: '1',
    fixtures: true,
    claudePath: async () => undefined
  })
  return svc
}

const listening = (port: number): Promise<boolean> =>
  new Promise((resolve) => {
    const s = connect(port, '127.0.0.1')
    s.on('connect', () => {
      s.destroy()
      resolve(true)
    })
    s.on('error', () => resolve(false))
  })

describe('PR3-04: on / off can overlap safely', () => {
  it('leaves no listener behind after overlapping start, port change and stop', async () => {
    const svc = service()
    const free = async (): Promise<number> => {
      const s = new MobileServer({
        registry: new DeviceRegistry(store()),
        call: async () => null,
        launcher: remoteLauncher().rl,
        web: { file: async () => undefined },
        flags: () => ({ readOnly: false, confirmOnPc: false, mode: 'tailscale', appVersion: '1' }),
        hosts: () => new Set(),
        changed: () => undefined
      })
      await s.start({ host: '127.0.0.1', port: 0 })
      const p = s.address()!.port
      await s.stop()
      return p
    }
    const [a, b] = [await free(), await free()]
    await svc.update({ port: a })
    await Promise.all([svc.start(), svc.update({ port: b }), svc.start()])
    await svc.stop()
    expect(await listening(a)).toBe(false)
    expect(await listening(b)).toBe(false)
  })
})

describe('PR3-12: phones hear about policy changes', () => {
  it('broadcasts when read-only or confirm-on-PC changes', async () => {
    const svc = service()
    const spy = vi.spyOn(svc.server, 'broadcast')
    await svc.update({ readOnly: true })
    expect(spy).toHaveBeenCalledWith({ type: 'event', channel: 'policy' })
  })
})

// ------------------------------------------------------------ PR3-05

describe('PR3-05: an unreadable serve status changes nothing', () => {
  it("doesn't add a rule when serve status fails", async () => {
    const calls: string[][] = []
    const ts = new TailscaleClient(
      async (_f, args) => {
        calls.push(args)
        if (args[0] === 'status')
          return {
            code: 0,
            stdout: JSON.stringify({ BackendState: 'Running', Self: { DNSName: 'pc.ts.net.' } }),
            stderr: ''
          }
        if (args[1] === 'status') return { code: 1, stdout: '', stderr: 'boom' }
        return { code: 0, stdout: '', stderr: '' }
      },
      async () => 'C:\\Program Files\\Tailscale\\tailscale.exe'
    )
    const r = await ts.serveOn(8443, 47821)
    expect(r.ok).toBe(false)
    expect(calls.some((c) => c[0] === 'serve' && c[1] === '--bg')).toBe(false)
  })
})

// ------------------------------------------------------------ PR3-06

describe('PR3-06: API keys are removed in the final shell too', () => {
  const cmd = (env: 'windows' | 'wsl', terminal: 'wt' | 'powershell' | 'cmd') =>
    buildLaunchCommand({
      env,
      distro: 'Ubuntu',
      cwd: env === 'wsl' ? '/home/me' : 'C:\\code',
      sessionId: ID,
      fork: false,
      skipPermissions: false,
      remoteControl: {},
      terminal,
      tools: TOOLS
    })

  it('unsets them after the profile, in every shell', () => {
    expect(cmd('wsl', 'wt').args.at(-1)).toMatch(
      /^unset ANTHROPIC_API_KEY ANTHROPIC_AUTH_TOKEN && claude /
    )
    expect(cmd('wsl', 'wt').args.join(' ')).not.toContain(';')
    expect(cmd('wsl', 'cmd').args[2]).toContain(
      'unset ANTHROPIC_API_KEY ANTHROPIC_AUTH_TOKEN && claude'
    )
    expect(cmd('wsl', 'powershell').args[2]).toContain(
      'unset ANTHROPIC_API_KEY ANTHROPIC_AUTH_TOKEN && claude'
    )
    expect(cmd('windows', 'wt').args.at(-1)).toContain(
      'set ANTHROPIC_API_KEY=& set ANTHROPIC_AUTH_TOKEN=& "'
    )
    expect(cmd('windows', 'cmd').args[2]).toContain(
      'set ANTHROPIC_API_KEY=& set ANTHROPIC_AUTH_TOKEN=& "'
    )
    expect(cmd('windows', 'powershell').args[2]).toContain(
      'Remove-Item Env:ANTHROPIC_API_KEY -ErrorAction SilentlyContinue; Remove-Item Env:ANTHROPIC_AUTH_TOKEN'
    )
  })

  const hasBash = spawnSync('bash', ['-c', 'true']).status === 0
  it.runIf(hasBash)('a profile that exports a key no longer reaches claude (bash)', () => {
    const line = cmd('wsl', 'wt').args.at(-1)!
    const r = spawnSync('bash', ['-s'], {
      input: `export ANTHROPIC_API_KEY=k ANTHROPIC_AUTH_TOKEN=t\nclaude() { echo "[\${ANTHROPIC_API_KEY-}][\${ANTHROPIC_AUTH_TOKEN-}]"; }\n${line}\n`,
      encoding: 'utf8'
    })
    expect(r.stdout.trim()).toBe('[][]')
  })

  it.runIf(process.platform === 'win32')('… and none reaches claude through cmd', async () => {
    const { mkdtempSync, writeFileSync } = await import('node:fs')
    const d = mkdtempSync(join(tmpdir(), 'csd-env-'))
    const fake = join(d, 'claude.cmd')
    writeFileSync(fake, '@echo off\r\necho [%ANTHROPIC_API_KEY%][%ANTHROPIC_AUTH_TOKEN%]\r\n')
    const c = buildLaunchCommand({
      env: 'windows',
      sessionId: ID,
      cwd: d,
      fork: false,
      skipPermissions: false,
      remoteControl: {},
      terminal: 'cmd',
      tools: { ...TOOLS, claude: fake }
    })
    const r = spawnSync(
      c.command,
      c.args.map((a) => (a === '/k' ? '/c' : a)),
      {
        cwd: c.spawnCwd,
        windowsVerbatimArguments: true,
        env: { ...process.env, ANTHROPIC_API_KEY: 'k', ANTHROPIC_AUTH_TOKEN: 't' },
        encoding: 'utf8'
      }
    )
    // In a batch file an unset %VAR% expands to nothing.
    expect(r.stdout.trim()).toBe('[][]')
  })
})

// ------------------------------------------------------- PR3-07, PR3-08

describe('PR3-07: a fork links to the new session, never the parent', () => {
  it('returns no parent key for a fork, and finds the new link by folder', async () => {
    const { rl } = remoteLauncher()
    const r = await rl.launch(DEVICE, { key: SESSION.key, kind: 'fork' })
    expect(r.key).toBeUndefined()
    expect(r.fork).toEqual({ parentKey: SESSION.key, sourceId: 'windows', cwd: 'C:\\code\\app' })
    const at = Date.parse('2026-10-23T12:00:00Z')
    const iso = (ms: number) => new Date(at + ms).toISOString()
    const parent = {
      ...SESSION,
      remoteUrl: 'https://claude.ai/code/session_PARENT0000',
      remoteUrlAt: iso(1000)
    }
    const child = {
      ...SESSION,
      key: 'windows:new',
      cwd: 'c:\\CODE\\app',
      remoteUrl: 'https://claude.ai/code/session_CHILD00000',
      remoteUrlAt: iso(9000)
    }
    const other = {
      ...child,
      key: 'windows:x',
      cwd: 'C:\\other',
      remoteUrl: 'https://claude.ai/code/session_OTHER00000'
    }
    expect(freshRemoteUrl([parent], r, at)).toBeUndefined()
    expect(freshRemoteUrl([parent, other, child], r, at)).toBe(child.remoteUrl)
    // Resume still watches its own session, and only links recorded since the launch.
    expect(freshRemoteUrl([parent], { key: SESSION.key }, at)).toBe(parent.remoteUrl)
    expect(freshRemoteUrl([parent], { key: SESSION.key }, at + 60_000)).toBeUndefined()
  })
})

describe('PR3-08: a branch does not adopt the parent’s Remote Control link', () => {
  it('ignores bridge_status entries copied into a branch', () => {
    const status = {
      type: 'system',
      subtype: 'bridge_status',
      url: 'https://claude.ai/code/session_PARENT0000',
      timestamp: '2026-10-23T10:00:00Z'
    }
    const copied = JSON.stringify({
      ...status,
      forkedFrom: { sessionId: 'parent', messageUuid: 'u1' }
    })
    expect(analyzeEvents(parseJsonl(copied).events).remoteUrl).toBeUndefined()
    expect(analyzeEvents(parseJsonl(JSON.stringify(status)).events).remoteUrl).toBe(status.url)
  })
})

// ------------------------------------------------------------ PR3-10

describe('PR3-10: phones get no PC folder paths', () => {
  it('strips storage, source, settings and bridge paths', () => {
    const p = phoneSessions({
      sessions: [
        {
          ...SESSION,
          filePath: 'C:\\a.jsonl',
          originalPath: 'C:\\a.jsonl',
          archivePath: 'C:\\arch\\a.jsonl'
        }
      ],
      sources: [
        {
          id: 'w',
          label: 'W',
          env: 'windows',
          projectsDir: 'C:\\Users\\me\\.claude\\projects',
          kind: 'auto',
          status: 'ok',
          sessionCount: 1,
          claudeSettingsPath: 'C:\\s.json'
        }
      ],
      scan: { phase: 'ready', done: 1, total: 1 }
    })
    const text = JSON.stringify(p)
    for (const leaked of ['a.jsonl', 'arch', '.claude', 's.json'])
      expect(text).not.toContain(leaked)
    expect(p.sessions[0].cwd).toBe('C:\\code\\app')
    const s = phoneSettings({
      extraFolders: ['C:\\x'],
      projectBilling: { 'c:\\p': 'acct-1' }
    } as never)
    expect(s.extraFolders).toEqual([])
    expect(s.projectBilling).toEqual({})
    const l = phoneLimits({
      envs: [
        { settingsPath: 'C:\\s', bridgeDir: 'C:\\b', chained: 'cmd --token=secret', label: 'W' }
      ]
    } as unknown as LimitsState)
    expect(JSON.stringify(l)).not.toMatch(/secret|C:/)
  })
})

// ------------------------------------------------------- PR3-11, PR3-13

describe('PR3-11: expired phones lose their live connection', () => {
  it("stops pushing to a phone that's no longer paired", async () => {
    const reg = new DeviceRegistry(store(), clock)
    let port = 0
    const server = new MobileServer({
      registry: reg,
      call: async () => null,
      launcher: remoteLauncher().rl,
      web: { file: async () => undefined },
      flags: () => ({ readOnly: false, confirmOnPc: false, mode: 'tailscale', appVersion: '1' }),
      hosts: () => allowedHosts({ bind: '127.0.0.1', port }),
      changed: () => undefined,
      now: clock
    })
    await server.start({ host: '127.0.0.1', port: 0 })
    port = server.address()!.port
    try {
      const p = reg.pair(reg.startPairing('h').code, 'Phone')
      if (!p.ok) throw new Error('pairing failed')
      const ws = new WebSocket(`ws://127.0.0.1:${port}/api/ws`, {
        headers: { origin: `http://127.0.0.1:${port}` }
      })
      await new Promise<void>((resolve) => {
        ws.on('open', () => ws.send(JSON.stringify({ type: 'auth', token: p.token })))
        ws.on('message', () => resolve())
      })
      expect(server.broadcast({ type: 'toast', title: 'a' })).toBe(1)
      now += 31 * 24 * 3600_000
      expect(server.broadcast({ type: 'toast', title: 'b' })).toBe(0)
      expect(server.isConnected(p.device.id)).toBe(false)
    } finally {
      await server.stop()
    }
  })
})

describe('PR3-13: no e-mail in the activity log', () => {
  it('logs wrong-code lockouts without the Tailscale identity', () => {
    const reg = new DeviceRegistry(store(), clock)
    reg.startPairing('h')
    for (let i = 0; i < 5; i++) reg.pair('AAAA-AAAA', 'x', '', 'ts:me@example.com:100.64.0.1')
    expect(JSON.stringify(reg.activity())).not.toContain('@')
  })
})

// ------------------------------------------------- second review (R2)

describe('PR3-R2-01: the real launcher checks again before writing or starting', () => {
  it('stops if read-only is turned on (or the phone revoked) while it prepares', async () => {
    const { Launcher } = await import('../src/main/services/launcher')
    for (const change of ['readOnly', 'revoke'] as const) {
      let readOnly = false
      let active = true
      let releaseTools: (t: typeof TOOLS) => void = () => undefined
      const spawn = vi.fn(async () => undefined)
      const session = { ...SESSION, originalPath: 'C:\\a.jsonl', title: 'Fix login' }
      const launcher = new Launcher(
        {
          canLaunch: true,
          fixtures: false,
          windowsHome: 'C:\\Users\\me',
          launchTools: () => new Promise((r) => (releaseTools = r)),
          pathExists: async () => true,
          spawnDetached: spawn,
          distroRoots: () => []
        } as never,
        { get: () => session, source: () => undefined, archiveRecord: () => undefined } as never,
        () => 'wt'
      )
      const { rl } = remoteLauncher({
        settings: () => ({ terminal: 'wt', readOnly, confirmOnPc: false, branchConfirmed: true }),
        deviceActive: () => active,
        launch: (o, ctx) => launcher.launch(o, ctx)
      })
      const pending = rl.launch(DEVICE, { key: SESSION.key, kind: 'resume' })
      await new Promise((r) => setTimeout(r, 20))
      if (change === 'readOnly') readOnly = true
      else active = false
      releaseTools(TOOLS)
      const r = await pending
      expect(r.ok).toBe(false)
      expect(spawn).not.toHaveBeenCalled()
    }
  })
})

describe('PR3-R2-02: branches built by the real builder', () => {
  it('drop or mark the original’s Remote Control status', async () => {
    const { planBranch, buildBranchFile } = await import('../src/shared/branch')
    const NEW = '11111111-2222-4333-8444-555555555555'
    const lines = [
      {
        type: 'user',
        uuid: 'u1',
        sessionId: 'p',
        timestamp: '2026-10-23T10:00:00Z',
        message: { role: 'user', content: 'hello' }
      },
      {
        type: 'system',
        subtype: 'bridge_status',
        sessionId: 'p',
        url: 'https://claude.ai/code/session_PARENT0000',
        timestamp: '2026-10-23T10:00:01Z'
      },
      {
        type: 'system',
        subtype: 'bridge_status',
        uuid: 's2',
        parentUuid: 'u1',
        sessionId: 'p',
        url: 'https://claude.ai/code/session_PARENT1111',
        timestamp: '2026-10-23T10:00:02Z'
      },
      {
        type: 'assistant',
        uuid: 'a1',
        parentUuid: 's2',
        sessionId: 'p',
        timestamp: '2026-10-23T10:00:03Z',
        message: { id: 'm1', role: 'assistant', content: [{ type: 'text', text: 'hi' }] }
      }
    ]
    const events = parseJsonl(lines.map((l) => JSON.stringify(l)).join('\n')).events
    const plan = planBranch(events, 'a1')
    if (!plan.ok) throw new Error(plan.error)
    const file = buildBranchFile(events, plan, NEW, 'p')
    const a = analyzeEvents(parseJsonl(file).events)
    expect(a.remoteUrl).toBeUndefined()
    expect(file).not.toContain('PARENT0000')
  })
})

describe('PR3-R2-03: a fork never borrows a sibling’s link', () => {
  it('only takes a session that is new since the launch', () => {
    const at = Date.parse('2026-10-23T12:00:00Z')
    const iso = (ms: number) => new Date(at + ms).toISOString()
    const result = { fork: { parentKey: SESSION.key, sourceId: 'windows', cwd: SESSION.cwd } }
    const sibling = {
      ...SESSION,
      key: 'windows:sib',
      remoteUrl: 'https://claude.ai/code/session_SIBLING000',
      remoteUrlAt: iso(2000)
    }
    const child = {
      ...SESSION,
      key: 'windows:new',
      remoteUrl: 'https://claude.ai/code/session_CHILD00000',
      remoteUrlAt: iso(1000)
    }
    const existing = new Set([SESSION.key, sibling.key])
    expect(freshRemoteUrl([sibling], result, at, existing)).toBeUndefined()
    expect(freshRemoteUrl([sibling, child], result, at, existing)).toBe(child.remoteUrl)
    // Two new sessions and neither linked to the parent: don't guess…
    const other = {
      ...child,
      key: 'windows:new2',
      remoteUrl: 'https://claude.ai/code/session_NEW2000000'
    }
    expect(freshRemoteUrl([child, other], result, at, existing)).toBeUndefined()
    // …unless one is linked to the parent.
    const linked = { ...child, lineage: { parentKey: SESSION.key } } as unknown as typeof child
    expect(freshRemoteUrl([linked, other], result, at, existing)).toBe(child.remoteUrl)
  })
})

describe('PR3-R2-04: start-up keeps a recovery that arrives mid-request', () => {
  it('runs again after a failed request if asked meanwhile, and retries on a timer', async () => {
    const { bootstrap } = await import('../src/renderer/src/mobile/bootstrap')
    let loaded = false
    const runs: Array<{ resolve: () => void; reject: (e: Error) => void }> = []
    const timers: Array<() => void> = []
    const boot = bootstrap({
      run: () =>
        new Promise<void>((resolve, reject) =>
          runs.push({
            resolve: () => {
              loaded = true
              resolve()
            },
            reject
          })
        ),
      loaded: () => loaded,
      onError: () => undefined,
      setTimer: (fn) => timers.push(fn),
      clearTimer: () => undefined
    })
    boot.load() // offline: pending
    boot.load() // the PC came back meanwhile: kept, not dropped
    runs[0].reject(new Error('offline'))
    await new Promise((r) => setTimeout(r, 0))
    expect(runs).toHaveLength(2)
    runs[1].reject(new Error('still offline'))
    await new Promise((r) => setTimeout(r, 0))
    expect(timers).toHaveLength(1) // nothing else asked: a timed retry
    timers[0]()
    runs[2].resolve()
    await new Promise((r) => setTimeout(r, 0))
    expect(loaded).toBe(true)
    boot.load()
    expect(runs).toHaveLength(3) // started: nothing more
  })
})

describe('PR3-R2-05: quitting waits for a start already queued', () => {
  it('leaves nothing listening and starts nothing after', async () => {
    const svc = service()
    const starting = svc.start()
    await svc.shutdown()
    await starting
    expect(svc.server.running).toBe(false)
    await svc.start()
    expect(svc.server.running).toBe(false)
  })
})

// ------------------------------------------------- third review (R3)

describe('PR3-R3-01: the fallback terminal is checked too', () => {
  it('does not start PowerShell if read-only was turned on while Windows Terminal failed', async () => {
    const { Launcher } = await import('../src/main/services/launcher')
    let readOnly = false
    const spawn = vi.fn(async () => {
      if (spawn.mock.calls.length === 1) {
        readOnly = true // changed while the first attempt was pending
        throw Object.assign(new Error('not found'), { code: 'ENOENT' })
      }
    })
    const launcher = new Launcher(
      {
        canLaunch: true,
        fixtures: false,
        windowsHome: 'C:/Users/me',
        launchTools: async () => TOOLS,
        pathExists: async () => true,
        spawnDetached: spawn,
        distroRoots: () => []
      } as never,
      {
        get: () => ({ ...SESSION, originalPath: 'C:/a.jsonl' }),
        source: () => undefined,
        archiveRecord: () => undefined
      } as never,
      () => 'wt'
    )
    const { rl } = remoteLauncher({
      settings: () => ({ terminal: 'wt', readOnly, confirmOnPc: false, branchConfirmed: true }),
      launch: (o, ctx) => launcher.launch(o, ctx)
    })
    const r = await rl.launch(DEVICE, { key: SESSION.key, kind: 'resume' })
    expect(r.ok).toBe(false)
    expect(spawn).toHaveBeenCalledTimes(1)
  })
})

describe('PR3-R3-02: a fork of another session is never the link', () => {
  it('rejects a new candidate linked to a different parent', () => {
    const at = Date.parse('2026-10-23T12:00:00Z')
    const result = { fork: { parentKey: SESSION.key, sourceId: 'windows', cwd: SESSION.cwd } }
    const otherFork = {
      ...SESSION,
      key: 'windows:of',
      remoteUrl: 'https://claude.ai/code/session_OTHERFORK0',
      remoteUrlAt: new Date(at + 1000).toISOString(),
      lineage: { parentKey: 'windows:someone-else' }
    } as unknown as SessionSummary
    expect(freshRemoteUrl([otherFork], result, at, new Set([SESSION.key]))).toBeUndefined()
  })
})

async function freePort(): Promise<number> {
  const { createServer } = await import('node:net')
  return new Promise((resolve) => {
    const s = createServer().listen(0, '127.0.0.1', () => {
      const p = (s.address() as { port: number }).port
      s.close(() => resolve(p))
    })
  })
}

describe('PR3-R3-03: a failed rule removal during a port move', () => {
  it("doesn't move, keeps the rule removable, and leaves other rules alone", async () => {
    const svc = service()
    const [a, b] = [await freePort(), await freePort()]
    await svc.update({ port: a })
    await svc.start()
    const store = (svc as unknown as { deps: { store: JsonStore<MobileFile> } }).deps.store
    expect(store.value.serveRule?.target).toBe(`http://127.0.0.1:${a}`)
    vi.spyOn(svc.tailscale, 'serveOff').mockResolvedValueOnce({ ok: false, error: 'busy' })
    const st = await svc.update({ port: b })
    expect(st.settings.port).toBe(a) // not moved
    expect(st.error).toMatch(/wasn't moved/)
    expect(st.running).toBe(true)
    // Stop removes the recorded rule.
    await svc.stop()
    expect(store.value.serveRule).toBeUndefined()
    expect((await svc.tailscale.status(8443, a)).serve).toBe('off')
  })

  it('removes a recorded rule on shutdown even when already stopped', async () => {
    const svc = service()
    const a = await freePort()
    await svc.update({ port: a })
    await svc.start()
    vi.spyOn(svc.tailscale, 'serveOff').mockResolvedValueOnce({ ok: false, error: 'busy' })
    await svc.stop()
    const store = (svc as unknown as { deps: { store: JsonStore<MobileFile> } }).deps.store
    expect(store.value.serveRule).toBeDefined() // removal failed
    await svc.shutdown()
    expect(store.value.serveRule).toBeUndefined()
  })
})

describe('PR3-R3-04: quitting during a restart keeps phone access on for next time', () => {
  it('leaves enabled set', async () => {
    const svc = service()
    const [a, b] = [await freePort(), await freePort()]
    await svc.update({ port: a })
    await svc.start()
    expect(svc.settings.enabled).toBe(true)
    const moving = svc.update({ port: b })
    await svc.shutdown()
    await moving
    expect(svc.server.running).toBe(false)
    expect(svc.settings.enabled).toBe(true)
  })
})

// ------------------------------------------------- fourth review (R4)

describe('PR3-R4-01: a rolled-back mode change keeps the firewall rule', () => {
  it('offers removal only when home Wi-Fi mode was really left', async () => {
    const { leftHomeWifi } = await import('../src/main/mobile/firewall')
    expect(leftHomeWifi('lan', 'tailscale')).toBe(true)
    expect(leftHomeWifi('lan', 'lan')).toBe(false) // rolled back
    expect(leftHomeWifi('tailscale', 'tailscale')).toBe(false)
    expect(leftHomeWifi('tailscale', 'lan')).toBe(false)
  })
})
