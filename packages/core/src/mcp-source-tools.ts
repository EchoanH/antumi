import { z } from 'zod'
import { AGENT_KINDS, agentDescriptor, AgentKind, MAX_SOURCE_REPORT, SourceTaskProposal, SourceFixProposal, SOURCE_OUTCOMES, SOURCE_REPORT_LIMIT, SOURCE_REPORT_TOOL, SOURCE_TASK_READ_TOOLS, type RpcConnection } from '@antumi/protocol'
import { reportRules, RESULT_FIELDS } from './source-report-prompt'

type WithCore = <T>(action: (rpc: RpcConnection) => Promise<T>) => Promise<T>
type Result = { content: { type: 'text'; text: string }[]; isError: boolean }

// summary alone is the tool as it first was; the rest says how the work ended, for core to act on.
const Note = z.string().trim().max(SOURCE_REPORT_LIMIT).optional()
const ReportInput = z.object({ summary: z.string().trim().min(1).max(MAX_SOURCE_REPORT), outcome: z.enum(SOURCE_OUTCOMES).optional(), verification: Note, question: Note, blocker: Note, fix: SourceFixProposal.optional() })
const text = (value: string, isError = false): Result => ({ content: [{ type: 'text', text: value }], isError })

// The summary tool for the agent of a task or investigation from an issue that can be written back
// to (docs/SOURCE-WRITEBACK.md). It drafts; Antumi posts, by the user's rules or hand.
export function sourceToolsOverCore(withCore: WithCore, conversationId: string) {
  return [
    {
      spec: {
        name: SOURCE_REPORT_TOOL,
        description: `给这个任务来源的事项（Jira、GitHub 等）写一条完成总结，存为草稿。做完工作、交给用户验收前调用；之后又改了就再调用一次覆盖。超过 ${SOURCE_REPORT_LIMIT} 字会被退回。\n${reportRules()}\n${RESULT_FIELDS}\n` +
          '它不会直接发出去：用户设置了规则时，Antumi 在提交验收或验收通过时把它作为评论发到事项上，否则由用户决定。你不能用它改事项状态。',
        inputSchema: {
          type: 'object',
          properties: {
            summary: { type: 'string', description: `总结正文，2 到 4 句，${SOURCE_REPORT_LIMIT} 字以内` },
            outcome: { type: 'string', enum: [...SOURCE_OUTCOMES], description: '这次工作的结果：delivered 已交付等验证，answered 只答复了问题，needs_input 缺信息无法继续，blocked 受阻' },
            verification: { type: 'string', description: '给验证的人看：怎么验、影响哪些地方。一两句，会作为单独一段附在评论后面' },
            question: { type: 'string', description: 'outcome 是 needs_input 时：要问报告人的一个具体问题' },
            blocker: { type: 'string', description: 'outcome 是 blocked 时：被什么挡住了' },
            fix: { type: 'object', description: '自动排查的分流建议，由 core 按用户授权决定是否创建修复任务；不直接执行。', properties: {
              decision: { type: 'string', enum: ['repair', 'needs_input', 'no_fix'] },
              evidence: { type: 'string', description: '缺陷证据与定位依据，最多 2000 字', maxLength: 2000 },
              plan: { type: 'string', description: '建议的修复范围与验证方法，最多 4000 字', maxLength: 4000 },
              task: { ...z.toJSONSchema(SourceTaskProposal), description: 'decision 为 repair 时必须提交完整任务提案：标题、详情、执行 Agent、模型、推理强度、服务商、项目与分支起点由中枢决定。先用 source_task_options 查询候选，再用 source_task_catalog 查询模型；未指定模型等表示使用所选 Agent 的默认值，不继承排查配置。权限由用户策略控制，不能在提案里设置。' }
            }, required: ['decision', 'evidence', 'plan'], additionalProperties: false }
          },
          required: ['summary'],
          additionalProperties: false
        },
        // Writes to Antumi alone, never to the tracker or the workspace, so it is fine while planning.
        annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false }
      },
      run: async (raw: Record<string, unknown>): Promise<Result> => {
        const args = ReportInput.safeParse(raw)
        if (!args.success) return text(`参数不对：${args.error.issues.map((issue) => `${issue.path.join('.')}: ${issue.message}`).join('；')}`, true)
        const { summary, ...result } = args.data
        try {
          await withCore((rpc) => rpc.call('sources.saveReport', { conversationId, text: summary, ...result }))
          return text('已存为事项总结草稿。用户会在任务的来源区块看到它。')
        } catch (error) {
          return text(`没能保存：${error instanceof Error ? error.message : String(error)}`, true)
        }
      }
    },
    {
      spec: {
        name: SOURCE_TASK_READ_TOOLS[0],
        description: '只读查询可用于任务提案的已登记项目、可用外部智能体及模型服务商。返回项目绝对路径；可结合事项所属项目、仓库地址、README 和代码判断任务应使用的项目，不需要用户维护项目映射。不会创建或启动任务。',
        inputSchema: { type: 'object', properties: {}, required: [], additionalProperties: false },
        annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false }
      },
      run: async (): Promise<Result> => {
        try {
          return await withCore(async (rpc) => {
            const [projects, environment, providers, settings] = await Promise.all([rpc.call('projects.recent', {}), rpc.call('system.environment', {}), rpc.call('modelProviders.list', {}), rpc.call('system.chatSettings', {})])
            const agents = AGENT_KINDS.flatMap((agent) => environment.checks.some((check) => check.tool === agent && check.status === 'ok' && !check.problem && !settings.disabledAgents?.includes(agent)) ? [{ agent, name: agentDescriptor(agent).label }] : [])
            return text(JSON.stringify({ projects, agents, modelProviders: providers.map((provider) => ({ id: provider.id, name: provider.name, agents: provider.agents, hasKey: provider.hasKey })) }))
          })
        } catch (error) { return text(error instanceof Error ? error.message : String(error), true) }
      }
    },
    {
      spec: {
        name: SOURCE_TASK_READ_TOOLS[1],
        description: '只读查询某个执行 Agent 的真实模型目录和可用推理强度。提交任务前先查询，选择返回的模型 ID 和 effort；不指定或填 null 表示使用该 Agent 的默认值。不会创建或启动任务。',
        inputSchema: { type: 'object', properties: { agent: { type: 'string', enum: [...AGENT_KINDS] }, modelProvider: { type: 'string' } }, required: ['agent'], additionalProperties: false },
        annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false }
      },
      run: async (raw: Record<string, unknown>): Promise<Result> => {
        const args = z.object({ agent: AgentKind, modelProvider: z.string().min(1).max(100).optional() }).safeParse(raw)
        if (!args.success) return text('请选择有效的 Agent 和服务商', true)
        try { return await withCore(async (rpc) => text(JSON.stringify(await rpc.call('conversations.chatCatalog', args.data)))) }
        catch (error) { return text(error instanceof Error ? error.message : String(error), true) }
      }
    }
  ]
}
