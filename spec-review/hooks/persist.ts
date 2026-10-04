// The shape of what the mod keeps across sessions in `$.store`: one record
// per document. The store calls themselves live in the hooks module, since
// the engine follows `$` only into functions of that file.
//
// The store holds 4 MiB of JSON in all, so a record keeps a bounded baseline
// text, and the records of the least recently touched documents are evicted.

import type { SpecReviewComment, SpecReviewSaved, SpecReviewThread } from '../types'

export const STORE_PREFIX = 'doc:'
export const MAX_SAVED_DOCS = 12
const BASELINE_CAP = 120_000

export function storeKey(cwd: string, path: string): string {
  const p = path.replace(/\\/g, '/')
  const base = cwd.replace(/\\/g, '/').replace(/\/+$/, '')
  const abs = p.startsWith('/') || /^[A-Za-z]:\//.test(p) ? p : `${base}/${p.replace(/^\.\//, '')}`
  return `${STORE_PREFIX}${abs}`
}

export function isSaved(value: unknown): value is SpecReviewSaved {
  if (typeof value !== 'object' || value === null) return false
  const v = value as Record<string, unknown>
  return typeof v.path === 'string' && Array.isArray(v.comments) && Array.isArray(v.threads) && typeof v.updatedAt === 'number'
}

export function toSaved(
  record: {
    path: string
    comments: readonly SpecReviewComment[]
    threads: readonly SpecReviewThread[]
    baselineText: string | null
    lastReviewAt: number | null
  },
  now: number,
): SpecReviewSaved {
  return {
    path: record.path,
    comments: [...record.comments],
    // A pending question is a request in flight in one session; it does not carry over.
    threads: record.threads.filter(t => t.status !== 'pending'),
    baselineText: record.baselineText !== null && record.baselineText.length <= BASELINE_CAP ? record.baselineText : null,
    lastReviewAt: record.lastReviewAt,
    updatedAt: now,
  }
}

/** Which of `others` to drop so that, with the one just written, at most MAX_SAVED_DOCS remain. */
export function keysToEvict(others: readonly { key: string; updatedAt: number }[]): string[] {
  if (others.length < MAX_SAVED_DOCS) return []
  const aged = [...others].sort((a, b) => a.updatedAt - b.updatedAt)
  return aged.slice(0, aged.length - (MAX_SAVED_DOCS - 1)).map(o => o.key)
}
