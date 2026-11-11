// electron-builder afterPack hook: the packaged app.asar holds only the built
// app (out/main, out/preload, out/renderer), its package.json and the
// resources it reads (icon, status line bridge scripts). Anything else (a log
// or notes file left in out/, a node_modules folder, source maps) fails the
// build, before an installer is made. Tested in tests/check-asar.test.ts.

const { join } = require('node:path')

/** Paths in the asar (as `/a/b`) that are allowed: exact, or a folder and all inside it. */
const EXACT = new Set(['/package.json', '/out', '/resources', '/resources/icon.png'])
const TREES = ['/out/main', '/out/preload', '/out/renderer', '/resources/bridge']

/** Entries of an asar listing that shouldn't be in it. */
function unexpectedEntries(list) {
  const out = []
  for (const raw of list) {
    const p = `/${String(raw).replace(/\\/g, '/').replace(/^\/+/, '')}`
    const allowed =
      !p.endsWith('.map') && (EXACT.has(p) || TREES.some((t) => p === t || p.startsWith(`${t}/`)))
    if (!allowed) out.push(p)
  }
  return out
}

async function afterPack(context) {
  const asar = require('@electron/asar')
  const file = join(context.appOutDir, 'resources', 'app.asar')
  const extra = unexpectedEntries(asar.listPackage(file))
  if (extra.length)
    throw new Error(
      `app.asar holds files it shouldn't (only out/main, out/preload, out/renderer, ` +
        `package.json and resources/ may be packed):\n  ${extra.slice(0, 30).join('\n  ')}` +
        (extra.length > 30 ? `\n  … and ${extra.length - 30} more` : '')
    )
  console.log(`  • app.asar checked: only the built app (${file})`)
}

module.exports = afterPack
module.exports.default = afterPack
module.exports.unexpectedEntries = unexpectedEntries
