// Writes fixtures/git/repos.json: sample repos for fixtures mode
// (`npm run dev -- --fixtures`), so the Changes tab has something to show
// without running git. Sample data only (user "beau", example.com).
// Run: node scripts/make-git-fixtures.mjs

import { createHash } from 'node:crypto'
import { mkdirSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const sha = (s) => createHash('sha1').update(`csd-fixture:${s}`).digest('hex')
const A = Object.fromEntries(
  ['a1', 'a2', 'a3', 'a4', 'a5', 'o1', 'o2', 's1', 's2'].map((k) => [k, sha(k)])
)
const email = 'beau@example.com'
const BT = '`'

function patch(files) {
  return files
    .map(([path, kind, hunk]) => {
      const head =
        kind === 'add'
          ? `diff --git a/${path} b/${path}\nnew file mode 100644\nindex 0000000..1111111\n--- /dev/null\n+++ b/${path}\n`
          : `diff --git a/${path} b/${path}\nindex 1111111..2222222 100644\n--- a/${path}\n+++ b/${path}\n`
      return head + hunk
    })
    .join('')
}

const lines = (...l) => l.join('\n') + '\n'

const data = {
  repos: [
    {
      env: 'windows',
      root: 'C:\\Users\\beau\\code\\acme-web',
      remote: 'https://github.com/beau/acme-web.git',
      userEmail: email,
      refs: [
        { ref: 'refs/heads/main', sha: A.a5 },
        { ref: 'refs/remotes/origin/main', sha: A.a5 },
        { ref: 'refs/remotes/origin/HEAD', sha: A.a5, symref: 'refs/remotes/origin/main' },
        { ref: 'refs/heads/fix/login-redirect', sha: A.a3 }
      ],
      commits: [
        {
          sha: A.a1,
          parents: [],
          email,
          at: '2026-10-01T09:00:00Z',
          subject: 'Add session cookie helpers',
          files: [{ path: 'src/lib/auth/cookies.ts', add: 20, del: 0 }]
        },
        {
          sha: A.a2,
          parents: [A.a1],
          email,
          at: '2026-10-21T13:04:10Z',
          subject: 'Fix login redirect: SameSite=Lax session cookie',
          trailers: ['Co-Authored-By: Claude <noreply@anthropic.com>'],
          files: [{ path: 'src/lib/auth/cookies.ts', add: 3, del: 2 }]
        },
        {
          sha: A.a3,
          parents: [A.a2],
          email,
          at: '2026-10-21T13:05:30Z',
          subject: 'Add cookie tests',
          trailers: ['Co-Authored-By: Claude <noreply@anthropic.com>'],
          files: [{ path: 'src/lib/auth/cookies.test.ts', add: 11, del: 0 }]
        },
        {
          sha: A.a4,
          parents: [A.a1, A.a3],
          email,
          at: '2026-10-22T08:30:00Z',
          subject: 'Merge pull request #14 from beau/fix/login-redirect',
          files: []
        },
        {
          sha: A.a5,
          parents: [A.a4],
          email,
          at: '2026-10-22T08:45:00Z',
          subject: 'Bump version to 3.4.1',
          files: [{ path: 'package.json', add: 1, del: 1 }]
        }
      ],
      patches: {
        [A.a2]: patch([
          [
            'src/lib/auth/cookies.ts',
            'mod',
            lines(
              '@@ -8,9 +8,10 @@ export function setSessionCookie(token: string) {',
              '   cookies().set(SESSION_COOKIE, token, {',
              '     httpOnly: true,',
              '     secure: true,',
              "-    sameSite: 'none',",
              "-    domain: '.acme.dev',",
              '+    // Lax keeps the cookie on the redirect back from the identity provider.',
              "+    sameSite: 'lax',",
              "     path: '/',",
              '+    maxAge: 60 * 60 * 24 * 7',
              '   })',
              ' }'
            )
          ]
        ]),
        [A.a3]: patch([
          [
            'src/lib/auth/cookies.test.ts',
            'add',
            lines(
              '@@ -0,0 +1,11 @@',
              "+import { describe, it, expect, vi } from 'vitest'",
              "+import { setSessionCookie } from './cookies'",
              '+',
              "+describe('setSessionCookie', () => {",
              "+  it('uses SameSite=Lax so the redirect keeps the session', () => {",
              '+    const set = vi.fn()',
              "+    vi.mock('next/headers', () => ({ cookies: () => ({ set }) }))",
              "+    setSessionCookie('t0ken')",
              "+    expect(set).toHaveBeenCalledWith('session_token', 't0ken', expect.objectContaining({ sameSite: 'lax' }))",
              '+  })',
              '+})'
            )
          ]
        ]),
        [A.a5]: patch([
          [
            'package.json',
            'mod',
            lines(
              '@@ -1,6 +1,6 @@',
              ' {',
              '   "name": "acme-web",',
              '-  "version": "3.4.0",',
              '+  "version": "3.4.1",',
              '   "private": true,',
              '   "scripts": {'
            )
          ]
        ])
      }
    },
    {
      env: 'wsl:Ubuntu',
      root: '/home/beau/projects/orders-api',
      remote: 'git@github.com:beau/orders-api.git',
      userEmail: email,
      refs: [
        { ref: 'refs/heads/main', sha: A.o1 },
        { ref: 'refs/remotes/origin/main', sha: A.o1 },
        { ref: 'refs/remotes/origin/HEAD', sha: A.o1, symref: 'refs/remotes/origin/main' },
        { ref: 'refs/heads/feature/pagination', sha: A.o2 },
        { ref: 'refs/remotes/origin/feature/pagination', sha: A.o2 }
      ],
      commits: [
        {
          sha: A.o1,
          parents: [],
          email,
          at: '2026-10-10T10:00:00Z',
          subject: 'Orders API: list and get',
          files: [{ path: 'internal/http/orders.go', add: 80, del: 0 }]
        },
        {
          sha: A.o2,
          parents: [A.o1],
          email,
          at: '2026-10-20T15:31:45Z',
          subject: 'Cursor pagination for GET /orders',
          files: [
            { path: 'internal/http/orders.go', add: 7, del: 6 },
            { path: 'internal/http/cursor.go', add: 13, del: 0 },
            { path: 'api/openapi.yaml', add: 2, del: 1 }
          ]
        }
      ],
      patches: {
        [A.o2]: patch([
          [
            'internal/http/orders.go',
            'mod',
            lines(
              '@@ -10,12 +10,13 @@ func (h *Handler) ListOrders(w http.ResponseWriter, r *http.Request) {',
              '-\tpage, _ := strconv.Atoi(r.URL.Query().Get("page"))',
              '-\tif page < 1 {',
              '-\t\tpage = 1',
              '-\t}',
              '-\torders, err := h.store.ListOrders(r.Context(), (page-1)*50, 50)',
              '+\tcursor, err := decodeCursor(r.URL.Query().Get("cursor"))',
              '+\tif err != nil {',
              '+\t\thttp.Error(w, "bad cursor", http.StatusBadRequest)',
              '+\t\treturn',
              '+\t}',
              '+\torders, next, err := h.listOrdersByCursor(r.Context(), cursor, 50)',
              ' \tif err != nil {',
              ' \t\thttp.Error(w, err.Error(), http.StatusInternalServerError)',
              ' \t\treturn',
              ' \t}',
              '-\twriteJSON(w, orders)',
              '+\twriteJSON(w, listResponse{Orders: orders, NextCursor: encodeCursor(next)})',
              ' }'
            )
          ],
          [
            'internal/http/cursor.go',
            'add',
            lines(
              '@@ -0,0 +1,13 @@',
              '+package http',
              '+',
              '+import (',
              '+\t"encoding/base64"',
              '+\t"encoding/json"',
              '+\t"time"',
              '+)',
              '+',
              '+// cursor marks where the next page starts: (created_at, id) of the last order.',
              '+type cursor struct {',
              `+\tCreatedAt time.Time ${BT}json:"t"${BT}`,
              `+\tID        int64     ${BT}json:"id"${BT}`,
              '+}'
            )
          ],
          [
            'api/openapi.yaml',
            'mod',
            lines(
              '@@ -41,6 +41,7 @@ paths:',
              '       parameters:',
              '-        - name: page',
              '+        - name: cursor',
              '           in: query',
              '           schema:',
              '             type: string',
              '+          description: Opaque cursor from next_cursor of the previous page.'
            )
          ]
        ])
      }
    },
    {
      env: 'windows',
      root: 'C:\\Users\\beau\\code\\shop api',
      remote: 'https://example.com/beau/shop-api.git',
      userEmail: email,
      refs: [
        { ref: 'refs/heads/main', sha: A.s1 },
        { ref: 'refs/heads/fix/checkout-totals', sha: A.s2 }
      ],
      commits: [
        {
          sha: A.s1,
          parents: [],
          email,
          at: '2026-10-01T12:00:00Z',
          subject: 'Checkout totals',
          files: [{ path: 'src/checkout/total.ts', add: 40, del: 0 }]
        },
        {
          sha: A.s2,
          parents: [A.s1],
          email,
          at: '2026-10-20T14:16:30Z',
          subject: 'Round the discount before the total',
          files: [
            { path: 'src/checkout/total.ts', add: 2, del: 1 },
            { path: 'tests/checkout.test.ts', add: 4, del: 0 }
          ]
        }
      ],
      patches: {
        [A.s2]: patch([
          [
            'src/checkout/total.ts',
            'mod',
            lines(
              '@@ -12,4 +12,5 @@ export function total(subtotal: number, coupon: number): number {',
              '-  const discounted = round(subtotal - coupon)',
              '+  // Round the discount on its own first, like the receipt does.',
              '+  const discounted = subtotal - round(coupon)',
              '   return round(discounted * (1 + TAX_RATE))',
              ' }'
            )
          ],
          [
            'tests/checkout.test.ts',
            'mod',
            lines(
              "@@ -20,3 +20,7 @@ describe('total', () => {",
              '     expect(total(10, 0)).toBe(10.83)',
              '   })',
              '+',
              "+  it('rounds the discount before the total', () => {",
              '+    expect(total(21.66, 1.666)).toBe(19.99)',
              '+  })',
              ' })'
            )
          ]
        ])
      }
    }
  ],
  gh: {
    auth: 'ok',
    prs: {
      'beau/orders-api': [
        {
          number: 22,
          title: 'Cursor pagination for /orders',
          url: 'https://github.com/beau/orders-api/pull/22',
          state: 'OPEN',
          isDraft: false,
          headRefName: 'feature/pagination'
        }
      ],
      'beau/acme-web': [
        {
          number: 14,
          title: 'Fix login redirect on Safari',
          url: 'https://github.com/beau/acme-web/pull/14',
          state: 'MERGED',
          isDraft: false,
          headRefName: 'fix/login-redirect'
        }
      ]
    }
  }
}

mkdirSync(join(root, 'fixtures', 'git'), { recursive: true })
writeFileSync(join(root, 'fixtures', 'git', 'repos.json'), JSON.stringify(data, null, 2) + '\n')
console.log('wrote fixtures/git/repos.json')
