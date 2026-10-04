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

  const push = (kind: SpecReviewBlockKind, start: number, end: number, headingPath: string[]) => {
    const body = lines.slice(start, end + 1).join('\n')
    if (body.trim() === '') return
    blocks.push({
      index: blocks.length,
      kind,
      text: body,
      startLine: start + 1,
      endLine: end + 1,
      headingPath,
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
      const start = i
      i += 1
      // A list runs until a blank line; indented continuation lines belong to it.
      while (i < lines.length && (lines[i] ?? '').trim() !== '' && !HEADING.test(lines[i] ?? '') && !FENCE.test(lines[i] ?? '')) i += 1
      push('list', start, i - 1, pathNow())
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

/** "Under 'A > B', the paragraph beginning '…'" for a prompt. */
export function describeBlock(block: SpecReviewBlock): string {
  const where = block.headingPath.length > 0 ? `under "${block.headingPath.join(' > ')}"` : 'at the top of the document'
  const what =
    block.kind === 'heading'
      ? 'the heading'
      : block.kind === 'code'
        ? 'the code block'
        : block.kind === 'list'
          ? 'the list'
          : block.kind === 'table'
            ? 'the table'
            : block.kind === 'quote'
              ? 'the quote'
              : 'the paragraph'
  return `${where}, ${what} beginning "${excerpt(block, 100)}"`
}
