// Browser test (Vite + Playwright, like names.browser.test.ts): the phone's
// session search follows the PC's data, not only the query.
// - A search made while the PC was still reading sessions is asked again when
//   they change (and so is one whose results changed with the git links).
// - Changes that keep coming don't postpone it, and with slow answers every
//   answer still shows (one refresh at a time).
// - A slow, older answer never replaces a newer one, nor does one that comes
//   after the search it was for is gone (unmounted).

import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import type { Browser, Page } from 'playwright'
import type { ViteDevServer } from 'vite'
import {
  launchBrowser,
  startHarness,
  trackPage,
  unavailableReason,
  waitReady
} from './browser-harness'

const virtualId = 'virtual:phone-search-browser'

const harness = `
import React from 'react'
import { createRoot } from 'react-dom/client'
import { useSearch } from '/src/renderer/src/mobile/search.ts'
import { useApp } from '/src/renderer/src/lib/store.ts'

// The PC: what its index finds now, and how long each answer takes.
window.found = []
window.delays = []
// For answers past the listed ones.
window.delay = 0
window.asked = 0
window.out = 0
window.maxOut = 0
window.csd = {
  search: (q) => {
    window.asked++
    const keys = window.found.slice()
    const delay = window.delays.length ? window.delays.shift() : window.delay
    window.out++
    window.maxOut = Math.max(window.maxOut, window.out)
    return new Promise((resolve) =>
      setTimeout(() => {
        window.out--
        resolve(keys.map((key) => ({ key, score: 1, fields: ['text'] })))
      }, delay)
    )
  }
}
window.sessionsChanged = () => useApp.setState({ sessions: useApp.getState().sessions.slice() })
window.hits = () => {
  const h = useApp.getState().hits
  return h ? [...h.keys()].sort() : null
}

function Search() {
  const [query, setQuery] = useSearch()
  window.setQuery = setQuery
  return React.createElement('div', { id: 'search' }, 'query: ' + query)
}

// A new mount of the search (the old one is gone).
function Page() {
  const [n, setN] = React.useState(0)
  window.remount = () => setN((x) => x + 1)
  return React.createElement(Search, { key: n })
}

useApp.setState({ sessions: [], loaded: true })
createRoot(document.getElementById('root')).render(React.createElement(Page))
`

let server: ViteDevServer | undefined
let browser: Browser | undefined
let origin: string

beforeAll(async () => {
  browser = await launchBrowser()
  if (!browser) return
  ;({ server, origin } = await startHarness({ virtualId, harness }))
  await (await open(60_000)).close()
}, 90_000)

afterAll(async () => {
  await browser?.close()
  await server?.close()
})

async function open(loadTimeout = 15_000): Promise<Page> {
  const page = trackPage(await browser!.newPage(), origin)
  page.setDefaultTimeout(loadTimeout)
  page.on('pageerror', (err) => console.error('[phone-search.browser]', err.message))
  await page.goto(`${origin}/`)
  await waitReady(page, page.locator('#search'))
  page.setDefaultTimeout(5_000)
  return page
}

type W = {
  found: string[]
  delays: number[]
  delay: number
  asked: number
  maxOut: number
  remount: () => void
  setQuery: (q: string) => void
  sessionsChanged: () => void
  hits: () => string[] | null
}
const run = <T>(page: Page, fn: (w: W) => T): Promise<T> =>
  page.evaluate(`(${fn.toString()})(window)`) as Promise<T>

describe('phone search', { timeout: 30_000 }, () => {
  it('a search made before the PC finished reading is asked again when sessions change', async ({
    skip
  }) => {
    if (!browser) skip(unavailableReason)
    const page = await open()
    try {
      await run(page, (w) => w.setQuery('login'))
      await expect.poll(() => run(page, (w) => w.hits())).toEqual([])
      // The PC has read the sessions (or worked out their git links): same query.
      await run(page, (w) => {
        w.found = ['a', 'b']
        w.sessionsChanged()
      })
      await expect.poll(() => run(page, (w) => w.hits())).toEqual(['a', 'b'])
    } finally {
      await page.close()
    }
  })

  it("changes that keep coming don't postpone it", async ({ skip }) => {
    if (!browser) skip(unavailableReason)
    const page = await open()
    try {
      await run(page, (w) => w.setQuery('login'))
      await expect.poll(() => run(page, (w) => w.hits())).toEqual([])
      await run(page, (w) => {
        w.found = ['c']
        const t = setInterval(() => w.sessionsChanged(), 100)
        setTimeout(() => clearInterval(t), 4000)
      })
      // Well before the changes stop.
      await expect.poll(() => run(page, (w) => w.hits()), { timeout: 2000 }).toEqual(['c'])
    } finally {
      await page.close()
    }
  })

  it('a slow, older answer never replaces a newer one', async ({ skip }) => {
    if (!browser) skip(unavailableReason)
    const page = await open()
    try {
      await run(page, (w) => {
        w.found = ['old']
        // The first answer takes 1.5 s; the later ones come at once.
        w.delays = [1500, 0, 0]
        w.setQuery('login')
      })
      await expect.poll(() => run(page, (w) => w.asked)).toBe(1)
      // Typed on and back: the same query asked again while the first is out.
      await run(page, (w) => w.setQuery('logi'))
      await expect.poll(() => run(page, (w) => w.asked)).toBe(2)
      await run(page, (w) => {
        w.found = ['new']
        w.setQuery('login')
      })
      await expect.poll(() => run(page, (w) => w.hits())).toEqual(['new'])
      await new Promise((r) => setTimeout(r, 1800))
      expect(await run(page, (w) => w.hits())).toEqual(['new'])
    } finally {
      await page.close()
    }
  })

  it('with slow answers and changes every 100 ms, every answer still shows', async ({ skip }) => {
    if (!browser) skip(unavailableReason)
    const page = await open()
    try {
      await run(page, (w) => {
        w.delay = 750
        w.setQuery('login')
      })
      await expect.poll(() => run(page, (w) => w.hits())).toEqual([])
      await run(page, (w) => {
        w.found = ['c']
        const t = setInterval(() => w.sessionsChanged(), 100)
        setTimeout(() => clearInterval(t), 10_000)
      })
      // While the changes go on.
      await expect.poll(() => run(page, (w) => w.hits()), { timeout: 4000 }).toEqual(['c'])
      await run(page, (w) => {
        w.found = ['d']
      })
      await expect.poll(() => run(page, (w) => w.hits()), { timeout: 4000 }).toEqual(['d'])
      // One refresh out at a time.
      expect(await run(page, (w) => w.maxOut)).toBe(1)
    } finally {
      await page.close()
    }
  })

  it('an answer that comes after its search is gone (unmounted) is dropped', async ({ skip }) => {
    if (!browser) skip(unavailableReason)
    const page = await open()
    try {
      await run(page, (w) => {
        w.found = ['old']
        w.delays = [1500]
        w.setQuery('login')
      })
      await expect.poll(() => run(page, (w) => w.asked)).toBe(1)
      // Left and opened again: the new search asks with the same query.
      await run(page, (w) => {
        w.found = ['new']
        w.remount()
      })
      await expect.poll(() => run(page, (w) => w.hits())).toEqual(['new'])
      await new Promise((r) => setTimeout(r, 1800))
      expect(await run(page, (w) => w.hits())).toEqual(['new'])
    } finally {
      await page.close()
    }
  })
})
