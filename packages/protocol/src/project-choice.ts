import { z } from 'zod'

export const ProjectChoice = z.object({
  path: z.string(),
  worktree: z.boolean(),
  source: z.string().nullable(),
  branch: z.string().nullable()
})
export type ProjectChoice = z.infer<typeof ProjectChoice>
