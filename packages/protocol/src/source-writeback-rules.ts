import { z } from 'zod'
import { TextTranslations } from './localization'

// Kept apart from source-writeback.ts, which needs source.ts, so source.ts can name it too.

export const WRITEBACK_STAGES = ['start', 'review', 'done'] as const
export type WritebackStage = typeof WRITEBACK_STAGES[number]

// Status names as the tracker shows them, | between alternatives; empty leaves the status alone.
const StatusNames = z.string().trim().max(500).default('')
export const SourceWritebackConfig = z.object({
  start: z.object({ status: StatusNames }).default({ status: '' }),
  review: z.object({ status: StatusNames, comment: z.boolean().default(false) }).default({ status: '', comment: false }),
  done: z.object({ status: StatusNames, comment: z.boolean().default(false) }).default({ status: '', comment: false }),
  // What this source's team wants in a summary besides the built-in rules, said to the agent.
  guidance: z.string().trim().max(1000).default('')
})
export type SourceWritebackConfig = z.infer<typeof SourceWritebackConfig>
export const EMPTY_WRITEBACK: SourceWritebackConfig = SourceWritebackConfig.parse({})

// What a plugin knows of its tracker's statuses, so settings offer them rather than a bare text box
// (manifest writebackRules). A stage left out takes free text; false means the tracker has no
// status for it, as GitHub has nothing between open and closed.
export const WritebackStatusPreset = z.object({
  value: z.string().trim().min(1).max(500),
  label: z.string().min(1).max(64),
  translations: TextTranslations.optional()
})
export type WritebackStatusPreset = z.infer<typeof WritebackStatusPreset>
export const WritebackStageHint = z.union([z.literal(false), z.object({
  presets: z.array(WritebackStatusPreset).max(8).default([]),
  // false when the presets are all the tracker can do, so settings offer no free text.
  custom: z.boolean().default(true),
  placeholder: z.string().max(100).optional(),
  hint: z.string().max(300).optional(),
  translations: TextTranslations.optional()
})])
export type WritebackStageHint = z.infer<typeof WritebackStageHint>
export const WritebackRuleHints = z.object({ start: WritebackStageHint.optional(), review: WritebackStageHint.optional(), done: WritebackStageHint.optional() })
export type WritebackRuleHints = z.infer<typeof WritebackRuleHints>

// The rules as they apply to a tracker: no status where it has none, no comment where it takes none.
// A rule saved before a plugin said so is kept on disk but never acted on.
export function applicableWriteback(config: SourceWritebackConfig, hints: WritebackRuleHints | undefined, comments: boolean): SourceWritebackConfig {
  const status = (stage: WritebackStage) => hints?.[stage] === false ? '' : config[stage].status
  return {
    start: { status: status('start') },
    review: { status: status('review'), comment: comments && config.review.comment },
    done: { status: status('done'), comment: comments && config.done.comment },
    guidance: config.guidance
  }
}
