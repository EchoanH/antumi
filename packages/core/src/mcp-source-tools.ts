import { z } from 'zod'
import { MAX_SOURCE_REPORT, SOURCE_OUTCOMES, SOURCE_REPORT_LIMIT, SOURCE_REPORT_TOOL, type RpcConnection } from '@antumi/protocol'
import { reportRules, RESULT_FIELDS } from './source-report-prompt'

type WithCore = <T>(action: (rpc: RpcConnection) => Promise<T>) => Promise<T>
type Result = { content: { type: 'text'; text: string }[]; isError: boolean }

// summary alone is the tool as it first was; the rest says how the work ended, for core to act on.
const Note = z.string().trim().max(SOURCE_REPORT_LIMIT).optional()
const ReportInput = z.object({ summary: z.string().trim().min(1).max(MAX_SOURCE_REPORT), outcome: z.enum(SOURCE_OUTCOMES).optional(), verification: Note, question: Note, blocker: Note })
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
            blocker: { type: 'string', description: 'outcome 是 blocked 时：被什么挡住了' }
          },
          required: ['summary'],
          additionalProperties: false
        },
        // Writes to Antumi alone, never to the tracker or the workspace, so it is fine while planning.
        annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false }
      },
      run: async (raw: Record<string, unknown>): Promise<Result> => {
        const args = ReportInput.safeParse(raw)
        if (!args.success) return text(`参数不对：summary 要有内容，最多 ${MAX_SOURCE_REPORT} 字；outcome 只能是 ${SOURCE_OUTCOMES.join('、')}；其余每项最多 ${SOURCE_REPORT_LIMIT} 字`, true)
        const { summary, ...result } = args.data
        try {
          await withCore((rpc) => rpc.call('sources.saveReport', { conversationId, text: summary, ...result }))
          return text('已存为事项总结草稿。用户会在任务的来源区块看到它。')
        } catch (error) {
          return text(`没能保存：${error instanceof Error ? error.message : String(error)}`, true)
        }
      }
    }
  ]
}
