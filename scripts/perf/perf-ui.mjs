/* global window, document, requestAnimationFrame */
// Real-data UI timing of the built app (out/). Prints numbers only (no titles, paths).
// Usage: node perf-ui.mjs <repo> <outDir> [--fixtures]
import { createRequire } from 'node:module'
import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'

const [repo, outDir] = process.argv.slice(2)
const fixtures = process.argv.includes('--fixtures')
const viewerOnly = process.env.CSD_PERF_ONLY === 'viewer'
const require = createRequire(join(repo, 'package.json'))
const { _electron: electron } = require('playwright')
const electronPath = require('electron')
mkdirSync(outDir, { recursive: true })

const results = { steps: [], ipc: [], memory: {}, startup: {}, timingLog: [] }
const log = (...a) => console.log(...a)

const t0 = Date.now()
const app = await electron.launch({
  executablePath: electronPath,
  args: [repo, ...(fixtures ? ['--fixtures'] : [])],
  env: {
    ...process.env,
    CSD_TIMING: '1',
    CSD_TIMING_LOOP_MS: '1800000',
    ...(fixtures ? { CSD_FIXTURES: '1' } : {})
  },
  timeout: 120_000
})
app.process().stdout.on('data', (b) => {
  for (const line of String(b).split(/\r?\n/))
    if (line.startsWith('[timing]')) results.timingLog.push({ at: Date.now() - t0, line })
})
const win = await app.firstWindow()
results.startup.firstWindowMs = Date.now() - t0
await win.waitForSelector('[role="option"]', { timeout: 120_000 })
results.startup.sessionListMs = Date.now() - t0
log('startup', results.startup)

// Long tasks (buffered: since the page loaded).
await win.evaluate(() => {
  window.__lt = []
  new PerformanceObserver((l) => {
    for (const e of l.getEntries()) window.__lt.push([e.startTime, e.duration])
  }).observe({ type: 'longtask', buffered: true })
})
await win.waitForTimeout(500)
results.startup.longTasks = await win.evaluate(() =>
  window.__lt.map(([s, d]) => [Math.round(s), Math.round(d)])
)

const heapCdp = await win.context().newCDPSession(win)
const heap = async () => Math.round((await heapCdp.send('Runtime.getHeapUsage')).usedSize / 1048576)
const metrics = async (label) => {
  const m = await app.evaluate(({ app }) => app.getAppMetrics())
  const by = {}
  let total = 0
  for (const p of m) {
    const ws = Math.round((p.memory.workingSetSize ?? 0) / 1024)
    const pb = Math.round((p.memory.privateBytes ?? 0) / 1024)
    by[p.type] = by[p.type] ?? { ws: 0, priv: 0, n: 0 }
    by[p.type].ws += ws
    by[p.type].priv += pb
    by[p.type].n++
    total += ws
  }
  const js = await heap()
  await heapCdp.send('HeapProfiler.collectGarbage')
  const jsAfterGc = await heap()
  const mb = (x) => Math.round(x / 1048576)
  const mainMem = await app.evaluate(async () => {
    const m = () => process.memoryUsage()
    const before = m()
    let after
    try {
      const v8 = process.getBuiltinModule('node:v8')
      const vm = process.getBuiltinModule('node:vm')
      v8.setFlagsFromString('--expose-gc')
      const gc = vm.runInNewContext('gc')
      gc()
      after = m()
    } catch {
      after = undefined
    }
    return { before, after }
  })
  const mainHeap = mb(mainMem.before.heapUsed)
  results.mainMem = results.mainMem ?? {}
  results.mainMem[label] = {
    rss: mb(mainMem.before.rss),
    heap: mb(mainMem.before.heapUsed),
    heapTotal: mb(mainMem.before.heapTotal),
    external: mb(mainMem.before.external),
    arrayBuffers: mb(mainMem.before.arrayBuffers),
    heapAfterGc: mainMem.after ? mb(mainMem.after.heapUsed) : undefined,
    rssAfterGc: mainMem.after ? mb(mainMem.after.rss) : undefined
  }
  console.log('main memory', label, JSON.stringify(results.mainMem[label]))
  console.log(
    'by process',
    label,
    JSON.stringify(
      Object.fromEntries(
        Object.entries(by).map(([k, v]) => [k, `${v.ws} MB ws / ${v.priv} MB private (${v.n})`])
      )
    )
  )
  results.memory[label] = {
    workingSetMB: total,
    byType: by,
    rendererHeapMB: js,
    rendererHeapAfterGcMB: jsAfterGc,
    mainHeapMB: mainHeap
  }
  log(
    'memory',
    label,
    `working set ${total} MB, renderer heap ${js} MB (${jsAfterGc} after GC), main heap ${mainHeap} MB`
  )
}

// Idle: let the startup scan settle.
log('idle 30 s…')
if (viewerOnly) log('viewer only')
const idleFrom = await win.evaluate(() => performance.now())
await win.waitForTimeout(30_000)
results.startup.idleLongTasks = await win.evaluate(
  (from) =>
    window.__lt.filter(([s]) => s >= from).map(([s, d]) => [Math.round(s - from), Math.round(d)]),
  idleFrom
)
await metrics('idle (sessions list)')

/** Wait until the view settled: no skeletons, then 400 ms without a long task. */
const settle = (from) =>
  win.evaluate(async (from) => {
    const frame = () => new Promise((r) => requestAnimationFrame(() => r()))
    const root = () => document.querySelector('[data-nav-scroll="main"]') ?? document.body
    let firstPaint
    const deadline = performance.now() + 60_000
    while (performance.now() < deadline) {
      await frame()
      if (firstPaint === undefined && root()) firstPaint = performance.now()
      if (!root().querySelector('.animate-pulse')) break
    }
    const ready = performance.now()
    // Quiet: 400 ms without a long task starting.
    while (performance.now() < deadline) {
      await new Promise((r) => setTimeout(r, 100))
      const last = window.__lt.length ? window.__lt[window.__lt.length - 1] : undefined
      const lastEnd = last ? last[0] + last[1] : 0
      if (performance.now() - Math.max(lastEnd, ready) >= 400) break
    }
    const lts = window.__lt.filter(([s]) => s >= from)
    const lastEnd = lts.length ? Math.max(...lts.map(([s, d]) => s + d)) : ready
    const r = root()
    return {
      firstPaintMs: Math.round(firstPaint - from),
      readyMs: Math.round(ready - from),
      interactiveMs: Math.round(Math.max(ready, lastEnd) - from),
      longTasks: lts.length,
      maxLongTaskMs: Math.round(Math.max(0, ...lts.map(([, d]) => d))),
      longTaskTotalMs: Math.round(lts.reduce((a, [, d]) => a + d, 0)),
      domNodes: r.getElementsByTagName('*').length,
      svgShapes: r.querySelectorAll('svg path, svg rect, svg circle, svg line').length,
      charts: r.querySelectorAll('.recharts-surface').length
    }
  }, from)

const step = async (name, action) => {
  const from = await win.evaluate(() => performance.now())
  await action()
  const r = await settle(from)
  results.steps.push({ name, ...r })
  log(
    `${name.padEnd(36)} paint ${String(r.firstPaintMs).padStart(5)}  ready ${String(r.readyMs).padStart(5)}  interactive ${String(r.interactiveMs).padStart(5)} ms | long tasks ${r.longTasks} (max ${r.maxLongTaskMs}, total ${r.longTaskTotalMs}) | dom ${r.domNodes} svg ${r.svgShapes} charts ${r.charts}`
  )
  return r
}

const viewIs = (v) => win.evaluate((v) => !!document.querySelector(`[data-scroll="${v}"]`), v)
const toSessions = async () => {
  if (await viewIs('usage')) await win.keyboard.press('Control+u')
  await win.waitForSelector('[role="option"]')
  await win.waitForTimeout(300)
}
const scopeItem = (label) =>
  win.locator('[aria-label="Show sessions of"] [role="radio"]', { hasText: label })
const initialScope = await win
  .locator('[aria-label="Show sessions of"] [role="radio"][data-state="on"]')
  .innerText()
  .catch(() => undefined)
results.initialScope = initialScope

const usageTabs = async (scope) => {
  for (const tab of ['Trends', 'Limit history', 'Credits', 'Raw table']) {
    const loc = win.locator('[role="tab"]', { hasText: tab })
    if (!(await loc.count())) continue
    await step(`${scope}: tab ${tab}`, () => loc.first().click())
  }
  await step(`${scope}: tab Trends again`, () =>
    win.locator('[role="tab"]', { hasText: 'Trends' }).first().click()
  )
  if (scope !== 'Codex') {
    const byVersion = win.locator('[aria-label="Group trends by"] [role="radio"]', {
      hasText: 'By version'
    })
    if (await byVersion.count()) await step(`${scope}: trends by version`, () => byVersion.click())
    const byModel = win.locator('[aria-label="Group trends by"] [role="radio"]', {
      hasText: 'By model'
    })
    if (await byModel.count()) await step(`${scope}: trends by model`, () => byModel.click())
  }
  const openRange = async () => {
    await win
      .locator('button[aria-haspopup="menu"]', {
        hasText:
          /(Today|This week|This month|Last 7 days|Last 30 days|Last 90 days|Last 12 months|All time|Custom range)/
      })
      .first()
      .click()
    await win.waitForSelector('[role="menuitemradio"]')
    await win.waitForTimeout(150)
  }
  for (const r of ['Last 7 days', 'Last 90 days', 'Last 12 months', 'All time', 'Last 30 days']) {
    await openRange()
    await step(`${scope}: range ${r}`, () =>
      win.locator('[role="menuitemradio"]', { hasText: r }).first().click()
    )
  }
  for (const p of ['Week', 'Month', 'Day'])
    await step(`${scope}: period ${p}`, () =>
      win.locator('[aria-label="Group by"] [role="radio"]', { hasText: p }).first().click()
    )
}

// Everything but the viewer (CSD_PERF_ONLY=viewer skips it).
if (!viewerOnly) {
  for (const scope of ['Claude', 'Codex', 'All']) {
    await toSessions()
    const item = scopeItem(scope)
    if (!(await item.count())) {
      log(`scope ${scope} not available`)
      continue
    }
    await item.first().click()
    await win.waitForTimeout(1500)
    await step(`${scope}: open Usage`, () => win.keyboard.press('Control+u'))
    if (scope === 'Claude') await metrics('on Usage (Claude Code)')
    await usageTabs(scope)
    await toSessions()
    await step(`${scope}: open Usage again (warm)`, () => win.keyboard.press('Control+u'))
    if (scope === 'All') await metrics('on Usage (All)')
  }

  // IPC: time and size of each call, from the renderer.
  const ipc = await win.evaluate(async () => {
    const out = []
    const sod = (x) => {
      const d = new Date(x)
      d.setHours(0, 0, 0, 0)
      return d.getTime()
    }
    const DAY = 86_400_000
    const calls = {
      'usage:report claude 30d/day': () =>
        window.csd.getUsageReport({
          from: sod(Date.now() - 29 * DAY),
          period: 'day',
          groupBy: 'model'
        }),
      'usage:report all 30d/day': () =>
        window.csd.getUsageReport({
          from: sod(Date.now() - 29 * DAY),
          period: 'day',
          groupBy: 'model',
          provider: 'all'
        }),
      'usage:report claude all/day': () =>
        window.csd.getUsageReport({ period: 'day', groupBy: 'model' }),
      'usage:report codex 30d/day': () =>
        window.csd.getUsageReport({
          from: sod(Date.now() - 29 * DAY),
          period: 'day',
          groupBy: 'model',
          provider: 'codex'
        }),
      'limits:state': () => window.csd.getLimits(),
      'codexLimits:state': () => window.csd.getCodexLimits(),
      'usage:trends model': () => window.csd.getTrends('model'),
      'usage:codexTrends model': () => window.csd.getCodexTrends('model'),
      'usage:speedTrends': () => window.csd.getSpeedTrends(),
      'usage:speedSignal claude': () => window.csd.getSpeedSignal('claude'),
      credits: () => window.csd.getCredits(),
      'sessions:list': () => window.csd.getSessions()
    }
    for (const [name, fn] of Object.entries(calls)) {
      const xs = []
      let size = 0
      for (let i = 0; i < 3; i++) {
        const t = performance.now()
        const r = await fn()
        xs.push(performance.now() - t)
        if (i === 0) size = JSON.stringify(r)?.length ?? 0
      }
      xs.sort((a, b) => a - b)
      out.push({
        name,
        firstMs: Math.round(xs[0]),
        medianMs: Math.round(xs[1]),
        kb: Math.round(size / 1024)
      })
    }
    return out
  })
  results.ipc = ipc
  for (const r of ipc) log('ipc', JSON.stringify(r))

  // Renderer CPU profile of opening Usage (Claude Code).
  await toSessions()
  await scopeItem('Claude').first().click()
  await win.waitForTimeout(1500)
  const cdp = await win.context().newCDPSession(win)
  await cdp.send('Profiler.enable')
  await cdp.send('Profiler.setSamplingInterval', { interval: 200 })
  await cdp.send('Profiler.start')
  await step('Claude Code: open Usage (profiled)', () => win.keyboard.press('Control+u'))
  await win.locator('button[aria-haspopup="menu"]', { hasText: 'Last 30 days' }).first().click()
  await win.waitForSelector('[role="menuitemradio"]')
  await step('Claude Code: range All time (profiled)', async () => {
    await win.locator('[role="menuitemradio"]', { hasText: 'All time' }).first().click()
  })
  const { profile } = await cdp.send('Profiler.stop')
  writeFileSync(join(outDir, 'renderer-usage-open.cpuprofile'), JSON.stringify(profile))
  {
    const byId = new Map(profile.nodes.map((n) => [n.id, n]))
    const self = new Map()
    let total = 0
    for (let i = 0; i < profile.samples.length; i++) {
      const n = byId.get(profile.samples[i])
      const f = n.callFrame
      if (f.functionName === '(idle)') continue
      const name = `${f.functionName || '(anon)'} ${f.url.split('/').pop()}:${f.lineNumber + 1}`
      const us = profile.timeDeltas[i] ?? 0
      self.set(name, (self.get(name) ?? 0) + us)
      total += us
    }
    results.rendererProfile = {
      totalMs: Math.round(total / 1000),
      top: [...self]
        .sort((a, b) => b[1] - a[1])
        .slice(0, 25)
        .map(([n, us]) => [n, Math.round(us / 1000)])
    }
    log('renderer profile (non-idle)', results.rendererProfile.totalMs, 'ms')
    for (const [n, ms] of results.rendererProfile.top) log(`  ${String(ms).padStart(5)} ms  ${n}`)
  }

  // A background rescan (F5) while Usage is open: long tasks for 25 s.
  {
    const from = await win.evaluate(() => performance.now())
    const logFrom = results.timingLog.length
    await win.keyboard.press('F5')
    await win.waitForTimeout(25_000)
    const lts = await win.evaluate(
      (from) => window.__lt.filter(([s]) => s >= from).map(([, d]) => Math.round(d)),
      from
    )
    results.rescan = {
      longTasks: lts.length,
      maxMs: Math.max(0, ...lts),
      totalMs: lts.reduce((a, b) => a + b, 0),
      mainLog: results.timingLog.slice(logFrom).map((x) => x.line)
    }
    log(
      'rescan on Usage',
      JSON.stringify({ ...results.rescan, mainLog: results.rescan.mainLog.length })
    )
  }
}
// ------------------------------------------------------------------ viewer
// Which sessions: the biggest by file size, any with exactly 715 messages, and
// a spread of medium ones (for the virtualization cut-off). Numbers only.
await toSessions()
if (await scopeItem('All').count()) {
  await scopeItem('All').first().click()
  await win.waitForTimeout(1500)
}
const picks = await win.evaluate(
  async (extra) => {
    const p = await window.csd.getSessions()
    const rows = (Array.isArray(p) ? p : p.sessions).filter((s) => s.messageCount > 0)
    const out = new Map()
    for (const s of [...rows].sort((a, b) => (b.sizeBytes ?? 0) - (a.sizeBytes ?? 0)).slice(0, 3))
      out.set(s.key, 'biggest')
    for (const s of rows.filter((s) => s.messageCount === 715)) out.set(s.key, '715 messages')
    for (const n of [4, 8, 12, 16, 20, 25, 30, 40, 50, 60, 80, 100, 150, 200, 300, ...extra]) {
      const s = rows
        .filter((s) => !out.has(s.key))
        .sort((a, b) => Math.abs(a.messageCount - n) - Math.abs(b.messageCount - n))[0]
      if (s) out.set(s.key, '~' + n + ' messages')
    }
    return [...out].map(([key, why]) => {
      const s = rows.find((r) => r.key === key)
      return {
        key,
        why,
        msgs: s.messageCount,
        mb: Math.round(((s.sizeBytes ?? 0) / 1048576) * 10) / 10
      }
    })
  },
  viewerOnly ? [6, 10, 14, 18, 22, 35, 45, 70, 120] : []
)
/** What the viewer is sent for a session: size by kind of content, and the time. */
const payload = (key) =>
  win.evaluate(async (key) => {
    const t = performance.now()
    const d = await window.csd.getSession(key, { cut: true })
    const ms = Math.round(performance.now() - t)
    const c = { text: 0, thinking: 0, toolInput: 0, toolOutput: 0, other: 0 }
    const n = { blocks: 0, text: 0, tools: 0, textLines: 0, fences: 0 }
    let inputsCut = 0
    for (const m of d?.messages ?? [])
      for (const b of m.blocks) {
        n.blocks++
        if (b.type === 'tool_use' || b.type === 'tool_result') n.tools++
        if (b.type === 'text') {
          n.text++
          n.textLines += b.text.split('\n').length
          n.fences += (b.text.match(/^```/gm) ?? []).length
        }
        if (b.type === 'text') c.text += b.text.length
        else if (b.type === 'thinking') c.thinking += b.text.length
        else if (b.type === 'tool_use') {
          c.toolInput += JSON.stringify(b.input ?? null).length
          c.toolOutput += b.result?.text.length ?? 0
          if (b.inputCut) inputsCut++
        } else if (b.type === 'tool_result') c.toolOutput += b.result.text.length
        else c.other += JSON.stringify(b).length
      }
    const kb = (x) => Math.round(x / 1024)
    return {
      ms,
      kb: kb(JSON.stringify(d)?.length ?? 0),
      messages: d?.messages.length ?? 0,
      inputsCut,
      counts: n,
      byKind: Object.fromEntries(Object.entries(c).map(([k, v]) => [k, kb(v)]))
    }
  }, key)
/** Scrolls the session list until the session's row is there (the list is virtualized). */
const showRow = (key) =>
  win.evaluate(async (id) => {
    const l = document.querySelector('[data-nav-scroll="list"]')
    if (!l) return false
    l.scrollTop = 0
    for (let i = 0; i < 5000; i++) {
      await new Promise((r) => requestAnimationFrame(() => r()))
      const el = document.getElementById(id)
      if (el) {
        el.scrollIntoView({ block: 'center' })
        return true
      }
      if (l.scrollTop + l.clientHeight >= l.scrollHeight - 2) return false
      l.scrollTop += Math.max(200, l.clientHeight * 0.8)
    }
    return false
  }, 'row-' + key)
results.viewer = []
results.calibration = []
// The viewer's own estimate (TypeScript with type-only imports: Node runs it as is).
const { groupTurns } = await import(
  pathToFileURL(join(repo, 'src/renderer/src/lib/transcript.ts')).href
)
const { estimateNodes, turnFeatures, NODE_WEIGHTS } = await import(
  pathToFileURL(join(repo, 'src/renderer/src/lib/dom-estimate.ts')).href
)
const { cutTranscript, CUT } = await import(
  pathToFileURL(join(repo, 'src/shared/transcript-cut.ts')).href
)
/** The size the viewer would be sent under other cut limits (only the big sessions). */
const POLICIES = {
  current: CUT,
  'in 40 lines/2000': { ...CUT, inLines: 40, inChars: 2000, inMin: 1000 },
  'in 24 lines/1500': { ...CUT, inLines: 24, inChars: 1500, inMin: 1000 },
  'in 24/1500, out 12/1500': {
    ...CUT,
    inLines: 24,
    inChars: 1500,
    inMin: 1000,
    outLines: 12,
    outChars: 1500,
    outMin: 1500
  },
  tight: { outLines: 1, outChars: 160, outMin: 160, inLines: 3, inChars: 200, inMin: 200 },
  'no bodies': { outLines: 0, outChars: 0, outMin: 0, inLines: 0, inChars: 0, inMin: 120 }
}
const policySizes = async (key) => {
  const full = await win.evaluate(
    async (key) => (await window.csd.getSession(key))?.messages ?? [],
    key
  )
  const kb = (v) => Math.round(JSON.stringify(v).length / 1024)
  const out = { full: kb(full) }
  for (const [name, limits] of Object.entries(POLICIES)) out[name] = kb(cutTranscript(full, limits))
  return out
}
/** Per drawn turn: its features and real node count; and the whole transcript's estimate. */
const estimateFor = async (key) => {
  const msgs = await win.evaluate(
    async (key) => (await window.csd.getSession(key, { cut: true }))?.messages ?? [],
    key
  )
  const turns = groupTurns(msgs)
  const actual = await win.evaluate(() =>
    Object.fromEntries(
      [...document.querySelectorAll('[data-msg-ids]')].map((el) => [
        el.getAttribute('data-msg-ids').split(' ')[0],
        el.getElementsByTagName('*').length + 1
      ])
    )
  )
  const rows = []
  for (const t of turns) {
    const id = t.kind === 'assistant' ? t.msgs[0].id : t.msg.id
    if (actual[id] !== undefined) rows.push({ ...turnFeatures(t), nodes: actual[id] })
  }
  const drawnActual = rows.reduce((a, r) => a + r.nodes, 0)
  let drawnEst = 0
  for (const t of turns) {
    const id = t.kind === 'assistant' ? t.msgs[0].id : t.msg.id
    if (actual[id] !== undefined) drawnEst += estimateNodes([t], Infinity, NODE_WEIGHTS)
  }
  return {
    rows,
    total: {
      turns: turns.length,
      estimate: Math.round(estimateNodes(turns)),
      drawnEstimate: Math.round(drawnEst),
      drawnActual
    }
  }
}
for (const [i, p] of picks.entries()) {
  const pay = await payload(p.key)
  await toSessions()
  if (!(await showRow(p.key))) {
    log('viewer: row not found', i + 1, p.why)
    results.viewer.push({ ...p, key: undefined, notFound: true, payload: pay })
    continue
  }
  await win.waitForTimeout(300)
  const row = win.locator('[id=' + JSON.stringify('row-' + p.key) + ']')
  const r = await step('viewer: ' + p.why + ' (' + p.msgs + ' msgs, ' + p.mb + ' MB)', () =>
    row.dispatchEvent('mousedown').then(() => row.click())
  )
  const drawn = await win.evaluate(() => ({
    turnsDrawn: document.querySelectorAll('[data-msg-ids]').length,
    virtual: !!document.querySelector('[data-index] [data-msg-ids]')
  }))
  // The DOM estimate (the viewer's own code) against the nodes each drawn turn has.
  const est = await estimateFor(p.key)
  results.viewer.push({
    why: p.why,
    msgs: p.msgs,
    mb: p.mb,
    payload: pay,
    ...drawn,
    ...est.total,
    ...r
  })
  log('  sent', JSON.stringify(pay), JSON.stringify(drawn), JSON.stringify(est.total))
  results.calibration.push(...est.rows)
  if (p.why === 'biggest' || p.why === '715 messages') {
    const sizes = await policySizes(p.key)
    results.viewer[results.viewer.length - 1].policyKb = sizes
    log('  KB by cut limits', JSON.stringify(sizes))
  }
}
await metrics('after the biggest sessions')
await step('list: scroll to bottom', () =>
  win.evaluate(() => {
    const l = document.querySelector('[data-nav-scroll="list"]')
    l?.scrollTo({ top: l.scrollHeight })
  })
)

// Restore the sidebar scope the app started with.
if (initialScope) {
  const it = scopeItem(initialScope.trim())
  if (await it.count()) await it.first().click()
}
await win.waitForTimeout(1000)
results.timingLog = results.timingLog.map((x) => `${x.at} ${x.line}`)
writeFileSync(join(outDir, 'perf-ui.json'), JSON.stringify(results, null, 1))
log('main-process timing lines:', results.timingLog.length)
for (const l of results.timingLog) log('  ', l)
await app.close()
