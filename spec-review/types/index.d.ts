// The spec-review mod's state contract: every value it keeps in `$.state`.

export type SpecReviewBlockKind =
  | 'heading'
  | 'paragraph'
  | 'list'
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
  question: string
  status: 'pending' | 'answered' | 'failed'
  answer?: string
  failure?: string
  outputTokens?: number
  cachedTokens?: number
}

export type SpecReviewDoc = {
  path: string
  title: string
  blocks: SpecReviewBlock[]
  /** The focused block's index. */
  cursor: number
  /** How many times the file was re-read since opening. */
  revision: number
}

export type SpecReviewComposer = {
  blockIndex: number
  mode: 'comment' | 'ask'
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
