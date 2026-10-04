// The spec-review mod's state contract: every value it keeps in `$.state`.

export type SpecReviewBlockKind =
  | 'heading'
  | 'paragraph'
  /** A whole list: what an earlier version made; lists now split into items. */
  | 'list'
  /** One list item, its nested items excluded (each is a block of its own). */
  | 'item'
  | 'code'
  | 'table'
  | 'quote'
  | 'rule'

export type SpecReviewBlock = {
  index: number
  kind: SpecReviewBlockKind
  /** The block's raw markdown. */
  text: string
  /** 1-based line range in the file. */
  startLine: number
  endLine: number
  /** Headings above this block, outermost first; a heading block includes itself. */
  headingPath: string[]
  /** For an item: how deeply it nests, 0 at the list's top level. */
  depth?: number
}

/** Where a comment belongs, independent of line numbers. */
export type SpecReviewAnchor = {
  headingPath: string[]
  /** The block's normalised opening text, at most 200 characters. */
  quote: string
  /** The block's index when the anchor was made; a hint only. */
  blockIndex: number
}

export type SpecReviewComment = {
  id: string
  anchor: SpecReviewAnchor
  text: string
  /** True when the anchor no longer matches any block of the current text. */
  isOrphan: boolean
}

export type SpecReviewThread = {
  id: string
  anchor: SpecReviewAnchor
  /** `ask` goes to the conversation's model over its transcript; `explain` to a small fresh model. */
  kind: 'ask' | 'explain'
  question: string
  status: 'pending' | 'answered' | 'failed'
  /** The model that answered: set for an `explain` thread, and for an `ask` answered without the conversation. */
  model?: string
  answer?: string
  failure?: string
  outputTokens?: number
  cachedTokens?: number
}

export type SpecReviewDoc = {
  path: string
  title: string
  /** The file's text as last read. */
  text: string
  blocks: SpecReviewBlock[]
  /** The focused block's index. */
  cursor: number
  /** How many times the file was re-read since opening. */
  revision: number
  /** The text the reviewer last read in full: set on open, on submit, on "mark reviewed". */
  baselineText: string
  /** Indices of blocks that differ from the baseline. */
  changed: number[]
  /** What the pane shows: the document, or the diff against the baseline. */
  view: 'document' | 'diff'
  /** True from a submitted review until the file next changes. */
  awaitingRevision: boolean
  /** When a review or approval was last sent for this document. */
  lastReviewAt: number | null
  /** The last find: its text and the blocks it matches, in order. */
  search: { query: string; matches: number[] } | null
  /** Columns the focused table or code block is scrolled right by; 0 when the cursor moves. */
  pan?: number
}

/** One document's record in `$.store`, kept across sessions. */
export type SpecReviewSaved = {
  path: string
  comments: SpecReviewComment[]
  threads: SpecReviewThread[]
  baselineText: string | null
  lastReviewAt: number | null
  updatedAt: number
}

export type SpecReviewComposer = {
  blockIndex: number
  mode: 'comment' | 'ask' | 'find'
} | null

export type SpecReviewCandidate = {
  path: string
  writtenAt: number
  /** The session's turn count when it was written. */
  turn: number
}

declare module 'claude-code' {
  interface PluginState {
    'spec-review': {
      doc: SpecReviewDoc | null
      comments: SpecReviewComment[]
      threads: SpecReviewThread[]
      composer: SpecReviewComposer
      candidates: SpecReviewCandidate[]
      offered: string[]
      notice: string | null
    }
  }
}
