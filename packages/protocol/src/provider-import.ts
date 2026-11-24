import { z } from 'zod'

export const ProviderImportIssue = z.enum(['unsupported', 'managed-account', 'missing-key', 'missing-endpoint', 'invalid-config', 'duplicate', 'models-unavailable', 'save-failed'])
export const ProviderImportCandidate = z.object({
  id: z.string(), name: z.string(), app: z.string(), endpoint: z.string().nullable(),
  models: z.array(z.string()), issue: ProviderImportIssue.nullable()
})
export type ProviderImportCandidate = z.infer<typeof ProviderImportCandidate>
export const ProviderImportPreview = z.object({
  token: z.string(), directory: z.string(), candidates: z.array(ProviderImportCandidate)
})
export type ProviderImportPreview = z.infer<typeof ProviderImportPreview>
export const ProviderImportResult = z.object({
  items: z.array(z.object({ id: z.string(), name: z.string(), status: z.enum(['imported', 'skipped', 'failed']), issue: ProviderImportIssue.nullable() }))
})
export type ProviderImportResult = z.infer<typeof ProviderImportResult>
