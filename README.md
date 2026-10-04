# spec-review

A Claude Code mod that turns "please review the plan" into a real review.

When a plugin such as [superpowers](https://github.com/obra/superpowers) writes
a design spec or an implementation plan and asks you to look at it, this mod
opens the document in a pane beside the conversation. You move through it block
by block, pin comments, ask side questions that never touch the main
conversation, and then send every comment as one review, or approve.

The design and the reasoning behind it are in [DESIGN.md](DESIGN.md). This
README covers what phase 1 does and how to run it.

## What phase 1 does

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

## Keys in the pane

The pane must hold the keyboard for hotkeys to work: it opens focused from
`/review`, or press `ctrl+x tab` or click it.

| Key | Action |
| --- | --- |
| `j` / `k` | Next / previous block |
| `g` | Top of the document |
| `Tab` / `Shift+Tab` | Walk the blocks (the focus ring) |
| `Enter` on a block marker | Comment on that block |
| `c` | Comment on the current block |
| `a` | Ask a side question about the current block |
| `s` | Submit all comments as one review |
| `o` | Approve (asks what to do with unsent comments) |
| `x` / `Esc` | Close the pane (comments are kept) |

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
| Mobile | Read and approve only; the app has no text field yet |

## Developing

```
claude plugin validate spec-review   # what the engine will load and refuse
claude plugin test spec-review       # 13 tests, no terminal needed
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
  hooks/review-prompt.ts       the review, ask, escalation and approval texts
  types/index.d.ts             the state contract ($.state under 'spec-review')
  tests/review.test.ts         claude plugin test
```

## Not yet (phases 2 and 3)

Persisting comments across sessions, a diff of the revision, vim-style
navigation through a `Client` module on terminal and desktop, `/` search, and a
cheap "explain this term" path on a small model. See DESIGN.md section 8.
