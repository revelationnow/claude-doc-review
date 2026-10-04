// Markdown to blocks, and anchors that survive a revision of the file.

import type { SpecReviewAnchor, SpecReviewBlock, SpecReviewBlockKind } from '../types'

const FENCE = /^\s{0,3}(`{3,}|~{3,})/
const HEADING = /^\s{0,3}(#{1,6})\s+(.*?)\s*#*\s*$/
const RULE = /^\s{0,3}([-*_])(\s*\1){2,}\s*$/
const LIST = /^\s*(?:[-*+]|\d{1,3}[.)])\s+/
const QUOTE = /^\s{0,3}>/
const TABLE_SEP = /^\s*\|?\s*:?-{3,}:?\s*(\|\s*:?-{3,}:?\s*)*\|?\s*$/

/** Strips what a surface cannot draw: carriage returns and control characters. */
export function cleanText(text: string): string {
  return text.replace(/\r/g, '').replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, '')
}

export function parseBlocks(text: string): SpecReviewBlock[] {
  const lines = cleanText(text).split('\n')
  const blocks: SpecReviewBlock[] = []
  const stack: { level: number; title: string }[] = []
  let i = 0

  const push = (kind: SpecReviewBlockKind, start: number, end: number, headingPath: string[], depth?: number) => {
    const slice = lines.slice(start, end + 1)
    // An item is drawn on its own, so its indent goes: four spaces would make it code.
    const body = (depth === undefined ? slice : dedent(slice, indentOf(slice[0] ?? ''))).join('\n').trimEnd()
    if (body.trim() === '') return
    blocks.push({
      index: blocks.length,
      kind,
      text: body,
      startLine: start + 1,
      endLine: end + 1,
      headingPath,
      ...(depth === undefined ? {} : { depth }),
    })
  }
  const pathNow = () => stack.map(h => h.title)

  while (i < lines.length) {
    const line = lines[i] ?? ''
    if (line.trim() === '') {
      i += 1
      continue
    }

    const fence = FENCE.exec(line)
    if (fence) {
      const mark = fence[1] ?? '```'
      const start = i
      i += 1
      while (i < lines.length) {
        const l = lines[i] ?? ''
        if (l.trim().startsWith(mark[0] ?? '`') && l.trim().length >= mark.length && /^[`~]+\s*$/.test(l.trim())) break
        i += 1
      }
      push('code', start, Math.min(i, lines.length - 1), pathNow())
      i += 1
      continue
    }

    const heading = HEADING.exec(line)
    if (heading) {
      const level = (heading[1] ?? '#').length
      const title = (heading[2] ?? '').trim()
      while (stack.length > 0 && (stack[stack.length - 1]?.level ?? 0) >= level) stack.pop()
      stack.push({ level, title })
      push('heading', i, i, pathNow())
      i += 1
      continue
    }

    if (RULE.test(line)) {
      push('rule', i, i, pathNow())
      i += 1
      continue
    }

    if (line.includes('|') && TABLE_SEP.test(lines[i + 1] ?? '')) {
      const start = i
      i += 2
      while (i < lines.length && (lines[i] ?? '').includes('|') && (lines[i] ?? '').trim() !== '') i += 1
      push('table', start, i - 1, pathNow())
      continue
    }

    if (QUOTE.test(line)) {
      const start = i
      while (i < lines.length && QUOTE.test(lines[i] ?? '')) i += 1
      push('quote', start, i - 1, pathNow())
      continue
    }

    if (LIST.test(line)) {
      // Each item is a block of its own, so a comment can land on one point; a
      // nested item follows its parent one level deeper. `indents` holds the
      // indents of the items open above the current one.
      const indents: number[] = []
      let start = -1
      let depth = 0
      let last = i
      while (i < lines.length) {
        const l = lines[i] ?? ''
        if (l.trim() === '') {
          // A blank line ends the list unless an item or an indented line follows.
          let k = i + 1
          while (k < lines.length && (lines[k] ?? '').trim() === '') k += 1
          const after = lines[k] ?? ''
          if (k < lines.length && (LIST.test(after) || /^\s{2,}\S/.test(after)) && !FENCE.test(after)) {
            i = k
            continue
          }
          break
        }
        if (HEADING.test(l) || FENCE.test(l)) break
        if (LIST.test(l)) {
          if (start !== -1) push('item', start, last, pathNow(), depth)
          const w = indentOf(l)
          while (indents.length > 0 && (indents[indents.length - 1] ?? 0) >= w) indents.pop()
          depth = indents.length
          indents.push(w)
          start = i
        }
        last = i
        i += 1
      }
      if (start !== -1) push('item', start, last, pathNow(), depth)
      continue
    }

    const start = i
    i += 1
    while (
      i < lines.length &&
      (lines[i] ?? '').trim() !== '' &&
      !HEADING.test(lines[i] ?? '') &&
      !FENCE.test(lines[i] ?? '') &&
      !LIST.test(lines[i] ?? '') &&
      !QUOTE.test(lines[i] ?? '')
    ) {
      i += 1
    }
    push('paragraph', start, i - 1, pathNow())
  }

  return blocks
}

/** Leading whitespace in columns, a tab counting four. */
function indentOf(line: string): number {
  const lead = /^[ \t]*/.exec(line)?.[0] ?? ''
  return lead.replace(/\t/g, '    ').length
}

/** Each line with up to `n` columns of its leading whitespace removed. */
function dedent(lines: readonly string[], n: number): string[] {
  return lines.map(l => {
    const lead = /^[ \t]*/.exec(l)?.[0] ?? ''
    const cut = Math.min(n, lead.replace(/\t/g, '    ').length)
    return lead.replace(/\t/g, '    ').slice(cut) + l.slice(lead.length)
  })
}

/** One table row's cells, an escaped pipe kept, emphasis and code marks dropped. */
function splitRow(line: string): string[] {
  let s = line.trim()
  if (s.startsWith('|')) s = s.slice(1)
  if (s.endsWith('|') && !s.endsWith('\\|')) s = s.slice(0, -1)
  const cells: string[] = []
  let cell = ''
  for (let i = 0; i < s.length; i += 1) {
    const c = s[i] ?? ''
    if (c === '\\' && s[i + 1] === '|') {
      cell += '|'
      i += 1
    } else if (c === '|') {
      cells.push(cell)
      cell = ''
    } else {
      cell += c
    }
  }
  cells.push(cell)
  return cells.map(c => c.trim().replace(/\*\*|__|`/g, ''))
}

function widthOf(text: string): number {
  return [...text].length
}

/**
 * A markdown table laid out as aligned monospace rows: header, a rule, then
 * the body, cells padded to their column and aligned as the separator says.
 * Drawn unwrapped, a row never breaks across lines.
 */
export function tableGrid(markdown: string): string[] {
  const rows = markdown.split('\n').filter(l => l.trim() !== '')
  const header = splitRow(rows[0] ?? '')
  const align = splitRow(rows[1] ?? '').map(c => (c.startsWith(':') && c.endsWith(':') ? 'center' : c.endsWith(':') ? 'right' : 'left'))
  const body = rows.slice(2).map(splitRow)
  const all = [header, ...body]
  const n = Math.max(...all.map(r => r.length))
  const widths = Array.from({ length: n }, (_, j) => Math.max(1, ...all.map(r => widthOf(r[j] ?? ''))))
  const pad = (text: string, j: number) => {
    const room = (widths[j] ?? 0) - widthOf(text)
    const how = align[j] ?? 'left'
    if (how === 'right') return ' '.repeat(room) + text
    if (how === 'center') return ' '.repeat(Math.floor(room / 2)) + text + ' '.repeat(Math.ceil(room / 2))
    return text + ' '.repeat(room)
  }
  const line = (r: readonly string[]) => widths.map((_, j) => pad(r[j] ?? '', j)).join(' │ ').trimEnd()
  return [line(header), widths.map(w => '─'.repeat(w)).join('─┼─'), ...body.map(line)]
}

/** A fenced code block's language (its info string's first word) and its lines, fences dropped. */
export function codeParts(markdown: string): { language?: string; lines: string[] } {
  const lines = markdown.split('\n')
  const open = /^\s{0,3}(`{3,}|~{3,})\s*([^\s`]*)/.exec(lines[0] ?? '')
  const mark = open?.[1] ?? '```'
  const inner = lines.slice(1)
  const close = inner[inner.length - 1]?.trim() ?? ''
  if (close.startsWith(mark) && /^[`~]+$/.test(close)) inner.pop()
  const language = open?.[2] ?? ''
  return language === '' ? { lines: inner } : { language, lines: inner }
}

/** The widest line a block draws unwrapped: a table's grid, a code block's lines. */
export function unwrappedLines(block: Pick<SpecReviewBlock, 'kind' | 'text'>): string[] | null {
  if (block.kind === 'table') return tableGrid(block.text)
  if (block.kind === 'code') return codeParts(block.text).lines
  return null
}

/** The document's title: its first heading, else its file name. */
export function titleOf(blocks: readonly SpecReviewBlock[], path: string): string {
  const first = blocks.find(b => b.kind === 'heading')
  return first ? plainText(first.text) : basename(path)
}

export function basename(path: string): string {
  const parts = path.split(/[\\/]/)
  return parts[parts.length - 1] ?? path
}

/** Markdown markers removed and whitespace collapsed, for quoting and matching. */
export function plainText(markdown: string): string {
  return markdown
    .replace(/^\s{0,3}#{1,6}\s+/gm, '')
    .replace(/^\s*(?:[-*+]|\d{1,3}[.)])\s+/gm, '')
    .replace(/^\s{0,3}>\s?/gm, '')
    .replace(/^\s{0,3}(`{3,}|~{3,}).*$/gm, '')
    .replace(/[*_`~]/g, '')
    .replace(/\s+/g, ' ')
    .trim()
}

export function normalizeQuote(markdown: string): string {
  return plainText(markdown).toLowerCase().slice(0, 200)
}

export function anchorFor(block: SpecReviewBlock): SpecReviewAnchor {
  return {
    headingPath: [...block.headingPath],
    quote: normalizeQuote(block.text),
    blockIndex: block.index,
  }
}

/**
 * Finds the block an anchor means in the current blocks: an exact quote
 * first, then a quote under the same heading sharing a long prefix, then the
 * index hint when its block still shares a short prefix. -1 when none.
 */
export function reanchor(anchor: SpecReviewAnchor, blocks: readonly SpecReviewBlock[]): number {
  const quotes = blocks.map(b => normalizeQuote(b.text))
  const exact = quotes.findIndex(q => q === anchor.quote && q !== '')
  if (exact !== -1) return exact

  const prefix = anchor.quote.slice(0, 40)
  if (prefix.length >= 12) {
    const samePath = blocks.findIndex(
      (b, i) => sameHeading(b.headingPath, anchor.headingPath) && (quotes[i] ?? '').startsWith(prefix),
    )
    if (samePath !== -1) return samePath
    const anyPath = quotes.findIndex(q => q.startsWith(prefix))
    if (anyPath !== -1) return anyPath
  }

  // A passage split in two keeps its comment on the first part: a list that
  // was one block, now one block per item.
  const split = blocks.findIndex(
    (b, i) => sameHeading(b.headingPath, anchor.headingPath) && (quotes[i] ?? '').length >= 12 && anchor.quote.startsWith(quotes[i] ?? ''),
  )
  if (split !== -1) return split

  const hinted = quotes[anchor.blockIndex]
  if (hinted !== undefined && anchor.quote.length >= 8 && hinted.startsWith(anchor.quote.slice(0, 20))) {
    return anchor.blockIndex
  }
  return -1
}

function sameHeading(a: readonly string[], b: readonly string[]): boolean {
  return a.length === b.length && a.every((h, i) => h === b[i])
}

/** The first `max` characters of a block as plain text, with an ellipsis when cut. */
export function excerpt(block: Pick<SpecReviewBlock, 'text'>, max = 160): string {
  const plain = plainText(block.text)
  return plain.length > max ? `${plain.slice(0, max - 1).trimEnd()}…` : plain
}

const WHAT: Record<SpecReviewBlockKind, string> = {
  heading: 'the heading',
  paragraph: 'the paragraph',
  list: 'the list',
  item: 'the list item',
  code: 'the code block',
  table: 'the table',
  quote: 'the quote',
  rule: 'the rule',
}

/** "Under 'A > B', the paragraph beginning '…'" for a prompt. */
export function describeBlock(block: SpecReviewBlock): string {
  const where = block.headingPath.length > 0 ? `under "${block.headingPath.join(' > ')}"` : 'at the top of the document'
  const what = WHAT[block.kind]
  return `${where}, ${what} beginning "${excerpt(block, 100)}"`
}
