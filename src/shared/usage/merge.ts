// Two time-sorted lists as one, without copying and sorting them again.

/** Every item has a time no earlier than the one before (NaN is never in order). */
function inOrder(xs: readonly { ts: number }[]): boolean {
  for (let i = 1; i < xs.length; i++) if (!(xs[i].ts >= xs[i - 1].ts)) return false
  return true
}

/**
 * `[...a, ...b].sort((x, y) => x.ts - y.ts)`, done as a merge when both lists
 * are already in time order (the sort is stable: on equal times a's items
 * come first, each list in its own order). Lists that aren't in order are
 * sorted as before.
 */
export function mergeByTime<T extends { ts: number }>(a: readonly T[], b: readonly T[]): T[] {
  if (!inOrder(a) || !inOrder(b)) return [...a, ...b].sort((x, y) => x.ts - y.ts)
  const out = new Array<T>(a.length + b.length)
  let i = 0
  let j = 0
  let k = 0
  while (i < a.length && j < b.length) out[k++] = b[j].ts < a[i].ts ? b[j++] : a[i++]
  while (i < a.length) out[k++] = a[i++]
  while (j < b.length) out[k++] = b[j++]
  return out
}
