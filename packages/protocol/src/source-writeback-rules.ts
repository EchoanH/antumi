import { z } from 'zod'
import { TextTranslations } from './localization'

// Kept apart from source-writeback.ts, which needs source.ts, so source.ts can name it too.

export const WRITEBACK_STAGES = ['start', 'review', 'done'] as const
export type WritebackStage = typeof WRITEBACK_STAGES[number]

// Status names as the tracker shows them, | between alternatives; empty leaves the status alone.
const StatusNames = z.string().trim().max(500).default('')
const StartRule = z.object({ status: StatusNames })
const StageRule = z.object({ status: StatusNames, comment: z.boolean().default(false) })
export const SourceWritebackConfig = z.object({
  start: StartRule.default({ status: '' }),
  review: StageRule.default({ status: '', comment: false }),
  done: StageRule.default({ status: '', comment: false }),
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

// A source takes issues of several types, each with a workflow of its own: a lane is the rules for
// one type, each stage left out following the source's own. off writes nothing back for the type.
const Id = z.string().min(1).max(500)
export const WritebackLane = z.object({
  typeId: Id,
  // Only in this project or team; left out, wherever the type turns up.
  scopeId: Id.optional(),
  // The type's name when the lane was made, shown once the tracker no longer lists it.
  name: z.string().max(200).default(''),
  mode: z.enum(['on', 'off']).default('on'),
  start: StartRule.optional(),
  review: StageRule.optional(),
  done: StageRule.optional()
})
export type WritebackLane = z.infer<typeof WritebackLane>

// dryRun: rules go through every step and record what they would write, without writing.
// sharedCounts: an issue assigned to the user and others counts as the user's.
export const WritebackOptions = z.object({ dryRun: z.boolean().default(false), sharedCounts: z.boolean().default(false) })
export type WritebackOptions = z.infer<typeof WritebackOptions>
export const NO_WRITEBACK_OPTIONS: WritebackOptions = WritebackOptions.parse({})

// A type a plugin knows its tracker has (manifest writebackTypes), with what its stages can be.
// mode off: left alone until the user makes a lane for it, as a pull request is.
export const WritebackType = z.object({
  id: Id, name: z.string().min(1).max(100), translations: TextTranslations.optional(),
  mode: z.enum(['on', 'off']).default('on'),
  rules: WritebackRuleHints.optional()
})
export type WritebackType = z.infer<typeof WritebackType>

export const WILDCARD_LANE = '*'

// The rules for an issue of this type in this scope: the lane naming both, else the one naming the
// type, else the source's own. off when the lane, or failing one the type itself, says so.
export function resolveLane(
  config: SourceWritebackConfig,
  lanes: readonly WritebackLane[],
  types: readonly WritebackType[],
  issue: { type?: { id: string } | undefined; scope?: { id: string } | undefined }
): { lane: string; off: boolean; rules: SourceWritebackConfig } {
  const typeId = issue.type?.id
  const matching = typeId ? lanes.filter((lane) => lane.typeId === typeId) : []
  const lane = matching.find((each) => each.scopeId !== undefined && each.scopeId === issue.scope?.id) ?? matching.find((each) => each.scopeId === undefined)
  if (!lane) return { lane: WILDCARD_LANE, off: types.find((type) => type.id === typeId)?.mode === 'off', rules: config }
  return {
    lane: lane.typeId,
    off: lane.mode === 'off',
    rules: { start: lane.start ?? config.start, review: lane.review ?? config.review, done: lane.done ?? config.done, guidance: config.guidance }
  }
}
