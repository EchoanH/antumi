import { z } from 'zod'
import { AttachmentId, MAX_TASK_IMAGES, SQUAD_CALL_TOOLS, type RpcConnection } from '@antumi/protocol'

const schemas = {
  list: z.object({}),
  dispatch: z.object({ squadId: z.string().uuid(), instruction: z.string().trim().min(1).max(20000), ref: z.string().min(1).max(200), images: z.array(AttachmentId).max(MAX_TASK_IMAGES).optional() }),
  status: z.object({}),
  cancel: z.object({ callId: z.string().uuid() })
}
const descriptions = {
  list: '查找当前会话可以调用的团队。返回准确团队 id、成员分工、权限和额度以及不可用原因。用户 @团队时先查找对应 id，再用 antumi_team_dispatch 委派，不自行代替团队回答。团队成员按需启动。',
  dispatch: '把独立开发工作交给指定团队，立即返回调用和任务记录。instruction 包含目标、背景、文件范围和验收要求，团队不会自动继承聊天历史。必要的图片可传 images 附件 id。core 从当前会话的干净 Git 项目和提交创建独立任务 worktree，沿用已有授权直接开始；不自动提交或复制主目录改动。ref 是本次工作唯一引用，重试沿用。派出后结束本轮，结果自动回传。团队完成后在你当前授权内合并有效提交并重新验证，不自动 push，不代用户接受任务。',
  status: '查看团队调用和结果，不反复轮询。这里看到的结果不再自动投递。收到待验收成果后先重读最新版本，再按当前授权合并提交并重新验证；未提交改动不可覆盖。',
  cancel: '取消本会话的一项团队调用，通过现有任务流程停止团队；保留任务、分支和文件。继续或重试使用任务原有入口。'
}
export function teamToolsOverCore(withCore: <T>(action: (rpc: RpcConnection) => Promise<T>) => Promise<T>, id: string) {
  return (['list', 'dispatch', 'status', 'cancel'] as const).map((kind) => ({
    spec: { name: SQUAD_CALL_TOOLS[kind], description: descriptions[kind], inputSchema: z.toJSONSchema(schemas[kind]),
      annotations: { readOnlyHint: kind === 'list' || kind === 'status', destructiveHint: false, idempotentHint: true, openWorldHint: false } },
    run: async (raw: Record<string, unknown>) => {
      try {
        const result = await withCore(async (rpc) => {
          if (kind === 'list') return rpc.call('squadCalls.targets', { id })
          if (kind === 'status') return rpc.call('squadCalls.list', { id, read: true })
          if (kind === 'dispatch') return rpc.call('squadCalls.dispatch', { id, ...schemas.dispatch.parse(raw) })
          return rpc.call('squadCalls.cancel', { id, ...schemas.cancel.parse(raw) })
        })
        return { content: [{ type: 'text' as const, text: JSON.stringify(result) }], isError: false }
      } catch (error) {
        return { content: [{ type: 'text' as const, text: error instanceof Error ? error.message : String(error) }], isError: true }
      }
    }
  }))
}
