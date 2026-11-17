import type { z } from 'zod'
import type { TaskStatus } from '@antumi/protocol'

// Only the projects and task collection capability core grants this call.
export type ChannelTaskInput = { title: string; details: string; projects: string[] }
export type ChannelToolScope = {
  roots: readonly string[]
  createTask?: (input: ChannelTaskInput) => Promise<{ id: string; title: string; status: TaskStatus }>
}

// target: what it read or created, as the question's record shows it. bytes: how much it returned.
export type ChannelToolResult = { text: string; target: string; bytes: number }

// One tool an agent locked down for a chat platform may call (docs/CHANNELS.md, 扩展点). The MCP
// server lists it from here and core runs it, so adding one touches no agent's adapter.
export type ChannelTool = {
  name: string
  description: string
  // As MCP lists it.
  inputSchema: Record<string, unknown>
  readOnly?: boolean
  // args: as the agent sent them, checked here.
  call(scope: ChannelToolScope, args: unknown): Promise<ChannelToolResult>
}

// Something the agent asked for that it may not have or that is not there: told to the agent as
// the tool's answer, never thrown further.
export class ChannelToolError extends Error {}

export function channelTool<Args>(spec: Omit<ChannelTool, 'call'> & { params: z.ZodType<Args>; run(scope: ChannelToolScope, args: Args): Promise<ChannelToolResult> }): ChannelTool {
  const { params, run, ...rest } = spec
  return {
    ...rest,
    call(scope, args) {
      const parsed = params.safeParse(args ?? {})
      if (!parsed.success) throw new ChannelToolError(`参数不对：${parsed.error.issues.map((issue) => `${issue.path.join('.')} ${issue.message}`).join('；')}`)
      return run(scope, parsed.data)
    }
  }
}
