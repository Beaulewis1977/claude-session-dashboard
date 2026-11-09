// Codex session alerts: the opt-in PermissionRequest hook (Phase D1), with
// the same safety model as Claude Code's hook bridge (hooks.ts).
//
// Only when the user clicks "Enable" for a Codex home (and confirms the exact
// diff), the app:
//   1. backs up `<home>/.codex/hooks.json` to the app data folder,
//   2. writes the hook script to `<user home>/.claude-session-dashboard/bin/`,
//   3. appends ONE hook group to `hooks.PermissionRequest` in hooks.json, at
//      the end of the list (the file is created if there is none).
// Existing hooks are never replaced, reordered or reformatted. Disable takes
// exactly the app's handler out again (the file as it was, when nothing else
// changed since). The new content is saved like settings.json: temp file in
// the same folder, re-read and compared with what was reviewed, one atomic
// rename. config.toml is never written: Codex asks the user to trust a new
// hook (`/hooks`), and the app only reads config.toml to show whether that
// happened. Never auth.json or anything else in the home.

import { mkdir, readFile, stat } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import type { BridgeApplyResult, BridgePlan } from '@shared/usage/limits'
import type { HookEnv } from '@shared/live'
import { hooksFeatureOff, parseHookTrust, trustEntry, trustOf } from '@shared/codex-live'
import type { SourceInfo } from '@shared/types'
import { JsonStore } from '../core/json-store'
import { copyShared } from '../core/shared-copy'
import { parseWslUnc } from '../core/wsl'
import {
  assertAppDataWrite,
  assertCodexHooksWrite,
  assertRealAppDataWrite
} from '../core/safe-paths'
import {
  appendHookGroups,
  diffLines,
  hooksProblem,
  parseJsonc,
  rawMember,
  removeHookHandlers,
  removeMember,
  scanTopLevel,
  setMember
} from '../core/settings-edit'
import {
  BRIDGE_DIR_NAME,
  readText,
  SettingsChangedError,
  sha256,
  tokenOf,
  writeBridgeFile,
  writeSettings,
  type SettingsTarget
} from './bridge'
import {
  hookGroup,
  installedEvents,
  isOurHandler,
  windowsHookCommand,
  type HookInstallRecord
} from './hooks'

/** The one event the Codex hook listens to: approvals are the only state rollouts can't tell. */
export const CODEX_HOOK_EVENTS = ['PermissionRequest'] as const
export const CODEX_EVENTS_DIR = 'codex-events'
const SCRIPT = { windows: 'csd-codex-hook.ps1', wsl: 'csd-codex-hook.sh' } as const

export const CODEX_HOOKS: SettingsTarget = { name: 'hooks.json', guard: assertCodexHooksWrite }

const shQuote = (s: string): string =>
  /^[A-Za-z0-9_./~-]+$/.test(s) ? s : `'${s.replace(/'/g, `'\\''`)}'`

export interface CodexHookPaths {
  sourceId: string
  label: string
  env: SourceInfo['env']
  user?: string
  /** The Codex home (host path). */
  home: string
  hooksPath: string
  configPath: string
  /** hooks.json as Codex itself names it (its trust keys use this path). */
  codexHooksPath: string
  bridgeDir: string
  command: string
}

/** Paths and the hook command for a Codex home (auto-detected homes named `.codex` only). */
export function codexHookPaths(src: SourceInfo): CodexHookPaths | undefined {
  if (src.provider !== 'codex' || src.kind !== 'auto') return undefined
  const home = dirname(src.projectsDir)
  if (!/[\\/]\.codex$/i.test(home)) return undefined
  const hooksPath = join(home, 'hooks.json')
  const bridgeDir = join(dirname(home), BRIDGE_DIR_NAME)
  let command: string
  let codexHooksPath: string
  if (src.env === 'windows') {
    command = windowsHookCommand(join(bridgeDir, 'bin', SCRIPT.windows))
    codexHooksPath = hooksPath
  } else {
    const unc = parseWslUnc(hooksPath)
    if (!unc || !src.user) return undefined
    const linuxHome = src.user === 'root' ? '/root' : `/home/${src.user}`
    command = `sh ${shQuote(`${linuxHome}/${BRIDGE_DIR_NAME}/bin/${SCRIPT.wsl}`)}`
    codexHooksPath = unc.linuxPath
  }
  return {
    sourceId: src.id,
    label: src.label,
    env: src.env,
    user: src.user,
    home,
    hooksPath,
    configPath: join(home, 'config.toml'),
    codexHooksPath,
    bridgeDir,
    command
  }
}

export interface CodexHookInstallRecord extends HookInstallRecord {
  /**
   * The trust entry config.toml already had at the hook's position when the
   * app added it (left by an older hook there), or null when there was none.
   * It doesn't mean the app's hook is trusted.
   */
  priorTrustHash?: string | null
}

export interface CodexHooksFile {
  version: 1
  installs: Record<string, CodexHookInstallRecord>
}

export function createCodexHooksStore(dataDir: string): JsonStore<CodexHooksFile> {
  return new JsonStore<CodexHooksFile>(join(dataDir, 'codex-hooks.json'), dataDir, () => ({
    version: 1,
    installs: {}
  }))
}

/** SHA-256 of Codex hook scripts earlier versions shipped (replaced by a newer one when unchanged). */
export const SHIPPED_CODEX_HOOK_SHA256: Record<string, string[]> = {
  [SCRIPT.windows]: [],
  [SCRIPT.wsl]: []
}

function hooksOf(text: string | undefined): Record<string, unknown> | undefined {
  if (!text) return undefined
  const v = (parseJsonc(text) as Record<string, unknown>).hooks
  return v && typeof v === 'object' && !Array.isArray(v)
    ? (v as Record<string, unknown>)
    : undefined
}

/** Where our handler is in `hooks.<event>`: Codex's trust keys are by position. */
export function handlerPosition(
  text: string | undefined,
  event: string,
  commands: ReadonlySet<string>
): { group: number; handler: number; groups: number } | undefined {
  const list = hooksOf(text)?.[event]
  if (!Array.isArray(list)) return undefined
  for (let g = 0; g < list.length; g++) {
    const hs = (list[g] as Record<string, unknown> | undefined)?.hooks
    if (!Array.isArray(hs)) continue
    const h = hs.findIndex((x) => isOurHandler(x, commands))
    if (h >= 0) return { group: g, handler: h, groups: list.length }
  }
  return undefined
}

const fileMsg = (m: string): string => m.replace(/settings\.json/g, 'hooks.json')

export interface CodexHooksHost {
  dataDir: string
  scriptsDir: string
  readScript: (path: string) => Promise<string>
  /** Reads a text file of the Codex home (hooks.json, config.toml): a seam for tests. */
  readHome?: (path: string) => Promise<string | undefined>
  /** When a file of the Codex home was last saved, epoch ms (a seam for tests). */
  savedAt?: (path: string) => Promise<number | undefined>
}

export class CodexHooksInstaller {
  constructor(
    private readonly store: JsonStore<CodexHooksFile>,
    private readonly host: CodexHooksHost
  ) {}

  get backupDir(): string {
    return join(this.host.dataDir, 'backups', 'codex-hooks')
  }

  record(sourceId: string): CodexHookInstallRecord | undefined {
    return this.store.value.installs[sourceId]
  }

  private read(path: string): Promise<string | undefined> {
    return this.host.readHome ? this.host.readHome(path) : readText(path)
  }

  private savedAt(path: string): Promise<number | undefined> {
    return this.host.savedAt
      ? this.host.savedAt(path)
      : stat(path).then(
          (st) => st.mtimeMs,
          () => undefined
        )
  }

  /** The trust entry config.toml has now at the handler's position in `text` (hooks.json). */
  private async entryAt(
    p: CodexHookPaths,
    text: string,
    commands: ReadonlySet<string>
  ): Promise<string | null> {
    const pos = handlerPosition(text, CODEX_HOOK_EVENTS[0], commands)
    if (!pos) return null
    const toml = (await this.read(p.configPath).catch(() => undefined)) ?? ''
    const e = trustEntry(
      parseHookTrust(toml),
      p.codexHooksPath,
      CODEX_HOOK_EVENTS[0],
      pos.group,
      pos.handler,
      p.env === 'windows'
    )
    return e?.hash ?? null
  }

  commands(src: SourceInfo): Set<string> {
    const out = new Set<string>()
    const c = codexHookPaths(src)?.command
    if (c) out.add(c)
    const rec = this.record(src.id)?.command
    if (rec) out.add(rec)
    return out
  }

  /** Sources where hooks.json runs the app's hook and Codex trusts it (no guessing there). */
  exactSources(envs: readonly HookEnv[]): Set<string> {
    return new Set(envs.filter((e) => e.installed && e.trust === 'trusted').map((e) => e.sourceId))
  }

  private async bundledScript(env: SourceInfo['env']): Promise<{ name: string; text: string }> {
    const name = env === 'windows' ? SCRIPT.windows : SCRIPT.wsl
    const text = await this.host.readScript(join(this.host.scriptsDir, name))
    return {
      name,
      text: env === 'windows' ? text.replace(/\r?\n/g, '\r\n') : text.replace(/\r\n/g, '\n')
    }
  }

  async describe(src: SourceInfo, lastEventAt?: number): Promise<HookEnv | undefined> {
    const p = codexHookPaths(src)
    if (!p) return undefined
    const rec = this.record(src.id)
    const env: HookEnv = {
      sourceId: p.sourceId,
      label: p.label,
      env: p.env,
      user: p.user,
      settingsPath: p.hooksPath,
      installed: false,
      installedAt: rec?.installedAt,
      lastEventAt,
      provider: 'codex'
    }
    if (src.status !== 'ok' && src.status !== 'missing') {
      env.unavailable = src.statusMessage ?? "This environment can't be read right now."
      env.installed = !!rec
      return env
    }
    let text: string | undefined
    try {
      text = await this.read(p.hooksPath)
      const commands = this.commands(src)
      const events = installedEvents(text, commands)
      env.installed = events.length > 0
      if (rec) env.changedSinceInstall = rec.events.some((e) => !events.includes(e))
      const pos = handlerPosition(text, CODEX_HOOK_EVENTS[0], commands)
      if (env.installed && pos) {
        // Read only, and only the hook trust and the hooks feature switch.
        const toml = (await this.read(p.configPath).catch(() => undefined)) ?? ''
        const installedAt = rec?.installedAt ? Date.parse(rec.installedAt) : undefined
        env.trust = trustOf(
          parseHookTrust(toml),
          {
            hooksPath: p.codexHooksPath,
            event: CODEX_HOOK_EVENTS[0],
            group: pos.group,
            handler: pos.handler,
            windows: p.env === 'windows'
          },
          {
            priorHash: rec?.priorTrustHash,
            installedAt: Number.isFinite(installedAt) ? installedAt : undefined,
            configSavedAt: await this.savedAt(p.configPath)
          }
        )
        // An approval the hook saved since it was added: it runs, whatever config.toml says.
        if (lastEventAt && installedAt && lastEventAt >= installedAt) env.trust = 'trusted'
        if (hooksFeatureOff(toml)) env.hooksFeatureOff = true
      }
    } catch {
      env.unavailable = "hooks.json isn't valid JSON, so the app won't change it."
    }
    return env
  }

  async plan(src: SourceInfo, action: 'install' | 'uninstall'): Promise<BridgePlan> {
    const p = codexHookPaths(src)
    const base: BridgePlan = {
      sourceId: src.id,
      action,
      label: src.label,
      settingsPath: p?.hooksPath ?? '',
      backupDir: this.backupDir,
      createsFile: false,
      diff: [],
      token: ''
    }
    if (!p)
      return {
        ...base,
        error: 'Codex alerts can only be enabled for a Codex home the app found (~/.codex).'
      }
    let before: string | undefined
    try {
      before = await this.read(p.hooksPath)
    } catch (err) {
      return { ...base, error: `Can't read hooks.json: ${(err as Error).message}` }
    }
    let after: string
    const notes: string[] = []
    try {
      if (before !== undefined) {
        parseJsonc(before)
        scanTopLevel(before)
        const problem = hooksProblem(before)
        if (problem) throw new Error(problem)
      }
      const commands = this.commands(src)
      const have = installedEvents(before, commands)
      if (action === 'install') {
        const missing = CODEX_HOOK_EVENTS.filter((e) => !have.includes(e))
        if (!missing.length) return { ...base, noop: true, token: tokenOf(before) }
        after = this.installedText(before, p.command, [...missing])
        notes.push(
          'Codex runs a new hook only after you trust it: open Codex and type /hooks, then trust "PermissionRequest". The app never marks it trusted for you.'
        )
      } else {
        if (!have.length) return { ...base, noop: true, token: tokenOf(before) }
        after = this.restoredText(before!, this.record(src.id), commands)
        const pos = handlerPosition(before, CODEX_HOOK_EVENTS[0], commands)
        if (pos && pos.group < pos.groups - 1)
          notes.push(
            `${pos.groups - 1 - pos.group} of your own PermissionRequest hook${pos.groups - 1 - pos.group === 1 ? '' : 's'} come${pos.groups - 1 - pos.group === 1 ? 's' : ''} after the app's. Codex remembers trust by position, so it will ask you to trust ${pos.groups - 1 - pos.group === 1 ? 'it' : 'them'} again in /hooks.`
          )
      }
      parseJsonc(after)
    } catch (err) {
      return {
        ...base,
        error: `hooks.json can't be changed safely (${fileMsg((err as Error).message)}), so the app won't change it.`
      }
    }
    return {
      ...base,
      createsFile: before === undefined,
      diff: diffLines(before ?? '', after),
      token: tokenOf(before),
      ...(notes.length ? { notes } : {})
    }
  }

  private installedText(before: string | undefined, command: string, events: string[]): string {
    const groups = events.map((e) => [e, hookGroup(command)] as [string, unknown])
    if (before === undefined || !before.trim()) {
      const hooks = Object.fromEntries(groups.map(([e, g]) => [e, [g]]))
      return `${JSON.stringify({ hooks }, null, 2)}\n`
    }
    return appendHookGroups(before, groups)
  }

  /** What Disable writes, most exact first (see HooksInstaller.restoredText). */
  restoredText(
    current: string,
    rec: HookInstallRecord | undefined,
    commands: ReadonlySet<string>
  ): string {
    if (rec && current === rec.writtenText) {
      if (rec.originalText !== undefined) return rec.originalText
      if (!rec.fileExisted) return removeMember(current, 'hooks')
    }
    const raw = rawMember(current, 'hooks')
    if (rec?.writtenHooksRaw !== undefined && raw === rec.writtenHooksRaw) {
      return rec.previousHooksRaw === undefined
        ? removeMember(current, 'hooks')
        : setMember(current, 'hooks', undefined, rec.previousHooksRaw)
    }
    const created = new Set<string>(rec?.createdEvents ?? CODEX_HOOK_EVENTS)
    return (
      removeHookHandlers(current, (h) => isOurHandler(h, commands), {
        dropEvent: (e) => created.has(e),
        dropHooks: !rec?.hadHooks
      }) ?? current
    )
  }

  async apply(
    src: SourceInfo,
    action: 'install' | 'uninstall',
    token: string
  ): Promise<BridgeApplyResult> {
    const p = codexHookPaths(src)
    if (!p) return { ok: false, error: 'Not a Codex home folder.' }
    const plan = await this.plan(src, action)
    if (plan.error) return { ok: false, error: plan.error }
    if (plan.token !== token)
      return {
        ok: false,
        error: 'hooks.json changed since you reviewed it. Review the change again.'
      }
    if (plan.noop) return { ok: true }
    const before = await this.read(p.hooksPath)
    if (tokenOf(before) !== token)
      return {
        ok: false,
        error: 'hooks.json changed since you reviewed it. Review the change again.'
      }
    try {
      let backupPath: string | undefined
      if (before !== undefined) {
        const stamp = new Date().toISOString().replace(/[:.]/g, '-')
        backupPath = join(
          this.backupDir,
          `${src.id.replace(/[^A-Za-z0-9._-]+/g, '_')}-${stamp}-hooks.json`
        )
        assertAppDataWrite(backupPath, this.host.dataDir)
        await assertRealAppDataWrite(backupPath, this.host.dataDir)
        await mkdir(this.backupDir, { recursive: true })
        await copyShared(p.hooksPath, backupPath)
      }
      if (action === 'install') {
        const { name, text: script } = await this.bundledScript(p.env)
        await writeBridgeFile(join(p.bridgeDir, 'bin', name), script)
        const commands = this.commands(src)
        const have = installedEvents(before, commands)
        const events = CODEX_HOOK_EVENTS.filter((e) => !have.includes(e))
        const after = this.installedText(before, p.command, [...events])
        await writeSettings(p.hooksPath, after, before, {}, CODEX_HOOKS)
        const prevHooks = before !== undefined ? rawMember(before, 'hooks') : undefined
        const prevEvents = new Set(Object.keys(hooksOf(before) ?? {}))
        const prior = this.record(src.id)
        const repair = have.length > 0
        const priorTrustHash = await this.entryAt(p, after, commands).catch(() => null)
        this.store.update((d) => {
          d.installs[src.id] = {
            installedAt: prior?.installedAt ?? new Date().toISOString(),
            settingsPath: p.hooksPath,
            command: p.command,
            events: [...new Set([...(prior?.events ?? []), ...have, ...events])],
            fileExisted: prior?.fileExisted ?? before !== undefined,
            originalText: repair ? undefined : before,
            writtenText: after,
            previousHooksRaw: repair ? undefined : prevHooks,
            writtenHooksRaw: repair ? undefined : rawMember(after, 'hooks'),
            hadHooks: prior?.hadHooks ?? (repair || prevHooks !== undefined),
            createdEvents: [
              ...new Set([
                ...(prior?.createdEvents ?? []),
                ...events.filter((e) => !prevEvents.has(e))
              ])
            ],
            backupPath,
            scriptSha256: sha256(script),
            priorTrustHash: prior ? prior.priorTrustHash : priorTrustHash
          }
        })
      } else {
        const after = this.restoredText(before!, this.record(src.id), this.commands(src))
        // The app created hooks.json and nothing else is in it now: it stays, as `{}`
        // (the app never deletes a file in .codex).
        await writeSettings(p.hooksPath, after, before, {}, CODEX_HOOKS)
        this.store.update((d) => {
          delete d.installs[src.id]
        })
      }
      await this.store.flush()
      return { ok: true, backupPath }
    } catch (err) {
      if (err instanceof SettingsChangedError) return { ok: false, error: err.message }
      throw err
    }
  }

  /** Bring an installed hook script up to date (only if nobody changed it). */
  async refreshScripts(sources: SourceInfo[]): Promise<string[]> {
    const updated: string[] = []
    for (const src of sources) {
      const rec = this.record(src.id)
      const p = codexHookPaths(src)
      if (src.status !== 'ok' || !rec || !p) continue
      try {
        if (!installedEvents(await this.read(p.hooksPath), this.commands(src)).length) continue
        const { name, text } = await this.bundledScript(p.env)
        const target = join(p.bridgeDir, 'bin', name)
        const current = await readFile(target, 'utf8').catch(() => undefined)
        if (current === text) continue
        const known =
          current === undefined ||
          sha256(current) === rec.scriptSha256 ||
          (SHIPPED_CODEX_HOOK_SHA256[name] ?? []).includes(sha256(current))
        if (!known) continue
        await writeBridgeFile(target, text)
        this.store.update((d) => {
          const r = d.installs[src.id]
          if (r) r.scriptSha256 = sha256(text)
        })
        updated.push(src.id)
      } catch (err) {
        console.warn('could not update the Codex hook script', p.bridgeDir, err)
      }
    }
    if (updated.length) await this.store.flush().catch(() => undefined)
    return updated
  }
}
