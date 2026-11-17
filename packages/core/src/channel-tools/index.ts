import { ChannelToolError, type ChannelTool, type ChannelToolResult, type ChannelToolScope } from './channel-tool'
import { projectList, projectRead, projectSearch } from './project'
import { taskCreate } from './task'

export { ChannelToolError, type ChannelTool, type ChannelToolResult, type ChannelToolScope } from './channel-tool'

// Every tool an agent locked down for a chat platform has. One is added here and nowhere else: the
// MCP server lists them, core runs them, and an agent's allowed tools are these names.
export const CHANNEL_TOOLS: readonly ChannelTool[] = [projectList, projectSearch, projectRead, taskCreate]
export const CHANNEL_TOOL_NAMES: readonly string[] = CHANNEL_TOOLS.map((tool) => tool.name)

// Runs one for the agent. What it may not have comes back as the tool's own answer, so the agent
// can say so; so does a call it got wrong.
export async function runChannelTool(scope: ChannelToolScope, name: string, args: unknown): Promise<ChannelToolResult & { isError: boolean }> {
  const tool = CHANNEL_TOOLS.find((each) => each.name === name)
  const failed = (text: string) => ({ text, target: '', bytes: 0, isError: true })
  if (!tool) return failed(`没有工具 ${name}`)
  try {
    return { ...(await tool.call(scope, args)), isError: false }
  } catch (error) {
    return failed(error instanceof ChannelToolError ? error.message : '工具调用失败')
  }
}
