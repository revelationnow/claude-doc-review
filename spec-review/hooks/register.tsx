// spec-review: review a design spec or implementation plan in a pane.
//
// Move block by block, pin comments, ask side questions the main conversation
// never sees, then submit every comment as one review, or approve.

import { atom, read, update } from 'claude-code'
import type { ElementConstructor, EngineInterface, InputProps, Register, RenderElement } from 'claude-code'

import type {
  SpecReviewBlock,
  SpecReviewCandidate,
  SpecReviewComment,
  SpecReviewComposer,
  SpecReviewDoc,
  SpecReviewThread,
} from '../types'
import { anchorFor, basename, cleanText, excerpt, parseBlocks, reanchor, titleOf } from './blocks'
import { buildApprovalPrompt, buildAskPrompt, buildEscalationPrompt, buildReviewPrompt } from './review-prompt'

const PLUGIN = 'spec-review'
const PANE = 'spec-review'
const COMMAND = 'review'

const DEFAULT_GLOBS =
  'docs/superpowers/specs/**/*.md,docs/superpowers/plans/**/*.md,docs/plans/**/*.md,docs/specs/**/*.md,**/*-design.md,**/*-plan.md,SPEC.md,PLAN.md'
const REVIEW_ASKED = /please (review|take a look)|review (it|the (plan|spec|design|document))|let me know if you want (to make )?(any )?changes/i
const MARKDOWN_CAP = 9000
const CANDIDATE_TURNS = 2

const docA = atom({ plugin: 'spec-review', key: 'doc' } as const, null)
const commentsA = atom({ plugin: 'spec-review', key: 'comments' } as const, [])
const threadsA = atom({ plugin: 'spec-review', key: 'threads' } as const, [])
const composerA = atom({ plugin: 'spec-review', key: 'composer' } as const, null)
const candidatesA = atom({ plugin: 'spec-review', key: 'candidates' } as const, [])
const offeredA = atom({ plugin: 'spec-review', key: 'offered' } as const, [])
const noticeA = atom({ plugin: 'spec-review', key: 'notice' } as const, null)

type Table = {
  Box: ElementConstructor<import('claude-code').BoxProps>
  Text: ElementConstructor<import('claude-code').TextProps>
  Button: ElementConstructor<import('claude-code').ButtonProps>
  Markdown: ElementConstructor<import('claude-code').MarkdownProps>
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

async function loadDoc($: EngineInterface, path: string, previous: SpecReviewDoc | null): Promise<SpecReviewDoc> {
  const raw = await $.fs.read(path)
  const text = typeof raw === 'string' ? raw : ''
  const blocks = parseBlocks(cleanText(text))
  const cursor = previous ? Math.min(previous.cursor, Math.max(0, blocks.length - 1)) : 0
  return {
    path,
    title: titleOf(blocks, path),
    blocks,
    cursor,
    revision: previous ? previous.revision + 1 : 0,
  }
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

/** Opens `path` in the pane. `asked` is true when a person's action is behind it. */
async function openDoc($: EngineInterface, path: string, asked: boolean) {
  const cwd = await $.session.cwd()
  const previous = await read($, docA)
  const isSame = previous !== null && samePath(cwd, previous.path, path)
  const doc = await loadDoc($, path, isSame ? previous : null)
  await update($, docA, () => doc)
  if (isSame) {
    await reanchorAll($, doc.blocks)
  } else {
    await update($, commentsA, () => [])
    await update($, threadsA, () => [])
  }
  await update($, composerA, () => null)
  await update($, noticeA, () => null)

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
  const next = await loadDoc($, doc.path, doc)
  await update($, docA, () => next)
  await reanchorAll($, next.blocks)
  await update($, noticeA, () => `Document updated (revision ${next.revision}).`)
}

function latest(list: readonly SpecReviewCandidate[]): SpecReviewCandidate | undefined {
  return [...list].sort((a, b) => b.writtenAt - a.writtenAt)[0]
}

function newId(prefix: string): string {
  return `${prefix}-${Math.random().toString(36).slice(2, 10)}`
}

// ---- actions ---------------------------------------------------------------

async function moveCursor($: EngineInterface, delta: number | ((cursor: number, n: number) => number)): Promise<void> {
  const doc = await read($, docA)
  if (!doc || doc.blocks.length === 0) return
  const n = doc.blocks.length
  const target = typeof delta === 'number' ? doc.cursor + delta : delta(doc.cursor, n)
  const cursor = Math.max(0, Math.min(n - 1, target))
  if (cursor === doc.cursor) return
  await update($, docA, d => (d ? { ...d, cursor } : d))
  void $.ui.scroll({ to: { key: `blk:${cursor}` }, in: PANE, block: 'nearest' }).catch(() => undefined)
  void $.ui.focus({ requestId: PANE, key: `b:${cursor}` }).catch(() => undefined)
}

async function openComposer($: EngineInterface, mode: 'comment' | 'ask', blockIndex?: number): Promise<void> {
  const doc = await read($, docA)
  if (!doc || doc.blocks.length === 0) return
  const at = blockIndex ?? doc.cursor
  if (at !== doc.cursor) await update($, docA, d => (d ? { ...d, cursor: at } : d))
  await update($, composerA, () => ({ blockIndex: at, mode }))
  void $.ui.scroll({ to: { key: `blk:${at}` }, in: PANE, block: 'nearest' }).catch(() => undefined)
  void $.ui.focus({ requestId: PANE, key: 'compose' }).catch(() => undefined)
}

async function addComment($: EngineInterface, block: SpecReviewBlock, text: string): Promise<void> {
  const comment: SpecReviewComment = { id: newId('c'), anchor: anchorFor(block), text, isOrphan: false }
  await update($, commentsA, list => [...list, comment])
  await update($, composerA, () => null)
}

async function ask($: EngineInterface, doc: SpecReviewDoc, block: SpecReviewBlock, question: string): Promise<void> {
  const thread: SpecReviewThread = { id: newId('t'), anchor: anchorFor(block), question, status: 'pending' }
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
  await update($, commentsA, () => [])
  await update($, noticeA, () => `Review sent with ${comments.length} ${comments.length === 1 ? 'comment' : 'comments'}. The pane refreshes when the file changes.`)
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
  await update($, commentsA, () => [])
  await update($, noticeA, () => 'Approval sent.')
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
}

// ---- drawing ---------------------------------------------------------------

function capMarkdown(text: string): string {
  return text.length > MARKDOWN_CAP ? `${text.slice(0, MARKDOWN_CAP)}\n\n_…block truncated for display…_` : text
}

function drawPane($: EngineInterface, args: {
  t: Table
  Input: ElementConstructor<InputProps> | null
  doc: SpecReviewDoc | null
  comments: readonly SpecReviewComment[]
  threads: readonly SpecReviewThread[]
  composer: SpecReviewComposer
  notice: string | null
  bodyRows: number
  approvePhrase: string
}): RenderElement {
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

  const n = doc.blocks.length
  const half = Math.max(10, Math.floor(args.bodyRows / 3))
  const showAll = n <= half * 2 + 1
  const lo = showAll ? 0 : Math.max(0, Math.min(doc.cursor - half, n - (half * 2 + 1)))
  const hi = showAll ? n : Math.min(n, lo + half * 2 + 1)
  const live = comments.filter(c => !c.isOrphan)
  const orphans = comments.filter(c => c.isOrphan)

  const rows: RenderElement[] = []
  for (let i = lo; i < hi; i += 1) {
    const block = doc.blocks[i]
    if (!block) continue
    const isCurrent = i === doc.cursor
    const own = live.filter(c => c.anchor.blockIndex === i)
    const ownThreads = threads.filter(th => th.anchor.blockIndex === i)

    rows.push(
      <Box key={`blk:${i}`} flexDirection="column" marginBottom={1}>
        <Box flexDirection="row">
          <Box width={3}>
            <Button key={`b:${i}`} plain dimColor={!isCurrent} label={isCurrent ? '▶' : '·'} onPress={() => void openComposer($, 'comment', i)} />
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
            <Button key={`rm:${c.id}`} plain dimColor label="✕" onPress={() => void update($, commentsA, list => list.filter(x => x.id !== c.id))} />
          </Box>
        ))}
        {ownThreads.map(th => (
          <Box key={`th:${th.id}`} flexDirection="column" marginLeft={3}>
            <Text color="cyan" wrap="wrap">
              ? {th.question}
            </Text>
            {th.status === 'pending' && <Text dimColor>asking…</Text>}
            {th.status === 'failed' && <Text color="red">could not ask: {th.failure ?? 'unknown'}</Text>}
            {th.status === 'answered' && <Markdown text={capMarkdown(th.answer ?? '')} dimColor />}
            {th.status !== 'pending' && (
              <Box flexDirection="row" gap={1}>
                <Button key={`keep:${th.id}`} plain label="keep as comment" onPress={() => void keepAsComment($, th)} />
                <Button key={`send:${th.id}`} plain label="send to conversation" onPress={() => void escalate($, th)} />
                <Button key={`drop:${th.id}`} plain dimColor label="dismiss" onPress={() => void update($, threadsA, list => list.filter(x => x.id !== th.id))} />
                {th.status === 'answered' && th.outputTokens !== undefined && (
                  <Text dimColor>
                    {th.outputTokens} out · {th.cachedTokens ?? 0} cached
                  </Text>
                )}
              </Box>
            )}
          </Box>
        ))}
        {composer && composer.blockIndex === i && (
          <Box flexDirection="row" marginLeft={3} gap={1}>
            {Input ? (
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
            ) : (
              <Text dimColor>This surface has no text field; comment from a desktop or terminal.</Text>
            )}
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
      </Text>
      {notice && <Text color="green">{notice}</Text>}
      <Box flexDirection="row" gap={2} marginBottom={1}>
        <Button key="next" plain hotkey="j" label="next" onPress={() => void moveCursor($, 1)} />
        <Button key="prev" plain hotkey="k" label="prev" onPress={() => void moveCursor($, -1)} />
        <Button key="top" plain hotkey="g" label="top" onPress={() => void moveCursor($, () => 0)} />
        <Button key="comment" plain hotkey="c" label="comment" onPress={() => void openComposer($, 'comment')} />
        <Button key="ask" plain hotkey="a" label="ask" onPress={() => void openComposer($, 'ask')} />
        <Button key="submit" plain hotkey="s" label={`submit review${live.length > 0 ? ` (${live.length})` : ''}`} onPress={() => void submitReview($)} />
        <Button key="approve" plain hotkey="o" label="approve" onPress={() => void approve($, args.approvePhrase)} />
        <Button key="close" plain hotkey="x" label="close" onPress={() => void $.ui.close({ id: PANE })} />
      </Box>
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
              <Button key={`rm:${c.id}`} plain dimColor label="✕" onPress={() => void update($, commentsA, list => list.filter(x => x.id !== c.id))} />
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

  const matches = (cwd: string, path: string): boolean => {
    const rel = relativeTo(cwd, path)
    return globs.some(g => g.test(rel))
  }

  on('session.start', async ($, e, next) => {
    await $.command.register({
      name: COMMAND,
      description: 'Review a spec or plan: move by block, comment, ask, submit one review',
      argumentHint: '[path]',
    })
    return next(e)
  })

  on('command.run', { command: COMMAND }, async ($, e) => {
    let path = e.args.trim()
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
      text: `Reviewing ${path}. In the pane: j/k move, c comment, a ask, s submit review, o approve, x close. Tab also walks the blocks.`,
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
    const common = { doc, comments, threads, composer, notice, bodyRows, approvePhrase }

    if (e.surface === 'mobile') {
      const t = $.ui.resolve(e)
      return drawPane($, { ...common, t, Input: null })
    }
    const t = $.ui.resolve(e)
    return drawPane($, { ...common, t, Input: t.Input })
  })
}
