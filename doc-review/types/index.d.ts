// The doc-review mod's state contract: every value it keeps in `$.state`.

export type DocReviewBlockKind =
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

export type DocReviewBlock = {
  index: number
  kind: DocReviewBlockKind
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
export type DocReviewAnchor = {
  headingPath: string[]
  /** The block's normalised opening text, at most 200 characters. */
  quote: string
  /** The block's index when the anchor was made; a hint only. */
  blockIndex: number
}

export type DocReviewComment = {
  id: string
  anchor: DocReviewAnchor
  text: string
  /** True when the anchor no longer matches any block of the current text. */
  isOrphan: boolean
}

export type DocReviewThread = {
  id: string
  anchor: DocReviewAnchor
  /** `ask` goes to the conversation's model over its transcript; `explain` to a small fresh model. */
  kind: 'ask' | 'explain'
  question: string
  status: 'pending' | 'answered' | 'failed'
  /** The model that answered: set for an `explain` thread, and for an `ask` answered without the conversation. */
  model?: string
  /** Why an `ask` was answered from the document alone: the conversation had no reply yet, or the person picked another model. */
  alone?: 'no-reply' | 'chosen'
  answer?: string
  failure?: string
  outputTokens?: number
  cachedTokens?: number
}

export type DocReviewDoc = {
  path: string
  title: string
  /** The file's text as last read. */
  text: string
  blocks: DocReviewBlock[]
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
export type DocReviewSaved = {
  path: string
  comments: DocReviewComment[]
  threads: DocReviewThread[]
  baselineText: string | null
  lastReviewAt: number | null
  updatedAt: number
}

export type DocReviewComposer = {
  blockIndex: number
  mode: 'comment' | 'ask' | 'find'
} | null

export type DocReviewCandidate = {
  path: string
  writtenAt: number
  /** The session's turn count when it was written. */
  turn: number
}

declare module 'claude-code' {
  interface PluginState {
    'doc-review': {
      doc: DocReviewDoc | null
      comments: DocReviewComment[]
      threads: DocReviewThread[]
      composer: DocReviewComposer
      candidates: DocReviewCandidate[]
      offered: string[]
      notice: string | null
      /** The model side questions go to this session, picked in the ask composer: 'session' forks the conversation. Null until picked. */
      askVia: string | null
    }
  }
}
