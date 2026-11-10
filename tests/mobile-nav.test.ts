// The phone's back gesture / button (src/renderer/src/mobile/nav-rules.ts): tabs, an
// open session and the Usage tabs are browser history entries; a session that
// no longer exists is skipped. Driven against a fake window.history.

import { describe, expect, it } from 'vitest'
import { startPhoneHistory, type PhoneNavState } from '../src/renderer/src/mobile/nav-rules'

/** A browser history stack: back() fires popstate with the entry's state, like a browser. */
class FakeHistory {
  stack: unknown[] = [null]
  private listeners = new Set<(state: unknown) => void>()
  onPopState = (cb: (state: unknown) => void): (() => void) => {
    this.listeners.add(cb)
    return () => this.listeners.delete(cb)
  }
  at = 0
  get state(): unknown {
    return this.stack[this.at]
  }
  pushState(data: unknown): void {
    this.stack = this.stack.slice(0, this.at + 1)
    this.stack.push(structuredClone(data))
    this.at++
  }
  replaceState(data: unknown): void {
    this.stack[this.at] = structuredClone(data)
  }
  go(n: number): void {
    const to = this.at + n
    if (to < 0 || to >= this.stack.length) return
    this.at = to
    for (const cb of [...this.listeners]) cb(this.state)
  }
  back(): void {
    this.go(-1)
  }
  forward(): void {
    this.go(1)
  }
}

function setup(sessions = ['a', 'b']) {
  const history = new FakeHistory()
  let state: PhoneNavState = { view: 'sessions', key: null, usageTab: 'trends' }
  const subs = new Set<() => void>()
  let t = 0
  const known = new Set(sessions)
  const loaded = { value: true }
  const nav = startPhoneHistory({
    history,
    onPopState: history.onPopState,
    get: () => state,
    apply: (s) => {
      state = { ...s }
      subs.forEach((cb) => cb())
    },
    subscribe: (cb) => {
      subs.add(cb)
      return () => subs.delete(cb)
    },
    exists: (k) => known.has(k),
    loaded: () => loaded.value,
    now: () => t
  })
  /** The app changing screens (a tap), `ms` after the last one. */
  const move = (patch: Partial<PhoneNavState>, ms = 1000): void => {
    t += ms
    state = { ...state, ...patch }
    subs.forEach((cb) => cb())
  }
  return { history, nav, move, known, loaded, get: () => state }
}

describe('phone history', () => {
  it('marks the first screen without adding an entry', () => {
    const { history } = setup()
    expect(history.stack).toHaveLength(1)
    expect(history.state).toMatchObject({ csdNav: { view: 'sessions', i: 0 } })
  })

  it('Back goes through tabs and an open session, Forward comes back', () => {
    const { history, move, get } = setup()
    move({ view: 'running' })
    move({ key: 'a' })
    expect(history.stack).toHaveLength(3)
    history.back()
    expect(get()).toMatchObject({ view: 'running', key: null })
    history.back()
    expect(get()).toMatchObject({ view: 'sessions', key: null })
    history.forward()
    history.forward()
    expect(get()).toMatchObject({ view: 'running', key: 'a' })
    // Restoring adds nothing.
    expect(history.stack).toHaveLength(3)
  })

  it('records Usage tabs, and quick taps through them are one entry', () => {
    const { history, move, get } = setup()
    move({ view: 'usage' })
    move({ usageTab: 'limits' })
    move({ usageTab: 'credits' }, 100)
    move({ usageTab: 'raw' }, 100)
    expect(history.stack).toHaveLength(3)
    history.back()
    expect(get()).toMatchObject({ view: 'usage', usageTab: 'trends' })
  })

  it('closing a session goes back in history (no new entry)', () => {
    const { history, nav, move, get } = setup()
    move({ view: 'running' })
    move({ key: 'b' })
    nav.close()
    expect(get()).toMatchObject({ view: 'running', key: null })
    expect(history.at).toBe(1)
  })

  it('closing a session with nothing behind it just closes it', () => {
    // A session open on the app's very first entry: Back would leave the app.
    const history = new FakeHistory()
    let closed: PhoneNavState | null = null
    const nav = startPhoneHistory({
      history,
      onPopState: history.onPopState,
      get: () => ({ view: 'sessions', key: 'a', usageTab: 'trends' }),
      apply: (st) => (closed = st),
      subscribe: () => () => undefined,
      exists: () => true,
      loaded: () => true
    })
    nav.close()
    expect(closed).toMatchObject({ view: 'sessions', key: null })
    expect(history.at).toBe(0)
  })

  it('going back skips a session that no longer exists', () => {
    const { history, move, known, get } = setup(['a', 'b'])
    move({ key: 'a' })
    move({ key: null })
    move({ key: 'b' })
    known.delete('a')
    history.back() // the list
    expect(get()).toMatchObject({ key: null })
    history.back() // session a: gone, skipped to the first screen
    expect(get()).toMatchObject({ view: 'sessions', key: null })
    expect(history.at).toBe(0)
  })

  it('going forward to a gone session shows its tab instead', () => {
    const { history, move, known, get } = setup(['a'])
    move({ view: 'running' })
    move({ key: 'a' })
    history.back()
    known.delete('a')
    history.forward()
    expect(get()).toMatchObject({ view: 'running', key: null })
    expect(history.state).toMatchObject({ csdNav: { key: null } })
  })

  it('ignores history entries that are not the app’s', () => {
    const { history, move, get } = setup()
    move({ view: 'settings' })
    history.stack.splice(1, 0, { something: 'else' })
    history.at = 2
    history.back()
    expect(get().view).toBe('settings')
  })

  it('before the session list has loaded, no session counts as gone', () => {
    // E.g. the PC answered slowly after a reload: the list is still empty.
    const { history, move, known, loaded, get } = setup(['a', 'b'])
    move({ key: 'a' })
    move({ key: null })
    move({ key: 'b' })
    loaded.value = false
    known.clear()
    history.back()
    history.back()
    // Session a's entry is kept (not skipped).
    expect(get()).toMatchObject({ key: 'a' })
    expect(history.at).toBe(1)
    history.forward()
    history.forward()
    // Session b's entry keeps its key (not replaced with null).
    expect(get()).toMatchObject({ key: 'b' })
    expect(history.state).toMatchObject({ csdNav: { key: 'b' } })
  })

  it('once loaded, an entry on a session that is gone shows its tab', () => {
    const { history, nav, move, known, loaded, get } = setup(['a'])
    move({ view: 'running' })
    move({ key: 'a' })
    loaded.value = false
    nav.checkLoaded()
    expect(get().key).toBe('a')
    known.delete('a')
    loaded.value = true
    nav.checkLoaded()
    expect(get()).toMatchObject({ view: 'running', key: null })
    expect(history.state).toMatchObject({ csdNav: { view: 'running', key: null } })
    expect(history.stack).toHaveLength(3)
  })
})
