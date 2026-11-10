// Git links: what a session's own file says about its git work (signals),
// for Claude Code and Codex, and that copied history isn't counted.

import { describe, expect, it } from 'vitest'
import { parseJsonl } from '@shared/jsonl'
import { claudeGitSignals } from '@shared/git/claude-signals'
import { commitsInOutput, prsInOutput, sessionTrailers, spansOf } from '@shared/git/signals'
import { analyzeCodex, codexGitSignals, parseLines } from '../src/main/providers/codex/parse'
import { line } from './helpers'

const SID = '11111111-2222-4333-8444-555555555555'
const T = (min: number): string =>
  new Date(Date.UTC(2026, 9, 21, 13, 0) + min * 60_000).toISOString()

function claude(events: unknown[]): string {
  return events.map(line).join('\n')
}

const bash = (id: string, command: string, at: number) => ({
  type: 'assistant',
  sessionId: SID,
  timestamp: T(at),
  gitBranch: 'fix/login',
  message: {
    role: 'assistant',
    content: [{ type: 'tool_use', id, name: 'Bash', input: { command } }]
  }
})
const result = (id: string, text: string, at: number) => ({
  type: 'user',
  sessionId: SID,
  timestamp: T(at),
  message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: id, content: text }] }
})

describe('git output parsing', () => {
  it("reads git's own commit lines (branch, root commit, detached HEAD)", () => {
    expect(commitsInOutput('[fix/login 3e5f7a9] Tidy the redirect\n 1 file changed')).toEqual([
      { sha: '3e5f7a9', kind: 'commit-line', branch: 'fix/login', subject: 'Tidy the redirect' }
    ])
    expect(commitsInOutput('[main (root-commit) ABCDEF1] First')[0]).toMatchObject({
      sha: 'abcdef1',
      branch: 'main',
      subject: 'First'
    })
    expect(commitsInOutput('[detached HEAD 1234567] Try')[0]).toEqual({
      sha: '1234567',
      kind: 'commit-line',
      subject: 'Try'
    })
  })

  it('falls back to SHAs at line starts (a chained git log --oneline or rev-parse)', () => {
    expect(commitsInOutput('abc1234 Fix it\n')).toEqual([
      { sha: 'abc1234', kind: 'chained', subject: 'Fix it' }
    ])
    const full = 'a'.repeat(40)
    expect(commitsInOutput(`${full}\n`)).toEqual([{ sha: full, kind: 'chained' }])
    // Not a SHA: a word, or a SHA inside a line.
    expect(commitsInOutput('nothing to commit, working tree clean')).toEqual([])
    expect(commitsInOutput('HEAD is now at abc1234')).toEqual([])
  })

  it('reads PR links and Claude-Session trailers', () => {
    expect(
      prsInOutput('Creating pull request…\nhttps://github.com/beau/acme-web/pull/14\n')
    ).toEqual([
      {
        owner: 'beau',
        repo: 'acme-web',
        number: 14,
        url: 'https://github.com/beau/acme-web/pull/14'
      }
    ])
    expect(prsInOutput('https://gitlab.com/beau/x/pull/3')).toEqual([])
    expect(
      sessionTrailers(
        'git commit -m "Fix\n\nClaude-Session: https://claude.ai/code/session_01ABCdef234"'
      )
    ).toEqual(['https://claude.ai/code/session_01ABCdef234'])
  })

  it('splits activity into stretches at 30-minute gaps', () => {
    const m = 60_000
    expect(spansOf([0, 5 * m, 20 * m, 90 * m, 100 * m])).toEqual([
      [0, 20 * m],
      [90 * m, 100 * m]
    ])
    expect(spansOf([])).toEqual([])
  })
})

describe('Claude Code signals', () => {
  it('collects branches, edited files, commits, PRs and links from its own lines', () => {
    const text = claude([
      {
        type: 'user',
        sessionId: SID,
        timestamp: T(0),
        gitBranch: 'main',
        message: { role: 'user', content: 'go' }
      },
      {
        type: 'assistant',
        sessionId: SID,
        timestamp: T(1),
        gitBranch: 'fix/login',
        message: {
          role: 'assistant',
          content: [
            {
              type: 'tool_use',
              id: 'e1',
              name: 'Edit',
              input: { file_path: 'C:\\code\\acme\\src\\a.ts' }
            },
            {
              type: 'tool_use',
              id: 'w1',
              name: 'Write',
              input: { file_path: 'C:\\code\\acme\\src\\b.ts' }
            }
          ]
        }
      },
      bash('c1', 'git add -A && git commit -m "Tidy"', 2),
      result('c1', '[fix/login 3e5f7a9] Tidy\n 2 files changed', 2.2),
      bash('c2', 'git commit -q -m x && git log --oneline -1', 3),
      result('c2', 'bcd2345 x', 3.1),
      bash('p1', 'gh pr create --fill', 4),
      result('p1', 'https://github.com/beau/acme/pull/14', 4.5),
      {
        type: 'system',
        subtype: 'bridge_status',
        sessionId: SID,
        timestamp: T(5),
        url: 'https://claude.ai/code/session_01AbCdEf9876'
      },
      bash(
        'c3',
        'git commit -m "y\n\nClaude-Session: https://claude.ai/code/session_01ZzYyXx1234"',
        6
      ),
      result('c3', 'nothing to commit', 6.1)
    ])
    const s = claudeGitSignals(parseJsonl(text).events, SID)
    expect(s.branches).toEqual(['main', 'fix/login'])
    expect(s.files).toEqual(['C:\\code\\acme\\src\\a.ts', 'C:\\code\\acme\\src\\b.ts'])
    expect(s.commits).toEqual([
      {
        sha: '3e5f7a9',
        kind: 'commit-line',
        branch: 'fix/login',
        subject: 'Tidy',
        from: Date.parse(T(2)),
        to: Date.parse(T(2.2))
      },
      {
        sha: 'bcd2345',
        kind: 'chained',
        subject: 'x',
        from: Date.parse(T(3)),
        to: Date.parse(T(3.1))
      }
    ])
    expect(s.prs.map((p) => p.number)).toEqual([14])
    expect(s.sessionUrls.sort()).toEqual([
      'https://claude.ai/code/session_01AbCdEf9876',
      'https://claude.ai/code/session_01ZzYyXx1234'
    ])
    // When each was seen (a fork's copy keeps the parent's times: see the git links service).
    const seenAt = new Map(s.sessionUrls.map((u, k) => [u, s.sessionUrlsAt?.[k]]))
    expect(seenAt.get('https://claude.ai/code/session_01AbCdEf9876')).toBe(Date.parse(T(5)))
    expect(seenAt.get('https://claude.ai/code/session_01ZzYyXx1234')).toBe(Date.parse(T(6)))
    expect(s.filesAt).toHaveLength(2)
    expect(s.spans).toEqual([[Date.parse(T(0)), Date.parse(T(6.1))]])
  })

  it("ignores a git log that wasn't part of a commit call, and outputs of other calls", () => {
    const s = claudeGitSignals(
      parseJsonl(
        claude([bash('l1', 'git log --oneline -5', 0), result('l1', 'abc1234 Old commit', 0.1)])
      ).events,
      SID
    )
    expect(s.commits).toEqual([])
  })

  it('leaves out lines copied from another session (a branch, an older-style copy)', () => {
    const text = claude([
      {
        ...bash('c1', 'git commit -m a', 0),
        forkedFrom: { sessionId: 'parent', messageUuid: 'u' }
      },
      {
        ...result('c1', '[main 1111111] a', 0.1),
        forkedFrom: { sessionId: 'parent', messageUuid: 'u' }
      },
      { ...bash('c2', 'git commit -m b', 1), sessionId: 'another-session' },
      { ...result('c2', '[main 2222222] b', 1.1), sessionId: 'another-session' },
      bash('c3', 'git commit -m c', 2),
      result('c3', '[main 3333333] c', 2.1)
    ])
    const s = claudeGitSignals(parseJsonl(text).events, SID)
    expect(s.commits.map((c) => c.sha)).toEqual(['3333333'])
    expect(s.spans).toEqual([[Date.parse(T(2)), Date.parse(T(2.1))]])
  })

  it('reads the richer toolUseResult copy when a result has no content', () => {
    const text = claude([
      bash('c1', 'git commit -m a', 0),
      { ...result('c1', '', 0.1), toolUseResult: { stdout: '[main 4444444] a', stderr: '' } }
    ])
    expect(claudeGitSignals(parseJsonl(text).events, SID).commits.map((c) => c.sha)).toEqual([
      '4444444'
    ])
  })
})

describe('Codex signals', () => {
  const OWN = '019a1111-0000-7000-8000-000000000001'
  const PARENT = '019a0000-0000-7000-8000-000000000000'
  const meta = (id: string, at: string, extra: Record<string, unknown> = {}) =>
    line({
      timestamp: at,
      type: 'session_meta',
      payload: { id, timestamp: at, cwd: 'C:\\code\\shop', ...extra }
    })
  const call = (at: string, callId: string, name: string, args: unknown) =>
    line({
      timestamp: at,
      type: 'response_item',
      payload: { type: 'function_call', name, call_id: callId, arguments: JSON.stringify(args) }
    })
  const out = (at: string, callId: string, output: string) =>
    line({
      timestamp: at,
      type: 'response_item',
      payload: { type: 'function_call_output', call_id: callId, output }
    })
  const patch = (at: string, callId: string, input: string) =>
    line({
      timestamp: at,
      type: 'response_item',
      payload: { type: 'custom_tool_call', name: 'apply_patch', call_id: callId, input }
    })

  it('reads its starting git info, apply_patch files and commits', () => {
    const text = [
      meta(OWN, '2026-10-20T14:15:04.000Z', {
        git: {
          commit_hash: 'A1B2C3D4E5F6',
          branch: 'fix/checkout-totals',
          repository_url: 'https://github.com/beau/shop.git'
        }
      }),
      patch(
        '2026-10-20T14:16:00.000Z',
        'p1',
        '*** Begin Patch\n*** Update File: src/cart.ts\n@@\n-a\n+b\n*** Add File: src/tax.ts\n+x\n*** End Patch'
      ),
      call('2026-10-20T14:17:00.000Z', 's1', 'shell', {
        command: [
          'bash',
          '-lc',
          "apply_patch <<'EOF'\n*** Begin Patch\n*** Delete File: old.ts\n*** End Patch\nEOF"
        ]
      }),
      call('2026-10-20T14:18:00.000Z', 'c1', 'exec_command', {
        cmd: 'git commit -am "Fix totals"'
      }),
      out(
        '2026-10-20T14:18:02.000Z',
        'c1',
        'Exit code: 0\nOutput:\n[fix/checkout-totals 9f8e7d6] Fix totals\n 2 files changed'
      ),
      call('2026-10-20T14:19:00.000Z', 'g1', 'exec_command', { cmd: 'gh pr create --fill' }),
      out('2026-10-20T14:19:05.000Z', 'g1', 'https://github.com/beau/shop/pull/7')
    ].join('\n')
    const s = analyzeCodex(text, OWN).git
    expect(s.head).toBe('a1b2c3d4e5f6')
    expect(s.remote).toBe('https://github.com/beau/shop.git')
    expect(s.branches).toEqual(['fix/checkout-totals'])
    expect(s.files).toEqual(['src/cart.ts', 'src/tax.ts', 'old.ts'])
    expect(s.commits).toMatchObject([
      { sha: '9f8e7d6', kind: 'commit-line', branch: 'fix/checkout-totals', subject: 'Fix totals' }
    ])
    expect(s.prs.map((p) => p.number)).toEqual([7])
  })

  it('reads namespaced tool names (functions.exec_command) like plain ones', () => {
    const ns = (at: string, callId: string, name: string, args: unknown) =>
      line({
        timestamp: at,
        type: 'response_item',
        payload: {
          type: 'function_call',
          namespace: 'functions',
          name,
          call_id: callId,
          arguments: JSON.stringify(args)
        }
      })
    const text = [
      meta(OWN, '2026-10-20T14:15:04.000Z'),
      ns('2026-10-20T14:16:00.000Z', 'c1', 'exec_command', { cmd: 'git commit -m x' }),
      out('2026-10-20T14:16:01.000Z', 'c1', '[main 3333333] x'),
      ns('2026-10-20T14:17:00.000Z', 'p1', 'apply_patch', {
        input: '*** Begin Patch\n*** Update File: src/a.ts\n*** End Patch'
      })
    ].join('\n')
    const s = analyzeCodex(text, OWN).git
    expect(s.commits.map((c) => c.sha)).toEqual(['3333333'])
    expect(s.files).toEqual(['src/a.ts'])
  })

  it("leaves out a fork's copy of its parent's history (stamped with the fork's time)", () => {
    const at = '2026-10-31T18:48:59.647Z'
    const copy = '2026-10-31T18:48:59.648Z'
    const text = [
      meta(OWN, at, { forked_from_id: PARENT }),
      meta(PARENT, copy),
      call(copy, 'c0', 'exec_command', { cmd: 'git commit -m parent' }),
      out(copy, 'c0', '[main 1111111] parent'),
      patch(copy, 'p0', '*** Begin Patch\n*** Update File: parent.ts\n*** End Patch'),
      call('2026-10-31T18:50:00.000Z', 'c1', 'exec_command', { cmd: 'git commit -m mine' }),
      out('2026-10-31T18:50:01.000Z', 'c1', '[main 2222222] mine')
    ].join('\n')
    const s = codexGitSignals(parseLines(text).lines, OWN)
    expect(s.commits.map((c) => c.sha)).toEqual(['2222222'])
    expect(s.files).toEqual([])
    // Its own first line (the meta) still counts as activity.
    expect(s.spans[0][0]).toBe(Date.parse(at))
  })

  it('leaves out a copy written seconds after the start, from its own file alone', () => {
    // Older Codex (no ordinals): the copy is one burst, however late; its own calls follow a reply.
    const at = '2026-10-31T18:48:59.000Z'
    const late = (ms: number) => new Date(Date.parse(at) + ms).toISOString()
    const text = [
      meta(OWN, at, { forked_from_id: PARENT }),
      meta(PARENT, late(6000)),
      call(late(6001), 'c0', 'exec_command', { cmd: 'git commit -m parent' }),
      out(late(6002), 'c0', '[main 1111111] parent'),
      call(late(6040), 'g0', 'exec_command', { cmd: 'gh pr create --fill' }),
      out(late(6080), 'g0', 'https://github.com/beau/shop/pull/3'),
      patch(late(6200), 'p0', '*** Begin Patch\n*** Update File: parent-only.ts\n*** End Patch'),
      patch(late(20_000), 'p1', '*** Begin Patch\n*** Update File: mine.ts\n*** End Patch'),
      call(late(30_000), 'c1', 'exec_command', { cmd: 'git commit -m mine' }),
      out(late(31_000), 'c1', '[main 2222222] mine')
    ].join('\n')
    const s = codexGitSignals(parseLines(text).lines, OWN)
    expect(s.commits.map((c) => c.sha)).toEqual(['2222222'])
    expect(s.prs).toEqual([])
    expect(s.files).toEqual(['mine.ts'])
    expect(s.filesAt).toEqual([Date.parse(late(20_000))])
  })

  it('older Codex: its own first turn right after the copy stays its own', () => {
    const at = '2026-10-31T18:48:59.000Z'
    const t = (ms: number) => new Date(Date.parse(at) + ms).toISOString()
    const msg = (ms: number, role: string, text: string) =>
      line({
        timestamp: t(ms),
        type: 'response_item',
        payload: { type: 'message', role, content: [{ type: 'input_text', text }] }
      })
    const copy = [
      meta(OWN, at, { forked_from_id: PARENT }),
      meta(PARENT, t(5)),
      call(t(6), 'c0', 'exec_command', { cmd: 'git commit -m parent' }),
      out(t(7), 'c0', '[main 1111111] parent')
    ]
    // Each line within a second of the one before: the prompt, the reply, the commit.
    const spaced = [
      ...copy,
      msg(800, 'user', 'Commit it'),
      msg(1600, 'assistant', 'Committing.'),
      call(t(2400), 'c1', 'exec_command', { cmd: 'git commit -m mine' }),
      out(t(3000), 'c1', '[main 2222222] mine')
    ]
    // Close together (within 250 ms each), but the commit's output comes later.
    const close = [
      ...copy,
      msg(100, 'user', 'Commit it'),
      msg(300, 'assistant', 'Committing.'),
      call(t(450), 'c1', 'exec_command', { cmd: 'git commit -m mine' }),
      out(t(2000), 'c1', '[main 2222222] mine')
    ]
    for (const lines of [spaced, close]) {
      const s = codexGitSignals(parseLines(lines.join('\n')).lines, OWN)
      expect(s.commits.map((c) => c.sha)).toEqual(['2222222'])
    }
  })

  it('newer Codex: everything before where its own history starts is the copy, whenever written', () => {
    // `subagent_history_start_ordinal` against each line's ordinal (real files: the
    // parent's lines, then Codex's own setup lines, then the subagent's history).
    const at = '2026-11-09T13:13:28.000Z'
    const t = (ms: number) => new Date(Date.parse(at) + ms).toISOString()
    let n = 0
    const o = (s: string) => s.replace(/^\{/, `{"ordinal":${n++},`)
    const text = [
      o(meta(OWN, at, { forked_from_id: PARENT, subagent_history_start_ordinal: 6 })),
      o(meta(PARENT, t(3000))),
      o(call(t(3001), 'c0', 'exec_command', { cmd: 'git commit -m parent' })),
      o(out(t(3001), 'c0', '[main 1111111] parent')),
      // Slow writing: past a second's gap, still the copy.
      o(patch(t(9000), 'p0', '*** Begin Patch\n*** Update File: parent-only.ts\n*** End Patch')),
      o(line({ timestamp: t(9001), type: 'event_msg', payload: { type: 'turn_aborted' } })),
      o(patch(t(9002), 'p1', '*** Begin Patch\n*** Update File: mine.ts\n*** End Patch')),
      o(call(t(12_000), 'c1', 'exec_command', { cmd: 'git commit -m mine' })),
      o(out(t(12_500), 'c1', '[main 2222222] mine'))
    ].join('\n')
    const s = analyzeCodex(text, OWN).git
    expect(s.commits.map((c) => c.sha)).toEqual(['2222222'])
    expect(s.files).toEqual(['mine.ts'])
  })
})
