import { expect, mock, test } from 'claude-code/testing'
import type { Engine } from 'claude-code/testing'
import type { On, RenderPropsOf } from 'claude-code'

import { parseBlocks, reanchor, anchorFor, describeBlock } from '../hooks/blocks'
import { globToRegExp } from '../hooks/register'
import { diffLines, unifiedHunks, diffText, changedBlocks } from '../hooks/diff'

const PLUGIN = 'spec-review'
const PANE = 'spec-review'
const SURFACES = ['terminal', 'desktop'] as const

const PLAN = `# Widget sync plan

## Goals

Keep widgets in sync across devices within five seconds.

## Architecture

### Storage

Widgets live in a SQLite file per user. A write-ahead log batches updates.

- Each row carries a version
- Conflicts resolve last-writer-wins

### Transport

\`\`\`ts
export function push(batch: Batch): Promise<void>
\`\`\`

| Phase | Owner |
| ----- | ----- |
| 1     | sync  |

## Risks

Clock skew between devices can reorder writes.
`

const PANE_PROPS: RenderPropsOf['Pane'] = {
  title: 'Review: plan.md',
  isFocused: true,
  bodyColumns: 100,
  placement: 'dock',
  scroll: { offset: 0, bodyRows: 40 },
  view: {},
}

/** The engine beneath the mod: a file, a working directory, a placed pane, a clock. */
function standBeneath(on: On, files: Record<string, string>, store: Record<string, unknown> = {}) {
  const opened: { id: string; focus?: true }[] = []
  const submitted: { text: string; asUser?: true }[] = []
  const status: (string | undefined)[] = []
  mock.clock(on, { now: 1_700_000_000_000 })
  mock.store(on, store)
  on('session.cwd', () => ({ value: '/repo' }))
  on('session.turns', () => ({ value: 7 }))
  // The engine resolves a relative path against the working directory before
  // the noun's hooks see it, so fixtures match by suffix.
  const lookup = (path: string) => Object.keys(files).find(k => path === k || path.endsWith(`/${k}`))
  on('fs.exists', (_, e) => ({ value: lookup(e.path) !== undefined }))
  on('fs.read', (_, e) => {
    const key = lookup(e.path)
    if (key === undefined) throw new Error(`no such file: ${e.path}`)
    return { value: files[key] ?? '' }
  })
  on('ui.open', (_, e) => {
    opened.push({ id: e.id, ...(e.focus ? { focus: true as const } : {}) })
    return { value: { isPlaced: true } }
  })
  on('ui.scroll', () => ({}))
  on('ui.focus', () => ({}))
  on('ui.status', (_, e) => {
    status.push(e.text)
    return { value: undefined }
  })
  on('ui.toast', () => ({ value: undefined }))
  on('prompt.submit', (_, e) => {
    submitted.push({ text: e.text, ...(e.origin?.kind === 'plugin' && e.origin.asUser ? { asUser: true as const } : {}) })
    return { text: e.text }
  })
  return { opened, submitted, status }
}

async function runReview($: Engine, path: string) {
  return $.command.run({
    command: 'review',
    args: path,
    origin: { kind: 'composer' },
    presentation: { isFullscreen: true, columns: 160 },
  })
}

test('markdown splits into blocks with heading paths', () => {
  const blocks = parseBlocks(PLAN)
  const kinds = blocks.map(b => b.kind)
  expect(kinds).toEqual([
    'heading', 'heading', 'paragraph', 'heading', 'heading', 'paragraph', 'list', 'heading', 'code', 'table', 'heading', 'paragraph',
  ])
  const storage = blocks.find(b => b.text.startsWith('Widgets live'))
  expect(storage?.headingPath).toEqual(['Widget sync plan', 'Architecture', 'Storage'])
  expect(storage?.startLine).toBe(11)
  expect(describeBlock(storage!)).toContain('under "Widget sync plan > Architecture > Storage"')
})

test('anchors survive edits above and inside the passage', () => {
  const before = parseBlocks(PLAN)
  const target = before.find(b => b.text.startsWith('Widgets live'))!
  const anchor = anchorFor(target)

  const shifted = parseBlocks(PLAN.replace('## Goals\n', '## Goals\n\nA new paragraph above.\n\nAnother one.\n'))
  const at = reanchor(anchor, shifted)
  expect(shifted[at]?.text).toStartWith('Widgets live')

  const reworded = parseBlocks(PLAN.replace('A write-ahead log batches updates.', 'Updates are batched through a write-ahead log.'))
  const at2 = reanchor(anchor, reworded)
  expect(reworded[at2]?.text).toStartWith('Widgets live')

  const removed = parseBlocks(PLAN.replace('Widgets live in a SQLite file per user. A write-ahead log batches updates.\n', ''))
  expect(reanchor(anchor, removed)).toBe(-1)
})

test('globs match the default spec and plan locations', () => {
  const re = globToRegExp('docs/superpowers/plans/**/*.md')
  expect(re.test('docs/superpowers/plans/2026-10-04-foo.md')).toBe(true)
  expect(re.test('docs/superpowers/plans/nested/foo.md')).toBe(true)
  expect(re.test('docs/superpowers/specs/foo.md')).toBe(false)
  const design = globToRegExp('**/*-design.md')
  expect(design.test('foo-design.md')).toBe(true)
  expect(design.test('a/b/foo-design.md')).toBe(true)
  expect(design.test('a/b/foo-plan.md')).toBe(false)
})

test('/review opens the pane focused and draws the document', async ($, on) => {
  const { opened } = standBeneath(on, { 'docs/plan.md': PLAN })

  const ran = await runReview($, 'docs/plan.md')
  expect(ran.text).toContain('Reviewing docs/plan.md')
  expect(opened).toEqual([{ id: PANE, focus: true }])

  for (const surface of SURFACES) {
    const ui = await $.ui.mount({ plugin: PLUGIN, surface, component: 'Pane', props: PANE_PROPS, requestId: PANE })
    expect(await ui.find({ type: 'Markdown', text: /Widgets live in a SQLite file/ })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: /block 1\/12/ })).toBeDefined()
    expect((await ui.findAll({ type: 'Button' })).length).toBeGreaterThan(12)
    await ui.unmount()
  }
})

test('/review without a path reports usage', async ($, on) => {
  standBeneath(on, {})
  const ran = await runReview($, '')
  expect(ran.text).toContain('Usage: /review')
  const missing = await runReview($, 'docs/missing.md')
  expect(missing.text).toContain('does not exist')
})

test('j and k move the cursor; a comment pins under the block; s submits one review', async ($, on) => {
  const { submitted } = standBeneath(on, { 'docs/plan.md': PLAN })
  await runReview($, 'docs/plan.md')

  for (const surface of SURFACES) {
    const ui = await $.ui.mount({ plugin: PLUGIN, surface, component: 'Pane', props: PANE_PROPS, requestId: PANE })

    for (let i = 0; i < 5; i += 1) await ui.press({ key: 'next' })
    expect(await ui.find({ type: 'Text', text: /block 6\/12/ })).toBeDefined()
    await ui.press({ key: 'prev' })
    expect(await ui.find({ type: 'Text', text: /block 5\/12/ })).toBeDefined()
    await ui.press({ key: 'next' })

    await ui.press({ key: 'comment' })
    expect(await ui.find({ type: 'Input', key: 'compose' })).toBeDefined()
    await ui.input({ key: 'compose', text: 'Why SQLite rather than the existing Postgres?' })
    expect(await ui.find({ type: 'Input', key: 'compose' })).toBeUndefined()
    expect(await ui.find({ type: 'Text', text: /Why SQLite rather than/ })).toBeDefined()
    expect(await ui.find({ type: 'Button', key: 'submit', text: /submit review \(1\)/ })).toBeDefined()

    await ui.press({ key: 'submit' })
    const review = submitted.pop()
    expect(review?.asUser).toBe(true)
    expect(review?.text).toContain('I reviewed `docs/plan.md` and have 1 comment')
    expect(review?.text).toContain('under "Widget sync plan > Architecture > Storage"')
    expect(review?.text).toContain('Comment: Why SQLite rather than the existing Postgres?')
    expect(await ui.find({ type: 'Text', text: /Review sent with 1 comment/ })).toBeDefined()
    expect(await ui.find({ type: 'Button', key: 'submit', text: /\(1\)/ })).toBeUndefined()

    await ui.press({ key: 'top' })
    await ui.unmount()
  }
})

test('a asks the model on the side through model.fork and shows the answer', async ($, on) => {
  const { submitted } = standBeneath(on, { 'docs/plan.md': PLAN })
  const forks: string[] = []
  on('model.fork', (_, e) => {
    forks.push(e.prompt)
    return {
      value: {
        isAnswered: true as const,
        text: 'Because the sync log needs an embedded store on every device.',
        usage: { input_tokens: 1200, output_tokens: 18, cache_read_input_tokens: 1100, cache_creation_input_tokens: 0 },
      },
    }
  })
  await runReview($, 'docs/plan.md')

  const ui = await $.ui.mount({ plugin: PLUGIN, surface: 'terminal', component: 'Pane', props: PANE_PROPS, requestId: PANE })
  for (let i = 0; i < 5; i += 1) await ui.press({ key: 'next' })
  await ui.press({ key: 'ask' })
  await ui.input({ key: 'compose', text: 'Why SQLite?' })

  expect(forks).toHaveLength(1)
  expect(forks[0]).toContain('under "Widget sync plan > Architecture > Storage"')
  expect(forks[0]).toContain('> Widgets live in a SQLite file per user.')
  expect(forks[0]).toContain('Question: Why SQLite?')
  expect(await ui.find({ type: 'Markdown', text: /embedded store on every device/ })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: /18 out · 1100 cached/ })).toBeDefined()
  expect(submitted).toHaveLength(0)

  const keep = await ui.findAll({ type: 'Button', text: 'keep as comment' })
  expect(keep).toHaveLength(1)
  await ui.press({ key: keep[0]!.key! })
  expect(await ui.find({ type: 'Text', text: /✎/ })).toBeDefined()
  expect(await ui.find({ type: 'Button', text: 'keep as comment' })).toBeUndefined()
  await ui.unmount()
})

test('a failed fork is reported on the thread, not thrown', async ($, on) => {
  standBeneath(on, { 'docs/plan.md': PLAN })
  on('model.fork', () => ({ value: { isAnswered: false as const, reason: 'nothing-to-fork' as const } }))
  await runReview($, 'docs/plan.md')
  const ui = await $.ui.mount({ plugin: PLUGIN, surface: 'desktop', component: 'Pane', props: PANE_PROPS, requestId: PANE })
  await ui.press({ key: 'ask' })
  await ui.input({ key: 'compose', text: 'Is this the final title?' })
  expect(await ui.find({ type: 'Text', text: /could not ask: nothing to ask yet/ })).toBeDefined()
  await ui.unmount()
})

test('approve with no comments sends the approval phrase as the user', async ($, on) => {
  const { submitted } = standBeneath(on, { 'docs/plan.md': PLAN })
  await runReview($, 'docs/plan.md')
  const ui = await $.ui.mount({ plugin: PLUGIN, surface: 'terminal', component: 'Pane', props: PANE_PROPS, requestId: PANE })
  await ui.press({ key: 'approve' })
  expect(submitted).toEqual([{ text: 'Looks good, proceed.', asUser: true }])
  await ui.unmount()
})

test('approve with unsent comments asks, and can fold them in as notes', async ($, on) => {
  const { submitted } = standBeneath(on, { 'docs/plan.md': PLAN })
  on('tool.call', { tool: 'AskUserQuestion' }, (_, e) => {
    // The dialog's result keys each answer by its question's text.
    const question = e.questions[0]?.question ?? ''
    return {
      result: { questions: e.questions, answers: { [question]: 'Include as non-blocking notes' } },
      text: 'Include as non-blocking notes',
    }
  })
  await runReview($, 'docs/plan.md')
  const ui = await $.ui.mount({ plugin: PLUGIN, surface: 'terminal', component: 'Pane', props: PANE_PROPS, requestId: PANE })
  await ui.press({ key: 'comment' })
  await ui.input({ key: 'compose', text: 'Title could name the product.' })
  await ui.press({ key: 'approve' })
  expect(submitted).toHaveLength(1)
  expect(submitted[0]?.text).toStartWith('Looks good, proceed.')
  expect(submitted[0]?.text).toContain('Note: Title could name the product.')
  await ui.unmount()
})

test('a revision of the open file re-anchors comments and marks the lost ones', async ($, on) => {
  const files: Record<string, string> = { 'docs/plan.md': PLAN }
  standBeneath(on, files)
  on('tool.call', { tool: 'Write' }, (_, e) => {
    files[e.file_path] = e.content
    return { result: { type: 'update', filePath: e.file_path, content: e.content, structuredPatch: [] }, text: 'ok' }
  })
  await runReview($, 'docs/plan.md')

  const ui = await $.ui.mount({ plugin: PLUGIN, surface: 'terminal', component: 'Pane', props: PANE_PROPS, requestId: PANE })
  for (let i = 0; i < 5; i += 1) await ui.press({ key: 'next' })
  await ui.press({ key: 'comment' })
  await ui.input({ key: 'compose', text: 'Name the SQLite file.' })
  for (let i = 0; i < 6; i += 1) await ui.press({ key: 'next' })
  await ui.press({ key: 'comment' })
  await ui.input({ key: 'compose', text: 'Quantify the skew.' })
  expect(await ui.find({ type: 'Text', text: /2 comments/ })).toBeDefined()

  const revised = PLAN.replace('## Goals\n', '## Goals\n\nA fresh paragraph.\n').replace('Clock skew between devices can reorder writes.\n', '')
  await $.tool.call({ tool: 'Write', file_path: 'docs/plan.md', content: revised })

  expect(await ui.find({ type: 'Text', text: /revision 1/ })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: /1 comment \(1 orphaned\)/ })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: /no longer appears/ })).toBeDefined()

  // The surviving comment still sits under its block, two blocks further down.
  const marker = await ui.findAll({ type: 'Button', text: '+' })
  expect(marker.length).toBe(1)
  expect(await ui.find({ type: 'Text', text: /1 changed since reviewed/ })).toBeDefined()
  await ui.unmount()
})

// ---- phase 2 ----------------------------------------------------------------

test('a line diff finds the shortest edit and unified hunks carry line numbers', () => {
  const ops = diffLines(['a', 'b', 'c', 'd'], ['a', 'x', 'c', 'd', 'e'])!
  expect(ops.map(o => `${o.kind[0]}${o.text}`)).toEqual(['sa', 'db', 'ax', 'sc', 'sd', 'ae'])
  const hunks = unifiedHunks(ops, 1)
  expect(hunks).toEqual(['@@ -1,4 +1,5 @@\n a\n-b\n+x\n c\n d\n+e'])
  expect(diffText('same\ntext', 'same\ntext')!.hunks).toEqual([])
  expect(diffLines([], ['only'])).toEqual([{ kind: 'add', text: 'only' }])
})

test('changed blocks are the new or reworded ones, not the moved ones', () => {
  const before = parseBlocks(PLAN)
  const after = parseBlocks(PLAN.replace('Keep widgets in sync across devices within five seconds.', 'Keep widgets in sync within two seconds.').replace('## Risks\n', '## Risks\n\nNew risk here.\n'))
  const changed = changedBlocks(after, before)
  expect(changed.map(i => after[i]!.text)).toEqual(['Keep widgets in sync within two seconds.', 'New risk here.'])
})

test('comments and side questions persist in the store and come back in a later open', async ($, on) => {
  const { submitted } = standBeneath(on, { 'docs/plan.md': PLAN, 'docs/other.md': '# Other\n\nUnrelated.\n' })
  on('model.fork', () => ({
    value: {
      isAnswered: true as const,
      text: 'An embedded store.',
      usage: { input_tokens: 10, output_tokens: 4, cache_read_input_tokens: 8, cache_creation_input_tokens: 0 },
    },
  }))
  await runReview($, 'docs/plan.md')
  let ui = await $.ui.mount({ plugin: PLUGIN, surface: 'terminal', component: 'Pane', props: PANE_PROPS, requestId: PANE })
  for (let i = 0; i < 5; i += 1) await ui.press({ key: 'next' })
  await ui.press({ key: 'comment' })
  await ui.input({ key: 'compose', text: 'Name the file.' })
  await ui.press({ key: 'ask' })
  await ui.input({ key: 'compose', text: 'Why SQLite?' })
  await ui.unmount()

  // Opening another document clears the pane; coming back restores from the store.
  await runReview($, 'docs/other.md')
  ui = await $.ui.mount({ plugin: PLUGIN, surface: 'terminal', component: 'Pane', props: PANE_PROPS, requestId: PANE })
  expect(await ui.find({ type: 'Text', text: /Name the file/ })).toBeUndefined()
  await ui.unmount()

  await runReview($, 'docs/plan.md')
  ui = await $.ui.mount({ plugin: PLUGIN, surface: 'terminal', component: 'Pane', props: PANE_PROPS, requestId: PANE })
  expect(await ui.find({ type: 'Text', text: /Restored 1 comment and 1 question from an earlier session/ })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: /Name the file/ })).toBeDefined()
  expect(await ui.find({ type: 'Markdown', text: /An embedded store/ })).toBeDefined()
  expect(await ui.find({ type: 'Button', key: 'submit', text: /\(1\)/ })).toBeDefined()

  // Sending the review clears the comments in the store too; the question stays.
  await ui.press({ key: 'submit' })
  expect(submitted).toHaveLength(1)
  await ui.unmount()
  await runReview($, 'docs/other.md')
  await runReview($, 'docs/plan.md')
  ui = await $.ui.mount({ plugin: PLUGIN, surface: 'terminal', component: 'Pane', props: PANE_PROPS, requestId: PANE })
  expect(await ui.find({ type: 'Text', text: /Restored 1 question from an earlier session/ })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: /Name the file/ })).toBeUndefined()
  await ui.unmount()
})

test('a revision after a submitted review shows a diff, marks changed blocks, and can be marked reviewed', async ($, on) => {
  const files: Record<string, string> = { 'docs/plan.md': PLAN }
  standBeneath(on, files)
  on('tool.call', { tool: 'Write' }, (_, e) => {
    files[e.file_path] = e.content
    return { result: { type: 'update', filePath: e.file_path, content: e.content, structuredPatch: [] }, text: 'ok' }
  })
  await runReview($, 'docs/plan.md')

  const ui = await $.ui.mount({ plugin: PLUGIN, surface: 'terminal', component: 'Pane', props: PANE_PROPS, requestId: PANE })
  expect(await ui.find({ type: 'Button', key: 'diff' })).toBeUndefined()
  await ui.press({ key: 'comment' })
  await ui.input({ key: 'compose', text: 'Name the product.' })
  await ui.press({ key: 'submit' })
  expect(await ui.find({ type: 'Text', text: /awaiting revision/ })).toBeDefined()

  const revised = PLAN.replace('# Widget sync plan', '# Acme widget sync plan').replace('## Risks\n', '## Risks\n\nClock skew is bounded by NTP.\n')
  await $.tool.call({ tool: 'Write', file_path: 'docs/plan.md', content: revised })

  expect(await ui.find({ type: 'Text', text: /awaiting revision/ })).toBeUndefined()
  expect(await ui.find({ type: 'Text', text: /Revision 1: 2 blocks differ/ })).toBeDefined()
  expect((await ui.findAll({ type: 'Button', text: '+' })).length).toBe(1) // the title is the cursor's block, drawn as ▶

  await ui.press({ key: 'next-change' })
  expect(await ui.find({ type: 'Text', text: /block 12\/13/ })).toBeDefined()
  await ui.press({ key: 'next-change' })
  expect(await ui.find({ type: 'Text', text: /block 1\/13/ })).toBeDefined()

  await ui.press({ key: 'diff' })
  const code = await ui.findAll({ type: 'Code' })
  expect(code.length).toBe(2)
  expect(code[0]!.props.format).toBe('diff')
  expect(code[0]!.text).toContain('-# Widget sync plan')
  expect(code[0]!.text).toContain('+# Acme widget sync plan')
  expect(code[1]!.text).toContain('+Clock skew is bounded by NTP.')
  expect(await ui.find({ type: 'Text', text: /\+3 −1 lines/ })).toBeDefined()

  await ui.press({ key: 'reviewed' })
  expect(await ui.find({ type: 'Code' })).toBeUndefined()
  expect(await ui.find({ type: 'Text', text: /Revision 1 marked as reviewed/ })).toBeDefined()
  expect(await ui.find({ type: 'Button', key: 'diff' })).toBeUndefined()
  await ui.unmount()
})

test('a document changed since the last session opens with its diff available', async ($, on) => {
  const files: Record<string, string> = { 'docs/plan.md': PLAN.replace('five seconds', 'two seconds') }
  // What an earlier session left behind: the text it reviewed.
  standBeneath(on, files, {
    'doc:/repo/docs/plan.md': { path: 'docs/plan.md', comments: [], threads: [], baselineText: PLAN, lastReviewAt: 1, updatedAt: 1 },
  })
  await runReview($, 'docs/plan.md')
  const ui = await $.ui.mount({ plugin: PLUGIN, surface: 'desktop', component: 'Pane', props: PANE_PROPS, requestId: PANE })
  expect(await ui.find({ type: 'Text', text: /The file changed since you last reviewed it: 1 block differs/ })).toBeDefined()
  await ui.press({ key: 'diff' })
  expect((await ui.find({ type: 'Code' }))?.text).toContain('+Keep widgets in sync across devices within two seconds.')
  await ui.unmount()
})

test('on a surface with no text field, comment and ask go through the dialog', async ($, on) => {
  const { submitted } = standBeneath(on, { 'docs/plan.md': PLAN })
  const asked: string[] = []
  on('tool.call', { tool: 'AskUserQuestion' }, (_, e) => {
    const question = e.questions[0]?.question ?? ''
    asked.push(question)
    return { result: { questions: e.questions, answers: { [question]: 'Spell out the five-second budget.' } }, text: 'ok' }
  })
  await runReview($, 'docs/plan.md')
  const ui = await $.ui.mount({ plugin: PLUGIN, surface: 'mobile', component: 'Pane', props: PANE_PROPS, requestId: PANE })
  expect(await ui.find({ type: 'Input' })).toBeUndefined()
  await ui.press({ key: 'next' })
  await ui.press({ key: 'next' })
  await ui.press({ key: 'comment' })
  expect(asked[0]).toContain('About "Keep widgets in sync across devices within five seconds."')
  expect(asked[0]).toEndWith('what is your comment?')
  expect(await ui.find({ type: 'Text', text: /Spell out the five-second budget/ })).toBeDefined()
  await ui.press({ key: 'submit' })
  expect(submitted[0]?.text).toContain('Comment: Spell out the five-second budget.')
  await ui.unmount()
})

test('a spec written this turn opens for review when the model asks for one', async ($, on) => {
  const files: Record<string, string> = {}
  const { opened } = standBeneath(on, files)
  on('tool.call', { tool: 'Write' }, (_, e) => {
    files[e.file_path] = e.content
    return { result: { type: 'create', filePath: e.file_path, content: e.content, structuredPatch: [] }, text: 'ok' }
  })
  on('turn.complete', (_, e) => ({ text: e.answer }))

  await $.tool.call({ tool: 'Write', file_path: '/repo/docs/superpowers/specs/2026-10-04-widgets-design.md', content: PLAN })
  await $.tool.call({ tool: 'Write', file_path: '/repo/src/index.ts', content: 'export {}' })
  expect(opened).toHaveLength(0)

  await $.turn.complete({
    turnId: 't1',
    reason: 'answer',
    isAborted: false,
    durationMs: 10,
    answer: 'Spec written and committed to docs/superpowers/specs/2026-10-04-widgets-design.md. Please review it and let me know if you want to make any changes.',
  })
  expect(opened).toEqual([{ id: PANE }])

  const ui = await $.ui.mount({ plugin: PLUGIN, surface: 'terminal', component: 'Pane', props: PANE_PROPS, requestId: PANE })
  expect(await ui.find({ type: 'Text', text: /2026-10-04-widgets-design\.md/ })).toBeDefined()
  await ui.unmount()

  // The same answer again does not re-open what was already offered.
  await $.tool.call({ tool: 'Write', file_path: '/repo/docs/superpowers/specs/2026-10-04-widgets-design.md', content: PLAN })
  await $.turn.complete({ turnId: 't2', reason: 'answer', isAborted: false, durationMs: 10, answer: 'Please review it.' })
  expect(opened).toHaveLength(1)
})

test('with offer set to toast the pane stays closed and the status line points at /review', { options: { offer: 'toast' } }, async ($, on) => {
  const files: Record<string, string> = {}
  const { opened, status } = standBeneath(on, files)
  on('tool.call', { tool: 'Write' }, (_, e) => {
    files[e.file_path] = e.content
    return { result: { type: 'create', filePath: e.file_path, content: e.content, structuredPatch: [] }, text: 'ok' }
  })
  on('turn.complete', (_, e) => ({ text: e.answer }))

  await $.tool.call({ tool: 'Write', file_path: '/repo/docs/plans/foo-plan.md', content: PLAN })
  await $.turn.complete({ turnId: 't1', reason: 'answer', isAborted: false, durationMs: 10, answer: 'Plan complete. Please review the plan.' })
  expect(opened).toHaveLength(0)
  expect(status).toContain('spec ready: /review')
})

// ---- phase 3 ----------------------------------------------------------------

test('f finds blocks by text, cycles through the matches, and e goes to the end', async ($, on) => {
  standBeneath(on, { 'docs/plan.md': PLAN })
  await runReview($, 'docs/plan.md')
  const ui = await $.ui.mount({ plugin: PLUGIN, surface: 'terminal', component: 'Pane', props: PANE_PROPS, requestId: PANE })

  await ui.press({ key: 'find' })
  expect(await ui.find({ type: 'Input', key: 'find' })).toBeDefined()
  await ui.input({ key: 'find', text: 'widget' })
  expect(await ui.find({ type: 'Input', key: 'find' })).toBeUndefined()
  // The title matches and holds the cursor, so the first match is the current block.
  expect(await ui.find({ type: 'Text', text: /find "widget" 1\/3/ })).toBeDefined()
  await ui.press({ key: 'find' })
  expect(await ui.find({ type: 'Text', text: /block 3\/12/ })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: /find "widget" 2\/3/ })).toBeDefined()
  await ui.press({ key: 'find' })
  expect(await ui.find({ type: 'Text', text: /block 6\/12/ })).toBeDefined()
  await ui.press({ key: 'find' })
  expect(await ui.find({ type: 'Text', text: /block 1\/12/ })).toBeDefined()

  await ui.press({ key: 'find-clear' })
  expect(await ui.find({ type: 'Text', text: /find "widget"/ })).toBeUndefined()

  await ui.press({ key: 'end' })
  expect(await ui.find({ type: 'Text', text: /block 12\/12/ })).toBeDefined()

  // A find with no match leaves the cursor where it was.
  await ui.press({ key: 'find' })
  await ui.input({ key: 'find', text: 'kubernetes' })
  expect(await ui.find({ type: 'Text', text: /block 12\/12/ })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: /no matches/ })).toBeDefined()
  await ui.unmount()
})

test('m cycles through the blocks that carry comments', async ($, on) => {
  standBeneath(on, { 'docs/plan.md': PLAN })
  await runReview($, 'docs/plan.md')
  const ui = await $.ui.mount({ plugin: PLUGIN, surface: 'desktop', component: 'Pane', props: PANE_PROPS, requestId: PANE })
  await ui.press({ key: 'next-comment' }) // nothing yet: a toast, no move
  expect(await ui.find({ type: 'Text', text: /block 1\/12/ })).toBeDefined()

  await ui.press({ key: 'b:2' })
  await ui.input({ key: 'compose', text: 'Which devices?' })
  await ui.press({ key: 'b:5' })
  await ui.input({ key: 'compose', text: 'Name the file.' })
  await ui.press({ key: 'top' })

  await ui.press({ key: 'next-comment' })
  expect(await ui.find({ type: 'Text', text: /block 3\/12/ })).toBeDefined()
  await ui.press({ key: 'next-comment' })
  expect(await ui.find({ type: 'Text', text: /block 6\/12/ })).toBeDefined()
  await ui.press({ key: 'next-comment' })
  expect(await ui.find({ type: 'Text', text: /block 3\/12/ })).toBeDefined()
  await ui.unmount()
})

test('h explains the current block on a small fresh model, with no transcript and no escalation', async ($, on) => {
  const { submitted } = standBeneath(on, { 'docs/plan.md': PLAN })
  const asked: { model: string; system?: string; prompt: string }[] = []
  on('model.complete', (_, e) => {
    asked.push({ model: e.model, system: e.system, prompt: e.prompt })
    return {
      value: {
        isAnswered: true as const,
        text: 'A write-ahead log records changes before applying them, so a crash loses nothing.',
        usage: { input_tokens: 90, output_tokens: 22, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 },
      },
    }
  })
  await runReview($, 'docs/plan.md')
  const ui = await $.ui.mount({ plugin: PLUGIN, surface: 'terminal', component: 'Pane', props: PANE_PROPS, requestId: PANE })
  for (let i = 0; i < 5; i += 1) await ui.press({ key: 'next' })
  await ui.press({ key: 'explain' })

  expect(asked).toHaveLength(1)
  expect(asked[0]!.model).toBe('haiku')
  expect(asked[0]!.system).toContain('Do not evaluate or suggest changes')
  expect(asked[0]!.prompt).toContain('> Widgets live in a SQLite file per user.')
  expect(await ui.find({ type: 'Text', text: /ⓘ Explain this passage \(haiku\)/ })).toBeDefined()
  expect(await ui.find({ type: 'Markdown', text: /write-ahead log records changes/ })).toBeDefined()
  expect(await ui.find({ type: 'Button', text: 'send to conversation' })).toBeUndefined()
  expect(await ui.find({ type: 'Button', text: 'keep as comment' })).toBeUndefined()
  expect(submitted).toHaveLength(0)

  const dismiss = await ui.findAll({ type: 'Button', text: 'dismiss' })
  await ui.press({ key: dismiss[0]!.key! })
  expect(await ui.find({ type: 'Text', text: /Explain this passage/ })).toBeUndefined()
  await ui.unmount()
})

test('the explain model is configurable', { options: { explainModel: 'sonnet' } }, async ($, on) => {
  standBeneath(on, { 'docs/plan.md': PLAN })
  const models: string[] = []
  on('model.complete', (_, e) => {
    models.push(e.model)
    return { value: { isAnswered: false as const, reason: 'empty-reply' as const, usage: { input_tokens: 0, output_tokens: 0, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 } } }
  })
  await runReview($, 'docs/plan.md')
  const ui = await $.ui.mount({ plugin: PLUGIN, surface: 'terminal', component: 'Pane', props: PANE_PROPS, requestId: PANE })
  await ui.press({ key: 'explain' })
  expect(models).toEqual(['sonnet'])
  expect(await ui.find({ type: 'Text', text: /could not ask: empty-reply/ })).toBeDefined()
  await ui.unmount()
})

test('/review forget clears the saved comments for a document', async ($, on) => {
  standBeneath(on, { 'docs/plan.md': PLAN, 'docs/other.md': '# Other\n\nUnrelated.\n' })
  await runReview($, 'docs/plan.md')
  let ui = await $.ui.mount({ plugin: PLUGIN, surface: 'terminal', component: 'Pane', props: PANE_PROPS, requestId: PANE })
  await ui.press({ key: 'comment' })
  await ui.input({ key: 'compose', text: 'Name the product.' })
  expect(await ui.find({ type: 'Text', text: /1 comment/ })).toBeDefined()

  const ran = await runReview($, 'forget')
  expect(ran.text).toContain('cleared the saved comments and questions for docs/plan.md')
  expect(await ui.find({ type: 'Text', text: /0 comments/ })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: /were cleared/ })).toBeDefined()
  await ui.unmount()

  await runReview($, 'docs/other.md')
  await runReview($, 'docs/plan.md')
  ui = await $.ui.mount({ plugin: PLUGIN, surface: 'terminal', component: 'Pane', props: PANE_PROPS, requestId: PANE })
  expect(await ui.find({ type: 'Text', text: /Restored/ })).toBeUndefined()
  await ui.unmount()

  const none = await runReview($, 'forget docs/nowhere.md')
  expect(none.text).toContain('cleared the saved comments and questions for docs/nowhere.md')
})
