import { z } from 'zod'
import { AgentKind } from '@antumi/protocol'

// What main knows of a newer Antumi, as the renderer shows it.
export const UpdateState = z.object({
  current: z.string(),
  status: z.enum(['idle', 'checking', 'none', 'available', 'ready', 'downloading', 'installing', 'error']),
  latest: z.object({
    version: z.string(),
    notes: z.string(),
    page: z.string(),
    // The installer for this machine, opened in the browser when it cannot be installed in place.
    download: z.string().nullable()
  }).nullable(),
  // Whether main can replace this packaged macOS app or Windows installation.
  canInstall: z.boolean(),
  progress: z.number().min(0).max(1).nullable(),
  error: z.string().nullable(),
  // With error agents-running: the daemon sessions still running, for the user to deal with.
  blockers: z.array(z.object({ sessionId: z.string(), agent: AgentKind.optional() })),
  checkedAt: z.number().nullable(),
  automatic: z.boolean().default(true),
  prerelease: z.boolean(),
  skipped: z.string().nullable()
})
export type UpdateState = z.infer<typeof UpdateState>

export { compareVersions, isVersion } from '@antumi/protocol'

