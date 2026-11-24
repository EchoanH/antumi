import { z } from 'zod'
import { ISSUE_STATUS_CATEGORIES, SourceId, SourceKey } from './source'
import { SourceUpdateTarget } from './source-comments'

// Writing back to the issue a task or an investigation came from: moving its status and posting
// comments. A plugin offers it with writeback: 1; see docs/SOURCE-WRITEBACK.md.

// The agent's tool for drafting the summary; it writes to Antumi only, so it asks the user nothing.
export const SOURCE_REPORT_TOOL = 'source_report'

export const MAX_WRITEBACK_COMMENT = 20_000
export const MAX_SOURCE_REPORT = 8_000
// What a summary for an issue may run to: the prompt asks for 300 characters, this leaves slack, and
// past it source_report refuses so the agent writes a shorter one.
export const SOURCE_REPORT_LIMIT = 600

const StatusCategory = z.enum(ISSUE_STATUS_CATEGORIES)

// One status the issue can move to now. id is the plugin's own (a Jira transition, a Linear state)
// and goes back to it unread; action is what the tracker calls the move, when it names one.
export const SourceTransitionOption = z.object({
  id: z.string().min(1).max(500),
  name: z.string().min(1).max(100),
  action: z.string().min(1).max(100).optional(),
  category: StatusCategory
})
export type SourceTransitionOption = z.infer<typeof SourceTransitionOption>

export const SourceTransitions = z.object({
  status: z.string().max(100),
  statusCategory: StatusCategory,
  options: z.array(SourceTransitionOption).max(100)
})
export type SourceTransitions = z.infer<typeof SourceTransitions>

export const SourceStatusResult = z.object({ status: z.string().max(100), statusCategory: StatusCategory })
export type SourceStatusResult = z.infer<typeof SourceStatusResult>

export const SourceCommentResult = z.object({ id: z.string().min(1).max(500), url: z.string().max(4000).nullable() })
export type SourceCommentResult = z.infer<typeof SourceCommentResult>

export const SOURCE_WRITE_TRIGGERS = ['manual', 'start', 'review', 'done'] as const
export const SourceWriteTrigger = z.enum(SOURCE_WRITE_TRIGGERS)
export type SourceWriteTrigger = z.infer<typeof SourceWriteTrigger>

// pending: recorded, not answered yet; uncertain: the call may or may not have reached the tracker.
export const SourceWriteState = z.enum(['pending', 'sent', 'skipped', 'failed', 'uncertain'])
export type SourceWriteState = z.infer<typeof SourceWriteState>

export const SourceWrite = z.object({
  id: z.string().uuid(),
  target: SourceUpdateTarget,
  provider: SourceId, instance: SourceId, key: SourceKey,
  kind: z.enum(['status', 'comment']),
  trigger: SourceWriteTrigger,
  // The status asked for, or the comment's text.
  detail: z.string(),
  // Where the comment's text came from, when a rule wrote it.
  origin: z.enum(['report', 'last-reply', 'user']).nullable(),
  state: SourceWriteState,
  // The status after the move, or the comment's id and link on the tracker.
  result: z.string().nullable(),
  url: z.string().nullable(),
  reason: z.string().nullable(),
  createdAt: z.number(), updatedAt: z.number()
})
export type SourceWrite = z.infer<typeof SourceWrite>

// The summary the agent drafted for the issue; Antumi posts it, never the agent.
export const SourceReport = z.object({ text: z.string().max(MAX_SOURCE_REPORT), updatedAt: z.number() })
export type SourceReport = z.infer<typeof SourceReport>

export const SourceWriteback = z.object({
  target: SourceUpdateTarget,
  supported: z.boolean(),
  // Whether the tracker takes comments, or only status moves.
  comments: z.boolean().default(true),
  report: SourceReport.nullable(),
  writes: z.array(SourceWrite)
})
export type SourceWriteback = z.infer<typeof SourceWriteback>

const RANK = { todo: 0, doing: 1, done: 2 } as const

// The option a rule's names pick: the first name that matches exactly one option, by status or by
// action. null when none does; skip when the issue is already there or past it.
export function pickTransition(transitions: SourceTransitions, names: string): { option: SourceTransitionOption } | { skip: 'already' | 'backwards' } | null {
  const wanted = names.split('|').map((name) => name.trim().toLowerCase()).filter(Boolean)
  for (const name of wanted) {
    if (transitions.status.trim().toLowerCase() === name) return { skip: 'already' }
    const matches = transitions.options.filter((option) => option.name.trim().toLowerCase() === name || option.action?.trim().toLowerCase() === name)
    const [option] = matches
    if (matches.length !== 1 || !option) continue
    const from = transitions.statusCategory
    const to = option.category
    if (from !== 'unknown' && to !== 'unknown' && RANK[from] > RANK[to]) return { skip: 'backwards' }
    return { option }
  }
  return null
}
