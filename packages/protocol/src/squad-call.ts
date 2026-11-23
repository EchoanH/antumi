import { z } from 'zod'
import { AttachmentId } from './attachments'
import { Squad } from './squad'
import { ChatPermissionMode } from './chat'
import { AgentCallWorktreeOutcome, DelegationQuota } from './agent-profile'

export const SquadCallSource = z.object({ path: z.string(), base: z.string().nullable(), reference: z.boolean() })
export const SquadCall = z.object({
  id: z.string().uuid(), parentId: z.string().uuid(), taskId: z.string(), ref: z.string(),
  squad: Squad, instruction: z.string(), images: z.array(AttachmentId).default([]), sources: z.array(SquadCallSource),
  permissionMode: ChatPermissionMode, allowBypass: z.boolean(), runId: z.string().uuid().nullable(),
  state: z.enum(['queued', 'starting', 'running', 'awaiting', 'paused', 'review', 'failed', 'cancelled']),
  result: z.string().nullable(), error: z.string().nullable(),
  version: z.number().int().nonnegative(), deliveredVersion: z.number().int().nonnegative(),
  outcomes: z.array(z.object({ source: z.string(), dir: z.string(), branch: z.string(), base: z.string(), outcome: AgentCallWorktreeOutcome })),
  createdAt: z.number(), updatedAt: z.number()
})
export type SquadCall = z.infer<typeof SquadCall>
export const SquadCallTarget = z.object({
  squad: Squad, reason: z.string().nullable(), permissionMode: ChatPermissionMode.nullable(),
  quotas: z.array(z.object({ memberId: z.string(), quota: DelegationQuota }))
})
export type SquadCallTarget = z.infer<typeof SquadCallTarget>
export function squadCallOpen(call: Pick<SquadCall, 'state'>): boolean {
  return !['review', 'failed', 'cancelled'].includes(call.state)
}
export const SQUAD_CALL_TOOLS = {
  list: 'antumi_team_list', dispatch: 'antumi_team_dispatch', status: 'antumi_team_status', cancel: 'antumi_team_cancel'
} as const
