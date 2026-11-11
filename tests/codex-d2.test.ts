// Codex Phase D2: summaries, Continue fresh, agent-to-agent messages and trends.

import { cp, mkdir, mkdtemp, readFile, readdir, rm, utimes, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  readHandoffPrompt,
  transcriptForSummary,
  type AiSummary,
  DEFAULT_SUMMARY_SETTINGS,
  sanitizeSummarySettings,
  SUMMARY_NOTICE_VERSION
} from '@shared/summary'
import { blockToMarkdown } from '@shared/markdown'
import type { LaunchOptions, SessionSummary } from '@shared/types'
import type { CodexTurnSample, UsageRecord } from '@shared/usage/types'
import { DEFAULT_CODEX_PRICES, DEFAULT_PRICES } from '@shared/usage/pricing'
import { DEFAULT_WEIGHTS } from '@shared/usage/limits'
import { ContextCost } from '../src/main/services/context-cost'
import {
  buildCodexTrends,
  codexMetricValue,
  compareCodexTrends,
  versionStep
} from '@shared/usage/codex-trends'
import { blocksMatching } from '@/lib/transcript'
import { blocksToPlainText } from '@/lib/copy'
import { fixturesLayout, prepareFixtures, seedFixtureData } from '../src/main/fixtures'
import { createFixturesPlatform } from '../src/main/platform'
import { appPaths, createMetadataStore, createSettingsStore } from '../src/main/services/store'
import {
  continuedHandoffId,
  PENDING_CONTINUE_MS,
  SessionService
} from '../src/main/services/sessions'
import { Launcher } from '../src/main/services/launcher'
import { ProviderRegistry } from '../src/main/providers/registry'
import { claudeProvider } from '../src/main/providers/claude'
import { createCodexProvider } from '../src/main/providers/codex'
import { analyzeCodex, buildCodexMessages } from '../src/main/providers/codex/parse'
import { readCodexUsageText } from '../src/main/providers/codex/read'
import { analyzeCodexUsage } from '../src/main/providers/codex/usage'
import { buildCodexLaunch, codexContinueArgs } from '../src/main/providers/codex/launch'
import { CODEX_USAGE_VERSION, CodexUsageStore } from '../src/main/services/codex-usage'
import { cleanupHandoffs, handoffPath, handoffStats, writeHandoff } from '../src/main/core/handoff'
import type { LaunchCommand, LaunchTools } from '../src/main/core/launch'
import {
  RemoteLauncher,
  remoteLaunchOptions,
  type RemoteLaunchDeps
} from '../src/main/mobile/remote-launch'
import { PrintRunner } from '../src/main/services/print-runner'
import { SummaryService } from '../src/main/services/summaries'
import { FIXTURES } from './helpers'

const CLI = '019a1111-0000-7000-8000-000000000001'
const WSL = '019a7777-0000-7000-8000-000000000007'
const SUB = '019a3333-0000-7000-8000-000000000003'
const NEW_CODEX = '019a9999-0000-7000-8000-000000000009'
const HANDOFF_ID = '6d6d6d6d-6d6d-4d6d-8d6d-6d6d6d6d6d6d'

const SUMMARY: AiSummary = {
  title: 'Fix the checkout rounding',
  done: ['Moved the rounding after tax'],
  files: ['src/checkout/total.ts'],
  decisions: [],
  todos: ['Add a test for coupons'],
  pickUp: 'Write the coupon test.',
  model: 'claude-sonnet-5-5',
  generatedAt: '2026-10-22T19:47:00.000Z',
  messageCount: 2
}

const TOOLS: LaunchTools = {
  wt: 'C:\\Windows\\wt.exe',
  powershell: 'C:\\Windows\\powershell.exe',
  cmd: 'C:\\Windows\\cmd.exe',
  wsl: 'C:\\Windows\\wsl.exe',
  codex: 'C:\\Users\\alex\\AppData\\Roaming\\npm\\codex.cmd'
}

let root: string
let busy: SessionService[] = []
beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'csd-codex-d2-'))
})
afterEach(async () => {
  await Promise.all(busy.map((b) => b.idle().catch(() => undefined)))
  busy = []
  await rm(root, { recursive: true, force: true, maxRetries: 5 })
})

const line = (type: string, payload: Record<string, unknown>, ts = '2026-10-20T10:00:00Z') =>
  JSON.stringify({ timestamp: ts, type, payload })

/** A user message (a prompt I wrote). */
const prompt = (text: string) => ({
  type: 'message',
  role: 'user',
  content: [{ type: 'input_text', text }]
})

// ------------------------------------------------------- agent messages

describe('messages between agents', () => {
  const am = (id: string | undefined, author: string, recipient: string, text: string) =>
    line('response_item', {
      type: 'agent_message',
      ...(id ? { id } : {}),
      author,
      recipient,
      content: [{ type: 'input_text', text }]
    })
  const text = [
    line('session_meta', { id: SUB, cwd: 'C:\\x' }),
    line('response_item', {
      type: 'message',
      role: 'user',
      content: [{ type: 'input_text', text: 'Audit the rounding.' }]
    }),
    am('am_1', '/root', '/root/money_audit', 'Check src/checkout for round() calls.'),
    // The same item again (a copied history): shown once.
    am('am_1', '/root', '/root/money_audit', 'Check src/checkout for round() calls.'),
    line('response_item', {
      type: 'message',
      role: 'assistant',
      content: [{ type: 'output_text', text: 'One call, in total.ts.' }]
    }),
    // Its text is the answer right above it: not shown a second time.
    am('am_2', '/root/money_audit', '/root', 'One call, in total.ts.'),
    am('am_3', '/root/money_audit', '/root', 'Report: total.ts line 12 rounds before tax.'),
    // Without author or recipient it isn't a message between agents.
    line('response_item', {
      type: 'agent_message',
      id: 'am_4',
      content: [{ type: 'input_text', text: 'stray' }]
    })
  ].join('\n')

  it('become collapsible Agent → Agent steps with the author and recipient, once each', () => {
    const msgs = buildCodexMessages(text)
    const blocks = msgs.flatMap((m) => m.blocks).filter((b) => b.type === 'agent_message')
    expect(blocks).toEqual([
      {
        type: 'agent_message',
        author: '/root',
        recipient: '/root/money_audit',
        text: 'Check src/checkout for round() calls.'
      },
      {
        type: 'agent_message',
        author: '/root/money_audit',
        recipient: '/root',
        text: 'Report: total.ts line 12 rounds before tax.'
      }
    ])
    // They're steps of the agent's flow, never prompts or answers.
    const agentMsgs = msgs.filter((m) => m.blocks.some((b) => b.type === 'agent_message'))
    expect(agentMsgs.every((m) => m.role === 'assistant')).toBe(true)
    const a = analyzeCodex(text, SUB)
    expect(a.userMessageCount).toBe(1)
    expect(a.assistantMessageCount).toBe(1)
  })

  it('are found by the session search and by Find in session', () => {
    expect(analyzeCodex(text, SUB).searchText).toContain('rounds before tax')
    const msgs = buildCodexMessages(text)
    const open = blocksMatching(msgs, 'before tax')
    expect(open.size).toBe(1)
    expect(blocksMatching(msgs, '/root/money_audit').size).toBe(2)
  })

  it('copy and export with who sent them to whom', () => {
    const b = {
      type: 'agent_message' as const,
      author: '/root/a',
      recipient: '/root',
      text: 'Done <ok>'
    }
    expect(blocksToPlainText([b])).toBe('/root/a → /root\n\nDone <ok>')
    expect(blockToMarkdown(b)).toContain('<summary>Agent → Agent: /root/a → /root</summary>')
  })

  it('the sample subagent rollout shows its report', async () => {
    const file = join(
      FIXTURES,
      'codex',
      'windows',
      'Users',
      'alex',
      '.codex',
      'sessions',
      '2026',
      '10',
      '20',
      `rollout-2026-10-20T09-20-30-${SUB}.jsonl`
    )
    const msgs = buildCodexMessages(await readFile(file, 'utf8'))
    expect(msgs.flatMap((m) => m.blocks).some((b) => b.type === 'agent_message')).toBe(true)
  })
})

// --------------------------------------------------------- summaries

describe('the summary transcript of a Codex session', () => {
  const rollout = [
    line('session_meta', { id: CLI, cwd: 'C:\\code\\shop' }),
    // Context Codex adds as user text: never sent.
    line('response_item', {
      type: 'message',
      role: 'user',
      content: [{ type: 'input_text', text: '<environment_context>\n<cwd>C:\\code</cwd>' }]
    }),
    line('response_item', {
      type: 'message',
      role: 'user',
      content: [{ type: 'input_text', text: '# AGENTS.md instructions for C:\\code\nBe terse.' }]
    }),
    line('response_item', {
      type: 'message',
      role: 'developer',
      content: [{ type: 'input_text', text: '<permissions instructions>secret policy' }]
    }),
    line('response_item', {
      type: 'message',
      role: 'user',
      content: [{ type: 'input_text', text: 'Fix the rounding. token=sk-abcdefghijklmnopqrstuvwx' }]
    }),
    line('response_item', {
      type: 'reasoning',
      summary: [{ type: 'summary_text', text: 'THINKING about rounding' }],
      encrypted_content: 'ENCRYPTEDBLOB'
    }),
    line('response_item', {
      type: 'function_call',
      name: 'shell_command',
      arguments: JSON.stringify({ command: 'npm test' }),
      call_id: 'c1'
    }),
    line('response_item', {
      type: 'function_call_output',
      call_id: 'c1',
      output: 'Exit code: 1\nTOOL OUTPUT HERE'
    }),
    line('response_item', {
      type: 'agent_message',
      id: 'a1',
      author: '/root/worker',
      recipient: '/root',
      content: [{ type: 'input_text', text: 'Worker report.' }]
    }),
    line('response_item', {
      type: 'message',
      role: 'assistant',
      content: [{ type: 'output_text', text: 'Fixed it.' }]
    })
  ].join('\n')

  it('has my prompts, the answers, one line per tool call and per agent message, nothing else', () => {
    const t = transcriptForSummary(buildCodexMessages(rollout), 100_000, 'Codex')
    expect(t.text).toContain('User: Fix the rounding.')
    expect(t.text).toContain('Codex: [tool] shell_command: npm test')
    expect(t.text).toContain('[agent /root/worker → /root] Worker report.')
    expect(t.text).toContain('Fixed it.')
    for (const never of [
      'environment_context',
      'AGENTS.md',
      'permissions instructions',
      'THINKING',
      'ENCRYPTEDBLOB',
      'TOOL OUTPUT HERE',
      'Exit code',
      'sk-abcdefghijklmnopqrstuvwx'
    ])
      expect(t.text).not.toContain(never)
    // Claude Code's transcripts keep their label (default).
    expect(transcriptForSummary(buildCodexMessages(rollout), 100_000).text).toContain(
      'Claude: [tool]'
    )
  })

  it('are written by Claude (claude -p), with the Codex session described as Codex', async () => {
    const { sessions } = await setup()
    const s = sessions.list().find((x) => x.provider === 'codex' && x.sessionId === CLI)!
    const calls: { cmd: { args: string[] }; stdin: string }[] = []
    const runner = new PrintRunner({
      findCli: async () => ({ kind: 'native', path: 'C:\\claude\\claude.exe', label: 'Windows' }),
      checkAuth: async () => ({ ok: true, method: 'claude.ai' }),
      runner: (cmd, stdin) => {
        calls.push({ cmd: cmd as never, stdin })
        return {
          done: Promise.resolve({
            stdout: JSON.stringify({
              type: 'result',
              subtype: 'success',
              is_error: false,
              result: JSON.stringify({ ...SUMMARY, title: 'Rounding' })
            }),
            stderr: '',
            code: 0,
            timedOut: false,
            cancelled: false
          }),
          cancel: () => undefined
        }
      }
    })
    const summaries = new SummaryService({
      sessions,
      dataDir: join(root, 'data'),
      runner,
      settings: () => ({ ...DEFAULT_SUMMARY_SETTINGS, noticeAccepted: true }),
      timeoutSec: () => 60,
      prices: () => DEFAULT_PRICES,
      fiveHourPct: async () => undefined,
      dollarsPerPct: () => undefined,
      recordUsage: () => undefined
    })
    const p = await summaries.preview(s.key)
    expect(p.prompt).toContain('Summarize this Codex session')
    expect(p.prompt).toContain('Codex: ')
    expect(p.prompt).not.toContain('environment_context')
    await summaries.enqueue([s.key], 'manual', p.id)
    await vi.waitFor(() => expect(sessions.get(s.key)?.meta.aiSummary?.title).toBe('Rounding'))
    // The prompt went on stdin to Claude Code, exactly as previewed; never to Codex.
    expect(calls.at(-1)!.stdin).toBe(p.prompt)
    expect(JSON.stringify(calls.at(-1)!.cmd)).not.toMatch(/codex/i)
  })
})

// ------------------------------------------------------ Continue fresh

describe('Continue fresh for Codex: the command', () => {
  const winPrompt = readHandoffPrompt(
    `C:\\Users\\alex smith\\AppData\\Roaming\\ClaudeSessionDashboard\\handoffs\\codex\\${HANDOFF_ID}.md`
  )!
  const wslPrompt = readHandoffPrompt(
    `/mnt/c/Users/alex smith/AppData/Roaming/ClaudeSessionDashboard/handoffs/codex/${HANDOFF_ID}.md`
  )!

  it('is a new codex session whose first message asks it to read the handoff file', () => {
    expect(winPrompt.mode).toBe('read')
    expect(winPrompt.prompt).toMatch(/^Read the handoff file C:\\Users\\alex smith\\.*\.md first/)
    const args = codexContinueArgs({
      prompt: winPrompt.prompt,
      bypass: false,
      modelChoice: { model: 'gpt-5.5-codex', effort: 'high' }
    })
    expect(args).toEqual([
      '-m',
      'gpt-5.5-codex',
      '-c',
      'model_reasoning_effort=high',
      winPrompt.prompt
    ])
    // Never a resume or fork of the old session, and no folder made writable.
    expect(args).not.toContain('resume')
    expect(args).not.toContain('fork')
    expect(args).not.toContain('--add-dir')
  })

  it('keeps the same bypass and approval rules as Resume', () => {
    expect(codexContinueArgs({ prompt: winPrompt.prompt, bypass: true })).toEqual([
      '--dangerously-bypass-approvals-and-sandbox',
      winPrompt.prompt
    ])
    expect(
      codexContinueArgs({ prompt: winPrompt.prompt, bypass: false, askPermissions: true })
    ).toEqual(['-a', 'on-request', '-s', 'workspace-write', winPrompt.prompt])
    expect(() =>
      codexContinueArgs({ prompt: winPrompt.prompt, bypass: true, askPermissions: true })
    ).toThrow()
  })

  it('refuses a first message that could be read as something else', () => {
    for (const bad of ['-c x=1', 'a; rm -rf /', 'a "b"', 'a%PATH%', 'a\nb'])
      expect(() => codexContinueArgs({ prompt: bad, bypass: false })).toThrow()
    expect(readHandoffPrompt('relative\\path.md')).toBeUndefined()
    expect(readHandoffPrompt('C:\\a;b\\h.md')).toBeUndefined()
  })

  it('stays one argument in every terminal, Windows and WSL, with spaces in paths', () => {
    const base = {
      sessionId: CLI,
      fork: false,
      skipPermissions: false,
      tools: TOOLS,
      continueFresh: { newSessionId: HANDOFF_ID, prompt: winPrompt.prompt }
    }
    for (const terminal of ['wt', 'powershell', 'cmd'] as const) {
      const cmd = buildCodexLaunch({
        ...base,
        env: 'windows',
        cwd: 'C:\\Users\\alex smith\\code\\shop api',
        terminal
      })
      expect(cmd.claudeArgs).toContain(winPrompt.prompt)
      expect(cmd.claudeArgs).not.toContain('resume')
      // The summary never travels on the command line: only the file's path.
      expect(cmd.commandLine).not.toContain('Write the coupon test')
    }
    const wsl = buildCodexLaunch({
      ...base,
      env: 'wsl',
      distro: 'Ubuntu',
      cwd: '/home/alex/code/shop api',
      terminal: 'wt',
      continueFresh: { newSessionId: HANDOFF_ID, prompt: wslPrompt.prompt }
    })
    // bash gets one quoted argument with the /mnt path.
    const bash = wsl.args[wsl.args.length - 1]
    expect(bash).toContain(`'${wslPrompt.prompt}'`)
    expect(bash).toContain('command codex')
    expect(bash).not.toContain('--add-dir')
  })
})

describe('Continue fresh for Codex (fixtures)', { timeout: 30_000 }, () => {
  it('writes the handoff under handoffs\\codex, starts codex and links the new session', async () => {
    const { sessions, launcher, metadata, paths, spawned, layout } = await setup({ launch: true })
    const s = sessions.list().find((x) => x.provider === 'codex' && x.sessionId === CLI)!
    sessions.setAiSummary(s.key, SUMMARY)
    const opts: LaunchOptions = {
      key: s.key,
      fork: false,
      skipPermissions: false,
      continueFresh: { newSessionId: HANDOFF_ID }
    }
    const p = await launcher.preview(opts)
    expect(p.continueError).toBeUndefined()
    const file = handoffPath(paths.dataDir, HANDOFF_ID, 'codex')
    expect(file).toBe(join(paths.dataDir, 'handoffs', 'codex', `${HANDOFF_ID}.md`))
    expect(p.continueFresh).toMatchObject({ handoffPath: file, mode: 'read' })
    expect(p.continueFresh!.handoff).toContain('This is a new Codex session')
    expect(p.claudeCommand).toContain('Read the handoff file')
    expect(p.claudeCommand).not.toContain('--add-dir')

    const r = await launcher.launch(opts)
    expect(r.ok).toBe(true)
    // Codex picks the new session's id: none is claimed up front.
    expect(r.continuedKey).toBeUndefined()
    expect(spawned).toHaveLength(1)
    expect(spawned[0].args.join(' ')).not.toContain('Write the coupon test')
    expect(await readFile(file, 'utf8')).toBe(p.continueFresh!.handoff)
    expect(metadata.value.pendingContinues?.[HANDOFF_ID]).toMatchObject({
      parentSessionId: CLI,
      parentKey: s.key,
      sourceId: s.sourceId,
      name: `${s.title} — continued`
    })
    // Nothing was written into ~/.codex by the app.
    const codexDir = dirname(s.filePath)
    const before = await readdir(codexDir)

    // Codex starts the session and writes its rollout: it's linked by the handoff it names.
    const firstPrompt = spawned[0].claudeArgs[spawned[0].claudeArgs.length - 1]
    const rollout = join(codexDir, `rollout-2026-10-20T11-00-00-${NEW_CODEX}.jsonl`)
    await writeFile(
      rollout,
      [
        line('session_meta', { id: NEW_CODEX, cwd: s.cwd }, '2026-10-20T16:00:00Z'),
        line(
          'response_item',
          { type: 'message', role: 'user', content: [{ type: 'input_text', text: firstPrompt }] },
          '2026-10-20T16:00:01Z'
        )
      ].join('\n') + '\n'
    )
    expect(before).not.toContain(`rollout-2026-10-20T11-00-00-${NEW_CODEX}.jsonl`)
    await sessions.fileChanged(s.sourceId, rollout)
    expect(metadata.value.sessions[`codex:${NEW_CODEX}`]).toMatchObject({
      name: `${s.title} — continued`,
      branch: { parentSessionId: CLI, parentKey: s.key, via: 'continue' }
    })
    expect(metadata.value.pendingContinues?.[HANDOFF_ID]).toBeUndefined()
    expect(layout).toBeTruthy()
  })

  it('a WSL Codex session reads the handoff through /mnt/…/handoffs/codex/', async () => {
    const { sessions, launcher } = await setup({ launch: true })
    const s = sessions.list().find((x) => x.provider === 'codex' && x.sessionId === WSL)!
    sessions.setAiSummary(s.key, SUMMARY)
    const p = await launcher.preview({
      key: s.key,
      fork: false,
      skipPermissions: false,
      continueFresh: {}
    })
    expect(p.continueError).toBeUndefined()
    expect(p.continueFresh!.sessionPath).toMatch(/^\/.*\/handoffs\/codex\/[0-9a-f-]{36}\.md$/)
    expect(p.claudeCommand).toContain(p.continueFresh!.sessionPath)
  })

  it('links only a session that names a pending handoff, and only for a week', () => {
    const p = `Read the handoff file C:\\x\\handoffs\\codex\\${HANDOFF_ID}.md first, then continue.`
    expect(continuedHandoffId(p)).toBe(HANDOFF_ID)
    expect(continuedHandoffId(`/mnt/c/x/handoffs/codex/${HANDOFF_ID.toUpperCase()}.md`)).toBe(
      HANDOFF_ID
    )
    // Claude Code's own handoffs (handoffs\<id>.md) are linked by their session id instead.
    expect(continuedHandoffId(`@C:\\x\\handoffs\\${HANDOFF_ID}.md`)).toBeUndefined()
    expect(continuedHandoffId('Read handoffs/codex/not-an-id.md')).toBeUndefined()
    expect(PENDING_CONTINUE_MS).toBe(7 * 24 * 3600_000)
  })

  it('is offered in the context-size warning with an estimate', async () => {
    const { sessions } = await setup()
    const s = sessions.list().find((x) => x.provider === 'codex' && x.sessionId === CLI)!
    expect(s.context).toBeTruthy()
    const cost = new ContextCost({
      limits: {
        dollarsPerPct: () => undefined,
        state: async () => ({}) as never,
        isSubscription: () => true
      },
      usage: { allRecords: () => [] },
      settings: () => ({ capacityWeights: DEFAULT_WEIGHTS, prices: DEFAULT_PRICES }) as never,
      codex: { limits: { dollarsPerPct: () => undefined }, prices: () => DEFAULT_CODEX_PRICES }
    })
    // No summary yet: the warning offers "Summarize first" (no fresh estimate).
    expect((await cost.estimate(s, {}))!.fresh).toBeUndefined()
    sessions.setAiSummary(s.key, SUMMARY)
    // With one, "Continue fresh" (the renderer shows it when the estimate has `fresh`):
    // Codex's own setup plus the handoff, far smaller than the session.
    const est = (await cost.estimate(sessions.get(s.key)!, {}))!
    expect(est.fresh).toBeTruthy()
    expect(est.fresh!.tokens).toBeGreaterThan(0)
    expect(est.fresh!.tokens).toBeLessThan(est.tokens + 10_000)
  })
})

describe('Continue fresh for Codex from a phone', () => {
  const SESSION = {
    key: `windows-codex:${CLI}`,
    sessionId: CLI,
    provider: 'codex',
    title: 'Fix rounding',
    availability: 'live',
    meta: { aiSummary: SUMMARY }
  } as unknown as SessionSummary

  function remote(session = SESSION) {
    const launched: LaunchOptions[] = []
    const deps: RemoteLaunchDeps = {
      session: (k) => (k === session.key ? session : undefined),
      preview: async () => ({
        commandLine: 'x',
        claudeCommand: 'codex',
        terminal: 'wt',
        fellBack: false,
        cwd: 'C:\\code',
        cwdExists: true,
        willRestore: false,
        restoreImpossible: false,
        originalPath: 'x',
        billingLabel: 'Subscription'
      }),
      launch: async (opts) => {
        launched.push(opts)
        return { ok: true, restored: false, commandLine: 'x' }
      },
      settings: () => ({
        terminal: 'wt',
        readOnly: false,
        confirmOnPc: false,
        branchConfirmed: true
      }),
      confirm: async () => true,
      deviceActive: () => true,
      log: () => undefined
    }
    return { rl: new RemoteLauncher(deps), launched }
  }
  const DEVICE = { id: 'd1', name: 'Phone', tokenHash: '', createdAt: '', lastSeenAt: '' }

  it('is the fixed command: prompts on, never bypassed, no Remote Control, id picked on the PC', async () => {
    expect(remoteLaunchOptions({ key: SESSION.key, kind: 'continue' }, 'wt', 'codex')).toEqual({
      key: SESSION.key,
      fork: false,
      skipPermissions: false,
      askPermissions: true,
      terminal: 'wt',
      continueFresh: {}
    })
    const { rl, launched } = remote()
    const r = await rl.launch(DEVICE, { key: SESSION.key, kind: 'continue' })
    expect(r.ok).toBe(true)
    expect(launched[0]).toMatchObject({ skipPermissions: false, askPermissions: true })
    expect(launched[0].remoteControl).toBeUndefined()
    expect(launched[0].continueFresh).toEqual({})
  })

  it('still needs a summary written on the PC, and Branch stays unavailable', async () => {
    const { rl, launched } = remote({ ...SESSION, meta: {} } as SessionSummary)
    expect((await rl.launch(DEVICE, { key: SESSION.key, kind: 'continue' })).error).toMatch(
      /Summarize this session on your PC/
    )
    const b = await remote().rl.launch(DEVICE, {
      key: SESSION.key,
      kind: 'branch',
      branch: { at: 'x', mode: 'include' }
    })
    expect(b.error).toMatch(/isn't available for Codex/)
    expect(launched).toHaveLength(0)
  })
})

// ------------------------------------------------------- handoff clean-up

describe('cleaning up old handoffs', () => {
  it('shows their size and deletes only old handoff files, in handoffs\\ and handoffs\\codex\\', async () => {
    const data = join(root, 'data')
    const old = Date.now() - 40 * 86_400_000
    const a = '11111111-1111-4111-8111-111111111111'
    const b = '22222222-2222-4222-8222-222222222222'
    const c = '33333333-3333-4333-8333-333333333333'
    await writeHandoff(data, a, 'old claude')
    await writeHandoff(data, b, 'old codex', 'codex')
    await writeHandoff(data, c, 'new codex', 'codex')
    await utimes(handoffPath(data, a), old / 1000, old / 1000)
    await utimes(handoffPath(data, b, 'codex'), old / 1000, old / 1000)
    // Other files in the folder are never the app's handoffs: left alone, even when old.
    const other = join(data, 'handoffs', 'notes.md')
    await writeFile(other, 'mine')
    await utimes(other, old / 1000, old / 1000)

    const st = await handoffStats(data)
    expect(st).toMatchObject({ files: 3, old: { files: 2 } })
    expect(st.bytes).toBe(['old claude', 'old codex', 'new codex'].join('').length)
    expect(await cleanupHandoffs(data)).toEqual({ deleted: 2, bytes: 19 })
    expect((await readdir(join(data, 'handoffs'))).sort()).toEqual(['codex', 'notes.md'])
    expect(await readdir(join(data, 'handoffs', 'codex'))).toEqual([`${c}.md`])
    expect(await handoffStats(data)).toMatchObject({ files: 1, old: { files: 0 } })
  })

  it('reports nothing when there are no handoffs yet', async () => {
    expect(await handoffStats(join(root, 'none'))).toEqual({
      files: 0,
      bytes: 0,
      old: { files: 0, bytes: 0 }
    })
    expect(await cleanupHandoffs(join(root, 'none'))).toEqual({ deleted: 0, bytes: 0 })
  })
})

// ------------------------------------------------------------- trends

describe('Codex turns for trends', () => {
  const usage = (
    total: number,
    last: { i: number; c: number; o: number; r: number },
    w = 200_000
  ) => ({
    type: 'token_count',
    info: {
      total_token_usage: {
        input_tokens: total,
        cached_input_tokens: 0,
        output_tokens: 0,
        reasoning_output_tokens: 0,
        total_tokens: total
      },
      last_token_usage: {
        input_tokens: last.i,
        cached_input_tokens: last.c,
        output_tokens: last.o,
        reasoning_output_tokens: last.r,
        total_tokens: last.i + last.o
      },
      model_context_window: w
    }
  })
  const rollout = [
    line('session_meta', { id: CLI, cli_version: '0.166.0' }, '2026-10-20T10:00:00Z'),
    line(
      'event_msg',
      { type: 'task_started', turn_id: 't1', started_at: 1, model_context_window: 200_000 },
      '2026-10-20T10:00:01Z'
    ),
    line('turn_context', { model: 'gpt-6.1-sol' }, '2026-10-20T10:00:01Z'),
    line(
      'response_item',
      {
        type: 'message',
        role: 'user',
        content: [
          { type: 'input_text', text: '<environment_context>x' },
          { type: 'input_text', text: 'Fix it' }
        ]
      },
      '2026-10-20T10:00:02Z'
    ),
    line(
      'response_item',
      { type: 'function_call', name: 'exec', arguments: '{}', call_id: 'a' },
      '2026-10-20T10:00:03Z'
    ),
    line(
      'response_item',
      { type: 'function_call_output', call_id: 'a', output: 'Exit code: 2\nboom' },
      '2026-10-20T10:00:04Z'
    ),
    line(
      'event_msg',
      {
        type: 'item_completed',
        item: {
          type: 'CommandExecution',
          status: 'failed',
          aggregated_output: 'boom',
          exit_code: 2
        }
      },
      '2026-10-20T10:00:04Z'
    ),
    line(
      'response_item',
      { type: 'custom_tool_call', name: 'apply_patch', input: '*** Begin', call_id: 'b' },
      '2026-10-20T10:00:05Z'
    ),
    line(
      'response_item',
      { type: 'custom_tool_call_output', call_id: 'b', output: 'Success' },
      '2026-10-20T10:00:06Z'
    ),
    line(
      'event_msg',
      { type: 'item_completed', item: { type: 'FileChange', status: 'completed' } },
      '2026-10-20T10:00:06Z'
    ),
    line(
      'event_msg',
      usage(10_000, { i: 10_000, c: 4_000, o: 500, r: 200 }),
      '2026-10-20T10:00:07Z'
    ),
    line(
      'event_msg',
      usage(21_000, { i: 11_000, c: 9_000, o: 300, r: 100 }),
      '2026-10-20T10:00:08Z'
    ),
    line(
      'event_msg',
      {
        type: 'task_complete',
        turn_id: 't1',
        started_at: 1,
        completed_at: 9,
        duration_ms: 8000,
        time_to_first_token_ms: 900,
        last_agent_message: 'secret answer text'
      },
      '2026-10-20T10:00:09Z'
    ),
    // A second turn, interrupted.
    line(
      'event_msg',
      { type: 'task_started', turn_id: 't2', started_at: 20 },
      '2026-10-20T10:00:20Z'
    ),
    line(
      'response_item',
      { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'More' }] },
      '2026-10-20T10:00:21Z'
    ),
    line(
      'event_msg',
      usage(33_000, { i: 12_000, c: 11_000, o: 100, r: 0 }),
      '2026-10-20T10:00:22Z'
    ),
    line(
      'event_msg',
      { type: 'turn_aborted', turn_id: 't2', reason: 'interrupted', duration_ms: 3000 },
      '2026-10-20T10:00:23Z'
    ),
    // A turn that never ended (Codex still running): not counted.
    line('event_msg', { type: 'task_started', turn_id: 't3' }, '2026-10-20T10:00:30Z'),
    line('event_msg', usage(46_000, { i: 13_000, c: 0, o: 50, r: 0 }), '2026-10-20T10:00:31Z')
  ].join('\n')

  const ctx = {
    key: `windows-codex:${CLI}`,
    project: 'shop',
    env: 'windows' as const,
    sessionId: CLI,
    version: '0.166.0'
  }

  it('come from turn events, tool outcomes and token counts, through the usage reader', async () => {
    const file = join(root, `rollout-2026-10-20T10-00-00-${CLI}.jsonl`)
    await writeFile(file, rollout + '\n')
    const text = await readCodexUsageText(file)
    // The reader never keeps text: no prompt, no output, no answer.
    for (const never of ['Fix it', 'boom', 'secret answer text', 'Begin', 'environment_context'])
      expect(text).not.toContain(never)
    const turns = analyzeCodexUsage(text, ctx).codexTurns!
    expect(turns).toHaveLength(2)
    expect(turns[0]).toMatchObject({
      id: 'codex-turn:t1',
      model: 'gpt-6.1-sol',
      version: '0.166.0',
      durationMs: 8000,
      firstTokenMs: 900,
      responses: 2,
      outputTokens: 800,
      reasoningTokens: 300,
      toolCalls: 2,
      // From the finished tool items (the more reliable signal), not the exit codes.
      toolResults: 2,
      toolErrors: 1,
      aborted: false,
      failed: false,
      prompted: true
    })
    expect(turns[0].contextPct).toBeCloseTo(((11_000 + 300) / 200_000) * 100)
    expect(turns[1]).toMatchObject({
      id: 'codex-turn:t2',
      aborted: true,
      responses: 1,
      prompted: true
    })
    // A plain rollout gives the same turns.
    expect(analyzeCodexUsage(rollout, ctx).codexTurns).toEqual(turns)
  })

  it('without tool items (older Codex), tool outcomes come from exit codes; without turn events, from prompts', () => {
    const old = [
      line('session_meta', { id: CLI }),
      line('turn_context', { model: 'gpt-5-codex' }),
      line(
        'response_item',
        { type: 'message', role: 'user', prompt: true },
        '2026-10-20T10:00:01Z'
      ),
      line('response_item', { type: 'function_call_output', exit: 1 }, '2026-10-20T10:00:02Z'),
      line('response_item', { type: 'function_call_output', exit: 0 }, '2026-10-20T10:00:03Z'),
      line('response_item', { type: 'function_call' }, '2026-10-20T10:00:03Z'),
      line('event_msg', usage(1000, { i: 1000, c: 0, o: 10, r: 0 }), '2026-10-20T10:00:04Z'),
      line(
        'response_item',
        { type: 'message', role: 'user', prompt: true },
        '2026-10-20T10:01:00Z'
      ),
      line('event_msg', usage(2100, { i: 1100, c: 0, o: 20, r: 0 }), '2026-10-20T10:01:01Z')
    ].join('\n')
    const turns = analyzeCodexUsage(old, ctx).codexTurns!
    expect(turns).toHaveLength(2)
    expect(turns[0]).toMatchObject({
      toolResults: 2,
      toolErrors: 1,
      toolCalls: 1,
      responses: 1,
      prompted: true
    })
    expect(turns[1]).toMatchObject({ responses: 1, toolCalls: 0 })
  })

  it("a subagent's turns count per response, never per prompt", () => {
    const sub = rollout.replace(
      line('session_meta', { id: CLI, cli_version: '0.166.0' }, '2026-10-20T10:00:00Z'),
      line('session_meta', { id: CLI, subagent: true }, '2026-10-20T10:00:00Z')
    )
    const turns = analyzeCodexUsage(sub, ctx).codexTurns!
    expect(turns.every((t) => t.subagent && !t.prompted)).toBe(true)
  })

  it("count once across forks (a fork copies its parent's turns with their ids)", () => {
    const store = new CodexUsageStore()
    const t = (key: string, ts: number): CodexTurnSample => ({
      id: 'codex-turn:01a1be2d-ffaf-7940-9787-c139b0068ac9',
      ts,
      key,
      responses: 1,
      outputTokens: 10,
      reasoningTokens: 0,
      toolCalls: 0,
      toolResults: 0,
      toolErrors: 0,
      aborted: false,
      failed: false,
      prompted: true
    })
    store.set('w:parent', [], [], 'sig', [t('w:parent', 1000)])
    store.set('w:fork', [], [], 'sig', [t('w:fork', 5000)])
    expect(store.turns().map((x) => x.key)).toEqual(['w:parent'])
  })
})

describe('Codex trends', () => {
  const DAY = 86_400_000
  const W1 = Date.parse('2026-10-05T12:00:00Z')
  const W2 = W1 + 7 * DAY
  const rec = (
    ts: number,
    model: string,
    version: string,
    o: number,
    r: number,
    cached: number
  ): UsageRecord => ({
    id: `r${ts}${model}`,
    ts,
    key: 'k',
    project: 'p',
    env: 'windows',
    model,
    version,
    provider: 'codex',
    input: 1000 - cached,
    cacheRead: cached,
    cacheWrite: 0,
    output: o,
    reasoning: r
  })
  const turn = (ts: number, over: Partial<CodexTurnSample> = {}): CodexTurnSample => ({
    id: `t${ts}`,
    ts,
    key: `s${Math.floor(ts / DAY)}`,
    model: 'gpt-6.1-sol',
    version: '0.163.0',
    durationMs: 10_000,
    firstTokenMs: 1000,
    responses: 4,
    outputTokens: 400,
    reasoningTokens: 100,
    toolCalls: 6,
    toolResults: 5,
    toolErrors: 1,
    aborted: false,
    failed: false,
    prompted: true,
    contextPct: 30,
    ...over
  })
  const records = [
    ...[0, 1, 2].map((i) => rec(W1 + i * 1000, 'gpt-6.1-sol', '0.163.0', 100, 20, 500)),
    ...[0, 1, 2].map((i) => rec(W2 + i * 1000, 'gpt-6.2-sol', '0.166.0', 300, 60, 900))
  ]
  const turns = [
    turn(W1),
    turn(W1 + 1000, { durationMs: 20_000, aborted: true, toolErrors: 3 }),
    turn(W1 + 2000, { subagent: true, prompted: false, responses: 50, toolCalls: 50 }),
    turn(W2, { model: 'gpt-6.2-sol', version: '0.166.0', durationMs: 4000, contextPct: 60 }),
    turn(W2 + 1000, { model: 'gpt-6.2-sol', version: '0.166.0', durationMs: 6000, contextPct: 80 })
  ]
  const input = { records, turns, timeZone: 'UTC', weekStart: 'monday' as const }

  it('works out each metric per week', () => {
    const r = buildCodexTrends({ ...input, groupBy: 'all' })
    expect(r.weeks).toHaveLength(2)
    const v = (metric: string, week: number) =>
      r.series.find((s) => s.metric === metric)!.points[week].value
    expect(v('outputPerResponse', 0)).toBe(100)
    expect(v('outputPerResponse', 1)).toBe(300)
    expect(v('reasoningPerResponse', 1)).toBe(60)
    expect(v('cachedInputRatio', 0)).toBe(50)
    expect(v('cachedInputRatio', 1)).toBe(90)
    // Median turn time; an interrupted turn isn't a turn time. W1: 10 s and the subagent's 10 s.
    expect(v('turnDuration', 0)).toBe(10)
    expect(v('turnDuration', 1)).toBe(5)
    expect(v('firstToken', 0)).toBe(1)
    // Tool errors: (1 + 3 + 1) of (5 + 5 + 5).
    expect(v('toolErrorRate', 0)).toBeCloseTo((5 / 15) * 100)
    // One of three turns was interrupted.
    expect(v('abortRate', 0)).toBeCloseTo((1 / 3) * 100)
    // Per prompt: the subagent's 50 responses aren't a prompt's.
    expect(v('responsesPerPrompt', 0)).toBe(4)
    expect(v('toolCallsPerPrompt', 0)).toBe(6)
    // Context: the last reading of each session in the week (W2: one session, 80%).
    expect(v('contextUsage', 1)).toBe(80)
  })

  it('marks a new model and a new Codex version, and groups by either', () => {
    const r = buildCodexTrends({ ...input, groupBy: 'model' })
    expect(r.groups.map((g) => g.key).sort()).toEqual(['gpt-6.1-sol', 'gpt-6.2-sol'])
    // By model, 0.163 → 0.166 is too small a step for a marker (Codex ships one almost weekly).
    expect(r.markers.map((m) => m.kind)).toEqual(['model'])
    const byVersion = buildCodexTrends({ ...input, groupBy: 'version' })
    expect(byVersion.versions).toEqual(['0.163.0', '0.166.0'])
    // By version, every change is marked.
    expect(byVersion.markers.find((m) => m.kind === 'version')!.label).toBe('v0.166.0')
  })

  it('keeps markers readable: no marker for a rarely used model, versions in big steps', () => {
    const W3 = W2 + 7 * DAY
    const W4 = W3 + 7 * DAY
    const many = [
      ...records,
      // A model used for 1 of 100+ responses (a review agent): no "new model" line.
      rec(W3, 'codex-auto-review', '0.167.0', 10, 0, 0),
      ...Array.from({ length: 100 }, (_, i) => rec(W3 + i, 'gpt-6.2-sol', '0.167.0', 300, 60, 900)),
      ...Array.from({ length: 20 }, (_, i) => rec(W4 + i, 'gpt-6.2-sol', '0.174.0', 300, 60, 900))
    ]
    const r = buildCodexTrends({ ...input, records: many, groupBy: 'all' })
    expect(r.markers.filter((m) => m.kind === 'model').map((m) => m.label)).not.toContain(
      'codex-auto-review'
    )
    // 0.163 → 0.167 isn't marked (four minors); 0.174 is eleven past the first: one marker.
    expect(r.markers.filter((m) => m.kind === 'version').map((m) => m.label)).toEqual(['v0.174.0'])
    expect(versionStep('0.163.0', '0.168.2')).toBe(5)
    expect(versionStep('0.163.0', '1.0.0')).toBe(Infinity)
    expect(versionStep('0.166.0-alpha.5', '0.166.0')).toBe(0)
  })

  it('compares two date ranges or two versions', () => {
    const c = compareCodexTrends(input, { version: '0.163.0' }, { version: '0.166.0' })
    const row = c.rows.find((x) => x.metric === 'outputPerResponse')!
    expect(row).toMatchObject({ a: 100, b: 300, changePct: 200 })
    expect(c.samples.a).toEqual({ responses: 3, requests: 2 })
    expect(c.samples.b).toEqual({ responses: 3, requests: 2 })
    const dates = compareCodexTrends(
      input,
      { from: W1 - DAY, to: W1 + DAY },
      { from: W2 - DAY, to: W2 + DAY }
    )
    expect(dates.rows.find((x) => x.metric === 'turnDuration')!.b).toBe(5)
  })

  it('needs enough data before showing a value', () => {
    const r = buildCodexTrends({
      records: records.slice(0, 2),
      turns: [],
      timeZone: 'UTC',
      weekStart: 'monday',
      groupBy: 'all'
    })
    expect(r.series.find((s) => s.metric === 'outputPerResponse')!.points[0].value).toBeUndefined()
    expect(
      codexMetricValue({ ...emptyAcc(), prompts: 1, promptResponses: 3 }, 'responsesPerPrompt')
    ).toBeUndefined()
  })
})

function emptyAcc() {
  return {
    records: 0,
    output: 0,
    reasoning: 0,
    inputAll: 0,
    cached: 0,
    turns: 0,
    durations: [],
    firstTokens: [],
    toolResults: 0,
    toolErrors: 0,
    abortedOrFailed: 0,
    prompts: 0,
    promptResponses: 0,
    promptToolCalls: 0,
    contexts: [],
    speeds: [],
    visibleSpeeds: [],
    fastSpeeds: [],
    fastFirstTokens: []
  }
}

// ------------------------------------------------------------- auth.json

describe('Codex login is never read', () => {
  it('the usage reader refuses auth.json (and any credential-looking file)', async () => {
    const home = join(root, '.codex')
    await mkdir(home, { recursive: true })
    await writeFile(join(home, 'auth.json'), '{"tokens":"x"}')
    await expect(readCodexUsageText(join(home, 'auth.json'))).rejects.toThrow('Not a session file')
  })
})

// ------------------------------------------------- review fixes (PR #35)

describe('the summary notice covers what is sent', () => {
  it('an acceptance of the older notice is asked again (auto-summarize too)', async () => {
    // Accepted before compaction summaries and agent messages were described: not accepted now.
    expect(sanitizeSummarySettings({ noticeAccepted: true }).noticeAccepted).toBe(false)
    expect(
      sanitizeSummarySettings({ noticeAccepted: true, noticeVersion: SUMMARY_NOTICE_VERSION - 1 })
        .noticeAccepted
    ).toBe(false)
    const now = sanitizeSummarySettings({
      noticeAccepted: true,
      noticeVersion: SUMMARY_NOTICE_VERSION
    })
    expect(now).toMatchObject({ noticeAccepted: true, noticeVersion: SUMMARY_NOTICE_VERSION })
    // Accepting again (the dialog sends the cleaned settings with noticeAccepted: true) sticks.
    const again = sanitizeSummarySettings({
      ...sanitizeSummarySettings({ noticeAccepted: true, autoEnabled: true }),
      noticeAccepted: true
    })
    expect(again.noticeAccepted).toBe(true)

    const { sessions } = await setup()
    const s = sessions.list().find((x) => x.provider === 'codex' && x.sessionId === CLI)!
    const summaries = new SummaryService({
      sessions,
      dataDir: join(root, 'data'),
      runner: new PrintRunner({
        findCli: async () => undefined,
        checkAuth: async () => ({ ok: true, method: 'claude.ai' })
      }),
      // What the app passes: the cleaned settings of an older acceptance with auto on.
      settings: () =>
        sanitizeSummarySettings({ noticeAccepted: true, autoEnabled: true, autoMinMessages: 10 }),
      timeoutSec: () => 60,
      prices: () => DEFAULT_PRICES,
      fiveHourPct: async () => undefined,
      dollarsPerPct: () => undefined,
      recordUsage: () => undefined
    })
    await expect(summaries.enqueue([s.key])).rejects.toThrow(/notice/)
    expect(await summaries.autoTick()).toBe(0)
  })
})

describe('Codex turn trends after review', () => {
  const ctx = {
    key: `windows-codex:${CLI}`,
    project: 'shop',
    env: 'windows' as const,
    sessionId: CLI
  }
  const tc = (total: number, o: number) => ({
    type: 'token_count',
    info: {
      total_token_usage: { input_tokens: total, output_tokens: 0, total_tokens: total },
      last_token_usage: { input_tokens: 1000, output_tokens: o, total_tokens: 1000 + o },
      model_context_window: 100_000
    }
  })
  const prompt = (text: string) => ({
    type: 'message',
    role: 'user',
    content: [{ type: 'input_text', text }]
  })

  it("a turn after a model switch is the new model's (task_started comes before turn_context)", () => {
    const text = [
      line('session_meta', { id: CLI }, '2026-10-20T10:00:00Z'),
      line('event_msg', { type: 'task_started', turn_id: 'a' }, '2026-10-20T10:00:01Z'),
      line('turn_context', { model: 'gpt-old' }, '2026-10-20T10:00:01Z'),
      line('response_item', prompt('one'), '2026-10-20T10:00:02Z'),
      line('event_msg', tc(1000, 10), '2026-10-20T10:00:03Z'),
      line(
        'event_msg',
        { type: 'task_complete', turn_id: 'a', duration_ms: 2000 },
        '2026-10-20T10:00:04Z'
      ),
      line('event_msg', { type: 'task_started', turn_id: 'b' }, '2026-10-20T10:01:00Z'),
      line('turn_context', { model: 'gpt-new' }, '2026-10-20T10:01:00Z'),
      line('response_item', prompt('two'), '2026-10-20T10:01:01Z'),
      line('event_msg', tc(2000, 20), '2026-10-20T10:01:02Z'),
      line(
        'event_msg',
        { type: 'task_complete', turn_id: 'b', duration_ms: 3000 },
        '2026-10-20T10:01:03Z'
      )
    ].join('\n')
    const a = analyzeCodexUsage(text, ctx)
    expect(a.codexTurns!.map((t) => [t.id, t.model])).toEqual([
      ['codex-turn:a', 'gpt-old'],
      ['codex-turn:b', 'gpt-new']
    ])
    // The same model as its responses.
    expect(a.records.map((r) => r.model)).toEqual(['gpt-old', 'gpt-new'])
  })

  it('a turn that fails before its first response still counts (failure and prompt)', () => {
    const text = [
      line('session_meta', { id: CLI }, '2026-10-20T10:00:00Z'),
      line('event_msg', { type: 'task_started', turn_id: 'x' }, '2026-10-20T10:00:01Z'),
      line('turn_context', { model: 'gpt-6.1-sol' }, '2026-10-20T10:00:01Z'),
      line('response_item', prompt('do it'), '2026-10-20T10:00:02Z'),
      line(
        'event_msg',
        { type: 'task_complete', turn_id: 'x', error: { message: 'stream error' } },
        '2026-10-20T10:00:05Z'
      )
    ].join('\n')
    const turns = analyzeCodexUsage(text, ctx).codexTurns!
    expect(turns).toHaveLength(1)
    expect(turns[0]).toMatchObject({
      failed: true,
      prompted: true,
      responses: 0,
      model: 'gpt-6.1-sol'
    })
    const r = buildCodexTrends({
      records: [],
      turns,
      timeZone: 'UTC',
      weekStart: 'monday',
      groupBy: 'all'
    })
    expect(r.weeks).toHaveLength(1)
  })

  it("sibling forks keep their own prompt-split turns; a fork's copy of its parent's counts once, also when slow or alone", () => {
    const PARENT = '019a0000-0000-7000-8000-00000000000a'
    // Each prompt's response: its running total and its own output (a response's identity).
    const old = (
      id: string,
      forked: boolean,
      metaAt: string,
      prompts: { at: string; text: string; total: number; out: number }[]
    ) =>
      [
        line('session_meta', { id, ...(forked ? { forked_from_id: PARENT } : {}) }, metaAt),
        line('turn_context', { model: 'gpt-5-codex' }, metaAt),
        ...prompts.flatMap((x) => [
          line('response_item', prompt(x.text), x.at),
          line('event_msg', tc(x.total, x.out), x.at)
        ])
      ].join('\n')
    const ctxOf = (id: string) => ({ ...ctx, key: `w:${id}`, sessionId: id, lineageRoot: PARENT })
    const first = { text: 'p', total: 1000, out: 10 }
    const parent = analyzeCodexUsage(
      old(PARENT, false, '2026-10-20T09:00:00Z', [{ ...first, at: '2026-10-20T09:00:01Z' }]),
      ctxOf(PARENT)
    )
    const f1id = '019a0000-0000-7000-8000-0000000000f1'
    const f2id = '019a0000-0000-7000-8000-0000000000f2'
    // Each fork copies the parent's turn (one of them six seconds after its meta, as a real
    // slow copy did), then adds a different turn of its own.
    const fork = (id: string, copyAt: string, own: { total: number; out: number }) =>
      analyzeCodexUsage(
        old(id, true, '2026-10-20T10:00:00.000Z', [
          { ...first, at: copyAt },
          { text: 'own', at: '2026-10-20T10:05:00Z', ...own }
        ]),
        ctxOf(id)
      )
    const f1 = fork(f1id, '2026-10-20T10:00:00.005Z', { total: 2100, out: 20 })
    const f2 = fork(f2id, '2026-10-20T10:00:06.000Z', { total: 2300, out: 30 })
    // As the app holds them: each session's usage rows and turns, and the fork links.
    const lineage = [
      { sessionId: PARENT, startedAt: '2026-10-20T09:00:00Z' },
      { sessionId: f1id, forkedFromId: PARENT, startedAt: '2026-10-20T10:00:00Z' },
      { sessionId: f2id, forkedFromId: PARENT, startedAt: '2026-10-20T10:00:00Z' }
    ]
    const load = (
      store: CodexUsageStore,
      list: [string, ReturnType<typeof analyzeCodexUsage>][]
    ) => {
      store.setLineage(lineage)
      for (const [id, a] of list) store.set(`w:${id}`, a.records, [], 's', a.codexTurns)
      return store
    }
    const store = load(new CodexUsageStore(), [
      [PARENT, parent],
      [f1id, f1],
      [f2id, f2]
    ])
    // The parent's turn once (its earliest copy, the original), and each fork's own turn.
    expect(
      store
        .turns()
        .map((t) => t.key)
        .sort()
    ).toEqual([`w:${PARENT}`, `w:${f1id}`, `w:${f2id}`])
    // The parent's file gone: the fork's copy of that turn still counts, once.
    // The same decision as the usage rows: a turn counts with its first response.
    const counted = new Set(store.records().map((r) => `codex-turn:${r.id}|${r.key}`))
    expect(store.turns().every((t) => counted.has(`${t.id}|${t.key}`))).toBe(true)
    // The parent's file gone (forks that copied it promptly, as nearly all do): the copied
    // turn still counts, once. (A copy written seconds late with the parent gone counts per
    // fork, exactly as its usage does: the Phase C limit in docs/ROADMAP.md.)
    const alone = load(new CodexUsageStore(), [
      [f1id, f1],
      [f2id, fork(f2id, '2026-10-20T10:00:00.005Z', { total: 2300, out: 30 })]
    ])
    expect(alone.turns()).toHaveLength(3)
    const aloneCounted = new Set(alone.records().map((r) => `codex-turn:${r.id}|${r.key}`))
    expect(alone.turns().every((t) => aloneCounted.has(`${t.id}|${t.key}`))).toBe(true)

    // Two siblings whose own (different) responses have exactly the same token counts:
    // both turns count, they aren't copies of each other.
    const twin = load(new CodexUsageStore(), [
      [PARENT, parent],
      [f1id, fork(f1id, '2026-10-20T10:00:00.005Z', { total: 2100, out: 20 })],
      [f2id, fork(f2id, '2026-10-20T10:00:00.005Z', { total: 2100, out: 20 })]
    ])
    expect(
      twin
        .turns()
        .map((t) => t.key)
        .sort()
    ).toEqual([`w:${PARENT}`, `w:${f1id}`, `w:${f2id}`])
  })

  it('in older rollouts a model switch before the next prompt stays with the next turn', () => {
    const text = [
      line('session_meta', { id: CLI }, '2026-10-20T10:00:00Z'),
      line('turn_context', { model: 'model-a' }, '2026-10-20T10:00:00Z'),
      line('response_item', prompt('one'), '2026-10-20T10:00:01Z'),
      line('event_msg', tc(1000, 10), '2026-10-20T10:00:02Z'),
      line('turn_context', { model: 'model-b' }, '2026-10-20T10:01:00Z'),
      line('response_item', prompt('two'), '2026-10-20T10:01:01Z'),
      line('event_msg', tc(2100, 20), '2026-10-20T10:01:02Z')
    ].join('\n')
    expect(analyzeCodexUsage(text, ctx).codexTurns!.map((t) => t.model)).toEqual([
      'model-a',
      'model-b'
    ])
  })

  it('every kind of finished tool counts toward the tool error rate (collaboration tools too)', async () => {
    const item = (type: string, status: string) =>
      line(
        'event_msg',
        { type: 'item_completed', item: { type, id: 'i', status } },
        '2026-10-20T10:00:03Z'
      )
    const rollout = [
      line('session_meta', { id: CLI }, '2026-10-20T10:00:00Z'),
      line('event_msg', { type: 'task_started', turn_id: 't' }, '2026-10-20T10:00:01Z'),
      line('response_item', prompt('go'), '2026-10-20T10:00:02Z'),
      item('CommandExecution', 'failed'),
      item('CollabAgentToolCall', 'completed'),
      item('CollabAgentToolCall', 'completed'),
      item('Extension', 'completed'),
      // Not tool calls: never counted.
      line(
        'event_msg',
        { type: 'item_completed', item: { type: 'AgentMessage', id: 'm', status: 'completed' } },
        '2026-10-20T10:00:03Z'
      ),
      line('event_msg', tc(1000, 10), '2026-10-20T10:00:04Z'),
      line('event_msg', { type: 'task_complete', turn_id: 't' }, '2026-10-20T10:00:05Z')
    ].join('\n')
    const plain = analyzeCodexUsage(rollout, ctx).codexTurns![0]
    expect(plain).toMatchObject({ toolResults: 4, toolErrors: 1 })
    const file = join(root, `rollout-2026-10-20T10-00-00-${CLI}.jsonl`)
    await writeFile(file, rollout + '\n')
    const viaReader = analyzeCodexUsage(await readCodexUsageText(file), ctx).codexTurns![0]
    expect(viaReader).toMatchObject({ toolResults: 4, toolErrors: 1 })
  })
})

describe('Continue fresh for Codex: the link is never missed', { timeout: 30_000 }, () => {
  it('a scan that finds the new session before the launch returns still links it', async () => {
    const ref: { sessions?: SessionService } = {}
    const { sessions, launcher, metadata } = await setup({
      launch: true,
      // Codex writes its rollout and the app scans it while the terminal is still starting.
      spawn: async (cmd) => {
        const s = ref.sessions!.list().find((x) => x.provider === 'codex' && x.sessionId === CLI)!
        const rolloutPath = join(
          dirname(s.filePath),
          `rollout-2026-10-20T11-00-00-${NEW_CODEX}.jsonl`
        )
        await writeFile(
          rolloutPath,
          [
            line('session_meta', { id: NEW_CODEX, cwd: s.cwd }, '2026-10-20T16:00:00Z'),
            line(
              'response_item',
              prompt(cmd.claudeArgs[cmd.claudeArgs.length - 1]),
              '2026-10-20T16:00:01Z'
            )
          ].join('\n') + '\n'
        )
        await ref.sessions!.fileChanged(s.sourceId, rolloutPath)
      }
    })
    ref.sessions = sessions
    const s = sessions.list().find((x) => x.provider === 'codex' && x.sessionId === CLI)!
    sessions.setAiSummary(s.key, SUMMARY)
    const r = await launcher.launch({
      key: s.key,
      fork: false,
      skipPermissions: false,
      continueFresh: {}
    })
    expect(r.ok).toBe(true)
    expect(metadata.value.sessions[`codex:${NEW_CODEX}`]?.branch).toMatchObject({
      parentKey: s.key,
      via: 'continue'
    })
    expect(Object.keys(metadata.value.pendingContinues ?? {})).toEqual([])
  })

  it('a session indexed before the link was recorded is linked when it is', async () => {
    const { sessions, metadata } = await setup()
    const s = sessions.list().find((x) => x.provider === 'codex' && x.sessionId === CLI)!
    const rollout = join(dirname(s.filePath), `rollout-2026-10-20T11-00-00-${NEW_CODEX}.jsonl`)
    await writeFile(
      rollout,
      [
        line('session_meta', { id: NEW_CODEX, cwd: s.cwd }, '2026-10-20T16:00:00Z'),
        line(
          'response_item',
          prompt(
            `Read the handoff file C:\\x\\handoffs\\codex\\${HANDOFF_ID}.md first, then continue from it.`
          ),
          '2026-10-20T16:00:01Z'
        )
      ].join('\n') + '\n'
    )
    await sessions.fileChanged(s.sourceId, rollout)
    expect(metadata.value.sessions[`codex:${NEW_CODEX}`]?.branch).toBeUndefined()
    sessions.recordPendingContinue(HANDOFF_ID, {
      parentSessionId: CLI,
      parentKey: s.key,
      sourceId: s.sourceId,
      createdAt: new Date().toISOString()
    })
    expect(metadata.value.sessions[`codex:${NEW_CODEX}`]?.branch).toMatchObject({ via: 'continue' })
  })

  it('nothing started: the pending link is dropped', async () => {
    const { sessions, launcher, metadata } = await setup({
      launch: true,
      spawn: async () => {
        throw Object.assign(new Error('no terminal'), { code: 'EACCES' })
      }
    })
    const s = sessions.list().find((x) => x.provider === 'codex' && x.sessionId === CLI)!
    sessions.setAiSummary(s.key, SUMMARY)
    const r = await launcher.launch({
      key: s.key,
      fork: false,
      skipPermissions: false,
      continueFresh: {}
    })
    expect(r.ok).toBe(false)
    expect(Object.keys(metadata.value.pendingContinues ?? {})).toEqual([])
  })
})

describe('second review fixes', { timeout: 30_000 }, () => {
  it('a WSL handoff is checked as the user Codex runs as, not the distro default', async () => {
    // Only the session's own WSL user can read the app's data folder here.
    const { sessions, launcher, canReadCalls } = await setup({
      launch: true,
      canRead: (_p, user) => user === 'alex'
    })
    const s = sessions.list().find((x) => x.provider === 'codex' && x.sessionId === WSL)!
    sessions.setAiSummary(s.key, SUMMARY)
    const opts = { key: s.key, fork: false, skipPermissions: false, continueFresh: {} }
    const p = await launcher.preview(opts)
    expect(p.continueError).toBeUndefined()
    const r = await launcher.launch(opts)
    expect(r.ok).toBe(true)
    const handoffChecks = canReadCalls.filter((c) =>
      /handoffs|ClaudeSessionDashboard|appdata/i.test(c.path)
    )
    expect(handoffChecks.length).toBeGreaterThan(0)
    expect(handoffChecks.every((c) => c.user === 'alex')).toBe(true)
  })

  it("a WSL user that can't read the handoff stops the launch", async () => {
    const { sessions, launcher, spawned } = await setup({
      launch: true,
      // The data folder is readable, the written handoff file isn't (for that user).
      canRead: (p) => !/handoffs\/codex\/.+\.md$/.test(p)
    })
    const s = sessions.list().find((x) => x.provider === 'codex' && x.sessionId === WSL)!
    sessions.setAiSummary(s.key, SUMMARY)
    const r = await launcher.launch({
      key: s.key,
      fork: false,
      skipPermissions: false,
      continueFresh: {}
    })
    expect(r.ok).toBe(false)
    expect(r.error).toMatch(/can't read the handoff file/)
    expect(spawned).toHaveLength(0)
  })

  it('a cache from the previous parser (version 5) is read again, not reused', async () => {
    expect(CODEX_USAGE_VERSION).toBe(7)
    const dir = join(root, 'usage-v5')
    await mkdir(dir, { recursive: true })
    await writeFile(
      join(dir, 'codex-index.json'),
      JSON.stringify({ version: 5, sessions: { 'w:a': 'path|1|t|root' } })
    )
    const store = new CodexUsageStore()
    await store.load(dir)
    // No signature kept: every Codex session is parsed again by the current parser.
    expect(store.index).toEqual({})
  })

  it("an older build's prompt-split turns of a fork family wait for a re-read (never counted twice)", async () => {
    const dir = join(root, 'usage-mixed')
    await mkdir(dir, { recursive: true })
    const P = '019a0000-0000-7000-8000-00000000000b'
    const F = '019a0000-0000-7000-8000-0000000000fb'
    const S = '019a0000-0000-7000-8000-0000000000cc'
    const t = (key: string, id: string): CodexTurnSample => ({
      id,
      ts: Date.parse('2026-10-20T10:00:00Z'),
      key,
      responses: 1,
      outputTokens: 10,
      reasoningTokens: 0,
      toolCalls: 0,
      toolResults: 0,
      toolErrors: 0,
      aborted: false,
      failed: false,
      prompted: true
    })
    // Saved by an earlier build (version 5): ordinal ids, a parent, its fork and an unrelated session,
    // plus a turn with Codex's own id (stable across versions).
    const realId = 'codex-turn:01a1be2d-0000-7940-9787-c139b0068ac9'
    await writeFile(
      join(dir, 'codex-index.json'),
      JSON.stringify({
        version: 5,
        sessions: {},
        lineage: { [P]: [null, null], [F]: [P, null], [S]: [null, null] }
      })
    )
    await writeFile(
      join(dir, 'codex-turns-2026-10.ndjson'),
      [
        t(`w:${P}`, `codex-turn:${P}:p0`),
        t(`w:${P}`, realId),
        t(`w:${F}`, `codex-turn:${F}:p0`),
        t(`w:${S}`, `codex-turn:${S}:p0`)
      ]
        .map((x) => JSON.stringify(x))
        .join('\n') + '\n'
    )
    const store = new CodexUsageStore()
    await store.load(dir)
    // The fork family's old prompt-split turns wait; the unrelated session's and the real id stay.
    expect(
      store
        .turns()
        .map((x) => x.id)
        .sort()
    ).toEqual([`codex-turn:${S}:p0`, realId].sort())
    // Once the fork is read again, its (new) turns count; the offline parent's old ones still wait.
    store.set(`w:${F}`, [], [], 'sig', [t(`w:${F}`, 'codex-turn:codex:abc')])
    expect(
      store
        .turns()
        .map((x) => x.id)
        .sort()
    ).toEqual([`codex-turn:${S}:p0`, realId, 'codex-turn:codex:abc'].sort())
  })

  it('turns an older build wrote are kept until their session is read again (never erased by a rebuild)', async () => {
    const dir = join(root, 'usage')
    await mkdir(dir, { recursive: true })
    const turn = (key: string, id: string): CodexTurnSample => ({
      id,
      ts: Date.parse('2026-10-20T10:00:00Z'),
      key,
      responses: 1,
      outputTokens: 10,
      reasoningTokens: 0,
      toolCalls: 0,
      toolResults: 0,
      toolErrors: 0,
      aborted: false,
      failed: false,
      prompted: true
    })
    // What the earlier PR build saved: index version 4, one month of turns for two sessions.
    await writeFile(
      join(dir, 'codex-index.json'),
      JSON.stringify({ version: 4, sessions: { 'w:a': 'x', 'w:b': 'y' } })
    )
    await writeFile(
      join(dir, 'codex-turns-2026-10.ndjson'),
      [turn('w:a', 'codex-turn:a1'), turn('w:b', 'codex-turn:b1')]
        .map((t) => JSON.stringify(t))
        .join('\n') + '\n'
    )
    const store = new CodexUsageStore()
    await store.load(dir)
    expect(
      store
        .turns()
        .map((t) => t.id)
        .sort()
    ).toEqual(['codex-turn:a1', 'codex-turn:b1'])
    // Session a is read again (b is offline): a's turns are replaced, b's stay, also on disk.
    store.set('w:a', [], [], 'sig', [turn('w:a', 'codex-turn:a2')])
    await store.flush(dir, root)
    const again = new CodexUsageStore()
    await again.load(dir)
    expect(
      again
        .turns()
        .map((t) => t.id)
        .sort()
    ).toEqual(['codex-turn:a2', 'codex-turn:b1'])
  })
})

// ------------------------------------------------------------- helpers

async function setup(
  opts: {
    launch?: boolean
    spawn?: (cmd: LaunchCommand) => Promise<void>
    /** Can this WSL user read this path? (Default: yes.) */
    canRead?: (path: string, user?: string) => boolean
  } = {}
) {
  await cp(FIXTURES, join(root, 'fixtures'), { recursive: true })
  await prepareFixtures(root, { codex: true })
  const layout = fixturesLayout(root)
  const base = createFixturesPlatform(layout.fixturesDir, layout.sourcesDir)
  const spawned: LaunchCommand[] = []
  const canReadCalls: { path: string; user?: string }[] = []
  const platform = opts.launch
    ? {
        ...base,
        canLaunch: true,
        spawnDetached: async (cmd: LaunchCommand) => {
          spawned.push(cmd)
          await opts.spawn?.(cmd)
        },
        wslCanRead: async (_d: string, path: string, user?: string) => {
          canReadCalls.push({ path, user })
          return opts.canRead ? opts.canRead(path, user) : true
        }
      }
    : base
  const paths = appPaths(layout.dataDir)
  const metadata = createMetadataStore(paths)
  const settings = createSettingsStore(paths)
  await metadata.load()
  await settings.load()
  await seedFixtureData(root, paths.archiveDir, metadata)
  const providers = new ProviderRegistry([claudeProvider, createCodexProvider()])
  const sessions = new SessionService(platform, paths, metadata, settings, providers)
  busy.push(sessions)
  const launcher = new Launcher(
    platform,
    sessions,
    () => 'wt',
    undefined,
    () => settings.value,
    paths.dataDir
  )
  await sessions.start()
  await sessions.idle()
  return { sessions, launcher, metadata, paths, settings, spawned, layout, canReadCalls }
}
