// API keys (Settings → Accounts), credit grants and Admin API reports.
//
// Keys are encrypted with Electron safeStorage (Windows DPAPI) and only the
// ciphertext is written to disk. If encryption isn't available the app refuses
// to store keys rather than falling back to plain text. Keys are never logged
// and never sent to the renderer.

import { EventEmitter } from 'node:events'
import { randomBytes } from 'node:crypto'
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

export interface Encryptor {
  available(): boolean
  encrypt(text: string): Buffer
  decrypt(data: Buffer): string
}

interface StoredAccount extends Account {
  /** base64 of the safeStorage ciphertext. */
  enc?: string
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
}

const id = (p: string): string => `${p}-${randomBytes(6).toString('hex')}`
const isoDay = (t: number): string => new Date(t).toISOString().slice(0, 10) + 'T00:00:00Z'

export class AccountsService extends EventEmitter<{ changed: [] }> {
  private timer: NodeJS.Timeout | undefined
  private refreshing = new Map<string, Promise<void>>()

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

  list(): Account[] {
    return this.store.value.accounts.map(({ enc: _enc, ...a }) => ({ ...a }))
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
    if (this.store.value.accounts.some((a) => a.masked === maskKey(k) && !a.sample)) {
      return { error: 'This key is already added.' }
    }
    const enc = this.enc.encrypt(k).toString('base64')
    const account: StoredAccount = {
      id: id('acct'),
      nickname: nickname.trim().slice(0, 60) || (kind === 'admin' ? 'Admin key' : 'API key'),
      kind,
      masked: maskKey(k),
      createdAt: new Date(now()).toISOString(),
      enc
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

  async rename(accountId: string, nickname: string): Promise<void> {
    this.store.update((d) => {
      const a = d.accounts.find((x) => x.id === accountId)
      if (a && nickname.trim()) a.nickname = nickname.trim().slice(0, 60)
    })
    await this.store.flush()
    this.emit('changed')
  }

  /** Forget a key. Its credit grants are kept (they are history). */
  async remove(accountId: string): Promise<void> {
    this.store.update((d) => {
      d.accounts = d.accounts.filter((a) => a.id !== accountId)
      delete d.admin[accountId]
    })
    await this.store.flush()
    this.emit('changed')
  }

  /** The decrypted key, for the main process only (launching, Admin API). */
  keyFor(accountId: string): string | undefined {
    const a = this.store.value.accounts.find((x) => x.id === accountId)
    if (!a?.enc) return undefined
    try {
      return this.enc.decrypt(Buffer.from(a.enc, 'base64'))
    } catch {
      return undefined
    }
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

  private async doRefresh(accountId: string): Promise<void> {
    const account = this.store.value.accounts.find((a) => a.id === accountId)
    if (!account || account.kind !== 'admin') return
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
        const key = this.keyFor(accountId)
        if (!key)
          throw new ApiError(
            "The key couldn't be decrypted on this computer. Remove it and add it again."
          )
        const o = { userAgent: this.opts.userAgent }
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
      const prev = this.store.value.admin[accountId]
      report = {
        ...(prev ?? { accountId, from: range[0][1], to: range[1][1], usage: [], costs: [] }),
        fetchedAt: now(),
        error: err instanceof ApiError ? err.message : 'Could not reach api.anthropic.com.'
      }
    }
    this.store.update((d) => {
      d.admin[accountId] = report
    })
    await this.store.flush()
    this.emit('changed')
  }
}
