// What the main process sends to its windows and to the phone goes through
// toRenderer: as is, except in fixtures mode, where the checkout's paths are
// shown as the sample PC's (see fixtures-display.ts). No Electron imports, so
// the phone server can use it too.

let outgoing: (<T>(value: T) => T) | undefined

/** Set once at startup, in fixtures mode. */
export function setOutgoingFilter(filter: <T>(value: T) => T): void {
  outgoing = filter
}

/** `value` as a window or the phone gets it. */
export function toRenderer<T>(value: T): T {
  return outgoing ? outgoing(value) : value
}
