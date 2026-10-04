// spec-review: review a design spec or implementation plan in a pane.
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
  Register,
  RenderElement,
  TextProps,
} from 'claude-code'

import type {
  SpecReviewBlock,
  SpecReviewCandidate,
  SpecReviewComment,
  SpecReviewComposer,
  SpecReviewDoc,
  SpecReviewThread,
} from '../types'
import { anchorFor, basename, cleanText, excerpt, parseBlocks, plainText, reanchor, titleOf } from './blocks'
import { changedBlocks, diffText } from './diff'
import { STORE_PREFIX, isSaved, keysToEvict, storeKey, toSaved } from './persist'
import { buildApprovalPrompt, buildAskPrompt, buildEscalationPrompt, buildExplainPrompt, buildReviewPrompt } from './review-prompt'

const PLUGIN = 'spec-review'
const PANE = 'spec-review'
const COMMAND = 'review'

const DEFAULT_GLOBS =
  'docs/superpowers/specs/**/*.md,docs/superpowers/plans/**/*.md,docs/plans/**/*.md,docs/specs/**/*.md,**/*-design.md,**/*-plan.md,SPEC.md,PLAN.md'
const REVIEW_ASKED = /please (review|take a look)|review (it|the (plan|spec|design|document))|let me know if you want (to make )?(any )?changes/i
const MARKDOWN_CAP = 9000
const CODE_CAP = 9000
const MAX_HUNKS = 40
const CANDIDATE_TURNS = 2

const docA = atom({ plugin: 'spec-review', key: 'doc' } as const, null)
const commentsA = atom({ plugin: 'spec-review', key: 'comments' } as const, [])
const threadsA = atom({ plugin: 'spec-review', key: 'threads' } as const, [])
const composerA = atom({ plugin: 'spec-review', key: 'composer' } as const, null)
const candidatesA = atom({ plugin: 'spec-review', key: 'candidates' } as const, [])
const offeredA = atom({ plugin: 'spec-review', key: 'offered' } as const, [])
const noticeA = atom({ plugin: 'spec-review', key: 'notice' } as const, null)

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

function withBaseline(doc: Omit<SpecReviewDoc, 'changed'>, baselineText: string): SpecReviewDoc {
  const changed = baselineText === doc.text ? [] : changedBlocks(doc.blocks, parseBlocks(baselineText))
  return { ...doc, baselineText, changed }
}

async function reanchorAll($: EngineInterface, blocks: readonly SpecReviewBlock[]): Promise<void> {
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

function latest(list: readonly SpecReviewCandidate[]): SpecReviewCandidate | undefined {
  return [...list].sort((a, b) => b.writtenAt - a.writtenAt)[0]
}

function newId(prefix: string): string {
  return `${prefix}-${Math.random().toString(36).slice(2, 10)}`
}

// ---- actions ---------------------------------------------------------------

async function setCursor($: EngineInterface, cursor: number): Promise<void> {
  await update($, docA, d => (d && d.cursor !== cursor ? { ...d, cursor, view: 'document' as const } : d))
  void $.ui.scroll({ to: { key: `blk:${cursor}` }, in: PANE, block: 'nearest' }).catch(() => undefined)
  void $.ui.focus({ requestId: PANE, key: `b:${cursor}` }).catch(() => undefined)
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
    $.ui.toast('spec-review: nothing differs from the version you reviewed.')
    return
  }
  const after = doc.changed.find(i => i > doc.cursor)
  await setCursor($, after ?? doc.changed[0] ?? doc.cursor)
}

function findMatches(blocks: readonly SpecReviewBlock[], query: string): number[] {
  const q = query.trim().toLowerCase()
  if (q === '') return []
  return blocks.filter(b => plainText(b.text).toLowerCase().includes(q)).map(b => b.index)
}

/** Sets the find text and moves to its first match at or after the cursor. */
async function runFind($: EngineInterface, query: string): Promise<void> {
  const doc = await read($, docA)
  if (!doc) return
  const matches = findMatches(doc.blocks, query)
  await update($, docA, d => (d ? { ...d, search: query.trim() === '' ? null : { query: query.trim(), matches } } : d))
  await update($, composerA, () => null)
  if (query.trim() === '') return
  if (matches.length === 0) {
    $.ui.toast(`spec-review: no block contains "${query.trim()}".`)
    return
  }
  await setCursor($, matches.find(i => i >= doc.cursor) ?? matches[0] ?? doc.cursor)
}

/** `f`: opens the find field, or with a find set moves to its next match. */
async function findNext($: EngineInterface): Promise<void> {
  const doc = await read($, docA)
  if (!doc) return
  const composer = await read($, composerA)
  if (!doc.search || doc.search.matches.length === 0 || composer?.mode === 'find') {
    await update($, docA, d => (d ? { ...d, view: 'document' as const } : d))
    await update($, composerA, () => ({ blockIndex: doc.cursor, mode: 'find' as const }))
    void $.ui.focus({ requestId: PANE, key: 'find' }).catch(() => undefined)
    return
  }
  const after = doc.search.matches.find(i => i > doc.cursor)
  await setCursor($, after ?? doc.search.matches[0] ?? doc.cursor)
}

async function clearFind($: EngineInterface): Promise<void> {
  await update($, docA, d => (d ? { ...d, search: null } : d))
  await update($, composerA, c => (c?.mode === 'find' ? null : c))
}

/** `m`: the next block after the cursor that carries a comment or a question, wrapping. */
async function nextComment($: EngineInterface): Promise<void> {
  const doc = await read($, docA)
  if (!doc) return
  const comments = await read($, commentsA)
  const threads = await read($, threadsA)
  const marked = [...new Set([...comments.filter(c => !c.isOrphan).map(c => c.anchor.blockIndex), ...threads.map(t => t.anchor.blockIndex)])].sort((a, b) => a - b)
  if (marked.length === 0) {
    $.ui.toast('spec-review: no comments or questions yet.')
    return
  }
  const after = marked.find(i => i > doc.cursor)
  await setCursor($, after ?? marked[0] ?? doc.cursor)
}

/** `h`: a plain-words explanation of the current block from a small, fresh model. */
async function explain($: EngineInterface, model: string): Promise<void> {
  const doc = await read($, docA)
  if (!doc) return
  const block = doc.blocks[doc.cursor]
  if (!block) return
  const thread: SpecReviewThread = {
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
    list.map((t): SpecReviewThread => {
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
async function composeViaDialog($: EngineInterface, mode: 'comment' | 'ask', blockIndex?: number): Promise<void> {
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
    await composeViaDialog($, mode === 'ask' ? 'comment' : 'ask', at)
    return
  }
  if (mode === 'ask') await ask($, doc, block, answer.trim())
  else await addComment($, block, answer.trim())
}

async function addComment($: EngineInterface, block: SpecReviewBlock, text: string): Promise<void> {
  const comment: SpecReviewComment = { id: newId('c'), anchor: anchorFor(block), text, isOrphan: false }
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

async function ask($: EngineInterface, doc: SpecReviewDoc, block: SpecReviewBlock, question: string): Promise<void> {
  const thread: SpecReviewThread = { id: newId('t'), anchor: anchorFor(block), kind: 'ask', question, status: 'pending' }
  await update($, threadsA, list => [...list, thread])
  await update($, composerA, () => null)

  const reply = await $.model.fork({ prompt: buildAskPrompt({ path: doc.path, block, question }) })
  await update($, threadsA, list =>
    list.map((t): SpecReviewThread => {
      if (t.id !== thread.id) return t
      if (reply.isAnswered) {
        return {
          ...t,
          status: 'answered',
          answer: cleanText(reply.text).trim(),
          outputTokens: reply.usage.output_tokens,
          cachedTokens: reply.usage.cache_read_input_tokens,
        }
      }
      const why =
        reply.reason === 'nothing-to-fork'
          ? 'nothing to ask yet: the conversation has no reply to build on'
          : reply.reason === 'api-error'
            ? `API error${reply.status ? ` ${reply.status}` : ''} (${reply.error})`
            : reply.reason
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
    $.ui.toast('spec-review: no comments yet. Press c on a block to add one.')
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
  let notes: SpecReviewComment[] = []
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
}

async function escalate($: EngineInterface, thread: SpecReviewThread): Promise<void> {
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

async function keepAsComment($: EngineInterface, thread: SpecReviewThread): Promise<void> {
  const answer = thread.answer ? ` (your side answer was: "${thread.answer.slice(0, 300)}")` : ''
  const comment: SpecReviewComment = {
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

function capHunk(hunk: string): string {
  if (hunk.length <= CODE_CAP) return hunk
  // Cut on a line so the hunk still parses; the header stays whole.
  const cut = hunk.lastIndexOf('\n', CODE_CAP)
  return hunk.slice(0, cut > 0 ? cut : CODE_CAP)
}

function drawDiff($: EngineInterface, t: Table, doc: SpecReviewDoc, notice: string | null): RenderElement {
  const { Box, Text, Button, Code } = t
  const d = diffText(doc.baselineText, doc.text)

  return (
    <Box flexDirection="column">
      <Box flexDirection="row" gap={1}>
        <Text bold>{doc.title}</Text>
        <Text dimColor>{doc.path}</Text>
      </Box>
      <Text dimColor>
        diff against the version you reviewed
        {d ? ` · +${d.added} −${d.removed} lines · ${doc.changed.length} ${doc.changed.length === 1 ? 'block' : 'blocks'} changed` : ''}
        {doc.revision > 0 ? ` · revision ${doc.revision}` : ''}
      </Text>
      {notice && <Text color="green">{notice}</Text>}
      <Box flexDirection="row" gap={2} marginBottom={1}>
        <Button key="diff" plain hotkey="d" label="document" onPress={() => void toggleView($)} />
        <Button key="next-change" plain hotkey="n" label="next change" onPress={() => void nextChange($)} />
        <Button key="reviewed" plain hotkey="r" label="mark reviewed" onPress={() => void markReviewed($)} />
        <Button key="close" plain hotkey="x" label="close" onPress={() => void $.ui.close({ id: PANE })} />
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
    doc: SpecReviewDoc | null
    comments: readonly SpecReviewComment[]
    threads: readonly SpecReviewThread[]
    composer: SpecReviewComposer
    notice: string | null
    bodyRows: number
    approvePhrase: string
    explainModel: string
  },
): RenderElement {
  const { t, Input, doc, comments, threads, composer, notice } = args
  const { Box, Text, Button, Markdown } = t

  if (!doc) {
    return (
      <Box flexDirection="column">
        <Text dimColor>No document open. Type /{COMMAND} &lt;path&gt; to review a markdown file.</Text>
        <Button key="close" plain hotkey="x" label="close" onPress={() => void $.ui.close({ id: PANE })} />
      </Box>
    )
  }
  if (doc.view === 'diff') return drawDiff($, t, doc, notice)

  // With a text field the composer draws under the block; without one the
  // engine's dialog takes the text.
  const compose = (mode: 'comment' | 'ask', at?: number) => (Input ? openComposer($, mode, at) : composeViaDialog($, mode, at))

  const n = doc.blocks.length
  const half = Math.max(10, Math.floor(args.bodyRows / 3))
  const showAll = n <= half * 2 + 1
  const lo = showAll ? 0 : Math.max(0, Math.min(doc.cursor - half, n - (half * 2 + 1)))
  const hi = showAll ? n : Math.min(n, lo + half * 2 + 1)
  const live = comments.filter(c => !c.isOrphan)
  const orphans = comments.filter(c => c.isOrphan)
  const changed = new Set(doc.changed)

  const rows: RenderElement[] = []
  for (let i = lo; i < hi; i += 1) {
    const block = doc.blocks[i]
    if (!block) continue
    const isCurrent = i === doc.cursor
    const isChanged = changed.has(i)
    const own = live.filter(c => c.anchor.blockIndex === i)
    const ownThreads = threads.filter(th => th.anchor.blockIndex === i)

    rows.push(
      <Box key={`blk:${i}`} flexDirection="column" marginBottom={1}>
        <Box flexDirection="row">
          <Box width={3}>
            <Button
              key={`b:${i}`}
              plain
              dimColor={!isCurrent && !isChanged}
              label={isCurrent ? '▶' : isChanged ? '+' : '·'}
              hover={{ dimColor: false, bold: true }}
              onPress={() => void compose('comment', i)}
            />
          </Box>
          <Box flexDirection="column" flexGrow={1}>
            <Markdown text={capMarkdown(block.text)} dimColor={!isCurrent && composer !== null} />
          </Box>
        </Box>
        {own.map(c => (
          <Box key={`cm:${c.id}`} flexDirection="row" marginLeft={3}>
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
          <Box key={`th:${th.id}`} flexDirection="column" marginLeft={3}>
            <Text color="cyan" wrap="wrap">
              {th.kind === 'explain' ? 'ⓘ' : '?'} {th.question}
              {th.kind === 'explain' && th.model ? ` (${th.model})` : ''}
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
          <Box flexDirection="row" marginLeft={3} gap={1}>
            <Input
              key="compose"
              autoFocus
              label={composer.mode === 'ask' ? 'ask:' : 'comment:'}
              placeholder={composer.mode === 'ask' ? 'a question about this passage' : 'what should change here'}
              submitLabel={composer.mode === 'ask' ? 'ask' : 'add'}
              onSubmit={value => {
                const text = value.trim()
                if (text === '') return
                if (composer.mode === 'ask') void ask($, doc, block, text)
                else void addComment($, block, text)
              }}
            />
            <Button key="cancel" plain dimColor label="cancel" onPress={() => void update($, composerA, () => null)} />
          </Box>
        )}
      </Box>,
    )
  }

  return (
    <Box flexDirection="column">
      <Box flexDirection="row" gap={1}>
        <Text bold>{doc.title}</Text>
        <Text dimColor>{doc.path}</Text>
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
      <Box flexDirection="row" gap={2} marginBottom={1}>
        <Button key="next" plain hotkey="j" label="next" onPress={() => void moveCursor($, 1)} />
        <Button key="prev" plain hotkey="k" label="prev" onPress={() => void moveCursor($, -1)} />
        <Button key="top" plain hotkey="g" label="top" onPress={() => void moveCursor($, () => 0)} />
        <Button key="end" plain hotkey="e" label="end" onPress={() => void moveCursor($, (_, n) => n - 1)} />
        <Button key="find" plain hotkey="f" label={doc.search ? 'find next' : 'find'} onPress={() => void findNext($)} />
        <Button key="next-comment" plain hotkey="m" label="next comment" onPress={() => void nextComment($)} />
        <Button key="comment" plain hotkey="c" label="comment" onPress={() => void compose('comment')} />
        <Button key="ask" plain hotkey="a" label="ask" onPress={() => void compose('ask')} />
        <Button key="explain" plain hotkey="h" label="explain" onPress={() => void explain($, args.explainModel)} />
        <Button key="submit" plain hotkey="s" label={`submit review${live.length > 0 ? ` (${live.length})` : ''}`} onPress={() => void submitReview($)} />
        <Button key="approve" plain hotkey="o" label="approve" onPress={() => void approve($, args.approvePhrase)} />
        {doc.changed.length > 0 && <Button key="next-change" plain hotkey="n" label="next change" onPress={() => void nextChange($)} />}
        {doc.changed.length > 0 && <Button key="diff" plain hotkey="d" label="diff" onPress={() => void toggleView($)} />}
        {doc.changed.length > 0 && <Button key="reviewed" plain hotkey="r" label="mark reviewed" onPress={() => void markReviewed($)} />}
        <Button key="close" plain hotkey="x" label="close" onPress={() => void $.ui.close({ id: PANE })} />
      </Box>
      {composer?.mode === 'find' && Input && (
        <Box flexDirection="row" gap={1} marginBottom={1}>
          <Input key="find" autoFocus label="find:" placeholder="text to look for in the document" submitLabel="find" value={doc.search?.query ?? ''} onSubmit={value => void runFind($, value)} />
          <Button key="find-cancel" plain dimColor label="cancel" onPress={() => void clearFind($)} />
        </Box>
      )}
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
      const target = (forget[1] ?? '').trim() || (await read($, docA))?.path || ''
      if (target === '') return { text: `${PLUGIN}: nothing to forget. Usage: /${COMMAND} forget [path]` }
      await forgetDoc($, target)
      return { text: `${PLUGIN}: cleared the saved comments and questions for ${target}.` }
    }

    if (path === '') {
      const doc = await read($, docA)
      path = doc?.path ?? latest(await read($, candidatesA))?.path ?? ''
    }
    if (path === '') {
      return { text: `${PLUGIN}: nothing to review yet. Usage: /${COMMAND} <path-to-markdown>` }
    }
    if (!(await $.fs.exists(path))) {
      return { text: `${PLUGIN}: ${path} does not exist.` }
    }
    const opened = await openDoc($, path, true)
    if (!opened.isPlaced) return { text: `${PLUGIN}: the pane is not placed: ${opened.reason}` }
    return {
      text: `Reviewing ${path}. In the pane: j/k move, f find, c comment, a ask, h explain, s submit review, o approve, d diff, x close. Tab also walks the blocks.`,
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
    const m = /^b:(\d+)$/.exec(e.element ?? '')
    if (m) {
      const cursor = Number(m[1])
      await update($, docA, d => (d && d.cursor !== cursor ? { ...d, cursor } : d))
    }
    return next(e)
  })

  on('ui.close', { id: PANE }, async ($, e, next) => {
    await update($, composerA, () => null)
    return next(e)
  })

  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => {
    const [doc, comments, threads, composer, notice] = await Promise.all([
      read($, docA),
      read($, commentsA),
      read($, threadsA),
      read($, composerA),
      read($, noticeA),
    ])
    const bodyRows = e.props.scroll?.bodyRows ?? e.viewport?.rows ?? 24
    const common = { doc, comments, threads, composer, notice, bodyRows, approvePhrase, explainModel }

    if (e.surface === 'mobile') {
      const t = $.ui.resolve(e)
      return drawPane($, { ...common, t, Input: null })
    }
    const t = $.ui.resolve(e)
    return drawPane($, { ...common, t, Input: t.Input })
  })
}
