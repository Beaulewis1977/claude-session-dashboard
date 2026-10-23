// Every IPC handler is registered through `handle`, which only answers the
// app's own page in the top frame of one of its windows. A frame inside a
// page, or a page a window was somehow navigated to, can't call into the main
// process.

import { BrowserWindow, ipcMain, type IpcMainInvokeEvent } from 'electron'
import { isAppPage } from './core/app-url'

let page: { indexFile: string; devUrl?: string } | undefined

/** The renderer's index.html (and the dev server URL in development). Set once at startup. */
export function setAppPage(indexFile: string, devUrl: string | undefined): void {
  page = { indexFile, devUrl }
}

function trusted(e: IpcMainInvokeEvent): boolean {
  const frame = e.senderFrame
  return (
    !!page &&
    !!frame &&
    frame.parent === null &&
    !!BrowserWindow.fromWebContents(e.sender) &&
    isAppPage(frame.url, page.indexFile, page.devUrl)
  )
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Listener = (e: IpcMainInvokeEvent, ...args: any[]) => unknown

const listeners = new Map<string, Listener>()

export function handle(channel: string, listener: Listener): void {
  listeners.set(channel, listener)
  ipcMain.handle(channel, (e, ...args) => {
    if (!trusted(e)) throw new Error(`Refused ${channel}: not from the app's own page`)
    return listener(e, ...args)
  })
}

/**
 * Call a handler from inside the main process (the phone companion, which
 * only reaches the channels on its own allow-list; see mobile/rpc.ts).
 */
export async function callHandler(channel: string, args: unknown[]): Promise<unknown> {
  const l = listeners.get(channel)
  if (!l) throw new Error(`No handler for ${channel}`)
  return l({} as IpcMainInvokeEvent, ...args)
}
