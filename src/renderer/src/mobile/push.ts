// Push alerts on this phone: its state, and turning them on (from a tap).

import { useEffect, useState } from 'react'
import { toast } from 'sonner'
import { phone } from '@/lib/web-api'

export type PushState = Awaited<ReturnType<typeof phone.pushState>>

export function usePushState(): [PushState | null, () => void] {
  const [s, setS] = useState<PushState | null>(null)
  const reload = (): void => {
    void phone
      .pushState()
      .then(setS)
      .catch(() => setS('unsupported'))
  }
  useEffect(reload, [])
  return [s, reload]
}

export async function turnPushOn(reload: () => void): Promise<void> {
  const r = await phone.enablePush()
  reload()
  if (r.ok)
    toast.success('Push alerts on', {
      description: 'This phone gets alerts even when the app is closed.'
    })
  else toast.error("Couldn't turn push alerts on", { description: r.error })
}
