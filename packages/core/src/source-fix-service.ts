import { type Conversation, type SourceFixInfo, type SourceReport, type SourceSnapshot, type SourceTaskProposal, type SourceTransitions, type Task, type TaskSource } from '@antumi/protocol'
import { Rejection } from './rejection'
import type { InvestigationRun } from './source-investigation-store'
import type { TaskCreationLink } from './task-store'
import { SourceFixStore, type FixRecord } from './source-fix-store'

export type Delivery = { urls: string[]; local: string[] }
export type FixContext = { source: TaskSource; snapshot: SourceSnapshot; facts: SourceTransitions | null; dryRun?: boolean }

type Deps = {
  candidates(): InvestigationRun[]
  allowed(run: InvestigationRun): boolean
  task(id: string): Task | null
  conversation(task: Task): Conversation | null
  capacity(proposal: SourceTaskProposal): boolean
  validate(proposal: SourceTaskProposal, run: InvestigationRun): Promise<void>
  prepare(run: InvestigationRun): Promise<FixContext>
  create(run: InvestigationRun, context: FixContext, proposal: SourceTaskProposal, link: TaskCreationLink): Promise<Task>
  start(task: Task, run: InvestigationRun): Promise<void>
  taskReport(task: Task): SourceReport | null
  receipt(task: Task): 'submitted' | 'uncertain' | null
  revision(task: Task): Promise<string>
  check(task: Task): Promise<string[] | null>
  repair(task: Task, text: string, ref: string): Promise<void>
  // urls: the pull requests; local: the task branches left unpushed where there is no GitHub.
  deliver(task: Task): Promise<Delivery>
  finish(task: Task, delivery: Delivery): void
  transferred(run: InvestigationRun, task: Task): void
  changed(id: string, info: SourceFixInfo): void
}
const TERMINAL = new Set(['ready', 'failed', 'skipped', 'handed-over', 'waiting-user'])
// A pull request is reviewed in the investigation itself: a task would open a second one beside it.
const PULL_REQUEST_TYPE = 'pull-request'

// The investigation opens the issue's task; core owns it and all external effects from there. Each
// task advances on its own, without keeping the investigation's agent alive.
export class SourceFixService {
  private running: Promise<void> | null = null
  private timer: ReturnType<typeof setInterval> | undefined
  private closed = false
  private readonly creating = new Set<string>()
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
  // The user going on with the task themselves; the investigation that opened it is theirs anyway.
  takeover(conversationId: string): void {
    for (const record of this.store.list()) {
      const task = record.taskId ? this.deps.task(record.taskId) : null
      if ((record.taskId === conversationId || task?.conversationId === conversationId) && record.state !== 'handed-over') this.update(record, { state: 'handed-over', message: '用户已接手，自动处理停止推进' })
    }
  }
  // Checked and created while the investigation waits on it, so whatever stops it comes back to the
  // agent to correct or report. One task per investigation, as one per issue.
  async create(run: InvestigationRun, proposal: SourceTaskProposal): Promise<Task> {
    if (this.closed) throw new Rejection('source-fix-taken-over', 'Antumi 正在退出')
    const existing = this.store.get(run.id)
    const linked = existing?.taskId ? this.deps.task(existing.taskId) : null
    if (linked) throw new Rejection('source-already-imported', `这个事项已有任务「${linked.title}」，不重复创建`)
    if (!this.deps.allowed(run)) throw new Rejection('invalid-configuration', '自动排查已关闭、不允许新建任务，或来源已变更')
    const context = await this.deps.prepare(run)
    if (context.dryRun) throw new Rejection('source-dry-run', '来源处于演练模式，不新建任务')
    if (context.facts?.statusCategory === 'done') throw new Rejection('source-done', '事项已完成，不新建任务')
    if (context.facts?.type?.id === PULL_REQUEST_TYPE) throw new Rejection('source-pull-request', 'PR 类事项不新建任务，请在这个会话里按要求处理')
    await this.deps.validate(proposal, run)
    this.creating.add(run.id)
    let record = this.update({ id: run.id, taskId: null, state: 'preparing', proposal, urls: [], message: null, attempts: 0, revision: null }, {})
    let task: Task
    try {
      task = await this.deps.create(run, context, proposal, this.store.taskLink(record, context.source, () => !this.closed && this.deps.allowed(run)))
    } catch (error) {
      this.update(this.store.get(run.id) ?? record, { state: 'failed', message: error instanceof Error ? error.message : String(error) })
      throw error
    } finally { this.creating.delete(run.id) }
    record = this.store.get(run.id) ?? record
    this.deps.transferred(run, task)
    this.update(record, { transferred: true })
    void this.tick()
    return task
  }
  tick(): Promise<void> {
    if (this.closed) return Promise.resolve()
    if (this.running) return this.running
    this.running = this.pass().catch((error: unknown) => console.error('[antumi-core] automatic source task failed:', error))
      .finally(() => { this.running = null })
    return this.running
  }
  private async pass(): Promise<void> {
    const runs = this.deps.candidates()
    // A wait on the user's answer or approval ends once it is given; every other wait is a person's to clear.
    for (const record of this.store.list()) {
      if (record.state !== 'waiting-user' || !record.awaitsAnswer) continue
      const run = runs.find((each) => each.id === record.id)
      const task = record.taskId ? this.deps.task(record.taskId) : null
      const conversation = task ? this.deps.conversation(task) : null
      if (!run || !this.deps.allowed(run) || !conversation || conversation.chat?.turn === 'awaiting' || conversation.chat?.request) continue
      this.update(record, { state: 'working', awaitsAnswer: false, message: null })
    }
    const records = this.store.list()
    for (const record of records) this.deps.changed(record.id, { taskId: record.taskId, state: record.state, urls: record.urls, message: record.message })
    const work: Promise<void>[] = []
    for (const record of records) {
      if (TERMINAL.has(record.state) || this.creating.has(record.id)) continue
      // Core stopped between the record and its task: the investigation may open it again.
      if (!record.taskId) { this.update(record, { state: 'failed', message: '任务没有建成，可以让排查会话重新新建' }); continue }
      const run = runs.find((each) => each.id === record.id)
      if (!run || !this.deps.allowed(run)) { this.update(record, { state: 'handed-over', message: '自动处理已关闭或来源已变更' }); continue }
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
      if (!task) { this.update(record, { state: 'failed', message: '关联任务已被删除，不自动重建' }); return }
      if (!record.transferred) { this.deps.transferred(run, task); record = this.update(record, { transferred: true }) }
      if (task.status === 'done' || task.status === 'abandoned') { this.update(record, { state: 'handed-over', message: '任务已由用户结束' }); return }
      if (!this.deps.allowed(run)) { this.update(record, { state: 'handed-over', message: '自动处理已关闭或来源已变更' }); return }
      if (record.state === 'preparing') {
        // A prior start with a conversation may have delivered its first message. Never start it twice.
        if (!task.conversationId && task.status === 'pending') {
          if (!record.proposal) { this.update(record, { state: 'waiting-user', message: '缺少任务参数，等待人工处理' }); return }
          if (!this.deps.capacity(record.proposal)) { if (record.message !== '等待执行 Agent 空出位置') this.update(record, { message: '等待执行 Agent 空出位置' }); return }
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
      if (chat.chat?.turn !== 'idle') { this.update(record, { state: 'waiting-user', awaitsAnswer: true, message: '任务需要你回答或批准' }); return }
      if (task.status !== 'running') { this.update(record, { state: 'handed-over', message: '用户已改变任务阶段' }); return }
      const report = this.deps.taskReport(task)
      if (report?.outcome !== 'delivered' || (record.reportAt !== undefined && report.updatedAt <= record.reportAt)) { this.update(record, { state: 'waiting-user', message: 'Agent 没有交付可验证的改动，请查看任务总结' }); return }
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
      // Recheck the source just before pushing. Stopping here never discards local work.
      const context = await this.deps.prepare(run)
      this.live(id)
      if (context.dryRun || !this.deps.allowed(run) || context.facts?.statusCategory === 'done') {
        this.update(record, { state: 'waiting-user', message: '事项已完成或配置已变化，未自动推送' }); return
      }
      if ((await this.deps.revision(task)) !== record.revision || this.deps.conversation(task)?.chat?.turn !== 'idle') throw new Rejection('source-fix-changed', '交付前代码或会话发生变化，请人工确认')
      const delivery = await this.deps.deliver(task)
      this.live(id)
      this.deps.finish(task, delivery)
      this.update(record, { state: 'ready', urls: delivery.urls, message: null })
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
