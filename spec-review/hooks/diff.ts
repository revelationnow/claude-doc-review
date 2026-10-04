// A line diff (Myers) and the unified hunks a Code element draws from it,
// plus which blocks of a document changed against an earlier version.

import type { SpecReviewBlock } from '../types'
import { normalizeQuote } from './blocks'

export type DiffOp = { kind: 'same' | 'add' | 'del'; text: string }

/** Above this many lines together the diff is skipped rather than computed. */
export const DIFF_LINE_CAP = 12000

/**
 * The shortest edit script from `a` to `b`, as Myers finds it; null when the
 * inputs are too large to diff within the cap.
 */
export function diffLines(a: readonly string[], b: readonly string[]): DiffOp[] | null {
  const n = a.length
  const m = b.length
  if (n + m > DIFF_LINE_CAP) return null
  if (n === 0) return b.map(text => ({ kind: 'add', text }))
  if (m === 0) return a.map(text => ({ kind: 'del', text }))

  const max = n + m
  const offset = max
  const trace: Int32Array[] = []
  let v = new Int32Array(2 * max + 2)
  v[offset + 1] = 0

  let found = false
  for (let d = 0; d <= max && !found; d += 1) {
    const snapshot = new Int32Array(v)
    trace.push(snapshot)
    for (let k = -d; k <= d; k += 2) {
      let x: number
      if (k === -d || (k !== d && (v[offset + k - 1] ?? 0) < (v[offset + k + 1] ?? 0))) {
        x = v[offset + k + 1] ?? 0
      } else {
        x = (v[offset + k - 1] ?? 0) + 1
      }
      let y = x - k
      while (x < n && y < m && a[x] === b[y]) {
        x += 1
        y += 1
      }
      v[offset + k] = x
      if (x >= n && y >= m) {
        found = true
        break
      }
    }
  }

  // Walk the trace back from the end to recover the path.
  const ops: DiffOp[] = []
  let x = n
  let y = m
  for (let d = trace.length - 1; d >= 0; d -= 1) {
    const vd = trace[d]!
    const k = x - y
    let prevK: number
    if (k === -d || (k !== d && (vd[offset + k - 1] ?? 0) < (vd[offset + k + 1] ?? 0))) {
      prevK = k + 1
    } else {
      prevK = k - 1
    }
    const prevX = vd[offset + prevK] ?? 0
    const prevY = prevX - prevK
    while (x > prevX && y > prevY) {
      x -= 1
      y -= 1
      ops.push({ kind: 'same', text: a[x] ?? '' })
    }
    if (d > 0) {
      if (x === prevX) {
        y -= 1
        ops.push({ kind: 'add', text: b[y] ?? '' })
      } else {
        x -= 1
        ops.push({ kind: 'del', text: a[x] ?? '' })
      }
    }
  }
  ops.reverse()
  return ops
}

/** Unified-diff hunks with `context` unchanged lines around each change. */
export function unifiedHunks(ops: readonly DiffOp[], context = 3): string[] {
  const changed = ops.map(op => op.kind !== 'same')
  if (!changed.some(Boolean)) return []

  // Group changes whose context windows touch.
  const groups: { start: number; end: number }[] = []
  let i = 0
  while (i < ops.length) {
    if (!changed[i]) {
      i += 1
      continue
    }
    let start = Math.max(0, i - context)
    let end = i
    let j = i
    while (j < ops.length) {
      if (changed[j]) {
        end = j
        j += 1
      } else {
        // Look ahead: another change within 2*context keeps the hunk going.
        let k = j
        while (k < ops.length && !changed[k] && k - j < context * 2) k += 1
        if (k < ops.length && changed[k]) {
          j = k
        } else {
          break
        }
      }
    }
    end = Math.min(ops.length - 1, end + context)
    const last = groups[groups.length - 1]
    if (last && start <= last.end + 1) {
      last.end = end
    } else {
      groups.push({ start, end })
    }
    i = end + 1
  }

  // Line numbers: walk ops once, keeping the old and new line at each index.
  const oldAt: number[] = []
  const newAt: number[] = []
  let oldLine = 1
  let newLine = 1
  for (const op of ops) {
    oldAt.push(oldLine)
    newAt.push(newLine)
    if (op.kind !== 'add') oldLine += 1
    if (op.kind !== 'del') newLine += 1
  }

  return groups.map(g => {
    let oldCount = 0
    let newCount = 0
    const body: string[] = []
    for (let k = g.start; k <= g.end; k += 1) {
      const op = ops[k]!
      if (op.kind !== 'add') oldCount += 1
      if (op.kind !== 'del') newCount += 1
      body.push(`${op.kind === 'add' ? '+' : op.kind === 'del' ? '-' : ' '}${op.text}`)
    }
    const oldStart = oldAt[g.start] ?? 1
    const newStart = newAt[g.start] ?? 1
    return [`@@ -${oldStart},${oldCount} +${newStart},${newCount} @@`, ...body].join('\n')
  })
}

export function diffText(before: string, after: string, context = 3): { hunks: string[]; added: number; removed: number } | null {
  const ops = diffLines(before.split('\n'), after.split('\n'))
  if (ops === null) return null
  return {
    hunks: unifiedHunks(ops, context),
    added: ops.filter(o => o.kind === 'add').length,
    removed: ops.filter(o => o.kind === 'del').length,
  }
}

/**
 * The indices of blocks whose text is not found, as a block, in the earlier
 * version: new or reworded passages. Unchanged blocks moved around are not
 * reported, since they read the same.
 */
export function changedBlocks(current: readonly SpecReviewBlock[], baselineBlocks: readonly SpecReviewBlock[]): number[] {
  const seen = new Set(baselineBlocks.map(b => normalizeQuote(b.text) + '\u0000' + b.text.trim()))
  return current.filter(b => !seen.has(normalizeQuote(b.text) + '\u0000' + b.text.trim())).map(b => b.index)
}
