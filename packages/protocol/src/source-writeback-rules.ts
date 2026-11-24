import { z } from 'zod'

// Kept apart from source-writeback.ts, which needs source.ts, so source.ts can name it too.

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
