import { expect, mock, test } from 'claude-code/testing'
import type { Engine } from 'claude-code/testing'
import type { On, RenderPropsOf } from 'claude-code'

import { parseBlocks, reanchor, anchorFor, describeBlock } from '../hooks/blocks'
import { globToRegExp } from '../hooks/register'

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
function standBeneath(on: On, files: Record<string, string>) {
  const opened: { id: string; focus?: true }[] = []
  const submitted: { text: string; asUser?: true }[] = []
  const status: (string | undefined)[] = []
  mock.clock(on, { now: 1_700_000_000_000 })
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
