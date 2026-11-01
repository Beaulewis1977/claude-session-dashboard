// API keys (Settings → Accounts), credit grants and Admin API reports.
//
// Keys are encrypted with Electron safeStorage (Windows DPAPI) and only the
// ciphertext is written to disk. If encryption isn't available the app refuses
// to store keys rather than falling back to plain text. Keys are never logged
// and never sent to the renderer.

import { EventEmitter } from 'node:events'
import { createHash, randomBytes } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { now } from '@shared/clock'
import {
  keyKind,
  maskKey,
  parseCostReport,
  parseUsageReport,
  sanitizeGrant,
  type Account,
  type AdminReport,
  type CreditGrant
} from '@shared/usage/credits'
import { JsonStore } from '../core/json-store'
import { ApiError, fetchReport, type Fetcher } from './anthropic-api'

/**
 * Electron safeStorage (Windows DPAPI), through its asynchronous API. Keys
 * saved with the older synchronous API decrypt the same way.
 */
export interface Encryptor {
  /** Checked once at startup (safeStorage.isAsyncEncryptionAvailable). */
  available(): boolean
  encrypt(text: string): Promise<Buffer>
  decrypt(data: Buffer): Promise<string>
}

interface StoredAccount extends Account {
  /** base64 of the safeStorage ciphertext. */
  enc?: string
  /**
   * SHA-256 of the whole key (with a fixed prefix): tells keys apart exactly,
   * where the masked form shows only the start and the last 4 characters.
   * A hash of a long random key can't be turned back into the key.
   */
  fp?: string
}

/** The fingerprint stored for a key (see StoredAccount.fp). */
export function keyFingerprint(key: string): string {
  return createHash('sha256').update(`csd-api-key-v1:${key.trim()}`).digest('hex')
}

export interface AccountsFile {
  version: 1
  accounts: StoredAccount[]
  grants: CreditGrant[]
  admin: Record<string, AdminReport>
}

export function createAccountsStore(dataDir: string): JsonStore<AccountsFile> {
  return new JsonStore<AccountsFile>(join(dataDir, 'accounts.json'), dataDir, () => ({
    version: 1,
    accounts: [],
    grants: [],
    admin: {}
  }))
}

export interface AccountsOptions {
  fetcher: Fetcher
  userAgent: string
  /** Fixtures mode: Admin reports come from these files instead of the network. */
  sampleAdminDir?: string
  refreshMinutes: () => number
  /**
   * Reconnecting a restored account merged another account (same key) into
   * it: point everything that used `fromId` (sessions, project defaults) at
   * `toId`.
   */
  onMerge?: (fromId: string, toId: string) => void | Promise<void>
}

const id = (p: string): string => `${p}-${randomBytes(6).toString('hex')}`
const isoDay = (t: number): string => new Date(t).toISOString().slice(0, 10) + 'T00:00:00Z'

export class AccountsService extends EventEmitter<{ changed: [] }> {
  private timer: NodeJS.Timeout | undefined
  private refreshing = new Map<string, Promise<void>>()
  /** Stops an account's refresh when the account is removed. */
  private aborts = new Map<string, AbortController>()

  constructor(
    private readonly store: JsonStore<AccountsFile>,
    private readonly enc: Encryptor,
    private readonly opts: AccountsOptions
  ) {
    super()
  }

  encryptionAvailable(): boolean {
    try {
      return this.enc.available()
    } catch {
      return false
    }
  }

  /** Fingerprints for keys saved before they existed (decrypted here, never stored). */
  async init(): Promise<void> {
    const todo = this.store.value.accounts.filter((a) => a.enc && !a.fp)
    if (!todo.length) return
    const fps = new Map<string, string>()
    for (const a of todo) {
      const key = await this.decrypt(a.enc as string)
      if (key) fps.set(a.id, keyFingerprint(key))
    }
    if (!fps.size) return
    this.store.update((d) => {
      for (const a of d.accounts) if (fps.has(a.id)) a.fp = fps.get(a.id)
    })
  }

  private async decrypt(enc: string): Promise<string | undefined> {
    try {
      return await this.enc.decrypt(Buffer.from(enc, 'base64'))
    } catch {
      return undefined
    }
  }

  list(): Account[] {
    return this.store.value.accounts.map(({ enc, fp: _fp, ...a }) =>
      !enc && !a.sample ? { ...a, needsKey: true } : { ...a }
    )
  }

  get(accountId: string): Account | undefined {
    return this.list().find((a) => a.id === accountId)
  }

  async add(nickname: string, key: string): Promise<{ account?: Account; error?: string }> {
    const k = key.trim()
    const kind = keyKind(k)
    if (!kind) {
      return {
        error: 'That doesn’t look like an Anthropic API key (sk-ant-api… or sk-ant-admin…).'
      }
    }
    if (!this.encryptionAvailable()) {
      return {
        error:
          "Windows can't encrypt the key for this app right now, so it won't be stored (keys are never saved in plain text)."
      }
    }
    const fp = keyFingerprint(k)
    const real = this.store.value.accounts.filter((a) => !a.sample)
    // The same key, stored: by fingerprint, or (no fingerprint yet) by its mask.
    const stored = real.find((a) => a.enc && (a.fp ? a.fp === fp : a.masked === maskKey(k)))
    if (stored) {
      const restored = real.some((a) => !a.enc && a.fp === fp)
      return {
        error: restored
          ? `This key is already added as “${stored.nickname}”. To connect it to the account restored from a backup, use Reconnect key on that account.`
          : 'This key is already added.'
      }
    }
    const enc = (await this.enc.encrypt(k)).toString('base64')
    // A restored account without its key (backups never hold keys) that used
    // exactly this key: the key goes back into it, so its id, credit grants
    // and history stay linked. Never by the mask alone (two keys can share it).
    const restored = real.find((a) => !a.enc && a.fp === fp && a.kind === kind)
    if (restored) {
      this.store.update((d) => {
        const a = d.accounts.find((x) => x.id === restored.id)
        if (!a) return
        a.enc = enc
        if (nickname.trim()) a.nickname = nickname.trim().slice(0, 60)
      })
      await this.store.flush()
      this.emit('changed')
      if (kind === 'admin') void this.refreshAdmin(restored.id)
      return { account: this.get(restored.id) }
    }
    const account: StoredAccount = {
      id: id('acct'),
      nickname: nickname.trim().slice(0, 60) || (kind === 'admin' ? 'Admin key' : 'API key'),
      kind,
      masked: maskKey(k),
      createdAt: new Date(now()).toISOString(),
      enc,
      fp
    }
    this.store.update((d) => {
      d.accounts.push(account)
    })
    await this.store.flush()
    this.emit('changed')
    if (kind === 'admin') void this.refreshAdmin(account.id)
    const { enc: _e, ...pub } = account
    return { account: pub }
  }

  /**
   * Give a restored account (no key on this PC) its key again, chosen by the
   * user for that account. The key must be the one it used: same fingerprint,
   * or, for an account restored without one, the same type and mask. If the
   * key is already stored as another account (added before the restore), that
   * account is merged into this one: its grants move here, and everything that
   * used it is pointed here (onMerge), so no history is split or lost.
   */
  async reconnect(accountId: string, key: string): Promise<{ account?: Account; error?: string }> {
    const k = key.trim()
    const kind = keyKind(k)
    const target = this.store.value.accounts.find((a) => a.id === accountId && !a.sample)
    if (!target) return { error: 'That account isn’t there any more.' }
    if (target.enc) return { error: 'This account already has its key on this PC.' }
    if (!kind)
      return {
        error: 'That doesn’t look like an Anthropic API key (sk-ant-api… or sk-ant-admin…).'
      }
    if (kind !== target.kind)
      return {
        error: `This account used ${target.kind === 'admin' ? 'an Admin' : 'a standard'} key.`
      }
    const fp = keyFingerprint(k)
    if (target.fp ? target.fp !== fp : target.masked !== maskKey(k))
      return { error: 'That isn’t the key this account used.' }
    if (!this.encryptionAvailable())
      return {
        error:
          "Windows can't encrypt the key for this app right now, so it won't be stored (keys are never saved in plain text)."
      }
    const enc = (await this.enc.encrypt(k)).toString('base64')
    const other = this.store.value.accounts.find(
      (a) =>
        a.id !== target.id && !a.sample && a.enc && (a.fp ? a.fp === fp : a.masked === maskKey(k))
    )
    if (other) {
      this.aborts.get(other.id)?.abort()
      this.aborts.delete(other.id)
    }
    this.store.update((d) => {
      const a = d.accounts.find((x) => x.id === target.id)
      if (!a) return
      a.enc = enc
      a.fp = fp
      if (other) {
        for (const g of d.grants) if (g.accountId === other.id) g.accountId = target.id
        d.accounts = d.accounts.filter((x) => x.id !== other.id)
        delete d.admin[other.id]
      }
    })
    await this.store.flush()
    if (other) await this.opts.onMerge?.(other.id, target.id)
    this.emit('changed')
    if (kind === 'admin') void this.refreshAdmin(target.id)
    return { account: this.get(target.id) }
  }

  async rename(accountId: string, nickname: string): Promise<void> {
    this.store.update((d) => {
      const a = d.accounts.find((x) => x.id === accountId)
      if (a && nickname.trim()) a.nickname = nickname.trim().slice(0, 60)
    })
    await this.store.flush()
    this.emit('changed')
  }

  /**
   * Forget a key. Its credit grants are kept (they are history). A refresh
   * still running for it is stopped and saves nothing.
   */
  async remove(accountId: string): Promise<void> {
    this.aborts.get(accountId)?.abort()
    this.aborts.delete(accountId)
    this.store.update((d) => {
      d.accounts = d.accounts.filter((a) => a.id !== accountId)
      delete d.admin[accountId]
    })
    await this.store.flush()
    this.emit('changed')
  }

  /** The decrypted key, for the main process only (launching, Admin API). */
  async keyFor(accountId: string): Promise<string | undefined> {
    const a = this.store.value.accounts.find((x) => x.id === accountId)
    if (!a?.enc) return undefined
    return this.decrypt(a.enc)
  }

  // ------------------------------------------------------------ grants

  grants(): CreditGrant[] {
    return this.store.value.grants.map((g) => ({ ...g }))
  }

  async addGrant(v: unknown): Promise<CreditGrant | undefined> {
    const g = sanitizeGrant(v)
    if (!g) return undefined
    const grant: CreditGrant = { id: id('grant'), ...g }
    this.store.update((d) => {
      d.grants.push(grant)
    })
    await this.store.flush()
    this.emit('changed')
    return grant
  }

  async removeGrant(grantId: string): Promise<void> {
    this.store.update((d) => {
      d.grants = d.grants.filter((g) => g.id !== grantId)
    })
    await this.store.flush()
    this.emit('changed')
  }

  // ------------------------------------------------------- Admin API

  adminReport(accountId: string): AdminReport | undefined {
    return this.store.value.admin[accountId]
  }

  startAutoRefresh(): void {
    if (this.timer) clearInterval(this.timer)
    const tick = (): void => {
      const minutes = this.opts.refreshMinutes()
      if (minutes <= 0) return
      for (const a of this.store.value.accounts) {
        if (a.kind !== 'admin') continue
        const last = this.store.value.admin[a.id]?.fetchedAt ?? 0
        if (now() - last >= minutes * 60_000) void this.refreshAdmin(a.id)
      }
    }
    tick()
    this.timer = setInterval(tick, 60_000)
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer)
  }

  /** Fetch the last 31 days of usage and cost for an Admin key. */
  refreshAdmin(accountId: string): Promise<void> {
    const running = this.refreshing.get(accountId)
    if (running) return running
    const p = this.doRefresh(accountId).finally(() => this.refreshing.delete(accountId))
    this.refreshing.set(accountId, p)
    return p
  }

  /** Is this account (with this key) still stored? */
  private stillStored(account: StoredAccount): boolean {
    return this.store.value.accounts.some((a) => a.id === account.id && a.enc === account.enc)
  }

  private async doRefresh(accountId: string): Promise<void> {
    const account = this.store.value.accounts.find((a) => a.id === accountId)
    if (!account || account.kind !== 'admin') return
    const ctrl = new AbortController()
    this.aborts.set(accountId, ctrl)
    try {
      await this.fetchAdmin(account, ctrl.signal)
    } finally {
      if (this.aborts.get(accountId) === ctrl) this.aborts.delete(accountId)
    }
  }

  private async fetchAdmin(account: StoredAccount, signal: AbortSignal): Promise<void> {
    const accountId = account.id
    const to = now()
    const from = to - 31 * 86_400_000
    const range: [string, string][] = [
      ['starting_at', isoDay(from)],
      ['ending_at', new Date(to).toISOString().replace(/\.\d{3}Z$/, 'Z')]
    ]
    let report: AdminReport
    try {
      let usagePages: unknown[]
      let costPages: unknown[]
      if (account.sample || !account.enc) {
        if (!this.opts.sampleAdminDir) throw new ApiError('No key stored for this account.')
        usagePages = [
          JSON.parse(await readFile(join(this.opts.sampleAdminDir, 'usage_report.json'), 'utf8'))
        ]
        costPages = [
          JSON.parse(await readFile(join(this.opts.sampleAdminDir, 'cost_report.json'), 'utf8'))
        ]
      } else {
        const key = await this.keyFor(accountId)
        if (!key)
          throw new ApiError(
            "The key couldn't be decrypted on this computer. Remove it and add it again."
          )
        const o = { userAgent: this.opts.userAgent, signal }
        usagePages = await fetchReport(
          this.opts.fetcher,
          key,
          '/v1/organizations/usage_report/messages',
          [
            ...range,
            ['bucket_width', '1d'],
            ['limit', '31'],
            ['group_by[]', 'model'],
            ['group_by[]', 'api_key_id']
          ],
          o
        )
        // Removed meanwhile: no second request with the forgotten key.
        if (signal.aborted || !this.stillStored(account)) return
        costPages = await fetchReport(
          this.opts.fetcher,
          key,
          '/v1/organizations/cost_report',
          [...range, ['limit', '31'], ['group_by[]', 'description']],
          o
        )
      }
      report = {
        accountId,
        fetchedAt: now(),
        from: range[0][1],
        to: range[1][1],
        usage: parseUsageReport(usagePages),
        costs: parseCostReport(costPages),
        sample: account.sample || undefined
      }
    } catch (err) {
      if (signal.aborted || !this.stillStored(account)) return
      const prev = this.store.value.admin[accountId]
      report = {
        ...(prev ?? { accountId, from: range[0][1], to: range[1][1], usage: [], costs: [] }),
        fetchedAt: now(),
        error: err instanceof ApiError ? err.message : 'Could not reach api.anthropic.com.'
      }
    }
    // Never recreate a report for an account removed while it was fetched.
    if (signal.aborted || !this.stillStored(account)) return
    this.store.update((d) => {
      d.admin[accountId] = report
    })
    await this.store.flush()
    this.emit('changed')
  }
}
