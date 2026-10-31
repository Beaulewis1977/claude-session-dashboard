// Installing and removing the status line bridge (Phase 5, exception #1).
//
// Only when the user clicks "Enable live limits" (and confirms the exact
// diff), the app:
//   1. backs up settings.json to the app data folder,
//   2. writes the bridge script to <home>/.claude-session-dashboard/bin/,
//   3. changes only the `statusLine` key of <home>/.claude/settings.json.
// "Disable" puts the previous `statusLine` back exactly. Nothing is deleted.

import { createHash, randomBytes } from 'node:crypto'
import { constants } from 'node:fs'
import {
  copyFile,
  lstat,
  mkdir,
  open,
  readdir,
  readFile,
  rename,
  stat,
  unlink,
  writeFile
} from 'node:fs/promises'
import { basename, dirname, join } from 'node:path'
import type { BridgeApplyResult, BridgeEnv, BridgePlan } from '@shared/usage/limits'
import type { SourceInfo } from '@shared/types'
import { JsonStore } from '../core/json-store'
import { copyShared } from '../core/shared-copy'
import {
  assertAppDataWrite,
  assertRealAppDataWrite,
  assertRealBridgeWrite,
  assertClaudeSettingsWrite
} from '../core/safe-paths'
import {
  diffLines,
  parseJsonc,
  rawMember,
  removeMember,
  scanTopLevel,
  setMember
} from '../core/settings-edit'

export const BRIDGE_DIR_NAME = '.claude-session-dashboard'
const MARKER = `${BRIDGE_DIR_NAME}/bin/statusline`

export interface InstallRecord {
  installedAt: string
  settingsPath: string
  bridgeDir: string
  command: string
  /** Did settings.json exist before? */
  fileExisted: boolean
  /** Exact text of the previous statusLine value, if there was one. */
  previousRaw?: string
  /** Exact text of settings.json before and after the change. */
  originalText?: string
  writtenText: string
  backupPath?: string
  /** SHA-256 of the bridge script the app last wrote, to recognise it later. */
  scriptSha256?: string
}

/**
 * SHA-256 of every bridge script an earlier version of the app installed
 * (with the line endings it wrote). Only these, or the one the app recorded
 * writing, are replaced by a newer bundled script: anything else was changed
 * by someone and is left alone.
 */
export const SHIPPED_SCRIPT_SHA256: Record<'statusline.ps1' | 'statusline.sh', string[]> = {
  // 1.0.0–1.3.0: File.Replace got "" as its backup path, so updates failed.
  'statusline.ps1': ['7f67e6e23eb2648ede21c4c055a78f2dca21498a090d711c80d44eaba52752f5'],
  'statusline.sh': ['fe0c04e0efd8885e902284407c990dc09cb708df1767dc6e41b606976ae785ba']
}

export const sha256 = (text: string): string => createHash('sha256').update(text).digest('hex')

export interface BridgeFile {
  version: 1
  installs: Record<string, InstallRecord>
  /** Alerts already shown, keyed by `${window}:${resetsAt}`. */
  alerted: Record<string, number[]>
}

export function createBridgeStore(dataDir: string): JsonStore<BridgeFile> {
  return new JsonStore<BridgeFile>(join(dataDir, 'bridge.json'), dataDir, () => ({
    version: 1,
    installs: {},
    alerted: {}
  }))
}

export interface BridgeHost {
  /** Where the app data lives (backups go to <dataDir>/backups/settings). */
  dataDir: string
  /** Bridge script sources (resources/bridge). */
  scriptsDir: string
  /** Git Bash, used on Windows to run a chained bash status line. */
  gitBash: () => Promise<string | undefined>
}

export interface EnvPaths {
  sourceId: string
  label: string
  env: SourceInfo['env']
  user?: string
  /** Host paths. */
  home: string
  settingsPath: string
  bridgeDir: string
  /** The command Claude Code will run. */
  command: string
}

const shQuote = (s: string): string =>
  /^[A-Za-z0-9_./~-]+$/.test(s) ? s : `'${s.replace(/'/g, `'\\''`)}'`

/** Paths and the status line command for one Claude home source. */
export function envPaths(src: SourceInfo): EnvPaths | undefined {
  if (src.kind !== 'auto' || !src.claudeSettingsPath) return undefined
  const settingsPath = src.claudeSettingsPath
  const home = dirname(dirname(settingsPath))
  const bridgeDir = join(home, BRIDGE_DIR_NAME)
  let command: string
  if (src.env === 'windows') {
    // Forward slashes: Claude Code may run this through Git Bash, which eats backslashes.
    const script = `${bridgeDir.replace(/\\/g, '/')}/bin/statusline.ps1`
    command = `powershell -NoProfile -NonInteractive -ExecutionPolicy Bypass -File "${script}"`
  } else {
    const linuxHome = src.user === 'root' ? '/root' : `/home/${src.user ?? ''}`
    command = `sh ${shQuote(`${linuxHome}/${BRIDGE_DIR_NAME}/bin/statusline.sh`)}`
  }
  return {
    sourceId: src.id,
    label: src.label,
    env: src.env,
    user: src.user,
    home,
    settingsPath,
    bridgeDir,
    command
  }
}

export function isBridgeCommand(cmd: unknown): boolean {
  return typeof cmd === 'string' && cmd.replace(/\\/g, '/').includes(MARKER)
}

export async function readText(p: string): Promise<string | undefined> {
  try {
    return await readFile(p, 'utf8')
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return undefined
    throw err
  }
}

export const tokenOf = (text: string | undefined): string =>
  createHash('sha256')
    .update(text ?? '\0missing')
    .digest('hex')
    .slice(0, 32)

function statusLineOf(text: string | undefined): Record<string, unknown> | undefined {
  if (!text) return undefined
  const v = (parseJsonc(text) as Record<string, unknown>).statusLine
  return v && typeof v === 'object' && !Array.isArray(v)
    ? (v as Record<string, unknown>)
    : undefined
}

function commandOf(text: string | undefined): string | undefined {
  const c = statusLineOf(text)?.command
  return typeof c === 'string' && c.trim() ? c : undefined
}

/** settings.json with the bridge as the status line (keeps padding/refreshInterval). */
function installedText(before: string | undefined, command: string): string {
  const current = statusLineOf(before)
  const value: Record<string, unknown> = { type: 'command', command }
  if (typeof current?.padding === 'number') value.padding = current.padding
  if (typeof current?.refreshInterval === 'number') value.refreshInterval = current.refreshInterval
  return before === undefined
    ? `${JSON.stringify({ statusLine: value }, null, 2)}\n`
    : setMember(before, 'statusLine', value)
}

export const SETTINGS_CHANGED =
  'settings.json changed while the app was preparing the change (another program or editor saved it). Nothing was changed. Review the change again.'

export class SettingsChangedError extends Error {}

/** Test seams: run code at the moment another program could save, or replace the rename. */
export interface WriteSettingsProbe {
  /** Runs after the temp file is written, just before the last check and the swap. */
  beforeSwap?: () => Promise<void>
  /** Stands in for fs.rename (tests of a replace that isn't possible). */
  rename?: (from: string, to: string) => Promise<void>
}

const sameText = (a: string | undefined, b: string | undefined): boolean =>
  tokenOf(a) === tokenOf(b)

/**
 * Save settings.json, the same way for every change the app makes to it (the
 * status line bridge and session alerts):
 *
 *   1. the whole new content goes to a temp file in the same folder, flushed
 *      to disk;
 *   2. right before the swap, settings.json is read again and must still be
 *      exactly what the user reviewed (else nothing changes: review again);
 *   3. one atomic same-folder rename replaces settings.json with the temp
 *      file, so there is never a moment without a settings.json.
 *
 * If that rename isn't possible (say, the share doesn't support it), nothing
 * is changed and the error says so. This narrows, but can't close, the window
 * in which another program saving at the same moment could be overwritten:
 * the caller keeps a backup of the reviewed file in the app's data folder
 * first. Claude's own file mode is kept.
 */
export async function writeSettings(
  path: string,
  text: string,
  expected: string | undefined,
  probe: WriteSettingsProbe = {}
): Promise<void> {
  assertClaudeSettingsWrite(path)
  const tmp = `${path}.csd-${randomBytes(4).toString('hex')}.tmp`
  assertClaudeSettingsWrite(tmp)
  const mode = await stat(path).then(
    (st) => st.mode & 0o777,
    () => undefined
  )
  const fh = await open(tmp, 'wx', mode ?? 0o644)
  try {
    await fh.writeFile(text, 'utf8')
    // On disk before it replaces anything (not every file system supports it).
    await fh.sync().catch(() => undefined)
  } finally {
    await fh.close()
  }
  try {
    await probe.beforeSwap?.()
    if (!sameText(await readText(path), expected)) throw new SettingsChangedError(SETTINGS_CHANGED)
    const doRename = probe.rename ?? rename
    for (let i = 0; ; i++) {
      try {
        await doRename(tmp, path)
        return
      } catch (err) {
        const code = (err as NodeJS.ErrnoException).code
        // Windows can hold the file open for a moment (antivirus, Claude reading it).
        if (i < 4 && (code === 'EPERM' || code === 'EBUSY' || code === 'EACCES')) {
          await new Promise((r) => setTimeout(r, 60 * (i + 1)))
          if (!sameText(await readText(path), expected))
            throw new SettingsChangedError(SETTINGS_CHANGED)
          continue
        }
        throw new Error(
          `settings.json can't be replaced in one step here (${code ?? (err as Error).message}). Nothing was changed.`,
          { cause: err }
        )
      }
    }
  } finally {
    await unlink(tmp).catch(() => undefined)
  }
}

const LEFTOVER_RE = /^settings\.json\.csd-[0-9a-f]+\.(tmp|prev)$/

/**
 * At startup: tidy up after a save that was interrupted (the app closed or
 * crashed mid-way). The app's own temp files next to settings.json are
 * removed. A `.prev` file (the earlier save routine moved settings.json aside
 * under that name) is put back only if settings.json is missing, and never
 * over an existing file; otherwise it is copied to the backup folder before it
 * goes. Returns what was done, for the log.
 */
export async function cleanupSettingsLeftovers(
  settingsPath: string,
  backupDir: string,
  dataDir: string
): Promise<{ removed: number; restored: boolean }> {
  assertClaudeSettingsWrite(settingsPath)
  const dir = dirname(settingsPath)
  let names: string[]
  try {
    names = (await readdir(dir)).filter((n) => LEFTOVER_RE.test(n))
  } catch {
    return { removed: 0, restored: false }
  }
  let removed = 0
  let restored = false
  const prevs: { file: string; mtimeMs: number }[] = []
  for (const n of names) {
    const file = join(dir, n)
    assertClaudeSettingsWrite(file)
    const st = await lstat(file).catch(() => undefined)
    if (!st?.isFile()) continue
    if (n.endsWith('.tmp')) {
      await unlink(file).then(
        () => removed++,
        () => undefined
      )
    } else prevs.push({ file, mtimeMs: st.mtimeMs })
  }
  prevs.sort((a, b) => b.mtimeMs - a.mtimeMs)
  for (const p of prevs) {
    const missing = await readText(settingsPath).then(
      (t) => t === undefined,
      () => false
    )
    if (missing && !restored) {
      // Exclusive: if anything created settings.json meanwhile, it stays.
      try {
        await copyFile(p.file, settingsPath, constants.COPYFILE_EXCL)
        restored = true
      } catch {
        continue
      }
    } else {
      // Kept in the app's backups before it goes.
      const backup = join(backupDir, `leftover-${Date.now()}-${basename(p.file)}`)
      assertAppDataWrite(backup, dataDir)
      await assertRealAppDataWrite(backup, dataDir)
      await mkdir(backupDir, { recursive: true })
      try {
        await copyShared(p.file, backup)
      } catch {
        continue
      }
    }
    await unlink(p.file).then(
      () => removed++,
      () => undefined
    )
  }
  return { removed, restored }
}

/**
 * Write a file in the bridge folder atomically. The real folder (links and
 * junctions followed) must still be a bridge folder. Windows can hold the
 * target open for a moment (antivirus, a running status line), so the rename
 * is retried a few times; the temp file never stays behind.
 */
export async function writeBridgeFile(path: string, text: string): Promise<void> {
  await assertRealBridgeWrite(path)
  await mkdir(dirname(path), { recursive: true })
  await assertRealBridgeWrite(path)
  const tmp = `${path}.${randomBytes(4).toString('hex')}.tmp`
  try {
    await writeFile(tmp, text, 'utf8')
    for (let i = 0; ; i++) {
      try {
        await rename(tmp, path)
        return
      } catch (err) {
        const code = (err as NodeJS.ErrnoException).code
        if (i >= 4 || (code !== 'EPERM' && code !== 'EBUSY' && code !== 'EACCES')) throw err
        await new Promise((r) => setTimeout(r, 50 * (i + 1)))
      }
    }
  } finally {
    await unlink(tmp).catch(() => undefined)
  }
}

export class BridgeInstaller {
  constructor(
    private readonly store: JsonStore<BridgeFile>,
    private readonly host: BridgeHost
  ) {}

  get backupDir(): string {
    return join(this.host.dataDir, 'backups', 'settings')
  }

  record(sourceId: string): InstallRecord | undefined {
    return this.store.value.installs[sourceId]
  }

  /** The bundled bridge script for an environment, with that system's line endings. */
  private async bundledScript(env: SourceInfo['env']): Promise<{ name: string; text: string }> {
    const name = env === 'windows' ? 'statusline.ps1' : 'statusline.sh'
    const text = await readFile(join(this.host.scriptsDir, name), 'utf8')
    return {
      name,
      text: env === 'windows' ? text.replace(/\r?\n/g, '\r\n') : text.replace(/\r\n/g, '\n')
    }
  }

  /**
   * Bring installed bridge scripts up to date with the ones bundled with this
   * version of the app (a fixed script would otherwise only arrive on a
   * reinstall). Only a script the app recognises (one it shipped, or the one
   * it recorded writing) is replaced: a script someone changed is kept as it
   * is. Only where settings.json still runs the bridge, and settings.json
   * itself is never touched. Returns the ids of the sources that were updated.
   */
  async refreshScripts(sources: SourceInfo[]): Promise<string[]> {
    const updated: string[] = []
    let dirty = false
    for (const src of sources) {
      const rec = this.record(src.id)
      if (src.status !== 'ok' || !rec) continue
      const p = envPaths(src)
      if (!p) continue
      try {
        if (!isBridgeCommand(commandOf(await readText(p.settingsPath)))) continue
        const { name, text } = await this.bundledScript(p.env)
        const target = join(p.bridgeDir, 'bin', name)
        const current = await readText(target)
        if (current === text) {
          // Up to date. Remember it, so a later version can recognise it
          // (installs from before hashes were recorded have none).
          if (rec.scriptSha256 !== sha256(text)) {
            this.store.update((d) => {
              const r = d.installs[src.id]
              if (r) r.scriptSha256 = sha256(text)
            })
            dirty = true
          }
          continue
        }
        const known =
          current !== undefined &&
          (sha256(current) === rec.scriptSha256 ||
            SHIPPED_SCRIPT_SHA256[name as keyof typeof SHIPPED_SCRIPT_SHA256].includes(
              sha256(current)
            ))
        if (!known) {
          console.warn('bridge script was changed by someone; not updating it', target)
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
        console.warn('could not update the bridge script', p.bridgeDir, err)
      }
    }
    if (dirty) {
      // A locked or unwritable bridge.json must not stop startup or a rescan.
      // The hashes stay in memory and the store saves them again later.
      await this.store.flush().catch((err: unknown) => {
        console.warn("couldn't save bridge.json; will retry", err)
        this.store.update(() => undefined)
      })
    }
    return updated
  }

  async describe(src: SourceInfo, lastReceivedAt?: number): Promise<BridgeEnv | undefined> {
    const p = envPaths(src)
    if (!p) return undefined
    const rec = this.record(src.id)
    const env: BridgeEnv = {
      sourceId: p.sourceId,
      label: p.label,
      env: p.env,
      user: p.user,
      settingsPath: p.settingsPath,
      bridgeDir: p.bridgeDir,
      installed: false,
      lastReceivedAt
    }
    if (src.status !== 'ok' && src.status !== 'missing') {
      env.unavailable = src.statusMessage ?? "This environment can't be read right now."
      env.installed = !!rec
      env.installedAt = rec?.installedAt
      return env
    }
    try {
      const text = await readText(p.settingsPath)
      const cmd = commandOf(text)
      env.installed = isBridgeCommand(cmd)
      if (rec) {
        env.installedAt = rec.installedAt
        env.chained = rec.previousRaw ? commandOf(`{"statusLine":${rec.previousRaw}}`) : undefined
        env.changedSinceInstall = !env.installed
      }
    } catch {
      env.unavailable = "settings.json isn't valid JSON, so the app won't change it."
    }
    return env
  }

  /** Compute the exact change, without writing anything. */
  async plan(src: SourceInfo, action: 'install' | 'uninstall'): Promise<BridgePlan> {
    const p = envPaths(src)
    const base = {
      sourceId: src.id,
      action,
      label: src.label,
      settingsPath: p?.settingsPath ?? '',
      backupDir: this.backupDir,
      createsFile: false,
      diff: [],
      token: ''
    }
    if (!p) return { ...base, error: 'Live limits can only be enabled for a Claude home folder.' }
    let before: string | undefined
    try {
      before = await readText(p.settingsPath)
    } catch (err) {
      return { ...base, error: `Can't read settings.json: ${(err as Error).message}` }
    }
    let after: string
    let chained: string | undefined
    try {
      if (before !== undefined) {
        parseJsonc(before) // must be valid JSON (comments allowed)
        scanTopLevel(before)
      }
      const current = statusLineOf(before)
      if (action === 'install') {
        if (isBridgeCommand(current?.command))
          return { ...base, noop: true, token: tokenOf(before) }
        chained = commandOf(before)
        after = installedText(before, p.command)
      } else {
        if (!isBridgeCommand(current?.command))
          return { ...base, noop: true, token: tokenOf(before) }
        const rec = this.record(src.id)
        after = this.restoredText(before!, rec)
        chained = rec?.previousRaw ? commandOf(`{"statusLine":${rec.previousRaw}}`) : undefined
      }
      parseJsonc(after) // sanity: the result must still be valid JSON
    } catch (err) {
      return {
        ...base,
        error: `settings.json isn't valid JSON (${(err as Error).message}), so the app won't change it.`
      }
    }
    return {
      ...base,
      createsFile: before === undefined,
      diff: diffLines(before ?? '', after),
      chained,
      token: tokenOf(before)
    }
  }

  /** What "Disable" writes: the original file if nothing else changed, else just the old statusLine. */
  private restoredText(current: string, rec: InstallRecord | undefined): string {
    if (rec && rec.originalText !== undefined && current === rec.writtenText)
      return rec.originalText
    if (rec && current === rec.writtenText && !rec.fileExisted)
      return removeMember(current, 'statusLine')
    if (rec?.previousRaw !== undefined)
      return setMember(current, 'statusLine', undefined, rec.previousRaw)
    return removeMember(current, 'statusLine')
  }

  async apply(
    src: SourceInfo,
    action: 'install' | 'uninstall',
    token: string
  ): Promise<BridgeApplyResult> {
    const p = envPaths(src)
    if (!p) return { ok: false, error: 'Not a Claude home folder.' }
    const plan = await this.plan(src, action)
    if (plan.error) return { ok: false, error: plan.error }
    if (plan.token !== token) {
      return {
        ok: false,
        error: 'settings.json changed since you reviewed it. Review the change again.'
      }
    }
    if (plan.noop) return { ok: true }
    const before = await readText(p.settingsPath)
    if (tokenOf(before) !== token) return { ok: false, error: SETTINGS_CHANGED }
    try {
      return await this.applyTo(src, p, action, before)
    } catch (err) {
      if (err instanceof SettingsChangedError) return { ok: false, error: err.message }
      throw err
    }
  }

  private async applyTo(
    src: SourceInfo,
    p: EnvPaths,
    action: 'install' | 'uninstall',
    before: string | undefined
  ): Promise<BridgeApplyResult> {
    // 1. Back up settings.json first.
    let backupPath: string | undefined
    if (before !== undefined) {
      const stamp = new Date().toISOString().replace(/[:.]/g, '-')
      backupPath = join(
        this.backupDir,
        `${src.id.replace(/[^A-Za-z0-9._-]+/g, '_')}-${stamp}-settings.json`
      )
      assertAppDataWrite(backupPath, this.host.dataDir)
      await assertRealAppDataWrite(backupPath, this.host.dataDir)
      await mkdir(this.backupDir, { recursive: true })
      await copyShared(p.settingsPath, backupPath)
    }

    if (action === 'install') {
      // 2. The bridge script and the chained command (outside .claude).
      const { name: scriptName, text: script } = await this.bundledScript(p.env)
      await writeBridgeFile(join(p.bridgeDir, 'bin', scriptName), script)
      const previous = commandOf(before)
      if (p.env === 'windows') {
        const shell = previous ? await this.host.gitBash() : undefined
        await writeBridgeFile(
          join(p.bridgeDir, 'chain.json'),
          JSON.stringify({ command: previous ?? '', shell: shell ?? null }, null, 2) + '\n'
        )
      } else {
        await writeBridgeFile(join(p.bridgeDir, 'chain.sh'), previous ? `${previous}\n` : '')
      }
      await mkdir(join(p.bridgeDir, 'live'), { recursive: true }).catch(() => undefined)

      // 3. Only the statusLine key.
      const after = installedText(before, p.command)
      await writeSettings(p.settingsPath, after, before)
      this.store.update((d) => {
        d.installs[src.id] = {
          installedAt: new Date().toISOString(),
          settingsPath: p.settingsPath,
          bridgeDir: p.bridgeDir,
          command: p.command,
          fileExisted: before !== undefined,
          previousRaw: before !== undefined ? rawMember(before, 'statusLine') : undefined,
          originalText: before,
          writtenText: after,
          backupPath,
          scriptSha256: sha256(script)
        }
      })
    } else {
      const rec = this.record(src.id)
      const after = this.restoredText(before!, rec)
      await writeSettings(p.settingsPath, after, before)
      this.store.update((d) => {
        delete d.installs[src.id]
      })
    }
    await this.store.flush()
    return { ok: true, backupPath }
  }
}
