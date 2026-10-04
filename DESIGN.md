# claude-doc-review: a Claude Code mod for discussing design and plan documents

Status: all three phases built in `doc-review/` (see README.md). Phase 3's `Client` module was dropped; the README says why.

## 1. The ask

When a plugin such as superpowers finishes a design spec or an implementation
plan and asks the user to review it, open the document in a pane, let the user
move through it, and let them press a key on any passage to open a chat about
that passage with the model.

## 2. Verdict: feasible on the current mod API

Every piece the idea needs exists in the function-hooks API this build ships
(`claude-code.d.ts`, the declaration the plugin-authoring skill writes). The
table maps each requirement to the primitive that covers it.

| Need | Primitive | Notes |
| --- | --- | --- |
| Notice a spec or plan was just written | `on('tool.call', { tool: 'Write' })`, also `Edit` | `e.file_path` and `e.content` are typed. Fires for subagent writes too (`e.agentId`). |
| Notice the model asked for a review | `on('turn.complete')` | `e.answer` is the final visible text. Superpowers ends with "Please review the plan" / "Please review it". |
| Open a window | `$.ui.open({ id, title, focus, closeOnEscape, holdToasts, rows, columns })` | Docked beside the transcript in fullscreen from 110 columns, otherwise inline above the prompt. |
| Draw the document | `Markdown` element, `Code` element with `startLine` gutter | Both cap at 10,000 characters per element, so a long doc is drawn as a window of blocks, never whole. |
| Move through it | `Button` per block (Tab / Shift+Tab walk the focus ring, Enter presses), `$.ui.scroll({ to: { key } })`, `$.ui.focus` | Works on every surface. Arrow keys scroll the pane body; the engine owns that. |
| Vim-style j/k navigation | `Client` element with `surface.onKey` | Terminal and desktop only. Takes keys only after a click gives it focus. Enhancement, not the base. |
| Type a question | `Input` element with `onSubmit`, `autoFocus` | Not on mobile (the mobile table has no `Input`). |
| Answer without touching the main conversation | `$.model.fork({ prompt })` | Re-sends the main thread's last request plus one user message. The model already has the spec in context, and the prefix is served from the API cache. |
| Answer cheaply with a fresh model | `$.model.complete({ model: 'haiku', prompt, system })` | For summaries, "explain this term", classification of a comment. |
| Hand the discussion to the real conversation | `$.prompt.submit({ text, asUser })` plus a `prompt.submit` hook that attaches `context: [quote]` | Runs once the session is idle. The quoted passage rides as hidden context so the model knows what "this" refers to. |
| Keep notes without a model turn | `$.session.append({ message: { type: 'user', content } })` | A user-role row the model sees next turn; the person does not see it as typed. |
| Remember comments across sessions | `$.store.get/set` | JSON, 4 MiB total. Key by document path. |
| Read the file as it is now | `$.fs.read(path)`, `$.fs.stat` | Re-read after every `Write`/`Edit` to that path to refresh the pane. |
| Manual entry point | `$.command.register({ name: 'doc-review' })` + `on('command.run')` | `/doc-review <path>` opens any markdown file. |
| Confirmations | `$.ui.ask(question, options)`, `$.ui.toast`, `$.ui.status` | The engine's own AskUserQuestion dialog. |

Two constraints shape the design more than anything else:

1. **A pane opened unasked is placed only from 144 terminal columns.** A pane
   opened in reaction to `turn.complete` counts as unasked. Below that width it
   waits undrawn until the person opens it themselves. So the mod cannot force
   a pop-up on a narrow terminal. The fix is in section 4.
2. **Per-line is the wrong granularity.** A `Markdown` leaf is one element, so
   there is no "line 47" to focus inside it. Line numbers also go stale the
   moment the model revises the document. The unit of navigation and anchoring
   should be the markdown *block*: heading, paragraph, list item, table, code
   fence. Blocks are what a reviewer actually comments on anyway.

## 3. Primary UX: review like a pull request, not like a chat

The strongest model for this is a code review tool, not a chat window. A
reviewer reads top to bottom, drops comments on passages, asks a few clarifying
questions along the way, and then submits the whole review at once. The model
then revises the document in one pass instead of ping-ponging on each line.

### 3.1 Flow

1. Superpowers writes `docs/superpowers/specs/2026-10-04-foo-design.md` and
   ends its turn with "Please review it".
2. The mod has seen the `Write`, matched the path, and seen the review phrase
   in `turn.complete`. It opens the review pane focused (or, on a narrow
   terminal, posts a toast and status line: `Spec ready: press /doc-review`).
3. The pane shows the document rendered as markdown. Each block is a focus
   stop. The focused block is drawn with `inverse` or a left bar. A one-line
   legend sits at the bottom:

   ```
   Tab/Shift+Tab move  ·  Enter comment  ·  a ask  ·  s submit review  ·  o approve  ·  Esc close
   ```

4. Enter on a block opens an inline composer under it (an `Input` with
   `autoFocus`). The user types a comment and presses Enter. The comment is
   pinned under the block, dim, prefixed with a marker. No model call yet.
5. `a` on a block opens the same composer in **ask** mode. Enter sends the
   question through `$.model.fork` with the quoted block as the first line of
   the prompt. The answer streams in under the block. Nothing enters the main
   transcript. The exchange is kept on the block and can be turned into a
   comment with one press.
6. `s` submits the review. The mod builds one prompt from all pinned comments,
   each anchored by heading path and quoted text, and calls
   `$.prompt.submit`. The model revises the document in the main conversation
   as usual. The pane stays open and refreshes on the next `Write`/`Edit`.
7. `o` approves: submits the plugin's expected approval phrase (for superpowers,
   "Looks good, proceed") so the plugin's own flow continues.

### 3.2 Why this beats a per-line chat window

- One revision pass instead of many partial edits. Cheaper and the document
  stays coherent.
- Clarifying questions do not pollute the main context. `$.model.fork` reuses
  the cached prefix, so each question costs roughly one short reply.
- The user keeps control of when the model acts. Nothing is sent until `s` or
  `o`.
- It mirrors what people already know from GitHub reviews.

### 3.3 Escalation path per block

Every ask-mode exchange has three exits, drawn as plain Buttons under it:

- **Keep as comment**: converts the Q and A into a pinned review comment.
- **Send to conversation**: `$.prompt.submit` right now with the block as
  hidden context, for when the user wants the model to act immediately.
- **Dismiss**.

## 4. Surfaces and placement

| Surface | What works | Degradation |
| --- | --- | --- |
| Terminal, fullscreen, 110+ cols | Docked pane beside the transcript, full keyboard flow | None |
| Terminal, main screen or narrow | Inline pane above the prompt, `rows` requested | Below 144 cols the auto-open waits. Mod posts a toast and sets `$.ui.status('Spec ready: /doc-review')`. `/doc-review` is an asked open and is placed at any width. |
| Desktop app | Same as terminal plus `Client` for j/k | None |
| VS Code | Pane, Buttons, Input | No `Client`, so no vim keys |
| Mobile | Pane, Markdown, Buttons | No `Input`. Read and approve only, with `$.ui.ask` for a canned set of responses. |

Escape returns the keyboard to the prompt. With `closeOnEscape` it also closes
the pane. For a review pane that should survive while the model revises, leave
`closeOnEscape` out and give the pane an explicit close Button.

## 5. Detection: when to offer the review

Three signals, any one of which arms the offer; the offer fires on
`turn.complete` of the main loop.

1. **Path match.** `Write` or `Edit` whose path matches a configurable glob
   list. Defaults: `docs/superpowers/specs/**/*.md`,
   `docs/superpowers/plans/**/*.md`, `docs/plans/**/*.md`, `**/*-design.md`,
   `**/*-plan.md`, `SPEC.md`, `PLAN.md`. Exposed as `userConfig` so other
   plugins' conventions can be added without code.
2. **Phrase match.** `e.answer` on `turn.complete` matches
   `/please review|review (the|this) (plan|spec|design)/i` and names a markdown
   path written this turn.
3. **Explicit.** `/doc-review <path>` or `/doc-review` with no argument, which opens the
   most recently written matching document.

Signal 1 alone is too eager (the model writes many markdown files). Signal 2
alone misses plugins with other wording. Together with a per-path "do not
offer again this session" memory they are quiet enough.

Writes from subagents carry `e.agentId`. Superpowers sometimes drafts plans in
a subagent, so the matcher must not filter those out.

## 6. Anchoring and refresh

Comments are anchored, not positioned:

```ts
type Anchor = {
  headingPath: string[]   // ['Architecture', 'Storage']
  quote: string           // first 200 chars of the block, normalised
  blockIndex: number      // hint only, for fast path
}
```

After the model revises the file, the mod re-reads it, re-parses blocks, and
re-anchors each comment by exact quote, then by heading path plus fuzzy quote,
and finally marks it "orphaned" with a dim notice rather than dropping it. The
review prompt sent to the model uses the same anchors, so the model sees
"Under heading X, the paragraph beginning '...'" and not a line number.

A `Code` element in `format: 'diff'` can show what changed between the version
the user reviewed and the current file. This is a cheap and very useful
addition after a revision round.

## 7. Things not in the original ask that matter

- **Cost and cache.** `$.model.fork` bills the whole prefix fresh once the
  cache entry lapses or after `/model`. A burst of questions in one sitting is
  cheap. One question an hour later re-bills the prefix. The pane should show
  the token cost from `r.usage` beside each answer so the user learns the
  shape of the cost.
- **Do not send the whole document twice.** In fork mode the model already has
  the spec in context. The prompt should quote the block and name the file,
  not paste the document. In `complete` mode (fresh model) the mod must
  include the document, so cap it at the relevant section plus headings.
- **Long documents.** Both `Markdown` and `Code` cap at 10,000 characters per
  element. Render each block as its own `Markdown` element and only the blocks
  inside a window around the cursor plus a margin. The pane body scroll is
  engine-owned, so keep the tree small enough that `$.ui.scroll({ to: { key }
  })` is the only movement the mod drives.
- **Who is talking.** A plugin's `$.prompt.submit` is framed as "The
  doc-review plugin sent a message" unless `asUser: true`. The submitted
  review should be `asUser: true` since the words are the user's; the
  transcript still records the plugin as origin.
- **Mid-turn behaviour.** `$.prompt.submit` from a plugin waits until the
  session is idle. If the user submits a review while the model is still
  working, show "queued" on the pane rather than letting it look lost.
- **Hotkey limits.** A Button `hotkey` is one lowercase letter or one digit and
  only works while the pane holds the keyboard. The legend must say the pane
  needs focus (ctrl+x tab or a click) and the mod should open the pane with
  `focus: true` whenever the open was asked for.
- **Approval phrases differ by plugin.** Superpowers waits for an affirmative
  reply, then runs writing-plans or executing-plans. Make the approve and
  request-changes phrases configurable per path glob so the mod can drive other
  plugins' gates too.
- **Persistence.** Keep comments in `$.store` keyed by absolute path plus a
  content hash, so a review interrupted by `/clear` or a restart survives, and
  so a second review of the same spec shows what was said before.
- **Transcript footprint.** The pane itself is not in the transcript. Only the
  final `prompt.submit` and any `session.append` notes reach the model. That is
  the main privacy and context-budget advantage over asking questions inline.
- **Reload semantics.** A hot reload re-runs `register` and `session.start`,
  and module variables reset. Keep the cursor, open document and draft
  comments in `$.state` atoms, declared in `types/index.d.ts`, so a reload
  does not lose the review in progress.
- **Tests.** `claude plugin test` can render the pane, press Buttons and submit
  Inputs with hooks beneath answering `ui.open`, `fs.read` and `model.fork`.
  The whole review flow is testable without a terminal.

## 8. Suggested build phases

**Phase 1, usable in a day.**
`/doc-review <path>` command; auto-offer on path plus phrase match; pane that
parses the file into blocks and draws each as `Markdown` with a focus Button;
Enter opens an `Input` under the block; `a` asks via `$.model.fork` and shows
the answer under the block; `s` submits all comments as one prompt with
`asUser`; `o` submits the approval phrase; refresh on `Write`/`Edit` to the
open path.

**Phase 2, review quality.**
Anchors with re-anchoring after revision; `$.store` persistence; orphaned
comment handling; diff view of the revision; cost display; `userConfig` for
globs and approval phrases; mobile read-only mode via `$.ui.ask`.

**Phase 3, polish.**
`Client` module for j/k, `/` search, `n`/`N` between comments on terminal and
desktop; hover styling; summary header with comment count; "explain this term"
using `$.model.complete` on haiku so trivial questions never touch the main
model.

## 9. File layout for the mod

```
doc-review/
  .claude-plugin/plugin.json      name, version, description, types, userConfig
  hooks/hooks.json                { "modules": ["./register.tsx"] }
  hooks/register.tsx              hooks: tool.call, turn.complete, command.run,
                                  ui.render (Pane), ui.press, ui.input, prompt.submit
  hooks/blocks.ts                 markdown to blocks, anchors, re-anchoring
  hooks/review-prompt.ts               builds the submitted review text
  hooks/navigator.tsx             (phase 3) Client module for vim keys
  types/index.d.ts                PluginState contract: open doc, cursor, comments
  hooks/register.test.ts          claude plugin test
```

## 10. Open questions for the author

- Should the review pane open automatically, or always wait for `/doc-review`?
  Auto-open is only reliable on wide fullscreen terminals, so a toast plus
  command may be the honest default everywhere.
- Should ask-mode answers ever be visible to the main model? The default
  proposed here is no, unless the user converts them into a comment or presses
  "Send to conversation".
- Is a single approval phrase enough, or should approve carry the remaining
  comments as "nits, non-blocking"?
