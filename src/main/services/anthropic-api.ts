// Phase 5, exception #2: read-only reporting calls to api.anthropic.com.
//
// Only two endpoints, only GET, only to https://api.anthropic.com, and only
// with an Admin API key the user added. No session content is ever sent.

const BASE = 'https://api.anthropic.com'
const ALLOWED = [
  '/v1/organizations/usage_report/messages',
  '/v1/organizations/cost_report'
] as const
export type ReportPath = (typeof ALLOWED)[number]

export type Fetcher = (
  url: string,
  init: { headers: Record<string, string>; signal?: AbortSignal }
) => Promise<{
  ok: boolean
  status: number
  json(): Promise<unknown>
  text(): Promise<string>
}>

export class ApiError extends Error {
  constructor(
    message: string,
    readonly status?: number
  ) {
    super(message)
  }
}

/** Build a report URL. Throws for anything that isn't an allowed endpoint on api.anthropic.com. */
export function reportUrl(path: ReportPath, params: [string, string][]): string {
  if (!ALLOWED.includes(path)) throw new ApiError(`Endpoint not allowed: ${path}`)
  const u = new URL(path, BASE)
  for (const [k, v] of params) u.searchParams.append(k, v)
  if (u.origin !== BASE || !ALLOWED.includes(u.pathname as ReportPath)) {
    throw new ApiError('Only api.anthropic.com reporting endpoints are allowed')
  }
  return u.toString()
}

/** Largest report page read (a month of daily buckets is far smaller). */
export const MAX_BODY_BYTES = 20 * 1024 * 1024

async function readBounded(body: ReadableStream<Uint8Array> | null, max: number): Promise<string> {
  if (!body) return ''
  const reader = body.getReader()
  const chunks: Uint8Array[] = []
  let size = 0
  for (;;) {
    const { done, value } = await reader.read()
    if (done) break
    size += value.byteLength
    if (size > max) {
      await reader.cancel().catch(() => undefined)
      throw new ApiError('The report was larger than expected, so it was not read.')
    }
    chunks.push(value)
  }
  return Buffer.concat(chunks).toString('utf8')
}

/**
 * The real fetcher (Node's fetch in the main process). Redirects are never
 * followed: the key travels in a header, and following one would send it to
 * wherever the redirect points. The body is read here, within the caller's
 * deadline, and only up to MAX_BODY_BYTES.
 */
export const httpsFetcher: Fetcher = async (url, init) => {
  const res = await fetch(url, { headers: init.headers, signal: init.signal, redirect: 'manual' })
  const text = await readBounded(res.body, MAX_BODY_BYTES)
  return {
    ok: res.ok,
    status: res.status,
    json: async () => JSON.parse(text) as unknown,
    text: async () => text
  }
}

function friendly(status: number, body: string): string {
  if (status >= 300 && status < 400)
    return `The API answered with a redirect (${status}), which the app doesn't follow.`
  if (status === 401) return 'The key was rejected (401). Check that it is an active Admin API key.'
  if (status === 403) return 'This key may not read usage reports (403). Admin API keys are needed.'
  if (status === 429) return 'Rate limited (429). The app will try again later.'
  const msg = /"message"\s*:\s*"([^"]{1,200})"/.exec(body)?.[1]
  return `Request failed (${status})${msg ? `: ${msg}` : ''}`
}

/**
 * GET every page of a report (follows `next_page`, at most `maxPages`). Each
 * page, body included, must arrive within `timeoutMs`; `signal` stops it all.
 */
export async function fetchReport(
  fetcher: Fetcher,
  key: string,
  path: ReportPath,
  params: [string, string][],
  opts: { userAgent: string; maxPages?: number; timeoutMs?: number; signal?: AbortSignal } = {
    userAgent: 'ClaudeSessionDashboard'
  }
): Promise<unknown[]> {
  const pages: unknown[] = []
  let page: string | undefined
  for (let i = 0; i < (opts.maxPages ?? 10); i++) {
    if (opts.signal?.aborted) throw new ApiError('Cancelled.')
    const url = reportUrl(path, page ? [...params, ['page', page]] : params)
    const ctrl = new AbortController()
    const timer = setTimeout(() => ctrl.abort(), opts.timeoutMs ?? 30_000)
    const signal = opts.signal ? AbortSignal.any([ctrl.signal, opts.signal]) : ctrl.signal
    // Settles when the deadline passes or the caller cancels, even if the
    // fetcher doesn't watch the signal while it reads the body.
    const stopped = new Promise<never>((_, reject) =>
      signal.addEventListener('abort', () => reject(new DOMException('Aborted', 'AbortError')), {
        once: true
      })
    )
    stopped.catch(() => undefined)
    let json: Record<string, unknown>
    try {
      const res = await Promise.race([
        fetcher(url, {
          headers: {
            'x-api-key': key,
            'anthropic-version': '2023-06-01',
            'user-agent': opts.userAgent
          },
          signal
        }),
        stopped
      ])
      if (!res.ok) {
        const body = await Promise.race([res.text().catch(() => ''), stopped])
        throw new ApiError(friendly(res.status, body), res.status)
      }
      json = (await Promise.race([res.json(), stopped])) as Record<string, unknown>
    } catch (err) {
      if (err instanceof ApiError) throw err
      throw new ApiError(
        (err as Error).name === 'AbortError'
          ? opts.signal?.aborted
            ? 'Cancelled.'
            : 'The request timed out.'
          : `Network error: ${(err as Error).message}`
      )
    } finally {
      clearTimeout(timer)
    }
    pages.push(json)
    if (json.has_more !== true || typeof json.next_page !== 'string') break
    page = json.next_page
  }
  return pages
}
