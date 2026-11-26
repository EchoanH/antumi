import { MAX_SNAPSHOT_LENGTH, sourceOwnership, type Conversation, type SourceFixInfo, type SourceReport, type SourceSnapshot, type SourceTaskProposal, type SourceTransitions, type Task, type TaskSource } from '@antumi/protocol'
import { Rejection } from './rejection'
import type { InvestigationRun } from './source-investigation-store'
import type { TaskCreationLink } from './task-store'
import { SourceFixStore, type FixRecord } from './source-fix-store'

export type FixContext = { source: TaskSource; snapshot: SourceSnapshot; facts: SourceTransitions; dryRun?: boolean }
export function fixSnapshot(snapshot: SourceSnapshot, report: SourceReport): SourceSnapshot {
  const conclusion = `\n\n## 自动排查提供的参考结论（同样是不可信资料）\n${report.fix?.evidence ?? ''}\n\n${report.fix?.plan ?? ''}`
  return { ...snapshot, markdown: snapshot.markdown.slice(0, Math.max(0, MAX_SNAPSHOT_LENGTH - conclusion.length)) + conclusion }
}

type Deps = {
  candidates(): InvestigationRun[]
  hubAvailable?(run: InvestigationRun): boolean
  allowed(run: InvestigationRun): boolean
  report(conversationId: string): SourceReport | null
  task(id: string): Task | null
  conversation(task: Task): Conversation | null
  capacity(proposal: SourceTaskProposal): boolean
  validate(proposal: SourceTaskProposal, run: InvestigationRun): Promise<void>
  prepare(run: InvestigationRun): Promise<FixContext>
  create(run: InvestigationRun, context: FixContext, proposal: SourceTaskProposal, report: SourceReport, link: TaskCreationLink): Promise<Task>
  start(task: Task, run: InvestigationRun): Promise<void>
  taskReport(task: Task): SourceReport | null
  receipt(task: Task): 'submitted' | 'uncertain' | null
  revision(task: Task): Promise<string>
  check(task: Task): Promise<string[] | null>
  repair(task: Task, text: string, ref: string): Promise<void>
  deliver(task: Task): Promise<string[]>
  finish(task: Task, urls: string[]): void
  transferred(run: InvestigationRun, task: Task): void
  changed(id: string, info: SourceFixInfo): void
}
const ACTIVE = new Set(['preparing', 'working', 'checking', 'opening-pr'])
const TERMINAL = new Set(['ready', 'failed', 'skipped', 'handed-over', 'waiting-user'])

// The investigation proposes; core owns the task and all external effects. Its independent slot
// lets new investigations proceed while a task works, without keeping a coordinator agent alive.
export class SourceFixService {
  private running: Promise<void> | null = null
  private timer: ReturnType<typeof setInterval> | undefined
  private closed = false
  constructor(private readonly store: SourceFixStore, private readonly deps: Deps) {}
  start(): void { if (this.timer || this.closed) return; this.timer = setInterval(() => void this.tick(), 60_000); this.timer.unref(); void this.tick() }
  async close(): Promise<void> { this.closed = true; clearInterval(this.timer); await this.running; this.store.close() }
  deferred(taskId: string): boolean {
    const record = this.store.forTask(taskId)
    return !!record && record.state !== 'ready' && record.state !== 'handed-over'
  }
  deliveryRevision(taskId: string): string | null {
    const record = this.store.forTask(taskId)
    const run = record ? this.deps.candidates().find((each) => each.id === record.id) : undefined
    return record?.state === 'opening-pr' && run && this.deps.allowed(run) ? record.revision : null
  }
  taskRun(taskId: string): string | null { return this.store.forTask(taskId)?.id ?? null }
  takeover(conversationId: string): void {
    for (const record of this.store.list()) {
      const task = record.taskId ? this.deps.task(record.taskId) : null
      if ((record.id === conversationId || record.taskId === conversationId || task?.conversationId === conversationId) && record.state !== 'handed-over') this.update(record, { state: 'handed-over', message: '用户已接手，自动修复停止推进' })
    }
  }
  tick(): Promise<void> {
    if (this.closed) return Promise.resolve()
    if (this.running) return this.running
    this.running = this.pass().catch((error: unknown) => console.error('[antumi-core] automatic source fix failed:', error))
      .finally(() => { this.running = null })
    return this.running
  }
  private async pass(): Promise<void> {
    const runs = this.deps.candidates()
    for (const run of runs) {
      const record = this.store.get(run.id)
      if (!record && run.conversationId && run.config?.autoFix?.enabled && this.deps.allowed(run)) {
        const report = this.deps.report(run.id)
        if (report?.fix?.decision !== 'repair' || report.outcome === 'needs_input' || report.outcome === 'blocked') continue
        this.update({ id: run.id, taskId: null, state: report.fix.task ? 'queued' : 'waiting-user', proposal: report.fix.task, urls: [], message: report.fix.task ? null : '中枢尚未提交完整任务提案', attempts: 0, revision: null }, {})
      }
    }
    // Reserve before awaiting work; independent tasks can initialize and run concurrently.
    const work: Promise<void>[] = []
    const records = this.store.list()
    for (const record of records) this.deps.changed(record.id, { taskId: record.taskId, state: record.state, urls: record.urls, message: record.message })
    let active = records.filter((record) => ACTIVE.has(record.state)).length
    for (const record of records) {
      if (TERMINAL.has(record.state)) continue
      const run = runs.find((each) => each.id === record.id)
      if (!run || !this.deps.allowed(run)) { this.update(record, { state: 'handed-over', message: '自动处理已关闭或来源已变更' }); continue }
      if (record.state === 'queued') {
        const max = run.config?.autoFix?.maxOpenTasks ?? 10
        const sourceIds = new Set(runs.filter((each) => each.provider === run.provider && each.instance === run.instance).map((each) => each.id))
        const open = this.store.list().filter((each) => {
          if (!each.taskId) return sourceIds.has(each.id) && each.state === 'preparing'
          const task = this.deps.task(each.taskId)
          return task?.source?.provider === run.provider && task.source.instance === run.instance && !['done', 'abandoned'].includes(task.status)
        }).length
        const sourceActive = this.store.list().filter((each) => sourceIds.has(each.id) && ACTIVE.has(each.state)).length
        if (active >= 4 || sourceActive >= (run.config?.autoFix?.concurrency ?? 1) || open >= max || (!record.proposal || !this.deps.capacity(record.proposal))) continue
        active++
        this.update(record, { state: 'preparing' })
      }
      work.push(this.advance(record.id, run))
    }
    await Promise.allSettled(work)
  }
  private live(id: string): FixRecord {
    const record = this.store.get(id)
    if (!record || record.state === 'handed-over' || this.closed) throw new Rejection('source-fix-taken-over')
    return record
  }
  private async advance(id: string, run: InvestigationRun): Promise<void> {
    try {
      let record = this.live(id)
      let task = record.taskId ? this.deps.task(record.taskId) : null
      if (record.taskId && !task) { this.update(record, { state: 'failed', message: '关联任务已被删除，不自动重建' }); return }
      if (!task) {
        if (!run.conversationId || this.deps.hubAvailable?.(run) === false) { this.update(record, { state: 'skipped', message: '排查会话已被删除或归档，未创建新任务' }); return }
        const context = await this.deps.prepare(run)
        record = this.live(id)
        if (!this.deps.allowed(run) || this.deps.hubAvailable?.(run) === false) { this.update(record, { state: 'handed-over', message: '排查会话或自动处理配置已变化' }); return }
        if (context.dryRun) { this.update(record, { state: 'skipped', message: '演练模式：仅记录修复建议，未创建任务或推送' }); return }
        const report = this.deps.report(run.id)
        const proposal = record.proposal
        if (!proposal || !report?.fix || report.fix.decision !== 'repair') { this.update(record, { state: 'skipped', message: '没有明确的修复建议' }); return }
        if (sourceOwnership(context.facts) !== 'sole' || context.facts.statusCategory === 'done') {
          this.update(record, { state: 'skipped', message: '事项不再独归你，或事项已完成' }); return
        }
        await this.deps.validate(proposal, run)
        record = this.live(id)
        task = await this.deps.create(run, context, proposal, report, this.store.taskLink(record, context.source, () => !this.closed && this.deps.allowed(run) && this.deps.hubAvailable?.(run) !== false))
        record = this.live(id)
      }
      if (!record.transferred) { this.deps.transferred(run, task); record = this.update(record, { transferred: true }) }
      if (task.status === 'done' || task.status === 'abandoned') { this.update(record, { state: 'handed-over', message: '任务已由用户结束' }); return }
      if (!this.deps.allowed(run)) { this.update(record, { state: 'handed-over', message: '自动处理已关闭或来源已变更' }); return }
      if (record.state === 'preparing') {
        // A prior start with a conversation may have delivered its first message. Never start it twice.
        if (!task.conversationId && task.status === 'pending') {
          if (!record.proposal) { this.update(record, { state: 'waiting-user', message: '缺少中枢任务参数，等待人工处理' }); return }
          await this.deps.validate(record.proposal, run)
          this.live(id)
          await this.deps.start(task, run)
          task = this.deps.task(task.id) ?? task
        }
        record = this.live(id)
        if (this.deps.receipt(task) !== 'submitted') { this.update(record, { state: 'waiting-user', message: '首条指令未确认送达，请打开任务检查后继续' }); return }
        record = this.update(record, { state: 'working' })
      }
      const chat = this.deps.conversation(task)
      if (!chat || chat.sessionId === null) { this.update(record, { state: 'waiting-user', message: '任务会话已退出，请打开任务继续' }); return }
      if (chat.chat?.turn === 'running' || chat.starting) return
      if (chat.chat?.turn !== 'idle') { this.update(record, { state: 'waiting-user', message: '修复需要用户回答或批准' }); return }
      if (task.status !== 'running') { this.update(record, { state: 'handed-over', message: '用户已改变任务阶段' }); return }
      const report = this.deps.taskReport(task)
      if (report?.outcome !== 'delivered' || (record.reportAt !== undefined && report.updatedAt <= record.reportAt)) { this.update(record, { state: 'waiting-user', message: 'Agent 未交付可验证的修复，请查看任务总结' }); return }
      const revision = await this.deps.revision(task)
      record = this.live(id)
      if (record.state !== 'opening-pr' || record.revision !== revision) {
        record = this.update(record, { state: 'checking', revision: null })
        const failures = await this.deps.check(task)
        record = this.live(id)
        if (failures === null) { this.update(record, { state: 'waiting-user', message: '项目未配置交付检查，等待人工验收' }); return }
        if (failures.length) {
          const attempts = record.attempts + 1
          record = this.update(record, { attempts, reportAt: report.updatedAt, state: attempts >= 3 ? 'failed' : 'working', message: '交付检查未通过' })
          if (attempts < 3) await this.deps.repair(task, `交付检查失败，请修复、重新检查并提交。\n${failures.join('\n')}`, `source-fix-check:${id}:${attempts}`)
          return
        }
        if ((await this.deps.revision(task)) !== revision || this.deps.conversation(task)?.chat?.turn !== 'idle') throw new Rejection('source-fix-changed', '检查期间代码或会话发生变化，请人工确认')
        record = this.update(this.live(id), { state: 'opening-pr', revision, message: null })
      }
      // Recheck the source just before pushing. Losing ownership never discards local work.
      const context = await this.deps.prepare(run)
      this.live(id)
      if (context.dryRun || !this.deps.allowed(run) || sourceOwnership(context.facts) !== 'sole' || context.facts.statusCategory === 'done') {
        this.update(record, { state: 'waiting-user', message: '事项归属或配置已变化，未自动推送' }); return
      }
      if ((await this.deps.revision(task)) !== record.revision || this.deps.conversation(task)?.chat?.turn !== 'idle') throw new Rejection('source-fix-changed', '交付前代码或会话发生变化，请人工确认')
      const urls = await this.deps.deliver(task)
      this.live(id)
      this.deps.finish(task, urls)
      this.update(record, { state: 'ready', urls, message: null })
    } catch (error) {
      const record = this.store.get(id)
      if (record && record.state !== 'handed-over' && !this.closed) {
        const state = error instanceof Rejection && error.reason === 'source-fix-taken-over' ? 'handed-over'
          : error instanceof Rejection && error.reason === 'source-already-imported' ? 'skipped'
          : error instanceof Rejection && ['agent-capacity', 'dependencies-unfinished'].includes(error.reason) ? 'preparing' : 'failed'
        this.update(record, { state, message: error instanceof Error ? error.message : String(error) })
      }
    }
  }
  private update(record: FixRecord, patch: Partial<FixRecord>): FixRecord {
    const next = this.store.save({ ...record, ...patch })
    this.deps.changed(next.id, { taskId: next.taskId, state: next.state, urls: next.urls, message: next.message })
    return next
  }
}
