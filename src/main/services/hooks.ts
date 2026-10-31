// Session alerts: installing and removing the hook bridge (opt-in, the same
// safety model as the status line bridge in bridge.ts).
//
// Only when the user clicks "Enable session alerts" (and confirms the exact
// diff), the app:
//   1. backs up settings.json to the app data folder,
//   2. writes the hook script to <home>/.claude-session-dashboard/bin/,
//   3. appends one hook group per event to `hooks` in <home>/.claude/settings.json.
// Existing hooks are never replaced, reordered or reformatted: ours go at the
// end of each event's list. "Disable" takes exactly ours out again (the file
// as it was, when nothing else changed since). Nothing else is touched.

import { mkdir } from 'node:fs/promises'
import { join } from 'node:path'
import type { BridgeApplyResult, BridgePlan } from '@shared/usage/limits'
import type { HookEnv } from '@shared/live'
import { HOOK_EVENTS } from '@shared/live'
import type { SourceInfo } from '@shared/types'
import { JsonStore } from '../core/json-store'
import { copyShared } from '../core/shared-copy'
import { assertAppDataWrite, assertRealAppDataWrite } from '../core/safe-paths'
import {
  appendHookGroups,
  diffLines,
  rawMember,
  removeMember,
  scanTopLevel,
  setMember,
  withoutHandlers
} from '../core/settings-edit'
import {
  BRIDGE_DIR_NAME,
  envPaths,
  readText,
  SETTINGS_CHANGED,
  SettingsChangedError,
  sha256,
  tokenOf,
  writeBridgeFile,
  writeSettings
} from './bridge'

const MARKER = `${BRIDGE_DIR_NAME}/bin/csd-hook`

export interface HookInstallRecord {
  installedAt: string
  settingsPath: string
  command: string
  events: string[]
  fileExisted: boolean
  /** Exact text of settings.json before and after the change. */
  originalText?: string
  writtenText: string
  /**
   * Exact text of the `hooks` value before (undefined: there was none) and
   * after. Unset after a repair (some of ours were already there), when only
   * taking ours out is exact.
   */
  previousHooksRaw?: string
  writtenHooksRaw?: string
  /** settings.json had a `hooks` key before the app first added any. */
  hadHooks: boolean
  /** Events the app created in `hooks` (dropped again if left empty). */
  createdEvents: string[]
  backupPath?: string
  scriptSha256?: string
}

/**
 * SHA-256 of every hook script an earlier version of the app installed, with
 * the line endings it wrote. Only these (or the one it recorded writing) are
 * replaced by a newer bundled script; a script someone changed is kept.
 */
export const SHIPPED_HOOK_SHA256: Record<'csd-hook.ps1' | 'csd-hook.sh', string[]> = {
  'csd-hook.ps1': [],
  'csd-hook.sh': []
}

export interface HooksFile {
  version: 1
  installs: Record<string, HookInstallRecord>
}

export function createHooksStore(dataDir: string): JsonStore<HooksFile> {
  return new JsonStore<HooksFile>(join(dataDir, 'hooks.json'), dataDir, () => ({
    version: 1,
    installs: {}
  }))
}

const shQuote = (s: string): string =>
  /^[A-Za-z0-9_./~-]+$/.test(s) ? s : `'${s.replace(/'/g, `'\\''`)}'`

/** The command Claude Code runs for each hook event in this home. */
export function hookCommand(src: SourceInfo): string | undefined {
  const p = envPaths(src)
  if (!p) return undefined
  if (p.env === 'windows') {
    // Forward slashes: Claude Code may run it through Git Bash, which eats backslashes.
    const script = `${p.bridgeDir.replace(/\\/g, '/')}/bin/csd-hook.ps1`
    return `powershell -NoProfile -NonInteractive -ExecutionPolicy Bypass -File "${script}"`
  }
  const linuxHome = src.user === 'root' ? '/root' : `/home/${src.user ?? ''}`
  return `sh ${shQuote(`${linuxHome}/${BRIDGE_DIR_NAME}/bin/csd-hook.sh`)}`
}

/** One hook group: runs in the background (never slows Claude down) and is quick anyway. */
export function hookGroup(command: string): Record<string, unknown> {
  return { hooks: [{ type: 'command', command, timeout: 10, async: true }] }
}

export function isHookCommand(cmd: unknown): boolean {
  return typeof cmd === 'string' && cmd.replace(/\\/g, '/').includes(MARKER)
}

const isOurHandler = (h: unknown): boolean =>
  !!h && typeof h === 'object' && isHookCommand((h as Record<string, unknown>).command)

function hooksOf(text: string | undefined): Record<string, unknown> | undefined {
  if (!text) return undefined
  const v = (JSON.parse(text) as Record<string, unknown>).hooks
  return v && typeof v === 'object' && !Array.isArray(v)
    ? (v as Record<string, unknown>)
    : undefined
}

/** Events in settings.json that run our hook script. */
export function installedEvents(text: string | undefined): string[] {
  const hooks = hooksOf(text)
  if (!hooks) return []
  return Object.entries(hooks)
    .filter(
      ([, list]) =>
        Array.isArray(list) &&
        list.some(
          (g) =>
            !!g &&
            typeof g === 'object' &&
            Array.isArray((g as Record<string, unknown>).hooks) &&
            ((g as Record<string, unknown>).hooks as unknown[]).some(isOurHandler)
        )
    )
    .map(([event]) => event)
}

export interface HooksHost {
  dataDir: string
  /** Bundled scripts (resources/bridge). */
  scriptsDir: string
  /** Reads a bundled script. */
  readScript: (path: string) => Promise<string>
}

export class HooksInstaller {
  constructor(
    private readonly store: JsonStore<HooksFile>,
    private readonly host: HooksHost
  ) {}

  get backupDir(): string {
    return join(this.host.dataDir, 'backups', 'settings')
  }

  record(sourceId: string): HookInstallRecord | undefined {
    return this.store.value.installs[sourceId]
  }

  /** Sources where the app installed the hooks (and settings.json still runs them). */
  installedSources(): string[] {
    return Object.keys(this.store.value.installs)
  }

  private async bundledScript(env: SourceInfo['env']): Promise<{ name: string; text: string }> {
    const name = env === 'windows' ? 'csd-hook.ps1' : 'csd-hook.sh'
    const text = await this.host.readScript(join(this.host.scriptsDir, name))
    return {
      name,
      text: env === 'windows' ? text.replace(/\r?\n/g, '\r\n') : text.replace(/\r\n/g, '\n')
    }
  }

  /** Bring installed hook scripts up to date (see BridgeInstaller.refreshScripts). */
  async refreshScripts(sources: SourceInfo[]): Promise<string[]> {
    const updated: string[] = []
    let dirty = false
    for (const src of sources) {
      const rec = this.record(src.id)
      const p = envPaths(src)
      if (src.status !== 'ok' || !rec || !p) continue
      try {
        if (!installedEvents(await readText(p.settingsPath)).length) continue
        const { name, text } = await this.bundledScript(p.env)
        const target = join(p.bridgeDir, 'bin', name)
        const current = await readText(target)
        if (current === text) {
          if (rec.scriptSha256 !== sha256(text)) {
            this.store.update((d) => {
              const r = d.installs[src.id]
              if (r) r.scriptSha256 = sha256(text)
            })
            dirty = true
          }
          continue
        }
        // A missing script (deleted by hand) comes back; a changed one stays.
        const known =
          current === undefined ||
          sha256(current) === rec.scriptSha256 ||
          SHIPPED_HOOK_SHA256[name as keyof typeof SHIPPED_HOOK_SHA256].includes(sha256(current))
        if (!known) {
          console.warn('hook script was changed by someone; not updating it', target)
          continue
        }
        await writeBridgeFile(target, text)
        this.store.update((d) => {
          const r = d.installs[src.id]
          if (r) r.scriptSha256 = sha256(text)
        })
        dirty = true
        updated.push(src.id)
      } catch (err) {
        console.warn('could not update the hook script', p.bridgeDir, err)
      }
    }
    if (dirty)
      await this.store.flush().catch((err: unknown) => {
        console.warn("couldn't save hooks.json; will retry", err)
        this.store.update(() => undefined)
      })
    return updated
  }

  async describe(src: SourceInfo, lastEventAt?: number): Promise<HookEnv | undefined> {
    const p = envPaths(src)
    if (!p) return undefined
    const rec = this.record(src.id)
    const env: HookEnv = {
      sourceId: p.sourceId,
      label: p.label,
      env: p.env,
      user: p.user,
      settingsPath: p.settingsPath,
      installed: false,
      installedAt: rec?.installedAt,
      lastEventAt
    }
    if (src.status !== 'ok' && src.status !== 'missing') {
      env.unavailable = src.statusMessage ?? "This environment can't be read right now."
      env.installed = !!rec
      return env
    }
    try {
      const events = installedEvents(await readText(p.settingsPath))
      env.installed = events.length > 0
      if (rec) env.changedSinceInstall = rec.events.some((e) => !events.includes(e))
    } catch {
      env.unavailable = "settings.json isn't valid JSON, so the app won't change it."
    }
    return env
  }

  /** Compute the exact change, without writing anything. */
  async plan(src: SourceInfo, action: 'install' | 'uninstall'): Promise<BridgePlan> {
    const p = envPaths(src)
    const base: BridgePlan = {
      sourceId: src.id,
      action,
      label: src.label,
      settingsPath: p?.settingsPath ?? '',
      backupDir: this.backupDir,
      createsFile: false,
      diff: [],
      token: ''
    }
    const command = hookCommand(src)
    if (!p || !command)
      return { ...base, error: 'Session alerts can only be enabled for a Claude home folder.' }
    let before: string | undefined
    try {
      before = await readText(p.settingsPath)
    } catch (err) {
      return { ...base, error: `Can't read settings.json: ${(err as Error).message}` }
    }
    let after: string
    try {
      if (before !== undefined) {
        JSON.parse(before)
        scanTopLevel(before)
      }
      const have = installedEvents(before)
      if (action === 'install') {
        const missing = HOOK_EVENTS.filter((e) => !have.includes(e))
        if (!missing.length) return { ...base, noop: true, token: tokenOf(before) }
        after = this.installedText(before, command, missing)
      } else {
        if (!have.length) return { ...base, noop: true, token: tokenOf(before) }
        after = this.restoredText(before!, this.record(src.id))
      }
      JSON.parse(after)
    } catch (err) {
      return {
        ...base,
        error: `settings.json can't be changed safely (${(err as Error).message}), so the app won't change it.`
      }
    }
    return {
      ...base,
      createsFile: before === undefined,
      diff: diffLines(before ?? '', after),
      token: tokenOf(before)
    }
  }

  private installedText(before: string | undefined, command: string, events: string[]): string {
    const groups = events.map((e) => [e, hookGroup(command)] as [string, unknown])
    if (before === undefined) {
      const hooks = Object.fromEntries(groups.map(([e, g]) => [e, [g]]))
      return `${JSON.stringify({ hooks }, null, 2)}\n`
    }
    return appendHookGroups(before, groups)
  }

  /**
   * What "Disable" writes, most exact first: the original file (nothing else
   * changed since); else the previous `hooks` value byte for byte (only other
   * settings changed); else `hooks` with exactly our handlers taken out (hooks
   * were edited since: everything else in them stays).
   */
  restoredText(current: string, rec: HookInstallRecord | undefined): string {
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
    const created = new Set(rec?.createdEvents ?? HOOK_EVENTS)
    const next = withoutHandlers(hooksOf(current), isOurHandler, (e) => created.has(e))
    if (!next) return current
    if (!Object.keys(next).length && !rec?.hadHooks) return removeMember(current, 'hooks')
    return setMember(current, 'hooks', next)
  }

  async apply(
    src: SourceInfo,
    action: 'install' | 'uninstall',
    token: string
  ): Promise<BridgeApplyResult> {
    const p = envPaths(src)
    const command = hookCommand(src)
    if (!p || !command) return { ok: false, error: 'Not a Claude home folder.' }
    const plan = await this.plan(src, action)
    if (plan.error) return { ok: false, error: plan.error }
    if (plan.token !== token)
      return {
        ok: false,
        error: 'settings.json changed since you reviewed it. Review the change again.'
      }
    if (plan.noop) return { ok: true }
    const before = await readText(p.settingsPath)
    if (tokenOf(before) !== token) return { ok: false, error: SETTINGS_CHANGED }
    try {
      // 1. Back up settings.json first.
      let backupPath: string | undefined
      if (before !== undefined) {
        const stamp = new Date().toISOString().replace(/[:.]/g, '-')
        backupPath = join(
          this.backupDir,
          `${src.id.replace(/[^A-Za-z0-9._-]+/g, '_')}-${stamp}-hooks-settings.json`
        )
        assertAppDataWrite(backupPath, this.host.dataDir)
        await assertRealAppDataWrite(backupPath, this.host.dataDir)
        await mkdir(this.backupDir, { recursive: true })
        await copyShared(p.settingsPath, backupPath)
      }
      if (action === 'install') {
        // 2. The hook script (outside .claude).
        const { name, text: script } = await this.bundledScript(p.env)
        await writeBridgeFile(join(p.bridgeDir, 'bin', name), script)
        await mkdir(join(p.bridgeDir, 'events'), { recursive: true }).catch(() => undefined)
        // 3. Only our hook groups, appended.
        const have = installedEvents(before)
        const events = HOOK_EVENTS.filter((e) => !have.includes(e))
        const after = this.installedText(before, command, events)
        await writeSettings(p.settingsPath, after, before)
        const prevHooks = before !== undefined ? rawMember(before, 'hooks') : undefined
        const prevEvents = new Set(Object.keys(hooksOf(before) ?? {}))
        const prior = this.record(src.id)
        // A repair: some of ours were there already, so "before" isn't the
        // original. Undo then takes out exactly ours, nothing more.
        const repair = have.length > 0
        this.store.update((d) => {
          d.installs[src.id] = {
            installedAt: prior?.installedAt ?? new Date().toISOString(),
            settingsPath: p.settingsPath,
            command,
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
            scriptSha256: sha256(script)
          }
        })
      } else {
        const after = this.restoredText(before!, this.record(src.id))
        await writeSettings(p.settingsPath, after, before)
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
}
