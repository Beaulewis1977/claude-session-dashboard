import { useState } from 'react'
import { projectKeyLabel } from '@shared/project-key'
import { toast } from 'sonner'
import {
  Building2,
  CalendarClock,
  Gift,
  KeyRound,
  Loader2,
  Lock,
  Plus,
  RefreshCw,
  Trash2,
  TriangleAlert,
  Wifi
} from 'lucide-react'
import type { AppSettings } from '@shared/types'
import type { Account, CreditGrant } from '@shared/usage/credits'
import { keyKind } from '@shared/usage/credits'
import { ago, formatUsd } from '@shared/format'
import { now } from '@shared/clock'
import { api } from '@/lib/api'
import { useApp } from '@/lib/store'
import { Badge } from '../ui/badge'
import { Button } from '../ui/button'
import { Dialog, DialogContent, DialogFooter, DialogHeader } from '../ui/dialog'
import { Input } from '../ui/input'
import { Segmented } from '../ui/segmented'
import { Row, Section } from '../SettingsView'
import { BillingPicker } from '../BillingPicker'

const dateFmt = new Intl.DateTimeFormat('en-US', {
  month: 'short',
  day: 'numeric',
  year: 'numeric'
})
const day = (iso?: string): string => (iso ? dateFmt.format(new Date(iso)) : '—')

function AddKeyDialog({ onClose }: { onClose: () => void }) {
  const [nickname, setNickname] = useState('')
  const [key, setKey] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string>()
  const kind = keyKind(key)
  const submit = async (): Promise<void> => {
    setBusy(true)
    setError(undefined)
    const res = await api.addAccount(nickname, key)
    setBusy(false)
    if (res.error) {
      setError(res.error)
      return
    }
    setKey('')
    toast.success(`Added ${res.account?.nickname}`, { description: res.account?.masked })
    onClose()
  }
  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="max-w-[520px]">
        <DialogHeader
          icon={
            <div className="flex size-8 items-center justify-center rounded-lg bg-accent-soft text-primary">
              <KeyRound className="size-4" />
            </div>
          }
          title="Add an API key"
          description="Stored encrypted with Windows (DPAPI). It's never shown again, never logged, and never leaves this computer except to Anthropic."
        />
        <form
          className="space-y-3 px-5 pt-3 pb-5"
          onSubmit={(e) => {
            e.preventDefault()
            void submit()
          }}
        >
          <label className="block">
            <span className="mb-1 block text-xs font-medium">Nickname</span>
            <Input
              autoFocus
              value={nickname}
              placeholder="Personal credits"
              onChange={(e) => setNickname(e.target.value)}
            />
          </label>
          <label className="block">
            <span className="mb-1 flex items-center justify-between text-xs font-medium">
              API key
              {key && (
                <span className="font-normal text-muted-foreground">
                  {kind === 'admin'
                    ? 'Admin key'
                    : kind === 'standard'
                      ? 'Standard key'
                      : 'Not a valid key'}
                </span>
              )}
            </span>
            <Input
              type="password"
              autoComplete="off"
              className="font-mono"
              placeholder="sk-ant-api03-… or sk-ant-admin01-…"
              value={key}
              onChange={(e) => setKey(e.target.value)}
            />
          </label>
          <div className="space-y-2 rounded-lg bg-secondary/70 px-3 py-2.5 text-xs leading-relaxed text-muted-foreground">
            <div className="flex gap-2">
              <KeyRound className="mt-0.5 size-3.5 shrink-0" />
              <span>
                <span className="font-medium text-foreground">Standard key</span> (sk-ant-api…): run
                sessions on API credits instead of your plan, and track their cost. No network calls
                by the app.
              </span>
            </div>
            <div className="flex gap-2">
              <Building2 className="mt-0.5 size-3.5 shrink-0" />
              <span>
                <span className="font-medium text-foreground">Admin key</span> (sk-ant-admin…): read
                your organization&apos;s usage and cost history. The app calls{' '}
                <span className="font-mono">api.anthropic.com</span> (read-only reporting endpoints)
                when you add it and on refresh. Individual accounts can&apos;t create Admin keys;
                they need an organization in the Claude Console.
              </span>
            </div>
          </div>
          {error && (
            <div className="flex items-start gap-2 text-xs text-destructive">
              <TriangleAlert className="mt-px size-3.5 shrink-0" />
              {error}
            </div>
          )}
          <button type="submit" hidden />
        </form>
        <DialogFooter>
          <Button variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button variant="primary" disabled={!kind || busy} onClick={() => void submit()}>
            {busy && <Loader2 className="animate-spin" />} Add key
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}

/** Give a restored account its key again: only the key it used is accepted. */
function ReconnectDialog({ account, onClose }: { account: Account; onClose: () => void }) {
  const [key, setKey] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string>()
  const submit = async (): Promise<void> => {
    setBusy(true)
    setError(undefined)
    const res = await api.reconnectAccount(account.id, key)
    setBusy(false)
    if (res.error) {
      setError(res.error)
      return
    }
    setKey('')
    toast.success(`Reconnected ${account.nickname}`, { description: account.masked })
    onClose()
  }
  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="max-w-[520px]">
        <DialogHeader
          icon={
            <div className="flex size-8 items-center justify-center rounded-lg bg-accent-soft text-primary">
              <KeyRound className="size-4" />
            </div>
          }
          title={`Reconnect the key for “${account.nickname}”`}
          description={`Paste the key this account used (${account.masked}). Another key is refused, even one that looks the same. If you already added this key as a separate account, that account is merged into this one, so all its sessions and credits stay together.`}
        />
        <form
          className="space-y-3 px-5 pt-3 pb-5"
          onSubmit={(e) => {
            e.preventDefault()
            void submit()
          }}
        >
          <Input
            type="password"
            autoComplete="off"
            autoFocus
            aria-label="API key"
            className="font-mono"
            placeholder={account.masked}
            value={key}
            onChange={(e) => setKey(e.target.value)}
          />
          {error && (
            <div className="flex items-start gap-2 text-xs text-destructive">
              <TriangleAlert className="mt-px size-3.5 shrink-0" />
              {error}
            </div>
          )}
          <button type="submit" hidden />
        </form>
        <DialogFooter>
          <Button variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button variant="primary" disabled={!key.trim() || busy} onClick={() => void submit()}>
            {busy && <Loader2 className="animate-spin" />} Reconnect
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}

function GrantForm({ accountId, onDone }: { accountId: string; onDone: () => void }) {
  const today = new Date(now()).toISOString().slice(0, 10)
  const [amount, setAmount] = useState('')
  const [received, setReceived] = useState(today)
  const [expires, setExpires] = useState('')
  const [note, setNote] = useState('')
  const valid = Number(amount) > 0 && !!received
  const save = async (): Promise<void> => {
    const g = await api.addGrant({
      accountId,
      amountUsd: Number(amount),
      receivedAt: `${received}T00:00:00`,
      expiresAt: expires ? `${expires}T23:59:59` : undefined,
      note
    })
    if (!g) toast.error('Check the amount and dates')
    else onDone()
  }
  return (
    <div className="grid grid-cols-[96px_1fr_1fr] gap-2 border-t border-border bg-secondary/40 px-3 py-3 sm:grid-cols-[96px_140px_140px_1fr_auto]">
      <label className="block">
        <span className="mb-1 block text-2xs text-muted-foreground">Amount (USD)</span>
        <Input
          type="number"
          min="0"
          step="0.01"
          value={amount}
          autoFocus
          onChange={(e) => setAmount(e.target.value)}
        />
      </label>
      <label className="block">
        <span className="mb-1 block text-2xs text-muted-foreground">Received</span>
        <Input type="date" value={received} onChange={(e) => setReceived(e.target.value)} />
      </label>
      <label className="block">
        <span className="mb-1 block text-2xs text-muted-foreground">Expires (optional)</span>
        <Input type="date" value={expires} onChange={(e) => setExpires(e.target.value)} />
      </label>
      <label className="col-span-2 block sm:col-span-1">
        <span className="mb-1 block text-2xs text-muted-foreground">Note</span>
        <Input
          value={note}
          placeholder="e.g. Hackathon credits"
          onChange={(e) => setNote(e.target.value)}
        />
      </label>
      <div className="flex items-end gap-1">
        <Button variant="ghost" size="sm" onClick={onDone}>
          Cancel
        </Button>
        <Button variant="primary" size="sm" disabled={!valid} onClick={() => void save()}>
          Add
        </Button>
      </div>
    </div>
  )
}

function AccountCard({ a, grants }: { a: Account; grants: CreditGrant[] }) {
  const credits = useApp((s) => s.credits)
  const [adding, setAdding] = useState(false)
  const [confirmRemove, setConfirmRemove] = useState(false)
  const [reconnecting, setReconnecting] = useState(false)
  const [refreshing, setRefreshing] = useState(false)
  const admin = credits?.admin.find((x) => x.accountId === a.id)
  const summary = credits?.summaries.find((x) => x.accountId === a.id)
  return (
    <div className="overflow-hidden rounded-lg border border-border">
      <div className="flex items-center gap-3 px-3 py-2.5">
        <div className="flex size-7 shrink-0 items-center justify-center rounded-md bg-accent-soft text-primary">
          {a.kind === 'admin' ? (
            <Building2 className="size-3.5" />
          ) : (
            <KeyRound className="size-3.5" />
          )}
        </div>
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2 text-[13px] font-medium">
            <input
              style={{ fieldSizing: 'content' } as React.CSSProperties}
              className="min-w-0 rounded bg-transparent px-0.5 outline-none hover:bg-hover focus:bg-background focus:ring-2 focus:ring-ring/30"
              defaultValue={a.nickname}
              aria-label="Nickname"
              onBlur={(e) =>
                e.target.value.trim() &&
                e.target.value !== a.nickname &&
                void api.renameAccount(a.id, e.target.value)
              }
              onKeyDown={(e) => e.key === 'Enter' && (e.target as HTMLInputElement).blur()}
            />
            <Badge variant={a.kind === 'admin' ? 'default' : 'accent'}>
              {a.kind === 'admin' ? 'Admin' : 'API'}
            </Badge>
            {a.sample && <Badge variant="muted">Sample</Badge>}
            {a.needsKey && (
              <Badge variant="warning">
                <TriangleAlert /> Key not on this PC
              </Badge>
            )}
          </div>
          <div className="font-mono text-[11px] text-muted-foreground">{a.masked}</div>
          {a.needsKey && (
            <div className="mt-0.5 flex items-center gap-2 text-xs text-muted-foreground">
              <span>
                Restored from a backup, which never holds keys. Reconnect the key it used; its
                credits and history stay with it.
              </span>
              <Button variant="outline" size="xs" onClick={() => setReconnecting(true)}>
                <KeyRound /> Reconnect key…
              </Button>
            </div>
          )}
          {reconnecting && <ReconnectDialog account={a} onClose={() => setReconnecting(false)} />}
          {a.kind === 'admin' && (
            <div className="mt-0.5 flex items-center gap-1.5 text-xs text-muted-foreground">
              <Wifi className="size-3" />
              {admin?.fetchedAt
                ? `Usage & cost report updated ${ago(admin.fetchedAt)}`
                : 'Not refreshed yet'}
              {admin?.error && <span className="text-warning">· {admin.error}</span>}
            </div>
          )}
        </div>
        {a.kind === 'admin' && (
          <Button
            variant="ghost"
            size="sm"
            disabled={refreshing}
            onClick={() => {
              setRefreshing(true)
              void api.refreshAdmin(a.id).finally(() => setRefreshing(false))
            }}
          >
            <RefreshCw className={refreshing ? 'animate-spin' : undefined} /> Refresh
          </Button>
        )}
        {confirmRemove ? (
          <div className="flex items-center gap-1">
            <Button variant="ghost" size="sm" onClick={() => setConfirmRemove(false)}>
              Keep
            </Button>
            <Button variant="destructive" size="sm" onClick={() => void api.removeAccount(a.id)}>
              Remove key
            </Button>
          </div>
        ) : (
          <Button
            variant="ghost"
            size="icon-sm"
            aria-label={`Remove ${a.nickname}`}
            onClick={() => setConfirmRemove(true)}
          >
            <Trash2 />
          </Button>
        )}
      </div>
      {a.kind === 'standard' && (
        <div className="border-t border-border">
          <div className="flex items-center justify-between px-3 pt-2 pb-1">
            <span className="text-2xs font-medium tracking-wide text-subtle-foreground uppercase">
              Credit grants
            </span>
            {summary && summary.granted > 0 && (
              <span className="text-xs text-muted-foreground tabular-nums">
                {formatUsd(summary.remaining)} left of {formatUsd(summary.granted)}
              </span>
            )}
          </div>
          {grants.map((g) => {
            const st = summary?.grants.find((x) => x.id === g.id)
            return (
              <div key={g.id} className="flex items-center gap-3 px-3 py-1.5 text-xs">
                <Gift className="size-3.5 shrink-0 text-subtle-foreground" />
                <span className="w-16 font-medium tabular-nums">{formatUsd(g.amountUsd)}</span>
                <span className="text-muted-foreground">{day(g.receivedAt)}</span>
                <span className="flex items-center gap-1 text-muted-foreground">
                  <CalendarClock className="size-3" />
                  {g.expiresAt ? `expires ${day(g.expiresAt)}` : 'no expiry'}
                </span>
                {st?.expired && <Badge variant="muted">Expired</Badge>}
                {st?.expiresSoon && <Badge variant="warning">Expires soon</Badge>}
                <span className="min-w-0 flex-1 truncate text-muted-foreground">{g.note}</span>
                {st && (
                  <span className="text-muted-foreground tabular-nums">
                    {formatUsd(st.remaining)} left
                  </span>
                )}
                <Button
                  variant="ghost"
                  size="icon-xs"
                  aria-label="Remove grant"
                  onClick={() => void api.removeGrant(g.id)}
                >
                  <Trash2 />
                </Button>
              </div>
            )
          })}
          {grants.length === 0 && !adding && (
            <div className="px-3 pb-2 text-xs text-muted-foreground">
              No credits entered. There&apos;s no API for the balance, so add the grants you receive
              here.
            </div>
          )}
          {adding ? (
            <GrantForm accountId={a.id} onDone={() => setAdding(false)} />
          ) : (
            <div className="px-2 pb-2">
              <Button variant="ghost" size="xs" onClick={() => setAdding(true)}>
                <Plus /> Add credit grant
              </Button>
            </div>
          )}
        </div>
      )}
    </div>
  )
}

export function AccountsSettings({
  update
}: {
  update: (p: Partial<AppSettings>) => Promise<void>
}) {
  const settings = useApp((s) => s.settings)
  const credits = useApp((s) => s.credits)
  const info = useApp((s) => s.info)
  const [adding, setAdding] = useState(false)
  const accounts = credits?.accounts ?? []
  const grants = (id: string): CreditGrant[] =>
    credits?.summaries.find((s) => s.accountId === id)?.grants ?? []
  return (
    <Section
      id="accounts"
      title="Accounts & API credits"
      description="Add API keys to run sessions on API credits and to track spending. Admin keys also pull your organization's usage and cost history from Anthropic."
    >
      {credits && !credits.encryptionAvailable && !info?.fixtures && (
        <div className="flex items-start gap-2 rounded-lg border border-warning/30 bg-warning-soft px-3 py-2.5 text-xs">
          <Lock className="mt-px size-3.5 shrink-0 text-warning" />
          Encryption isn&apos;t available on this system, so new keys can&apos;t be stored. Keys are
          never saved in plain text.
        </div>
      )}
      <div className="space-y-2">
        {accounts.map((a) => (
          <AccountCard key={a.id} a={a} grants={grants(a.id)} />
        ))}
      </div>
      <div>
        <Button variant="outline" size="sm" onClick={() => setAdding(true)}>
          <Plus /> Add API key…
        </Button>
      </div>
      <Row
        label="Default billing for launches"
        hint="Used by Resume, Fork and New session unless a project has its own default."
      >
        <BillingPicker
          align="end"
          value={settings.defaultBilling}
          onChange={(v) => void update({ defaultBilling: v })}
        />
      </Row>
      {Object.keys(settings.projectBilling).length > 0 && (
        <div className="rounded-lg border border-border px-3 py-2 text-xs">
          <div className="mb-1 text-2xs font-medium tracking-wide text-subtle-foreground uppercase">
            Project defaults
          </div>
          {Object.entries(settings.projectBilling).map(([project, b]) => (
            <div key={project} className="flex items-center gap-2 py-0.5">
              <span className="min-w-0 flex-1 truncate font-mono text-[11px] text-muted-foreground">
                {projectKeyLabel(project)}
              </span>
              <span>
                {b === 'subscription'
                  ? 'Subscription'
                  : (accounts.find((a) => a.id === b)?.nickname ?? 'Removed key')}
              </span>
              <Button
                variant="ghost"
                size="icon-xs"
                aria-label="Remove project default"
                onClick={() => {
                  const next = { ...settings.projectBilling }
                  delete next[project]
                  void update({ projectBilling: next })
                }}
              >
                <Trash2 />
              </Button>
            </div>
          ))}
        </div>
      )}
      {accounts.some((a) => a.kind === 'admin') && (
        <Row label="Refresh Admin reports" hint="Read-only calls to api.anthropic.com.">
          <Segmented
            ariaLabel="Refresh interval"
            value={String(settings.adminRefreshMinutes)}
            onChange={(v) => void update({ adminRefreshMinutes: Number(v) })}
            options={[
              { value: '0', label: 'Manually' },
              { value: '15', label: '15 min' },
              { value: '60', label: 'Hourly' },
              { value: '360', label: '6 h' }
            ]}
          />
        </Row>
      )}
      {adding && <AddKeyDialog onClose={() => setAdding(false)} />}
    </Section>
  )
}
