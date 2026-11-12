// The Settings menu's amber dots, gathered while Settings is open (the rules
// are in shared/settings-attention.ts).

import { useEffect, useState } from 'react'
import type { SectionId } from '@shared/settings-registry'
import type { BackupStatus } from '@shared/backup'
import type { MobileStatus } from '@shared/mobile'
import { settingsAttention, type Attention } from '@shared/settings-attention'
import { now } from '@shared/clock'
import { api } from './api'
import { useApp } from './store'

export type { Attention }

/** The attention list for the open Settings page (backup and phone status are fetched). */
export function useSettingsAttention(active: boolean): Partial<Record<SectionId, Attention[]>> {
  const sources = useApp((s) => s.sources)
  const live = useApp((s) => s.live)
  const limits = useApp((s) => s.limits)
  const credits = useApp((s) => s.credits)
  const [backup, setBackup] = useState<BackupStatus | null>(null)
  const [mobile, setMobile] = useState<MobileStatus | null>(null)

  useEffect(() => {
    if (!active || api.remote) return
    let alive = true
    const loadBackup = (): void =>
      void api
        .backupStatus?.()
        .then((s) => alive && setBackup(s))
        .catch(() => undefined)
    const loadMobile = (): void =>
      void api
        .mobileStatus?.()
        .then((s) => alive && setMobile(s))
        .catch(() => undefined)
    loadBackup()
    loadMobile()
    const offs = [api.onBackupChanged?.(loadBackup), api.onMobileChanged?.(loadMobile)]
    return () => {
      alive = false
      for (const off of offs) off?.()
    }
  }, [active])

  return settingsAttention({
    now: now(),
    sources,
    hooks: live?.hooks,
    limits,
    backup,
    mobile,
    accounts: credits?.accounts
  })
}
