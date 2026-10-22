// Builds src/shared/usage/litellm-prices.json: the Claude rows of LiteLLM's
// model_prices_and_context_window.json (MIT, see THIRD_PARTY_NOTICES),
// converted to USD per million tokens. The app never fetches prices; run this
// by hand to refresh the bundled snapshot:
//
//   curl -o /tmp/litellm.json https://raw.githubusercontent.com/BerriAI/litellm/<commit>/model_prices_and_context_window.json
//   node scripts/make-price-snapshot.mjs /tmp/litellm.json <commit> <YYYY-MM-DD>

import { readFile, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const [file, commit, date] = process.argv.slice(2)
if (!file || !commit || !/^\d{4}-\d{2}-\d{2}$/.test(date ?? '')) {
  console.error('usage: node scripts/make-price-snapshot.mjs <litellm.json> <commit> <YYYY-MM-DD>')
  process.exit(1)
}
const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const data = JSON.parse(await readFile(file, 'utf8'))

const mtok = (v) =>
  typeof v === 'number' && Number.isFinite(v) ? Math.round(v * 1e6 * 1e6) / 1e6 : undefined

/** "anthropic.claude-opus-4-1-20250805-v1:0" → "claude-opus-4-1" */
function baseId(key) {
  return key
    .replace(/^anthropic\./, '')
    .replace(/-v\d+:\d+$/, '')
    .replace(/-\d{8}$/, '')
}

function row(id, v) {
  const input = mtok(v.input_cost_per_token)
  const output = mtok(v.output_cost_per_token)
  if (input === undefined || output === undefined) return undefined
  const r = {
    model: id,
    input,
    output,
    cacheWrite5m: mtok(v.cache_creation_input_token_cost) ?? Math.round(input * 1.25 * 1e6) / 1e6,
    cacheWrite1h: mtok(v.cache_creation_input_token_cost_above_1hr) ?? input * 2,
    cacheRead: mtok(v.cache_read_input_token_cost) ?? Math.round(input * 0.1 * 1e6) / 1e6
  }
  const fast = v.provider_specific_entry?.fast
  if (typeof fast === 'number' && fast > 1) r.fast = fast
  // Long-context tier (LiteLLM names it after its threshold).
  for (const k of Object.keys(v)) {
    const m = /^input_cost_per_token_above_(\d+)k_tokens$/.exec(k)
    if (!m) continue
    const t = `above_${m[1]}k_tokens`
    r.longContext = {
      above: Number(m[1]) * 1000,
      input: mtok(v[k]),
      output: mtok(v[`output_cost_per_token_${t}`]) ?? output,
      cacheWrite5m: mtok(v[`cache_creation_input_token_cost_${t}`]) ?? r.cacheWrite5m,
      cacheWrite1h: mtok(v[`cache_creation_input_token_cost_above_1hr_${t}`]) ?? mtok(v[k]) * 2,
      cacheRead: mtok(v[`cache_read_input_token_cost_${t}`]) ?? r.cacheRead
    }
  }
  return r
}

// Anthropic's own API rows first; Bedrock's global rows (same prices) only
// fill in older models that LiteLLM no longer lists under the direct API.
const rows = new Map()
const candidates = Object.entries(data).filter(([k]) => !k.includes('/'))
for (const [k, v] of candidates) {
  if (v?.litellm_provider !== 'anthropic' || !k.startsWith('claude-')) continue
  const r = row(baseId(k), v)
  if (r && !rows.has(r.model)) rows.set(r.model, r)
}
// Newest release first, so a stray old row doesn't win.
const released = (k) => /-(\d{8})-v\d+:\d+$/.exec(k)?.[1] ?? ''
const bedrock = candidates
  .filter(
    ([k, v]) => /^anthropic\.claude-/.test(k) && String(v?.litellm_provider).startsWith('bedrock')
  )
  .sort(([a], [b]) => released(b).localeCompare(released(a)))
for (const [k, v] of bedrock) {
  const id = baseId(k)
  // Only models Claude Code has used (skips Claude 2 / Instant and odd ids).
  if (!/^claude-(?:3-[57]-[a-z]+|(?:opus|sonnet|haiku)-\d(?:-\d)?)$/.test(id)) continue
  const r = row(id, v)
  if (r && !rows.has(r.model)) rows.set(r.model, { ...r, via: 'bedrock' })
}

const order = (id) => {
  const m = /claude-(?:(\d)-(\d)-)?([a-z]+)(?:-(\d+))?(?:-(\d))?/.exec(id) ?? []
  const fam = { fable: 0, mythos: 1, opus: 2, sonnet: 3, haiku: 4 }[m[3]] ?? 9
  const ver = m[1] ? Number(m[1]) + Number(m[2]) / 10 : Number(m[4] ?? 0) + Number(m[5] ?? 0) / 10
  return [fam, -ver, id]
}
const models = [...rows.values()].sort((a, b) => {
  const x = order(a.model)
  const y = order(b.model)
  return x[0] - y[0] || x[1] - y[1] || String(x[2]).localeCompare(String(y[2]))
})

const out = {
  source: 'https://github.com/BerriAI/litellm/blob/main/model_prices_and_context_window.json',
  commit,
  date,
  unit: 'USD per million tokens',
  models
}
const dest = join(root, 'src/shared/usage/litellm-prices.json')
await writeFile(dest, JSON.stringify(out, null, 2) + '\n')
console.log(`wrote ${models.length} models to ${dest}`)
