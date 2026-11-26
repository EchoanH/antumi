import { RESERVED_MCP_SERVER_NAME, isCommandTool, isPlanApproval, mcpToolParts, type ChatItem, type UnattendedMode } from '@antumi/protocol'
import type { ChatAnswer } from './chat-driver'
import { readOnlyCommand } from './command-rules'

export const UNATTENDED_DENIAL = '这是无人值守运行，当前模式不允许这一步，已自动拒绝。换一种在项目内完成的做法；做不到就跳过，并在最后的总结里写清楚需要我做什么。'
export const READ_ONLY_PLAN_DENIAL = '这是只读的自动排查，不会执行计划，已自动拒绝。把结论和修复方案写进最后的报告，修复由 Antumi 另行安排。'
export const READ_ONLY_DENIAL = '这是无人值守的自动排查，只自动放行读取：读文件、搜索、查网页，以及不改动任何东西的命令（如 git log、gh issue view，管道和 && 连起来的也行）。这一步不在其中，已自动拒绝。换成只读的做法；做不到就跳过，并在最后的总结里写清楚还需要什么。'
// Tools that only read, by the names the agents give them (Claude's, and ACP's kinds).
const READ_TOOLS = new Set(['Read', 'Glob', 'Grep', 'LS', 'WebFetch', 'WebSearch', 'read', 'search', 'fetch', 'think'])

// What a run nobody watches lets through when it may read: a tool that only reads, a command that
// changes nothing (judged by its full text: an approval's title holds only its first line), and
// the user's MCP tools, which a run that only reads is given only the read-only ones of. Antumi's
// own that ask act (a browser page, a terminal), so they are not among them.
function onlyReads(item: Extract<ChatItem, { kind: 'approval' }>, command: string | null): boolean {
  if (isCommandTool(item.tool)) return command !== null && readOnlyCommand(command)
  if (READ_TOOLS.has(item.tool)) return true
  const mcp = mcpToolParts(item.tool, null)
  return !!mcp && mcp.server !== RESERVED_MCP_SERVER_NAME
}
// How long a question waits for the user, notified as any question is, before it is answered for them.
export const UNATTENDED_QUESTION_WAIT_MS = 10 * 60_000
export const UNATTENDED_QUESTION = '这是无人值守运行，等了 10 分钟没有人回答这个问题。按最合理的假设继续，并在最后的总结里写明你做了哪些假设。'

// What Antumi answers for the user in a run nobody watches, so the run never waits on them for
// long: a question goes unanswered (once it has waited, see ConversationService), with word to
// assume and go on; a plan is approved, as a scheduled run
// approves the one it finds; anything else is allowed where the run allows everything, and denied
// otherwise, with word to work around it. Null for what needs no answer: one already answered,
// and a question asked in passing, which does not hold the agent up.
// reads: 'allow' lets what only reads through whatever the mode; 'only' also refuses a plan, as
// carrying it out would leave a run that only reads. command: an approved command's full text.
export function unattendedAnswer(item: ChatItem, mode: UnattendedMode, reads?: 'allow' | 'only', command: string | null = null): ChatAnswer | null {
  if (item.kind === 'question') return item.resolution === null && !item.async ? { decision: 'deny', message: UNATTENDED_QUESTION } : null
  if (item.kind !== 'approval' || item.resolution !== null) return null
  if (isPlanApproval(item)) return reads === 'only' ? refusal(item, READ_ONLY_PLAN_DENIAL) : { decision: 'allowForSession' }
  // Yes this once: a yes for the session can outlast the run (OpenCode keeps "always" for the
  // project), and every later ask is answered here anyway.
  if (mode === 'bypass' || (reads && onlyReads(item, command))) {
    const choice = item.choices?.find((each) => each.decision === 'allow')
    return { decision: 'allow', ...(choice ? { choice: choice.id } : {}) }
  }
  return refusal(item, reads ? READ_ONLY_DENIAL : UNATTENDED_DENIAL)
}

// A plain no, rather than one that also rules the tool out for the rest of the session.
function refusal(item: Extract<ChatItem, { kind: 'approval' }>, message: string): ChatAnswer {
  const choice = item.choices?.find((each) => each.decision === 'deny' && each.grants.length === 0) ?? item.choices?.find((each) => each.decision === 'deny')
  return { decision: 'deny', message, ...(choice ? { choice: choice.id } : {}) }
}

export const CHANNEL_DENIAL = '这一步不允许：你在聊天平台上回答别人的提问，只能用给出的工具读取项目。用已有的工具继续；做不到就直接说明查不到什么。'

// What Antumi answers for an agent locked down for a chat platform's asker: no, to everything, at
// once. Nobody there may grant it, and the user is not asked on a stranger's behalf; a question
// gets the same answer, so the agent says what it could not settle rather than wait.
export function channelAnswer(item: ChatItem): ChatAnswer | null {
  if ((item.kind !== 'approval' && item.kind !== 'question') || item.resolution !== null) return null
  if (item.kind === 'question') return { decision: 'deny', message: CHANNEL_DENIAL }
  return refusal(item, CHANNEL_DENIAL)
}
