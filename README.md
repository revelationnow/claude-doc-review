# spec-review

A Claude Code mod that turns "please review the plan" into a real review.

When a plugin such as [superpowers](https://github.com/obra/superpowers) writes
a design spec or an implementation plan and asks you to look at it, this mod
opens the document in a pane beside the conversation. You move through it block
by block, pin comments, ask side questions that never touch the main
conversation, and then send every comment as one review, or approve.

The design and the reasoning behind it are in [DESIGN.md](DESIGN.md). This
README covers what the mod does today and how to run it.

## What it does

- **Notices a spec or plan.** A `Write` or `Edit` to a path matching the
  configured globs (superpowers' `docs/superpowers/specs/` and `plans/` by
  default) marks it as a candidate. When the model's turn ends with a review
  request, or names the file, the pane opens on it.
- **`/review [path]`** opens any markdown file for review, or the most recent
  candidate when no path is given.
- **Blocks, not lines.** The document is split into markdown blocks (heading,
  paragraph, list, code fence, table, quote). Each block is a focus stop.
- **Comments are anchored by content.** A comment remembers the heading path
  and the opening text of its block, so it survives the model revising the
  file. When a passage disappears, the comment is kept and marked orphaned.
- **Side questions via `model.fork`.** Asking a question runs one completion
  over the session's own transcript, so the model already has the spec in
  context and the answer never enters the conversation. Each answer shows its
  output and cached token counts.
- **One review, one revision.** Submitting sends all comments as a single
  prompt in your words, anchored by heading and quote. Approving sends the
  approval phrase, optionally with unsent comments folded in as non-blocking
  notes.
- **Live refresh.** When the model edits the open file, the pane re-reads it
  and re-anchors every comment.
- **Comments persist across sessions.** Each document's comments, answered
  side questions and the text you last reviewed are kept in the plugin store.
  Reopening the file in a later session restores them, and the store keeps
  the twelve most recently touched documents.
- **A diff of the revision.** Submitting a review (or pressing `r`) takes the
  current text as the version you reviewed. When the model revises the file,
  changed blocks are marked `+` in the margin, `n` jumps between them, and `d`
  shows the unified diff against the reviewed version. A file that changed
  between sessions opens with that diff available.
- **Works without a text field.** On a surface with no `Input` (the mobile
  app), comment and ask go through the engine's own question dialog, whose
  free-text answer becomes the comment.
- **Find, and cycle.** `f` opens a find field; matches are counted in the
  header and `f` again moves to the next one. `m` cycles through the blocks
  that carry comments or questions, `e` jumps to the end.
- **Explain on a small model.** `h` asks a fresh small model (`haiku` by
  default) to explain the current passage in plain words. It sees only the
  passage and the document's title, never the conversation, so it costs a few
  hundred tokens and leaves no trace in the transcript.
- **Forget.** `/review forget [path]` clears a document's saved comments and
  questions, in the pane and in the store.

## Keys in the pane

The pane must hold the keyboard for hotkeys to work: it opens focused from
`/review`, or press `ctrl+x tab` or click it.

| Key | Action |
| --- | --- |
| `j` / `k` | Next / previous block |
| `g` / `e` | Top / end of the document |
| `f` | Find text; again for the next match |
| `m` | Next block with a comment or question |
| `Tab` / `Shift+Tab` | Walk the blocks (the focus ring) |
| `Enter` on a block marker | Comment on that block |
| `c` | Comment on the current block |
| `a` | Ask a side question about the current block |
| `h` | Explain the current block on a small fresh model |
| `s` | Submit all comments as one review |
| `o` | Approve (asks what to do with unsent comments) |
| `n` | Next block changed since the version you reviewed |
| `d` | Toggle the diff against the version you reviewed |
| `r` | Mark the current revision as reviewed (clears the diff) |
| `x` / `Esc` | Close the pane (comments are kept) |

`n`, `d` and `r` appear only while something differs from the reviewed version.

Under an answered side question: **keep as comment**, **send to
conversation** (hands the question to the real conversation with the passage
as context), or **dismiss**.

## Running it

From a terminal, for one session:

```
claude --plugin-dir ./spec-review
```

For every session, add the folder's absolute path to `CLAUDE_CODE_PLUGIN_DIRS`
in the `env` block of `~/.claude/settings.json`. The folder is watched, so a
saved edit hot-reloads the mod.

Then open a spec:

```
/review docs/superpowers/specs/2026-10-04-widgets-design.md
```

Or just let superpowers finish a brainstorm or a plan; the pane offers itself.

## Configuration

Set in the config menu (`/config`) or under `pluginConfigs.spec-review` in
settings.

| Option | Default | Meaning |
| --- | --- | --- |
| `globs` | superpowers specs and plans, `docs/plans`, `*-design.md`, `*-plan.md`, `SPEC.md`, `PLAN.md` | Comma-separated globs of documents that count |
| `offer` | `auto` | `auto` opens the pane when a review is asked for; `toast` only shows a toast and status line; `off` leaves it to `/review` |
| `approvePhrase` | `Looks good, proceed.` | What `o` sends as your words |
| `explainModel` | `haiku` | The model alias or id behind `h` |

Note on `auto`: a pane opened without a user action is only placed on
terminals 144 columns or wider (110 once you have opened it yourself). On a
narrower terminal the mod falls back to a toast and a status line pointing at
`/review`, which places the pane at any width.

## Surfaces

| Surface | Support |
| --- | --- |
| Terminal, fullscreen | Docked pane, all keys |
| Terminal, main screen | Inline pane above the prompt, all keys |
| Desktop app, VS Code | Same as terminal |
| Mobile | Comment and ask through the question dialog; no inline text field |

## Developing

```
claude plugin validate spec-review   # what the engine will load and refuse
claude plugin test spec-review       # 24 tests, no terminal needed
```

Type-checking: once the mod has loaded in a session, the engine lays this
build's API declarations under `spec-review/.claude-plugin/types/`, and
`tsc -p spec-review` type-checks against them.

Layout:

```
spec-review/
  .claude-plugin/plugin.json   manifest, userConfig, types contract
  hooks/hooks.json             names the hooks module
  hooks/register.tsx           the hooks: tool.call, turn.complete, command.run, ui.*
  hooks/blocks.ts              markdown to blocks; anchors and re-anchoring
  hooks/diff.ts                line diff, unified hunks, changed-block detection
  hooks/persist.ts             the shape of the per-document store record
  hooks/review-prompt.ts       the review, ask, escalation and approval texts
  types/index.d.ts             the state contract ($.state under 'spec-review')
  tests/review.test.ts         claude plugin test
```

## Deliberately not built

The design doc's phase 3 named a `Client` module for vim-style keys. The
Button hotkeys already give `j`, `k`, `g`, `e`, `f`, `m`, `n` on every
surface, and a `Client` takes keys only after a click gives it focus, on
terminal and desktop alone. It would add a second input path without adding
a key the pane does not already answer, so it was left out.

Block markers carry a hover style (undimmed and bold under the pointer). The
test kit describes elements without their hover styling, so that is
type-checked and validated but not covered by a test.

## Two rules of the engine worth knowing when editing this

- `$` is followed only into functions declared in the same file. A helper in
  another module cannot take `$`, which is why `persist.ts` holds shapes and
  the store calls sit in `register.tsx`.
- An atom's reference must be written as string literals at the call site.
