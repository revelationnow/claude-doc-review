// The texts the mod sends to the model: a review, a side question, an approval.

import type { SpecReviewBlock, SpecReviewComment } from '../types'
import { describeBlock, excerpt, reanchor } from './blocks'

function quoteOf(comment: SpecReviewComment, blocks: readonly SpecReviewBlock[]): string {
  const at = reanchor(comment.anchor, blocks)
  const block = at === -1 ? undefined : blocks[at]
  if (block) return `${describeBlock(block)}:\n   > ${excerpt(block, 240)}`
  const where = comment.anchor.headingPath.length > 0 ? `under "${comment.anchor.headingPath.join(' > ')}"` : 'in the document'
  return `${where}, a passage that no longer appears, which began "${comment.anchor.quote.slice(0, 100)}"`
}

export function buildReviewPrompt(args: {
  path: string
  comments: readonly SpecReviewComment[]
  blocks: readonly SpecReviewBlock[]
}): string {
  const n = args.comments.length
  const lines = [
    `I reviewed \`${args.path}\` and have ${n} ${n === 1 ? 'comment' : 'comments'}. Please revise the document to address each one, keep the rest as it is, and then summarise what changed per comment.`,
    '',
  ]
  args.comments.forEach((c, i) => {
    lines.push(`${i + 1}. ${quoteOf(c, args.blocks)}`)
    lines.push(`   Comment: ${c.text}`)
    lines.push('')
  })
  return lines.join('\n').trimEnd()
}

export function buildAskPrompt(args: { path: string; block: SpecReviewBlock; question: string }): string {
  return [
    `I am reviewing \`${args.path}\` and have a question about one passage, ${describeBlock(args.block)}:`,
    '',
    ...args.block.text.split('\n').map(l => `> ${l}`),
    '',
    `Question: ${args.question}`,
    '',
    'Answer from what you know of this document and the conversation. Do not edit any file; this is a side question during review.',
  ].join('\n')
}

export function buildEscalationPrompt(args: {
  path: string
  block: SpecReviewBlock
  question: string
  answer?: string
}): string {
  const lines = [
    `About \`${args.path}\`, ${describeBlock(args.block)}:`,
    '',
    `> ${excerpt(args.block, 300)}`,
    '',
    args.question,
  ]
  if (args.answer) {
    lines.push('', `(When I asked this on the side, you answered: "${args.answer.slice(0, 400)}")`)
  }
  return lines.join('\n')
}

export function buildApprovalPrompt(args: {
  path: string
  phrase: string
  notes: readonly SpecReviewComment[]
  blocks: readonly SpecReviewBlock[]
}): string {
  if (args.notes.length === 0) return args.phrase
  const lines = [args.phrase, '', `A few non-blocking notes on \`${args.path}\` you may fold in as you go:`, '']
  args.notes.forEach((c, i) => {
    lines.push(`${i + 1}. ${quoteOf(c, args.blocks)}`)
    lines.push(`   Note: ${c.text}`)
    lines.push('')
  })
  return lines.join('\n').trimEnd()
}

/** A fresh small model's brief: the passage and the document's title, nothing more. */
export function buildExplainPrompt(args: { path: string; title: string; block: SpecReviewBlock }): { system: string; prompt: string } {
  return {
    system:
      'You explain passages of software design documents to their reviewer. Answer in plain words, in at most four short sentences. Define any jargon or acronym the passage uses. Do not evaluate or suggest changes; only explain what it says and means.',
    prompt: [
      `Document: "${args.title}" (${args.path}).`,
      `Passage, ${describeBlock(args.block)}:`,
      '',
      ...args.block.text.split('\n').map(l => `> ${l}`),
      '',
      'Explain this passage.',
    ].join('\n'),
  }
}
