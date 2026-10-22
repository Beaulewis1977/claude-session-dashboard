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

function friendly(status: number, body: string): string {
  if (status === 401) return 'The key was rejected (401). Check that it is an active Admin API key.'
  if (status === 403) return 'This key may not read usage reports (403). Admin API keys are needed.'
  if (status === 429) return 'Rate limited (429). The app will try again later.'
  const msg = /"message"\s*:\s*"([^"]{1,200})"/.exec(body)?.[1]
  return `Request failed (${status})${msg ? `: ${msg}` : ''}`
}

/** GET every page of a report (follows `next_page`, at most `maxPages`). */
export async function fetchReport(
  fetcher: Fetcher,
  key: string,
  path: ReportPath,
  params: [string, string][],
  opts: { userAgent: string; maxPages?: number; timeoutMs?: number } = {
    userAgent: 'ClaudeSessionDashboard'
  }
): Promise<unknown[]> {
  const pages: unknown[] = []
  let page: string | undefined
  for (let i = 0; i < (opts.maxPages ?? 10); i++) {
    const url = reportUrl(path, page ? [...params, ['page', page]] : params)
    const ctrl = new AbortController()
    const timer = setTimeout(() => ctrl.abort(), opts.timeoutMs ?? 30_000)
    let res
    try {
      res = await fetcher(url, {
        headers: {
          'x-api-key': key,
          'anthropic-version': '2023-06-01',
          'user-agent': opts.userAgent
        },
        signal: ctrl.signal
      })
    } catch (err) {
      throw new ApiError(
        (err as Error).name === 'AbortError'
          ? 'The request timed out.'
          : `Network error: ${(err as Error).message}`
      )
    } finally {
      clearTimeout(timer)
    }
    if (!res.ok)
      throw new ApiError(friendly(res.status, await res.text().catch(() => '')), res.status)
    const json = (await res.json()) as Record<string, unknown>
    pages.push(json)
    if (json.has_more !== true || typeof json.next_page !== 'string') break
    page = json.next_page
  }
  return pages
}
