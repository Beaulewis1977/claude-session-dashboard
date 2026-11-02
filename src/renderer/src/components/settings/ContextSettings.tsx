// Settings → Context size: the large-session warning before Resume.

import {
  BAND_LIMITS,
  DEFAULT_CONTEXT_WARNING,
  MAX_THRESHOLD,
  MIN_THRESHOLD,
  type ContextWarningSettings
} from '@shared/context'
import { formatInt, formatTokens } from '@shared/format'
import type { AppSettings } from '@shared/types'
import { useApp } from '@/lib/store'
import { Switch } from '../ui/checkbox'
import { Row, Section } from '../SettingsView'
import { NumberField } from './SummariesSettings'

export function ContextSettings({
  update
}: {
  update: (patch: Partial<AppSettings>) => Promise<void>
}) {
  const cw = useApp((s) => s.settings.contextWarning) ?? DEFAULT_CONTEXT_WARNING
  const sessions = useApp((s) => s.sessions)
  const set = (patch: Partial<ContextWarningSettings>): Promise<void> =>
    update({ contextWarning: { ...cw, ...patch } })
  const above = sessions.filter(
    (s) => !s.meta.hidden && (s.context?.tokens ?? 0) >= cw.thresholdTokens
  ).length
  const bands = BAND_LIMITS.map((b, i) => {
    const from = i ? formatTokens(BAND_LIMITS[i - 1].below) : '0'
    return `${b.band} ${from}–${formatTokens(b.below)}`
  }).join(', ')

  return (
    <Section
      id="context"
      title="Context size"
      description={
        <>
          Each session shows how big its context is ({bands}, XL from{' '}
          {formatTokens(BAND_LIMITS[BAND_LIMITS.length - 1].below)} tokens). Resuming reloads all of
          it, which can use a big part of your 5-hour window.
        </>
      }
    >
      <Row
        label="Warn before resuming a large session"
        hint="Resume shows the size, an estimate of what reloading it would use, and offers Continue fresh or Fork. It never blocks: Resume anyway is one click. You can turn it off for single sessions in the warning."
      >
        <Switch
          checked={cw.enabled}
          onCheckedChange={(enabled) => void set({ enabled })}
          aria-label="Warn before resuming a large session"
        />
      </Row>
      <Row
        label="Warn from"
        hint={
          above > 0
            ? `${formatInt(above)} visible session${above === 1 ? ' is' : 's are'} at or above this size now.`
            : 'No visible session is this big right now.'
        }
      >
        <NumberField
          label="Warn from this many thousand tokens"
          value={Math.round(cw.thresholdTokens / 1000)}
          min={MIN_THRESHOLD / 1000}
          max={MAX_THRESHOLD / 1000}
          suffix="thousand tokens"
          onCommit={(k) => void set({ thresholdTokens: k * 1000 })}
        />
      </Row>
    </Section>
  )
}
