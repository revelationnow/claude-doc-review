// doc-review: review a design spec or implementation plan in a pane.
//
// Move block by block, pin comments, ask side questions the main conversation
// never sees, then submit every comment as one review, or approve. Comments
// persist across sessions, and a revision can be read as a diff against the
// version last reviewed.

import { atom, read, update } from 'claude-code'
import type {
  BoxProps,
  ButtonProps,
  CodeProps,
  ElementConstructor,
  EngineInterface,
  InputProps,
  MarkdownProps,
  ModelForkResult,
  Register,
  RenderElement,
  TextProps,
} from 'claude-code'

import type {
  DocReviewBlock,
  DocReviewCandidate,
  DocReviewComment,
  DocReviewComposer,
  DocReviewDoc,
  DocReviewThread,
} from '../types'
import { anchorFor, basename, cleanText, codeParts, excerpt, parseBlocks, plainText, reanchor, titleOf, unwrappedLines } from './blocks'
import { changedBlocks, diffText } from './diff'
import { STORE_PREFIX, isSaved, keysToEvict, storeKey, toSaved } from './persist'
import { buildApprovalPrompt, buildAskPrompt, buildEscalationPrompt, buildExplainPrompt, buildReviewPrompt, buildStandaloneAskPrompt } from './review-prompt'

const PLUGIN = 'doc-review'
const PANE = 'doc-review'
// Not `review`: Claude Code has a built-in /review for pull requests.
const COMMAND = 'doc-review'

const DEFAULT_GLOBS =
  'docs/superpowers/specs/**/*.md,docs/superpowers/plans/**/*.md,docs/plans/**/*.md,docs/specs/**/*.md,**/*-design.md,**/*-plan.md,SPEC.md,PLAN.md'
const REVIEW_ASKED = /please (review|take a look)|review (it|the (plan|spec|design|document))|let me know if you want (to make )?(any )?changes/i
const MARKDOWN_CAP = 9000
const CODE_CAP = 9000
const MAX_HUNKS = 40
const CANDIDATE_TURNS = 2
// Below this many columns the pane draws compact: a narrower gutter, the path on its own line.
const NARROW = 70
// Up to this many blocks the pane draws them all, so the wheel reaches every
// one; a longer document draws a window of WINDOW_HALF either side of the cursor.
const MAX_DRAWN = 200
/** Rows the sticky bar takes at the top of a scrolled pane: status, actions, rule. */
const BAR_ROWS = 3
const WINDOW_HALF = 60

const docA = atom({ plugin: 'doc-review', key: 'doc' } as const, null)
const commentsA = atom({ plugin: 'doc-review', key: 'comments' } as const, [])
const threadsA = atom({ plugin: 'doc-review', key: 'threads' } as const, [])
const composerA = atom({ plugin: 'doc-review', key: 'composer' } as const, null)
const candidatesA = atom({ plugin: 'doc-review', key: 'candidates' } as const, [])
const offeredA = atom({ plugin: 'doc-review', key: 'offered' } as const, [])
const noticeA = atom({ plugin: 'doc-review', key: 'notice' } as const, null)
const askViaA = atom({ plugin: 'doc-review', key: 'askVia' } as const, null)

/** Ask through a fork of the conversation: the session's model, with the transcript cached. */
const VIA_SESSION = 'session'

/** What the ask composer's model button cycles through, the configured default first. */
function askChoices(configured: string): string[] {
  return [...new Set([configured, VIA_SESSION, 'sonnet', 'haiku', 'opus'])]
}

function viaLabel(via: string): string {
  return via === VIA_SESSION ? 'via this conversation' : `via ${via}`
}

/** A path as typed, or as an @-mention completed it (`@path`, `@"path with spaces"`). */
function argPath(raw: string): string {
  const s = raw.trim()
  const m = /^@"(.*)"$/.exec(s) ?? /^@(.*)$/.exec(s)
  return (m ? m[1]! : s).trim()
}

type Table = {
  Box: ElementConstructor<BoxProps>
  Text: ElementConstructor<TextProps>
  Button: ElementConstructor<ButtonProps>
  Markdown: ElementConstructor<MarkdownProps>
  Code: ElementConstructor<CodeProps>
}

// ---- globs -----------------------------------------------------------------

export function globToRegExp(glob: string): RegExp {
  let re = '^'
  for (let i = 0; i < glob.length; i += 1) {
    const c = glob[i] ?? ''
    if (c === '*') {
      if (glob[i + 1] === '*') {
        i += 1
        if (glob[i + 1] === '/') {
          i += 1
          re += '(?:.*/)?'
        } else {
          re += '.*'
        }
      } else {
        re += '[^/]*'
      }
    } else if (c === '?') {
      re += '[^/]'
    } else if ('.+^${}()|[]\\'.includes(c)) {
      re += `\\${c}`
    } else {
      re += c
    }
  }
  return new RegExp(`${re}$`)
}

function relativeTo(cwd: string, path: string): string {
  const p = path.replace(/\\/g, '/')
  const base = cwd.replace(/\\/g, '/').replace(/\/+$/, '')
  if (base !== '' && p.startsWith(`${base}/`)) return p.slice(base.length + 1)
  return p.replace(/^\.\//, '')
}

function samePath(cwd: string, a: string, b: string): boolean {
  return relativeTo(cwd, a) === relativeTo(cwd, b)
}

// ---- document --------------------------------------------------------------

async function readText($: EngineInterface, path: string): Promise<string> {
  const raw = await $.fs.read(path)
  return cleanText(typeof raw === 'string' ? raw : '')
}

function withBaseline(doc: Omit<DocReviewDoc, 'changed'>, baselineText: string): DocReviewDoc {
  const changed = baselineText === doc.text ? [] : changedBlocks(doc.blocks, parseBlocks(baselineText))
  return { ...doc, baselineText, changed }
}

async function reanchorAll($: EngineInterface, blocks: readonly DocReviewBlock[]): Promise<void> {
  await update($, commentsA, list =>
    list.map(c => {
      const at = reanchor(c.anchor, blocks)
      return at === -1 ? { ...c, isOrphan: true } : { ...c, isOrphan: false, anchor: { ...c.anchor, blockIndex: at } }
    }),
  )
  await update($, threadsA, list =>
    list.map(t => {
      const at = reanchor(t.anchor, blocks)
      return at === -1 ? t : { ...t, anchor: { ...t.anchor, blockIndex: at } }
    }),
  )
}

async function loadSaved($: EngineInterface, key: string) {
  const value = await $.store.get(key)
  return isSaved(value) ? value : null
}

/** Writes the open document's comments, questions and baseline to the store. */
async function persist($: EngineInterface): Promise<void> {
  const doc = await read($, docA)
  if (!doc) return
  const cwd = await $.session.cwd()
  const key = storeKey(cwd, doc.path)
  const saved = toSaved(
    {
      path: doc.path,
      comments: await read($, commentsA),
      threads: await read($, threadsA),
      baselineText: doc.baselineText,
      lastReviewAt: doc.lastReviewAt,
    },
    await $.clock.now(),
  )
  await $.store.set(key, saved)

  // Keep the store bounded: drop the records of the least recently touched documents.
  const others = (await $.store.keys()).filter(k => k.startsWith(STORE_PREFIX) && k !== key)
  if (others.length >= 12) {
    const aged: { key: string; updatedAt: number }[] = []
    for (const other of others) {
      const value = await $.store.get(other)
      aged.push({ key: other, updatedAt: isSaved(value) ? value.updatedAt : 0 })
    }
    for (const old of keysToEvict(aged)) await $.store.delete(old)
  }
}

/** Opens `path` in the pane. `asked` is true when a person's action is behind it. */
async function openDoc($: EngineInterface, path: string, asked: boolean) {
  const cwd = await $.session.cwd()
  const previous = await read($, docA)
  const isSame = previous !== null && samePath(cwd, previous.path, path)
  const text = await readText($, path)
  const blocks = parseBlocks(text)
  let notice: string | null = null

  if (isSame) {
    const doc = withBaseline(
      {
        ...previous,
        text,
        blocks,
        title: titleOf(blocks, path),
        cursor: Math.min(previous.cursor, Math.max(0, blocks.length - 1)),
        revision: previous.text === text ? previous.revision : previous.revision + 1,
        view: 'document',
        awaitingRevision: previous.text === text ? previous.awaitingRevision : false,
        search: null,
      },
      previous.baselineText,
    )
    await update($, docA, () => doc)
    await reanchorAll($, blocks)
  } else {
    const saved = await loadSaved($, storeKey(cwd, path))
    const doc = withBaseline(
      {
        path,
        title: titleOf(blocks, path),
        text,
        blocks,
        cursor: 0,
        revision: 0,
        baselineText: saved?.baselineText ?? text,
        view: 'document',
        awaitingRevision: false,
        lastReviewAt: saved?.lastReviewAt ?? null,
        search: null,
      },
      saved?.baselineText ?? text,
    )
    await update($, docA, () => doc)
    await update($, commentsA, () => (saved ? [...saved.comments] : []))
    await update($, threadsA, () => (saved ? [...saved.threads] : []))
    await reanchorAll($, blocks)
    if (saved && (saved.comments.length > 0 || saved.threads.length > 0)) {
      const parts: string[] = []
      if (saved.comments.length > 0) parts.push(`${saved.comments.length} ${saved.comments.length === 1 ? 'comment' : 'comments'}`)
      if (saved.threads.length > 0) parts.push(`${saved.threads.length} ${saved.threads.length === 1 ? 'question' : 'questions'}`)
      notice = `Restored ${parts.join(' and ')} from an earlier session.`
    }
    if (doc.changed.length > 0) {
      notice = `${notice ? `${notice} ` : ''}The file changed since you last reviewed it: ${doc.changed.length} ${doc.changed.length === 1 ? 'block differs' : 'blocks differ'} (d for the diff).`
    }
  }
  await update($, composerA, () => null)
  await update($, noticeA, () => notice)
  await persist($)

  const opened = await $.ui.open({
    id: PANE,
    title: `Review: ${basename(path)}`,
    rows: 28,
    ...(asked ? { focus: true as const } : {}),
  })
  if (opened.isPlaced) $.ui.status(undefined)
  return opened
}

async function refreshDoc($: EngineInterface): Promise<void> {
  const doc = await read($, docA)
  if (!doc) return
  const exists = await $.fs.exists(doc.path)
  if (!exists) {
    await update($, noticeA, () => 'The file was removed.')
    return
  }
  const text = await readText($, doc.path)
  if (text === doc.text) return
  const blocks = parseBlocks(text)
  const next = withBaseline(
    {
      ...doc,
      text,
      blocks,
      title: titleOf(blocks, doc.path),
      cursor: Math.min(doc.cursor, Math.max(0, blocks.length - 1)),
      revision: doc.revision + 1,
      awaitingRevision: false,
      search: doc.search ? { query: doc.search.query, matches: findMatches(blocks, doc.search.query) } : null,
    },
    doc.baselineText,
  )
  await update($, docA, () => next)
  await reanchorAll($, blocks)
  const n = next.changed.length
  await update($, noticeA, () =>
    n > 0
      ? `Revision ${next.revision}: ${n} ${n === 1 ? 'block differs' : 'blocks differ'} from the version you reviewed (d for the diff, n to jump).`
      : `Revision ${next.revision}: nothing differs from the version you reviewed.`,
  )
  await persist($)
}

function latest(list: readonly DocReviewCandidate[]): DocReviewCandidate | undefined {
  return [...list].sort((a, b) => b.writtenAt - a.writtenAt)[0]
}

function newId(prefix: string): string {
  return `${prefix}-${Math.random().toString(36).slice(2, 10)}`
}

// ---- actions ---------------------------------------------------------------

/**
 * Makes a block current and scrolls to it. `pan` sets how far a wide block
 * sits sideways (0 by default); `focus: false` leaves the keyboard where it
 * is, as the find field needs while the person types.
 */
async function setCursor($: EngineInterface, cursor: number, opts: { pan?: number; focus?: boolean } = {}): Promise<void> {
  // Not `pan`: the engine follows $ by function name, and a second
  // declaration of a name it follows refuses the whole module.
  const sideways = opts.pan ?? 0
  let from = cursor
  await update($, docA, d => {
    if (d) from = d.cursor
    return d && (d.cursor !== cursor || (d.pan ?? 0) !== sideways) ? { ...d, cursor, view: 'document' as const, pan: sideways } : d
  })
  // Going up, the block lands on the window's first row, where the sticky bar
  // covers it: reveal the mark drawn the bar's height above it instead.
  // The first block goes back to the very top, header and all.
  const to = cursor === 0 ? 'start' : { key: cursor < from ? `pre:${cursor}` : `blk:${cursor}` }
  void $.ui.scroll({ to, in: PANE, block: 'nearest' }).catch(() => undefined)
  if (opts.focus !== false) void $.ui.focus({ requestId: PANE, key: `b:${cursor}` }).catch(() => undefined)
}

async function moveCursor($: EngineInterface, delta: number | ((cursor: number, n: number) => number)): Promise<void> {
  const doc = await read($, docA)
  if (!doc || doc.blocks.length === 0) return
  const n = doc.blocks.length
  const target = typeof delta === 'number' ? doc.cursor + delta : delta(doc.cursor, n)
  await setCursor($, Math.max(0, Math.min(n - 1, target)))
}

/** Moves to the next changed block after the cursor, wrapping around. */
async function nextChange($: EngineInterface): Promise<void> {
  const doc = await read($, docA)
  if (!doc) return
  if (doc.changed.length === 0) {
    $.ui.toast('doc-review: nothing differs from the version you reviewed.')
    return
  }
  const after = doc.changed.find(i => i > doc.cursor)
  await setCursor($, after ?? doc.changed[0] ?? doc.cursor)
}

function findMatches(blocks: readonly DocReviewBlock[], query: string): number[] {
  const q = query.trim().toLowerCase()
  if (q === '') return []
  return blocks.filter(b => plainText(b.text).toLowerCase().includes(q)).map(b => b.index)
}

/** The columns the pane body last drew at: what a find needs to pan a wide block to its match. */
let lastColumns = 100

/** Where each occurrence of `query` sits in `text`, as [start, end) in code points, case-insensitive. */
function occurrences(text: string, query: string): [number, number][] {
  const q = query.toLowerCase()
  if (q === '') return []
  const lower = text.toLowerCase()
  const out: [number, number][] = []
  for (let at = lower.indexOf(q); at >= 0; at = lower.indexOf(q, at + q.length)) {
    const from = [...text.slice(0, at)].length
    out.push([from, from + [...text.slice(at, at + q.length)].length])
  }
  return out
}

/** How far to pan a table or code block so the first occurrence of `query` shows: 0 when it already does. */
function panToMatch(block: DocReviewBlock, query: string): number {
  const lines = unwrappedLines(block)
  if (!lines) return 0
  const gutter = lastColumns < NARROW ? 2 : 3
  const room = Math.max(10, lastColumns - gutter - (block.depth ?? 0) * 2)
  const { max } = panRange(block, room)
  for (const line of lines) {
    const hit = occurrences(line, query)[0]
    if (!hit) continue
    if (hit[1] <= room) return 0
    return Math.max(0, Math.min(max, hit[0] - Math.floor(room / 3)))
  }
  return 0
}

/** Moves to match `at` of the find: pans a wide block to it. */
async function landOnMatch($: EngineInterface, doc: DocReviewDoc, at: number, query: string, focus = true): Promise<void> {
  const block = doc.blocks[at]
  await setCursor($, at, { pan: block ? panToMatch(block, query) : 0, focus })
}

/** Enter in the find field: keeps the find and its match, closes the field. */
async function runFind($: EngineInterface, query: string): Promise<void> {
  const doc = await read($, docA)
  if (!doc) return
  const composer = await read($, composerA)
  const origin = composer?.mode === 'find' ? composer.blockIndex : doc.cursor
  const q = query.trim()
  const matches = findMatches(doc.blocks, q)
  await update($, docA, d => (d ? { ...d, search: q === '' ? null : { query: q, matches } } : d))
  await update($, composerA, () => null)
  if (q === '') return
  if (matches.length === 0) {
    $.ui.toast(`doc-review: no block contains "${q}".`)
    await setCursor($, origin)
    return
  }
  await landOnMatch($, doc, nextMatchFrom(matches, origin) ?? origin, q)
}

/**
 * Each keystroke in the find field: the matches and their highlights update,
 * the cursor stays. A jump would scroll the field out of the window, and a
 * focused field scrolled out of the window loses the keyboard; Enter jumps.
 */
async function findAsYouType($: EngineInterface, query: string): Promise<void> {
  const doc = await read($, docA)
  const composer = await read($, composerA)
  if (!doc || composer?.mode !== 'find') return
  const q = query.trim()
  const matches = findMatches(doc.blocks, q)
  await update($, docA, d => (d ? { ...d, search: q === '' ? null : { query: q, matches } } : d))
}

/** The match Enter in the find field goes to: the first at or after where find began. */
function nextMatchFrom(matches: readonly number[], origin: number): number | undefined {
  return matches.find(i => i >= origin) ?? matches[0]
}

/** `f`: opens the find field, holding the current find's text to edit or replace. */
async function openFind($: EngineInterface): Promise<void> {
  const doc = await read($, docA)
  if (!doc) return
  await update($, docA, d => (d ? { ...d, view: 'document' as const } : d))
  await update($, composerA, () => ({ blockIndex: doc.cursor, mode: 'find' as const, initial: doc.search?.query ?? '' }))
  void $.ui.focus({ requestId: PANE, key: 'find-field' }).catch(() => undefined)
}

/** `n`: the next match, wrapping; with no find yet, opens the field. */
async function findNext($: EngineInterface): Promise<void> {
  const doc = await read($, docA)
  if (!doc) return
  if (!doc.search || doc.search.matches.length === 0) return openFind($)
  const { matches, query } = doc.search
  await landOnMatch($, doc, matches.find(i => i > doc.cursor) ?? matches[0] ?? doc.cursor, query)
}

/** `p`: the previous match, wrapping. */
async function findPrev($: EngineInterface): Promise<void> {
  const doc = await read($, docA)
  if (!doc?.search || doc.search.matches.length === 0) return
  const { matches, query } = doc.search
  await landOnMatch($, doc, [...matches].reverse().find(i => i < doc.cursor) ?? matches[matches.length - 1] ?? doc.cursor, query)
}

async function clearFind($: EngineInterface): Promise<void> {
  await update($, docA, d => (d ? { ...d, search: null } : d))
  await update($, composerA, c => (c?.mode === 'find' ? null : c))
}

/** The find field's cancel: the find held before it opened stays, or none; the cursor never left. */
async function cancelFind($: EngineInterface): Promise<void> {
  const composer = await read($, composerA)
  const before = composer?.mode === 'find' ? (composer.initial ?? '').trim() : ''
  if (before === '') await clearFind($)
  else {
    // The find held before the field opened comes back, as typed edits are dropped.
    await update($, docA, d => (d ? { ...d, search: { query: before, matches: findMatches(d.blocks, before) } } : d))
    await update($, composerA, () => null)
  }
  if (composer?.mode === 'find') await setCursor($, composer.blockIndex)
}

/** `m`: the next block after the cursor that carries a comment or a question, wrapping. */
async function nextComment($: EngineInterface): Promise<void> {
  const doc = await read($, docA)
  if (!doc) return
  const comments = await read($, commentsA)
  const threads = await read($, threadsA)
  const marked = [...new Set([...comments.filter(c => !c.isOrphan).map(c => c.anchor.blockIndex), ...threads.map(t => t.anchor.blockIndex)])].sort((a, b) => a - b)
  if (marked.length === 0) {
    $.ui.toast('doc-review: no comments or questions yet.')
    return
  }
  const after = marked.find(i => i > doc.cursor)
  await setCursor($, after ?? marked[0] ?? doc.cursor)
}

/** `i`: a plain-words explanation of a block (the current one by default) from a small, fresh model. */
async function explain($: EngineInterface, model: string, blockIndex?: number): Promise<void> {
  const doc = await read($, docA)
  if (!doc) return
  const at = blockIndex ?? doc.cursor
  const block = doc.blocks[at]
  if (!block) return
  if (at !== doc.cursor) await update($, docA, d => (d ? { ...d, cursor: at, pan: 0 } : d))
  const thread: DocReviewThread = {
    id: newId('x'),
    anchor: anchorFor(block),
    kind: 'explain',
    question: 'Explain this passage',
    status: 'pending',
    model,
  }
  await update($, threadsA, list => [...list, thread])
  await update($, composerA, () => null)

  const { system, prompt } = buildExplainPrompt({ path: doc.path, title: doc.title, block })
  const reply = await $.model.complete({ model, system, prompt, effort: 'low', maxTokens: 400, timeoutMs: 30000 })
  await update($, threadsA, list =>
    list.map((t): DocReviewThread => {
      if (t.id !== thread.id) return t
      if (reply.isAnswered) {
        return { ...t, status: 'answered', answer: cleanText(reply.text).trim(), outputTokens: reply.usage.output_tokens, cachedTokens: reply.usage.cache_read_input_tokens }
      }
      const why = reply.reason === 'api-error' ? `API error${reply.status ? ` ${reply.status}` : ''} (${reply.error})` : reply.reason
      return { ...t, status: 'failed', failure: why }
    }),
  )
  await persist($)
}

/** Drops the document's saved comments and questions, in the pane and the store. */
async function forgetDoc($: EngineInterface, path: string): Promise<void> {
  const cwd = await $.session.cwd()
  await $.store.delete(storeKey(cwd, path))
  const doc = await read($, docA)
  if (doc && samePath(cwd, doc.path, path)) {
    await update($, commentsA, () => [])
    await update($, threadsA, () => [])
    await update($, docA, d => (d ? { ...withBaseline(d, d.text), awaitingRevision: false, lastReviewAt: null } : d))
    await update($, noticeA, () => 'Saved comments and questions for this document were cleared.')
  }
}

async function toggleView($: EngineInterface): Promise<void> {
  await update($, docA, d => (d ? { ...d, view: d.view === 'diff' ? ('document' as const) : ('diff' as const) } : d))
  await update($, composerA, () => null)
  void $.ui.scroll({ to: 'start', in: PANE }).catch(() => undefined)
}

/**
 * Scrolls block `at`'s table or code sideways, within 0 to `max`, and makes it
 * the current block: by `by` columns from where it is, or to column `to`.
 * With `cycle` (the `p` key) a move past the right edge goes back to the left.
 */
async function pan(
  $: EngineInterface,
  at: number,
  move: { by: number; cycle?: boolean } | { to: number },
  max: number,
): Promise<void> {
  await update($, docA, d => {
    if (!d) return d
    const from = d.cursor === at ? (d.pan ?? 0) : 0
    const to =
      'to' in move
        ? Math.max(0, Math.min(max, move.to))
        : move.cycle && from >= max
          ? 0
          : Math.max(0, Math.min(max, from + move.by))
    return d.cursor === at && to === from && d.view === 'document' ? d : { ...d, cursor: at, view: 'document' as const, pan: to }
  })
}

/** How far a table or code block can scroll sideways in `room` columns, and by how much a step. */
function panRange(block: DocReviewBlock, room: number): { max: number; step: number } {
  return { max: Math.max(0, unwrappedWidth(block) - room), step: Math.max(8, room - 8) }
}

/** The blocks the pane draws: all of them, or a window around the cursor in a long document. */
function windowOf(n: number, cursor: number): { lo: number; hi: number } {
  if (n <= MAX_DRAWN) return { lo: 0, hi: n }
  const size = WINDOW_HALF * 2 + 1
  const lo = Math.max(0, Math.min(cursor - WINDOW_HALF, n - size))
  return { lo, hi: Math.min(n, lo + size) }
}

/** Takes the current text as the version reviewed: the diff empties. */
async function markReviewed($: EngineInterface): Promise<void> {
  const doc = await read($, docA)
  if (!doc) return
  await update($, docA, d => (d ? { ...withBaseline(d, d.text), view: 'document' as const, awaitingRevision: false } : d))
  await update($, noticeA, () => `Revision ${doc.revision} marked as reviewed.`)
  await persist($)
}

async function openComposer($: EngineInterface, mode: 'comment' | 'ask', blockIndex?: number): Promise<void> {
  const doc = await read($, docA)
  if (!doc || doc.blocks.length === 0) return
  const at = blockIndex ?? doc.cursor
  if (at !== doc.cursor || doc.view !== 'document') await update($, docA, d => (d ? { ...d, cursor: at, view: 'document' as const } : d))
  await update($, composerA, () => ({ blockIndex: at, mode }))
  void $.ui.scroll({ to: { key: `blk:${at}` }, in: PANE, block: 'nearest' }).catch(() => undefined)
  void $.ui.focus({ requestId: PANE, key: 'compose' }).catch(() => undefined)
}

/**
 * The composer for a surface with no text field (mobile): the engine's own
 * dialog, whose "Other" takes free text.
 */
async function composeViaDialog($: EngineInterface, mode: 'comment' | 'ask', via: string, blockIndex?: number): Promise<void> {
  const doc = await read($, docA)
  if (!doc || doc.blocks.length === 0) return
  const at = blockIndex ?? doc.cursor
  const block = doc.blocks[at]
  if (!block) return
  if (at !== doc.cursor) await update($, docA, d => (d ? { ...d, cursor: at } : d))

  const other = mode === 'ask' ? 'Comment instead' : 'Ask instead'
  let answer: string
  try {
    answer = await $.ui.ask(`About "${excerpt(block, 80)}": what is your ${mode === 'ask' ? 'question' : 'comment'}?`, {
      options: ['Cancel', other],
      header: mode === 'ask' ? 'Ask' : 'Comment',
    })
  } catch {
    return
  }
  if (answer === 'Cancel' || answer.trim() === '') return
  if (answer === other) {
    await composeViaDialog($, mode === 'ask' ? 'comment' : 'ask', via, at)
    return
  }
  if (mode === 'ask') await ask($, doc, block, answer.trim(), via)
  else await addComment($, block, answer.trim())
}

async function addComment($: EngineInterface, block: DocReviewBlock, text: string): Promise<void> {
  const comment: DocReviewComment = { id: newId('c'), anchor: anchorFor(block), text, isOrphan: false }
  await update($, commentsA, list => [...list, comment])
  await update($, composerA, () => null)
  await persist($)
}

async function removeComment($: EngineInterface, id: string): Promise<void> {
  await update($, commentsA, list => list.filter(x => x.id !== id))
  await persist($)
}

async function dismissThread($: EngineInterface, id: string): Promise<void> {
  await update($, threadsA, list => list.filter(x => x.id !== id))
  await persist($)
}

async function ask($: EngineInterface, doc: DocReviewDoc, block: DocReviewBlock, question: string, via: string): Promise<void> {
  const thread: DocReviewThread = { id: newId('t'), anchor: anchorFor(block), kind: 'ask', question, status: 'pending' }
  await update($, threadsA, list => [...list, thread])
  await update($, composerA, () => null)

  let reply: ModelForkResult
  let standaloneModel: string | undefined
  let alone: 'no-reply' | 'chosen' | undefined
  const standalone = async (model: string): Promise<ModelForkResult> => {
    const { system, prompt } = buildStandaloneAskPrompt({ path: doc.path, title: doc.title, text: doc.text, block, question })
    return $.model.complete({ model, system, prompt, maxTokens: 800, timeoutMs: 90000 })
  }

  if (via === VIA_SESSION) {
    // Over the conversation's own transcript first: the model already has the
    // document in context and the prefix is cached.
    reply = await $.model.fork({ prompt: buildAskPrompt({ path: doc.path, block, question }) })
    // A fresh session, or one just cleared, has no reply to fork from. Then ask
    // the session's model directly, with the whole document attached.
    if (!reply.isAnswered && reply.reason === 'nothing-to-fork') {
      standaloneModel = await $.session.model()
      alone = 'no-reply'
      reply = await standalone(standaloneModel)
    }
  } else {
    // A fork always runs on the session's model, so another model gets the
    // document alone: no conversation, no cached prefix.
    standaloneModel = via
    alone = 'chosen'
    reply = await standalone(via)
  }

  await update($, threadsA, list =>
    list.map((t): DocReviewThread => {
      if (t.id !== thread.id) return t
      if (reply.isAnswered) {
        return {
          ...t,
          status: 'answered',
          answer: cleanText(reply.text).trim(),
          outputTokens: reply.usage.output_tokens,
          cachedTokens: reply.usage.cache_read_input_tokens,
          ...(standaloneModel ? { model: standaloneModel } : {}),
          ...(alone ? { alone } : {}),
        }
      }
      const why = reply.reason === 'api-error' ? `API error${reply.status ? ` ${reply.status}` : ''} (${reply.error})` : reply.reason
      return { ...t, status: 'failed', failure: why }
    }),
  )
  await persist($)
}

async function submitReview($: EngineInterface): Promise<void> {
  const doc = await read($, docA)
  const comments = await read($, commentsA)
  if (!doc) return
  if (comments.length === 0) {
    $.ui.toast('doc-review: no comments yet. Press c on a block to add one.')
    return
  }
  const text = buildReviewPrompt({ path: doc.path, comments, blocks: doc.blocks })
  const sent = await $.prompt.submit({ text, asUser: true })
  if (sent.drop !== undefined) {
    await update($, noticeA, () => `Review not sent: ${sent.drop}`)
    return
  }
  const now = await $.clock.now()
  await update($, commentsA, () => [])
  // The version reviewed is the one the comments were made on: the next
  // revision diffs against it.
  await update($, docA, d => (d ? { ...withBaseline(d, d.text), awaitingRevision: true, lastReviewAt: now } : d))
  await update($, noticeA, () => `Review sent with ${comments.length} ${comments.length === 1 ? 'comment' : 'comments'}. The pane refreshes when the file changes.`)
  await persist($)
}

async function approve($: EngineInterface, phrase: string): Promise<void> {
  const doc = await read($, docA)
  const comments = await read($, commentsA)
  if (!doc) return
  let notes: DocReviewComment[] = []
  if (comments.length > 0) {
    let choice: string
    try {
      choice = await $.ui.ask(`You have ${comments.length} unsent ${comments.length === 1 ? 'comment' : 'comments'}. Include them with the approval?`, [
        'Include as non-blocking notes',
        'Approve only',
        'Cancel',
      ])
    } catch {
      return
    }
    if (choice === 'Cancel') return
    if (choice === 'Include as non-blocking notes') notes = [...comments]
  }
  const text = buildApprovalPrompt({ path: doc.path, phrase, notes, blocks: doc.blocks })
  const sent = await $.prompt.submit({ text, asUser: true })
  if (sent.drop !== undefined) {
    await update($, noticeA, () => `Approval not sent: ${sent.drop}`)
    return
  }
  const now = await $.clock.now()
  await update($, commentsA, () => [])
  await update($, docA, d => (d ? { ...withBaseline(d, d.text), awaitingRevision: false, lastReviewAt: now } : d))
  await update($, noticeA, () => 'Approval sent.')
  await persist($)
  // The review is over: the pane makes way for the conversation.
  await $.ui.close({ id: PANE })
}

async function escalate($: EngineInterface, thread: DocReviewThread): Promise<void> {
  const doc = await read($, docA)
  if (!doc) return
  const at = reanchor(thread.anchor, doc.blocks)
  const block = at === -1 ? undefined : doc.blocks[at]
  if (!block) return
  const text = buildEscalationPrompt({ path: doc.path, block, question: thread.question, answer: thread.answer })
  const sent = await $.prompt.submit({ text, asUser: true })
  if (sent.drop !== undefined) {
    await update($, noticeA, () => `Not sent: ${sent.drop}`)
    return
  }
  await update($, threadsA, list => list.filter(t => t.id !== thread.id))
  await update($, noticeA, () => 'Question sent to the conversation.')
  await persist($)
}

async function keepAsComment($: EngineInterface, thread: DocReviewThread): Promise<void> {
  const answer = thread.answer ? ` (your side answer was: "${thread.answer.slice(0, 300)}")` : ''
  const comment: DocReviewComment = {
    id: newId('c'),
    anchor: thread.anchor,
    text: `${thread.question}${answer}`,
    isOrphan: false,
  }
  await update($, commentsA, list => [...list, comment])
  await update($, threadsA, list => list.filter(t => t.id !== thread.id))
  await persist($)
}

// ---- drawing ---------------------------------------------------------------

function capMarkdown(text: string): string {
  return text.length > MARKDOWN_CAP ? `${text.slice(0, MARKDOWN_CAP)}\n\n_…block truncated for display…_` : text
}

/** Cut on a line under the element's limit, as a hunk is. */
function capCode(source: string): string {
  if (source.length <= CODE_CAP) return source
  const cut = source.lastIndexOf('\n', CODE_CAP)
  return source.slice(0, cut > 0 ? cut : CODE_CAP)
}

function widthOf(line: string): number {
  return [...line].length
}

/** How wide a table or code block draws unwrapped; 0 for a block that wraps. */
function unwrappedWidth(block: DocReviewBlock): number {
  const lines = unwrappedLines(block)
  return lines ? Math.max(0, ...lines.map(widthOf)) : 0
}

/**
 * One block's content. Prose wraps as Markdown draws it; a table (as an
 * aligned grid) and a code block never wrap: a line wider than `room` is cut
 * at the edge, and `pan` columns scroll it right.
 */
/**
 * `text` from code point `from` on, as Text runs with every occurrence of
 * `query` inverted. Never empty: a line panned past its end is one space.
 */
function marked(t: Table, id: string, text: string, query: string, from = 0): (string | RenderElement)[] {
  const { Text } = t
  const chars = [...text]
  const out: (string | RenderElement)[] = []
  let at = from
  for (const [a, b] of occurrences(text, query)) {
    if (b <= from) continue
    const start = Math.max(a, from)
    if (start > at) out.push(chars.slice(at, start).join(''))
    out.push(
      <Text key={`hit:${id}:${start}`} inverse>
        {chars.slice(start, b).join('')}
      </Text>,
    )
    at = b
  }
  if (at < chars.length) out.push(chars.slice(at).join(''))
  return out.length > 0 ? out : [' ']
}

function drawBody(
  $: EngineInterface,
  t: Table,
  block: DocReviewBlock,
  args: { room: number; pan: number; dim: boolean; isCurrent: boolean; query?: string },
): RenderElement {
  const { Box, Text, Button, Markdown, Code } = t
  const lines = unwrappedLines(block)
  // Markdown has no way to mark a span, so a block holding the find's text is
  // drawn as plain text with each occurrence inverted, while the find lasts.
  if (!lines && args.query) {
    const marker = block.kind === 'item' ? (/^\s*([-*+]|\d{1,3}[.)])\s/.exec(block.text)?.[1] ?? '-') + ' ' : ''
    return (
      <Text dimColor={args.dim} bold={block.kind === 'heading'}>
        {marker}
        {marked(t, `${block.index}`, plainText(block.text), args.query)}
      </Text>
    )
  }
  if (!lines) return <Markdown text={capMarkdown(block.text)} dimColor={args.dim} />

  const language = block.kind === 'code' ? codeParts(block.text).language : undefined
  const width = Math.max(0, ...lines.map(widthOf))
  // Code drops an empty line, so a row scrolled past its end (or a blank line
  // of code) keeps one space: the block holds its height at every pan.
  const shown = lines.map(l => (args.pan > 0 ? [...l].slice(args.pan).join('') : l) || ' ')
  const isWide = width > args.room
  const range = panRange(block, args.room)
  const query = args.query
  return (
    <Box flexDirection="column">
      {query ? (
        // The same lines, panned the same way, as text: Code cannot mark a span.
        lines.map((line, k) => (
          <Text key={`ln:${block.index}:${k}`} dimColor={args.dim} wrap="truncate-end">
            {marked(t, `${block.index}:${k}`, line, query, args.pan)}
          </Text>
        ))
      ) : (
        <Code source={capCode(shown.join('\n'))} {...(language ? { language } : {})} wrap="truncate-end" />
      )}
      {isWide && drawScrollbar($, t, { at: block.index, pan: args.pan, width, room: args.room, ...range })}
    </Box>
  )
}

/**
 * The scrollbar under a wide table or code block: `‹`, a track of pressable
 * segments with the thumb drawn bold, `›`, and the columns in view. A press on
 * a segment centres the thumb there; on a block not yet current it selects it.
 * Buttons, not a Client: they work on every surface and never take the keys.
 */
function drawScrollbar(
  $: EngineInterface,
  t: Table,
  a: { at: number; pan: number; width: number; room: number; max: number; step: number },
): RenderElement {
  const { Box, Text, Button } = t
  // The label takes the room of its widest form, so the track's width never
  // depends on where the block is panned to: the bar holds its size.
  const labelRoom = `${a.width}–${a.width}/${a.width}`.length
  const label = `${a.pan + 1}–${Math.min(a.width, a.pan + a.room)}/${a.width}`.padEnd(labelRoom)
  // ‹, ›, the label and the gaps between them take the rest of the row.
  const track = Math.max(8, a.room - labelRoom - 6)
  // At most 30 segments (each one a Button), each as wide as fills the track.
  const cell = Math.max(2, Math.ceil(track / 30))
  const segments = Math.max(4, Math.floor(track / cell))
  const thumb = Math.max(1, Math.min(segments, Math.round((segments * a.room) / a.width)))
  const travel = segments - thumb
  const start = a.max === 0 || travel === 0 ? 0 : Math.round((travel * a.pan) / a.max)
  const panAt = (k: number) => (travel === 0 ? 0 : Math.round((Math.max(0, Math.min(travel, k - Math.floor(thumb / 2))) * a.max) / travel))

  return (
    <Box flexDirection="row" columnGap={1}>
      <Button key={`pan-left:${a.at}`} plain dimColor={a.pan === 0} label="‹" onPress={() => void pan($, a.at, { by: -a.step }, a.max)} />
      <Box flexDirection="row" flexShrink={0}>
        {Array.from({ length: segments }, (_, k) => {
          const isThumb = k >= start && k < start + thumb
          return (
            <Button
              key={`seg:${a.at}:${k}`}
              plain
              dimColor={!isThumb}
              label={(isThumb ? '━' : '─').repeat(cell)}
              onPress={() => void pan($, a.at, { to: panAt(k) }, a.max)}
            />
          )
        })}
      </Box>
      <Button key={`pan-right:${a.at}`} plain dimColor={a.pan >= a.max} label="›" onPress={() => void pan($, a.at, { by: a.step }, a.max)} />
      <Box flexShrink={0}>
        <Text dimColor wrap="truncate-end">
          {label}
        </Text>
      </Box>
    </Box>
  )
}

function capHunk(hunk: string): string {
  if (hunk.length <= CODE_CAP) return hunk
  // Cut on a line so the hunk still parses; the header stays whole.
  const cut = hunk.lastIndexOf('\n', CODE_CAP)
  return hunk.slice(0, cut > 0 ? cut : CODE_CAP)
}

function drawDiff($: EngineInterface, t: Table, doc: DocReviewDoc, notice: string | null): RenderElement {
  const { Box, Text, Button, Code } = t
  const d = diffText(doc.baselineText, doc.text)

  return (
    <Box flexDirection="column">
      <Box flexDirection="row" gap={1}>
        <Text bold>{doc.title}</Text>
        <Box flexShrink={1}>
          <Text dimColor wrap="truncate-middle">
            {doc.path}
          </Text>
        </Box>
      </Box>
      <Text dimColor>
        diff against the version you reviewed
        {d ? ` · +${d.added} −${d.removed} lines · ${doc.changed.length} ${doc.changed.length === 1 ? 'block' : 'blocks'} changed` : ''}
        {doc.revision > 0 ? ` · revision ${doc.revision}` : ''}
      </Text>
      {notice && <Text color="green">{notice}</Text>}
      <Box flexDirection="row" flexWrap="wrap" columnGap={2} marginBottom={1}>
        <Button key="diff" plain hotkey="d" label="document" onPress={() => void toggleView($)} />
        <Button key="next-change" plain hotkey="r" label="next revised" onPress={() => void nextChange($)} />
        <Button key="reviewed" plain hotkey="v" label="mark viewed" onPress={() => void markReviewed($)} />
        <Button key="close" plain hotkey="q" label="close" onPress={() => void $.ui.close({ id: PANE })} />
      </Box>
      {!d && <Text dimColor>The two versions are too long to diff here.</Text>}
      {d && d.hunks.length === 0 && <Text dimColor>No changes since the version you reviewed.</Text>}
      {d &&
        d.hunks.slice(0, MAX_HUNKS).map((hunk, i) => (
          <Box key={`hunk:${i}`} flexDirection="column" marginBottom={1}>
            <Code source={capHunk(hunk)} format="diff" wrap="wrap" />
          </Box>
        ))}
      {d && d.hunks.length > MAX_HUNKS && <Text dimColor>… {d.hunks.length - MAX_HUNKS} more hunks not shown</Text>}
    </Box>
  )
}

function drawPane(
  $: EngineInterface,
  args: {
    t: Table
    Input: ElementConstructor<InputProps> | null
    doc: DocReviewDoc | null
    comments: readonly DocReviewComment[]
    threads: readonly DocReviewThread[]
    composer: DocReviewComposer
    notice: string | null
    /** Cells across the pane's body. */
    columns: number
    approvePhrase: string
    explainModel: string
    /** The configured default for side questions. */
    askModel: string
    /** Where the next side question goes: this session's pick, else askModel. */
    askVia: string
    /** The first row of the tree the pane's window shows. */
    offset: number
  },
): RenderElement {
  const { t, Input, doc, comments, threads, composer, notice } = args
  const { Box, Text, Button, Markdown } = t

  if (!doc) {
    return (
      <Box flexDirection="column">
        <Text dimColor>No document open. Type /{COMMAND} &lt;path&gt; to review a markdown file.</Text>
        <Button key="close" plain hotkey="q" label="close" onPress={() => void $.ui.close({ id: PANE })} />
      </Box>
    )
  }
  if (doc.view === 'diff') return drawDiff($, t, doc, notice)

  // With a text field the composer draws under the block; without one the
  // engine's dialog takes the text.
  const compose = (mode: 'comment' | 'ask', at?: number) => (Input ? openComposer($, mode, at) : composeViaDialog($, mode, args.askVia, at))

  const n = doc.blocks.length
  const { lo, hi } = windowOf(n, doc.cursor)
  const live = comments.filter(c => !c.isOrphan)
  const orphans = comments.filter(c => c.isOrphan)
  const changed = new Set(doc.changed)
  const matched = new Set(doc.search?.matches ?? [])
  const isFinding = composer?.mode === 'find'
  const isNarrow = args.columns < NARROW
  const gutter = isNarrow ? 2 : 3
  const roomFor = (block: DocReviewBlock) => Math.max(10, args.columns - gutter - (block.depth ?? 0) * 2)

  /**
   * A block's actions: always shown on the current block, shown on any other
   * while the pointer is on it. They sit in the blank row under the block, so
   * nothing moves. An item of a tight list has no blank row under it (the
   * next item starts there and would paint over them), so its actions sit at
   * the right end of its own last line instead, drawn over it.
   */
  const actionRow = (i: number, isCurrent: boolean, isTight: boolean) => {
    const at = doc.blocks[i]
    const place = isTight ? { bottom: 0, right: 0 } : { bottom: -1, left: gutter + (at?.depth ?? 0) * 2 }
    return (
      // Unkeyed: a key would make it a hover scope of its own, and a hidden
      // Box is never under the pointer.
      <Box
        position="absolute"
        {...place}
        flexDirection="row"
        {...(isCurrent ? {} : { display: 'none' as const, hover: { display: 'flex' as const } })}
      >
        {isTight && <Text>{'  '}</Text>}
        <Button key={`act-c:${i}`} plain dimColor label="comment" onPress={() => void compose('comment', i)} />
        <Text dimColor> · </Text>
        <Button key={`act-a:${i}`} plain dimColor label="ask" onPress={() => void compose('ask', i)} />
        <Text dimColor> · </Text>
        <Button key={`act-h:${i}`} plain dimColor label="explain" onPress={() => void explain($, args.explainModel, i)} />
      </Box>
    )
  }

  const rows: RenderElement[] = []
  for (let i = lo; i < hi; i += 1) {
    const block = doc.blocks[i]
    if (!block) continue
    const isCurrent = i === doc.cursor
    const isChanged = changed.has(i)
    const own = live.filter(c => c.anchor.blockIndex === i)
    const ownThreads = threads.filter(th => th.anchor.blockIndex === i)
    const indent = (block.depth ?? 0) * 2
    // Items of one list sit tight, as the list would.
    // The current one keeps its gap: its actions sit there.
    const isTight = block.kind === 'item' && doc.blocks[i + 1]?.kind === 'item' && !isCurrent
    const under = gutter + indent

    rows.push(
      <Box key={`blk:${i}`} flexDirection="column" marginBottom={isTight ? 0 : 1}>
        <Box key={`pre:${i}`} position="absolute" top={-BAR_ROWS} left={0} width={1} height={1} />
        <Box flexDirection="row">
          <Box width={gutter}>
            <Button
              key={`b:${i}`}
              plain
              dimColor={!isCurrent && !isChanged}
              label={isCurrent ? '▶' : isChanged ? '+' : '·'}
              hover={{ dimColor: false, bold: true }}
              // A click selects the block; on the current one (Enter after Tab, a second click) it comments.
              onPress={() => void (isCurrent ? compose('comment', i) : setCursor($, i))}
            />
          </Box>
          <Box flexDirection="column" flexGrow={1} flexShrink={1} marginLeft={indent}>
            {drawBody($, t, block, {
              room: roomFor(block),
              pan: isCurrent ? (doc.pan ?? 0) : 0,
              dim: !isCurrent && composer !== null && composer.mode !== 'find',
              isCurrent,
              ...(doc.search && matched.has(i) ? { query: doc.search.query } : {}),
            })}
          </Box>
        </Box>
        {own.map(c => (
          <Box key={`cm:${c.id}`} flexDirection="row" marginLeft={under}>
            <Text color="yellow">✎ </Text>
            <Box flexGrow={1}>
              <Text color="yellow" wrap="wrap">
                {c.text}
              </Text>
            </Box>
            <Button key={`rm:${c.id}`} plain dimColor label="✕" onPress={() => void removeComment($, c.id)} />
          </Box>
        ))}
        {ownThreads.map(th => (
          <Box key={`th:${th.id}`} flexDirection="column" marginLeft={under}>
            <Text color="cyan" wrap="wrap">
              {th.kind === 'explain' ? 'ⓘ' : '?'} {th.question}
              {th.kind === 'explain' && th.model ? ` (${th.model})` : ''}
              {th.kind === 'ask' && th.model
                ? th.alone === 'chosen'
                  ? ` (answered by ${th.model} from the document alone)`
                  : ` (answered by ${th.model} from the document alone: the conversation had no reply yet)`
                : ''}
            </Text>
            {th.status === 'pending' && <Text dimColor>{th.kind === 'explain' ? 'explaining…' : 'asking…'}</Text>}
            {th.status === 'failed' && <Text color="red">could not ask: {th.failure ?? 'unknown'}</Text>}
            {th.status === 'answered' && <Markdown text={capMarkdown(th.answer ?? '')} dimColor />}
            {th.status !== 'pending' && (
              <Box flexDirection="row" gap={1}>
                {th.kind === 'ask' && <Button key={`keep:${th.id}`} plain label="keep as comment" onPress={() => void keepAsComment($, th)} />}
                {th.kind === 'ask' && <Button key={`send:${th.id}`} plain label="send to conversation" onPress={() => void escalate($, th)} />}
                <Button key={`drop:${th.id}`} plain dimColor label="dismiss" onPress={() => void dismissThread($, th.id)} />
                {th.status === 'answered' && th.outputTokens !== undefined && (
                  <Text dimColor>
                    {th.outputTokens} out · {th.cachedTokens ?? 0} cached
                  </Text>
                )}
              </Box>
            )}
          </Box>
        ))}
        {composer && composer.mode !== 'find' && composer.blockIndex === i && Input && (
          <Box flexDirection="row" marginLeft={under} gap={1}>
            <Input
              key="compose"
              autoFocus
              label={composer.mode === 'ask' ? 'ask' : 'comment'}
              placeholder={composer.mode === 'ask' ? 'a question about this passage' : 'what should change here'}
              submitLabel={composer.mode === 'ask' ? 'ask' : 'add'}
              onSubmit={value => {
                const text = value.trim()
                if (text === '') return
                if (composer.mode === 'ask') void ask($, doc, block, text, args.askVia)
                else void addComment($, block, text)
              }}
            />
            {composer.mode === 'ask' && (
              <Button
                key="ask-via"
                plain
                dimColor
                label={viaLabel(args.askVia)}
                onPress={() => {
                  const choices = askChoices(args.askModel)
                  const next = choices[(choices.indexOf(args.askVia) + 1) % choices.length]!
                  void update($, askViaA, () => next)
                }}
              />
            )}
            <Button key="cancel" plain dimColor label="cancel" onPress={() => void update($, composerA, () => null)} />
          </Box>
        )}
        {actionRow(i, isCurrent, isTight)}
      </Box>,
    )
  }

  const current = doc.blocks[doc.cursor]
  const currentWidth = current ? unwrappedWidth(current) : 0
  const { max: panMax, step: panStep } = current ? panRange(current, roomFor(current)) : { max: 0, step: 8 }

  return (
    <Box flexDirection="column">
      {/* Room for the bar at the top while the find field is open. */}
      {isFinding && Input && <Box key="find-room" height={BAR_ROWS} />}
      <Box flexDirection={isNarrow ? 'column' : 'row'} columnGap={1}>
        <Text bold>{doc.title}</Text>
        <Box flexShrink={1}>
          <Text dimColor wrap="truncate-middle">
            {doc.path}
          </Text>
        </Box>
      </Box>
      <Text dimColor>
        block {Math.min(doc.cursor + 1, n)}/{n} · {live.length} {live.length === 1 ? 'comment' : 'comments'}
        {orphans.length > 0 ? ` (${orphans.length} orphaned)` : ''}
        {threads.length > 0 ? ` · ${threads.length} ${threads.length === 1 ? 'question' : 'questions'}` : ''}
        {doc.revision > 0 ? ` · revision ${doc.revision}` : ''}
        {doc.changed.length > 0 ? ` · ${doc.changed.length} changed since reviewed` : ''}
        {doc.awaitingRevision ? ' · awaiting revision' : ''}
        {doc.search
          ? ` · find "${doc.search.query}" ${doc.search.matches.length === 0 ? 'no matches' : `${Math.max(1, doc.search.matches.indexOf(doc.cursor) + 1)}/${doc.search.matches.length}`}`
          : ''}
      </Text>
      {notice && <Text color="green">{notice}</Text>}
      <Box flexDirection="row" flexWrap="wrap" columnGap={2} marginBottom={1}>
        <Button key="next" plain hotkey="j" label="next" onPress={() => void moveCursor($, 1)} />
        <Button key="prev" plain hotkey="k" label="prev" onPress={() => void moveCursor($, -1)} />
        <Button key="top" plain hotkey="g" label="top" onPress={() => void moveCursor($, () => 0)} />
        <Button key="end" plain hotkey="e" label="end" onPress={() => void moveCursor($, (_, n) => n - 1)} />
        <Button key="find" plain hotkey="f" label="find" onPress={() => void openFind($)} />
        {doc.search && doc.search.matches.length > 0 && composer?.mode !== 'find' && (
          <Button key="find-next" plain hotkey="n" label="next match" onPress={() => void findNext($)} />
        )}
        {doc.search && doc.search.matches.length > 0 && composer?.mode !== 'find' && (
          <Button key="find-prev" plain hotkey="p" label="prev match" onPress={() => void findPrev($)} />
        )}
        <Button key="next-comment" plain hotkey="m" label="next comment" onPress={() => void nextComment($)} />
        <Button key="comment" plain hotkey="c" label="comment" onPress={() => void compose('comment')} />
        <Button key="ask" plain hotkey="a" label="ask" onPress={() => void compose('ask')} />
        <Button key="explain" plain hotkey="i" label="explain" onPress={() => void explain($, args.explainModel)} />
        <Button key="submit" plain hotkey="s" label={`submit review${live.length > 0 ? ` (${live.length})` : ''}`} onPress={() => void submitReview($)} />
        <Button key="approve" plain hotkey="y" label="approve" onPress={() => void approve($, args.approvePhrase)} />
        {panMax > 0 && <Button key="pan-back" plain hotkey="h" label="pan left" onPress={() => void pan($, doc.cursor, { by: -panStep }, panMax)} />}
        {panMax > 0 && <Button key="pan" plain hotkey="l" label="pan right" onPress={() => void pan($, doc.cursor, { by: panStep, cycle: true }, panMax)} />}
        {doc.changed.length > 0 && <Button key="next-change" plain hotkey="r" label="next revised" onPress={() => void nextChange($)} />}
        {doc.changed.length > 0 && <Button key="diff" plain hotkey="d" label="diff" onPress={() => void toggleView($)} />}
        {doc.changed.length > 0 && <Button key="reviewed" plain hotkey="v" label="mark viewed" onPress={() => void markReviewed($)} />}
        <Button key="close" plain hotkey="q" label="close" onPress={() => void $.ui.close({ id: PANE })} />
      </Box>
      {composer?.mode === 'find' && !Input && <Text dimColor>This surface has no text field for find.</Text>}
      {doc.search && composer?.mode !== 'find' && (
        <Box flexDirection="row" gap={1} marginBottom={1}>
          <Text dimColor>
            find "{doc.search.query}": {doc.search.matches.length} {doc.search.matches.length === 1 ? 'block' : 'blocks'}
          </Text>
          <Button key="find-clear" plain dimColor label="clear" onPress={() => void clearFind($)} />
        </Box>
      )}
      {lo > 0 && <Text dimColor>… {lo} more above (k to move up)</Text>}
      {rows}
      {hi < n && <Text dimColor>… {n - hi} more below (j to move down)</Text>}
      {orphans.length > 0 && (
        <Box flexDirection="column" marginTop={1}>
          <Text dimColor>Comments whose passage no longer appears (still sent with the review):</Text>
          {orphans.map(c => (
            <Box key={`orphan:${c.id}`} flexDirection="row">
              <Text dimColor wrap="wrap">
                ✎ {c.anchor.quote.slice(0, 60)}… : {c.text}
              </Text>
              <Button key={`rm:${c.id}`} plain dimColor label="✕" onPress={() => void removeComment($, c.id)} />
            </Box>
          ))}
        </Box>
      )}
      {(args.offset > 0 || isFinding) &&
        drawStickyBar($, t, {
          offset: args.offset,
          columns: args.columns,
          status: `block ${Math.min(doc.cursor + 1, n)}/${n} · ${live.length} ${live.length === 1 ? 'comment' : 'comments'}${
            doc.search
              ? ` · find "${doc.search.query}" ${doc.search.matches.length === 0 ? 'no matches' : `${Math.max(1, doc.search.matches.indexOf(doc.cursor) + 1)}/${doc.search.matches.length}`}`
              : ''
          }`,
          hasMatches: (doc.search?.matches.length ?? 0) > 0,
          // The find field rides in the bar, so it shows wherever the pane is
          // scrolled to, with the match Enter goes to previewed above it.
          preview: isFinding ? findPreview(t, doc, composer?.blockIndex ?? doc.cursor, args.columns) : null,
          finder:
            isFinding && Input ? (
              <Box flexDirection="row" gap={1} height={1}>
                <Input
                  key="find-field"
                  autoFocus
                  label="find"
                  placeholder="text to look for in the document"
                  submitLabel="done"
                  value={composer?.initial ?? ''}
                  onInput={value => void findAsYouType($, value)}
                  onSubmit={value => void runFind($, value)}
                />
                <Button key="find-cancel" plain dimColor label="cancel" onPress={() => void cancelFind($)} />
              </Box>
            ) : null,
          compose,
          explain: () => void explain($, args.explainModel),
          submitLabel: `submit review${live.length > 0 ? ` (${live.length})` : ''}`,
        })}
    </Box>
  )
}

/** One row while typing a find: the match Enter goes to, its text around the hit marked. */
function findPreview(t: Table, doc: DocReviewDoc, origin: number, columns: number): RenderElement {
  const { Text } = t
  const search = doc.search
  if (!search) return <Text dimColor>typing finds as you go · Enter jumps to the match · cancel</Text>
  const at = nextMatchFrom(search.matches, origin)
  const block = at === undefined ? undefined : doc.blocks[at]
  if (at === undefined || !block) return <Text dimColor>find "{search.query}": no matches</Text>
  const lines = unwrappedLines(block) ?? [plainText(block.text)]
  const line = lines.find(l => occurrences(l, search.query).length > 0) ?? lines[0] ?? ''
  const hit = occurrences(line, search.query)[0]?.[0] ?? 0
  const from = Math.max(0, hit - 24)
  const head = `${search.matches.indexOf(at) + 1}/${search.matches.length} · block ${at + 1} · ${from > 0 ? '…' : ''}`
  return (
    <Text wrap="truncate-end">
      <Text dimColor>{head}</Text>
      {marked(t, 'preview', [...line].slice(from, from + columns).join('').trim(), search.query)}
    </Text>
  )
}

/**
 * The pane's top rows once it is scrolled: where it is and the main actions,
 * drawn over the document at the window's first row. The engine owns the
 * scroll and draws again at each move, so the bar rides along. Mouse only:
 * the hotkeys live on the header, which stays mounted above the window.
 */
function drawStickyBar(
  $: EngineInterface,
  t: Table,
  a: {
    offset: number
    columns: number
    status: string
    hasMatches: boolean
    /** The status row while finding: the match Enter goes to. */
    preview: RenderElement | null
    /** The find field, drawn in the bar while finding. */
    finder: RenderElement | null
    compose: (mode: 'comment' | 'ask') => unknown
    explain: () => void
    submitLabel: string
  },
): RenderElement {
  const { Box, Text, Button } = t
  const blank = ' '.repeat(a.columns)
  return (
    <Box key="sticky-bar" position="absolute" top={a.offset} left={0} width={a.columns} height={BAR_ROWS} flexDirection="column">
      {/* Spaces first, so nothing of the document shows between the buttons. */}
      <Box position="absolute" top={0} left={0} flexDirection="column">
        {Array.from({ length: BAR_ROWS }, (_, k) => (
          <Text key={`bar-blank:${k}`}>{blank}</Text>
        ))}
      </Box>
      {a.preview ?? (
        <Text dimColor wrap="truncate-end">
          {a.status}
        </Text>
      )}
      {a.finder ?? (
      <Box flexDirection="row" columnGap={2} overflow="hidden" height={1}>
        <Button key="bar:next" plain label="next" onPress={() => void moveCursor($, 1)} />
        <Button key="bar:prev" plain label="prev" onPress={() => void moveCursor($, -1)} />
        <Button key="bar:find" plain label="find" onPress={() => void openFind($)} />
        {a.hasMatches && <Button key="bar:find-next" plain label="next match" onPress={() => void findNext($)} />}
        {a.hasMatches && <Button key="bar:find-prev" plain label="prev match" onPress={() => void findPrev($)} />}
        <Button key="bar:comment" plain label="comment" onPress={() => void a.compose('comment')} />
        <Button key="bar:ask" plain label="ask" onPress={() => void a.compose('ask')} />
        <Button key="bar:explain" plain label="explain" onPress={a.explain} />
        <Button key="bar:submit" plain label={a.submitLabel} onPress={() => void submitReview($)} />
        <Button key="bar:top" plain label="top" onPress={() => void moveCursor($, () => 0)} />
      </Box>
      )}
      <Text dimColor wrap="truncate-end">
        {'─'.repeat(a.columns)}
      </Text>
    </Box>
  )
}

// ---- hooks -----------------------------------------------------------------

export const register: Register = (on, options) => {
  const globs = String(options.globs ?? DEFAULT_GLOBS)
    .split(',')
    .map(g => g.trim())
    .filter(g => g !== '')
    .map(globToRegExp)
  const offer = String(options.offer ?? 'auto')
  const approvePhrase = String(options.approvePhrase ?? 'Looks good, proceed.')
  const explainModel = String(options.explainModel ?? 'haiku')
  const askModel = String(options.askModel ?? VIA_SESSION).trim() || VIA_SESSION

  const matches = (cwd: string, path: string): boolean => {
    const rel = relativeTo(cwd, path)
    return globs.some(g => g.test(rel))
  }

  on('session.start', async ($, e, next) => {
    await $.command.register({
      name: COMMAND,
      description: 'Review a spec or plan: move by block, comment, ask, submit one review',
      argumentHint: '[path] | forget [path]',
    })
    return next(e)
  })

  on('command.run', { command: COMMAND }, async ($, e) => {
    let path = e.args.trim()

    const forget = /^forget(?:\s+(.*))?$/.exec(path)
    if (forget) {
      const target = argPath(forget[1] ?? '') || (await read($, docA))?.path || ''
      if (target === '') return { text: `nothing to forget. Usage: /${COMMAND} forget [path]` }
      await forgetDoc($, target)
      return { text: `cleared the saved comments and questions for ${target}.` }
    }

    path = argPath(path)
    if (path === '') {
      const doc = await read($, docA)
      path = doc?.path ?? latest(await read($, candidatesA))?.path ?? ''
    }
    if (path === '') {
      return { text: `nothing to review yet. Usage: /${COMMAND} <path-to-markdown>` }
    }
    if (!(await $.fs.exists(path))) {
      return { text: `${path} does not exist.` }
    }
    const opened = await openDoc($, path, true)
    if (!opened.isPlaced) return { text: `the pane is not placed: ${opened.reason}` }
    return {
      text: `Reviewing ${path}. In the pane: j/k move, f find (n/p next/prev match), c comment, a ask, i explain, s submit review, y approve, d diff, q close. Tab also walks the blocks.`,
    }
  })

  on('tool.call', { tool: ['Write', 'Edit'] }, async ($, e, next) => {
    const ran = await next(e)
    if (ran.deny !== undefined || ran.isError === true) return ran

    const cwd = await $.session.cwd()
    const doc = await read($, docA)
    if (doc && samePath(cwd, doc.path, e.file_path)) {
      await refreshDoc($)
    } else if (matches(cwd, e.file_path)) {
      const writtenAt = await $.clock.now()
      const turn = await $.session.turns()
      await update($, candidatesA, list => [...list.filter(c => !samePath(cwd, c.path, e.file_path)), { path: e.file_path, writtenAt, turn }].slice(-20))
    }
    return ran
  })

  on('turn.complete', async ($, e, next) => {
    const done = await next(e)
    if (e.agentId !== undefined || offer === 'off') return done

    // A document written more than two turns ago is no longer what a review
    // request means; forget it rather than open something stale.
    const turn = await $.session.turns()
    const candidates = (await read($, candidatesA)).filter(c => turn - c.turn <= CANDIDATE_TURNS)
    if (candidates.length === 0) {
      await update($, candidatesA, () => [])
      return done
    }

    const named = candidates.find(c => e.answer.includes(basename(c.path)))
    const pick = named ?? (REVIEW_ASKED.test(e.answer) ? latest(candidates) : undefined)
    if (!pick) return done

    await update($, candidatesA, () => [])
    const offered = await read($, offeredA)
    if (offered.includes(pick.path)) return done
    await update($, offeredA, list => [...list, pick.path])

    const cwd = await $.session.cwd()
    const shown = relativeTo(cwd, pick.path)
    if (offer === 'toast') {
      $.ui.toast(`Spec ready for review: /${COMMAND} ${shown}`)
      $.ui.status(`spec ready: /${COMMAND}`)
      return done
    }
    const opened = await openDoc($, pick.path, false)
    if (!opened.isPlaced) {
      $.ui.toast(`Spec ready for review: /${COMMAND} ${shown}`)
      $.ui.status(`spec ready: /${COMMAND}`)
    }
    return done
  })

  on('ui.focus', { requestId: PANE }, async ($, e, next) => {
    // A block's marker or one of its actions: the block becomes the current one,
    // which also shows its actions should the focus land on a hidden one.
    const m = /^(?:b|act-[cah]):(\d+)$|^(?:seg|pan-left|pan-right):(\d+)/.exec(e.element ?? '')
    if (m) {
      const cursor = Number(m[1] ?? m[2])
      await update($, docA, d => (d && d.cursor !== cursor ? { ...d, cursor, pan: 0 } : d))
    }
    return next(e)
  })

  // The wheel at the edge of what is drawn, in a document too long to draw
  // whole: move the window on by taking the cursor to the first block past it.
  on('ui.scroll', { requestId: PANE }, async ($, e, next) => {
    if (e.origin.kind !== 'person' || !e.pointer) return next(e)
    const doc = await read($, docA)
    if (!doc || doc.view !== 'document') return next(e)
    const { lo, hi } = windowOf(doc.blocks.length, doc.cursor)
    const atBottom = e.by > 0 && e.offset >= Math.max(0, e.contentRows - e.bodyRows)
    const atTop = e.by < 0 && e.offset <= 0
    if (atBottom && hi < doc.blocks.length) {
      await setCursor($, hi)
      return {}
    }
    if (atTop && lo > 0) {
      await setCursor($, lo - 1)
      return {}
    }
    return next(e)
  })

  on('ui.close', { id: PANE }, async ($, e, next) => {
    await update($, composerA, () => null)
    return next(e)
  })

  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => {
    const [doc, comments, threads, composer, notice, picked] = await Promise.all([
      read($, docA),
      read($, commentsA),
      read($, threadsA),
      read($, composerA),
      read($, noticeA),
      read($, askViaA),
    ])
    const columns = e.props.bodyColumns ?? e.viewport?.columns ?? 80
    lastColumns = columns
    const offset = e.props.scroll?.offset ?? 0
    const common = { doc, comments, threads, composer, notice, columns, approvePhrase, explainModel, askModel, askVia: picked ?? askModel, offset }

    if (e.surface === 'mobile') {
      const t = $.ui.resolve(e)
      return drawPane($, { ...common, t, Input: null })
    }
    const t = $.ui.resolve(e)
    return drawPane($, { ...common, t, Input: t.Input })
  })
}
