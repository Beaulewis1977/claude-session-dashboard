// IPC for "Ask across sessions" (see ask-sessions/service.ts).

import { BrowserWindow } from 'electron'
import { isAskEffort, isAskModel, type AskEffort, type AskModel } from '@shared/ask-sessions/types'
import { handle } from './ipc-guard'
import type { AskSessionsService } from './ask-sessions/service'

const text = (v: unknown, max: number, what = 'Type a question first.'): string => {
  if (typeof v !== 'string' || !v.trim()) throw new Error(what)
  return v.trim().slice(0, max)
}
const id = (v: unknown): string => {
  if (typeof v !== 'string' || !/^[0-9a-f]{16}$/.test(v)) throw new Error('Unknown question')
  return v
}
const sids = (v: unknown): string[] =>
  (Array.isArray(v) ? v : [])
    .filter((s): s is string => typeof s === 'string' && /^S\d{1,3}$/.test(s))
    .slice(0, 200)

export function registerAskSessionsIpc(ask: AskSessionsService): void {
  const send = (channel: string, payload?: unknown): void => {
    for (const w of BrowserWindow.getAllWindows())
      if (!w.isDestroyed()) w.webContents.send(channel, payload)
  }
  ask.on('changed', () => send('askSessions:changed'))
  ask.on('status', (s) => send('askSessions:status', s))

  handle('askSessions:status', () => ask.status())
  handle('askSessions:ask', (_e, q, opts) => {
    const o = (opts && typeof opts === 'object' ? opts : {}) as Record<string, unknown>
    return ask.ask(text(q, 1000), {
      ...(o.scope && typeof o.scope === 'object' ? { scope: o.scope as object } : {}),
      ...(o.content === true ? { content: true } : {}),
      ...(typeof o.phoneRequest === 'string' ? { phoneRequest: id(o.phoneRequest) } : {})
    })
  })
  handle('askSessions:prompt', (_e, p, keep) => ask.promptText(id(p), sids(keep)))
  handle('askSessions:estimate', (_e, p, keep, model) =>
    ask.estimate(id(p), sids(keep), isAskModel(model) ? model : 'sonnet')
  )
  handle('askSessions:send', (_e, p, opts) => {
    const o = (opts && typeof opts === 'object' ? opts : {}) as Record<string, unknown>
    if (!isAskModel(o.model) || !isAskEffort(o.effort)) throw new Error('Unknown model or effort level.')
    return ask.send(id(p), {
      keep: sids(o.keep),
      model: o.model as AskModel,
      effort: o.effort as AskEffort
    })
  })
  handle('askSessions:cancel', (_e, p) => ask.cancel(id(p)))
  handle('askSessions:history', () => ask.history())
  handle('askSessions:delete', (_e, i) => ask.delete(id(i)))
  handle('askSessions:rebuild', () => ask.rebuild())
  handle('askSessions:deleteIndex', () => ask.deleteIndex())
  handle('askSessions:pending', () => ask.pending())
  handle('askSessions:decline', (_e, i) => ask.decline(id(i)))
  // For the phone (through its allow-list): local answers, and how its own question is doing.
  handle('askSessions:phoneLocal', (_e, q) => ask.phoneLocal(text(q, 1000)))
  handle('askSessions:phoneStatus', (_e, i) => ask.requestStatus(id(i)) ?? null)
}
