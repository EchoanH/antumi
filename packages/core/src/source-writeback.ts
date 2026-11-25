import { randomUUID } from 'node:crypto'
import {
  MAX_SOURCE_REPORT,
  SOURCE_REPORT_LIMIT,
  MAX_WRITEBACK_COMMENT,
  pickTransition,
  type SourceTransitions,
  type SourceUpdateTarget,
  type SourceWrite,
  type SourceWriteback as WritebackView,
  type SourceWriteTrigger,
  type Task,
  type TaskSource
} from '@antumi/protocol'
import { Rejection } from './rejection'
import type { SourceService } from './source-service'
import { itemKey, type SourceWritebackStore } from './source-writeback-store'

// Writing back to the issue a task or an investigation came from: by hand, or by the source's rules
// as the task starts, goes for review and is accepted. See docs/SOURCE-WRITEBACK.md.

export type WritebackOwner = { target: SourceUpdateTarget; source: TaskSource; conversationId: string | null }
type Hooks = {
  owner(target: SourceUpdateTarget): WritebackOwner | null
  // The agent's last complete reply in a conversation, for a rule's comment with no summary.
  lastReply(conversationId: string): string | null
  changed(view: WritebackView): void
}
type Sources = Pick<SourceService, 'writer' | 'writebackRules'>
export type Condense = (conversationId: string, platform: string, reply: string, guidance: string) => Promise<string | null>
type Writer = NonNullable<ReturnType<SourceService['writer']>>
type Trigger = Exclude<SourceWriteTrigger, 'manual'>

// Failures that say the tracker refused, so the write did not happen.
const DEFINITE = new Set(['source-auth-failed', 'source-forbidden', 'source-not-found', 'source-bad-query', 'source-invalid-settings', 'source-not-configured'])

const TRIGGER: Partial<Record<Task['status'], Trigger>> = { running: 'start', review: 'review', done: 'done' }

export class SourceWriteback {
  // One write at a time per issue, rules and the user alike, in the order asked.
  private readonly queues = new Map<string, Promise<unknown>>()
  // The last reply rewritten as a summary by the small model; null when that cannot be done.
  private condense: Condense | undefined

  constructor(
    private readonly store: SourceWritebackStore,
    private readonly sources: Sources,
    private readonly hooks: Hooks,
    private readonly now: () => number = Date.now
  ) {
    store.settleInterrupted(now())
  }

  view(target: SourceUpdateTarget): WritebackView {
    const owner = this.hooks.owner(target)
    const writer = owner && this.sources.writer(owner.source)
    return { target, supported: !!writer, comments: writer?.comments ?? true, report: this.store.report(target), writes: this.store.writes(target) }
  }

  setCondenser(condense: Condense): void { this.condense = condense }

  ownComments(source: TaskSource): ReadonlySet<string> {
    return this.store.postedComments(source.provider, source.instance, source.key)
  }

  async transitions(target: SourceUpdateTarget): Promise<SourceTransitions> {
    const { writer } = this.require(target)
    return writer.transitions()
  }

  transition(target: SourceUpdateTarget, id: string): Promise<SourceWrite> {
    const { owner, writer } = this.require(target)
    return this.queued(owner.source, async () => {
      const transitions = await writer.transitions()
      const option = transitions.options.find((each) => each.id === id)
      if (!option) throw new Rejection('source-writeback-stale', '事项的状态已经变了，请重新选择')
      return this.moveTo(owner, writer, option, 'manual')
    })
  }

  comment(target: SourceUpdateTarget, markdown: string): Promise<SourceWrite> {
    const text = markdown.trim()
    if (!text) throw new Rejection('source-writeback-empty', '评论不能为空')
    if (text.length > MAX_WRITEBACK_COMMENT) throw new Rejection('source-writeback-too-long', `评论最多 ${MAX_WRITEBACK_COMMENT} 字`)
    const { owner, writer } = this.require(target)
    if (!writer.comments) throw new Rejection('source-writeback-no-comments', '这个来源不支持发评论')
    return this.queued(owner.source, () => this.post(owner, writer, text, 'manual', 'user'))
  }

  // Tries a write again that failed or whose result is unknown. A status is chosen afresh, so a
  // move the tracker already made is not made twice.
  retry(id: string): Promise<SourceWrite> {
    const write = this.store.write(id)
    if (!write) throw new Rejection('source-write-not-found')
    if (write.state !== 'failed' && write.state !== 'uncertain') throw new Rejection('source-write-not-retryable', '只能重试失败或结果待确认的写入')
    const { owner, writer } = this.require(write.target)
    return this.queued(owner.source, async () => {
      // The same write id again, so a tracker that dedupes by it (Linear) finds a comment that did go.
      if (write.kind === 'comment') return this.send(writer, this.save({ ...write, state: 'pending', reason: null, updatedAt: this.now() }))
      this.save({ ...write, state: 'skipped', reason: '已重试', updatedAt: this.now() }, false)
      return this.moveByNames(owner, writer, write.detail, write.trigger)
    })
  }

  saveReport(target: SourceUpdateTarget, text: string): WritebackView {
    if (!this.hooks.owner(target)) throw new Rejection('source-none', '这个会话不是从来源事项来的')
    const report = text.trim().slice(0, MAX_SOURCE_REPORT)
    if (!report) throw new Rejection('source-writeback-empty', '总结不能为空')
    if (report.length > SOURCE_REPORT_LIMIT) throw new Rejection('source-report-too-long', `总结有 ${report.length} 字，超过 ${SOURCE_REPORT_LIMIT} 字。请压缩到 2 到 4 句、300 字以内，去掉过程、commit 号和本地路径，再调用一次。`)
    this.store.saveReport(target, { text: report, updatedAt: this.now() })
    return this.emit(target)
  }

  // A task's status changed: the source's rule for it, if any, runs in the background. Its result,
  // failure included, is only recorded; the task's move never waits on the tracker.
  taskMoved(before: Task, after: Task): void {
    const trigger = TRIGGER[after.status]
    // Going on after review is not a start, and a redo that starts again does not move it twice.
    if (!trigger || !after.source || (trigger === 'start' && before.status !== 'pending')) return
    const target: SourceUpdateTarget = { kind: 'task', id: after.id }
    if (trigger === 'start' && this.store.ruleWrites(target).some((write) => write.trigger === 'start' && write.state === 'sent')) return
    const rules = this.sources.writebackRules(after.source.provider, after.source.instance)
    const rule = rules[trigger]
    const wantsComment = 'comment' in rule && rule.comment
    if (!rule.status && !wantsComment) return
    const owner = this.hooks.owner(target)
    const writer = owner && this.sources.writer(owner.source)
    if (!owner || !writer) return
    void this.queued(owner.source, async () => {
      if (rule.status) await this.moveByNames(owner, writer, rule.status, trigger)
      // Asked here, in the issue's queue, so a review comment still on its way counts.
      if (wantsComment && !(trigger === 'done' && this.commented(target))) await this.ruleComment(owner, writer, trigger)
    }).catch((error: unknown) => console.error(`[antumi-core] writing back to ${itemKey(owner.source)} failed:`, error instanceof Error ? error.message : error))
  }

  private commented(target: SourceUpdateTarget): boolean {
    return this.store.ruleWrites(target).some((write) => write.kind === 'comment' && (write.state === 'sent' || write.state === 'uncertain'))
  }

  private async ruleComment(owner: WritebackOwner, writer: Writer, trigger: Trigger): Promise<SourceWrite> {
    if (!writer.comments) return this.save(this.record(owner, 'comment', trigger, '', null, { state: 'skipped', reason: '这个来源不支持发评论' }))
    const report = this.store.report(owner.target)
    // Handed in again with the same summary: once is enough. A rewritten one goes out.
    if (report && this.store.ruleWrites(owner.target).some((write) => write.kind === 'comment' && write.detail === report.text && (write.state === 'sent' || write.state === 'uncertain'))) {
      return this.save(this.record(owner, 'comment', trigger, report.text, 'report', { state: 'skipped', reason: '同样的总结已经发过' }))
    }
    if (report) return this.post(owner, writer, report.text, trigger, 'report')
    // A reply is written for the user, headings, steps and questions and all: never posted as it
    // is, only as the small model rewrites it, and nothing when that fails.
    const reply = owner.conversationId ? this.hooks.lastReply(owner.conversationId)?.trim() : null
    if (!reply || !owner.conversationId) return this.save(this.record(owner, 'comment', trigger, '', null, { state: 'skipped', reason: 'Agent 没有写总结，也没有可用的回复，没有发评论' }))
    const { guidance } = this.sources.writebackRules(owner.source.provider, owner.source.instance)
    const condensed = await this.condense?.(owner.conversationId, owner.source.name, reply, guidance).catch((error: unknown) => {
      console.error('[antumi-core] condensing the last reply for an issue failed:', error instanceof Error ? error.message : error)
      return null
    }) ?? null
    if (condensed) return this.post(owner, writer, condensed, trigger, 'last-reply')
    return this.save(this.record(owner, 'comment', trigger, '', null, { state: 'skipped', reason: 'Agent 没有写总结，最后一条回复也没能压缩成总结，没有发评论' }))
  }

  private async moveByNames(owner: WritebackOwner, writer: Writer, names: string, trigger: SourceWriteTrigger): Promise<SourceWrite> {
    let transitions: SourceTransitions
    try {
      transitions = await writer.transitions()
    } catch (error) {
      return this.save(this.record(owner, 'status', trigger, names, null, { state: 'failed', reason: reasonOf(error) }))
    }
    const picked = pickTransition(transitions, names)
    if (!picked) {
      const reason = `没有可流转到的状态「${names}」，当前是「${transitions.status}」`
      return this.save(this.record(owner, 'status', trigger, names, null, { state: 'skipped', reason }))
    }
    if ('skip' in picked) {
      const reason = picked.skip === 'already' ? `已经是「${transitions.status}」` : `当前「${transitions.status}」比目标更靠后，不往回改`
      return this.save(this.record(owner, 'status', trigger, names, null, { state: 'skipped', reason, result: transitions.status }))
    }
    return this.moveTo(owner, writer, picked.option, trigger)
  }

  private async moveTo(owner: WritebackOwner, writer: Writer, option: SourceTransitions['options'][number], trigger: SourceWriteTrigger): Promise<SourceWrite> {
    const write = this.save(this.record(owner, 'status', trigger, option.name, null, { state: 'pending' }))
    try {
      const result = await writer.transition(option.id)
      return this.save({ ...write, state: 'sent', result: result.status, updatedAt: this.now() })
    } catch (error) {
      // A move is safe to try again: the next one reads where the issue is first.
      return this.save({ ...write, state: 'failed', reason: reasonOf(error), updatedAt: this.now() })
    }
  }

  private post(owner: WritebackOwner, writer: Writer, text: string, trigger: SourceWriteTrigger, origin: SourceWrite['origin']): Promise<SourceWrite> {
    return this.send(writer, this.save(this.record(owner, 'comment', trigger, text, origin, { state: 'pending' })))
  }

  // A comment's write id is its record's id, the same on every try.
  private async send(writer: Writer, write: SourceWrite): Promise<SourceWrite> {
    try {
      const result = await writer.comment(write.detail, write.id)
      return this.save({ ...write, state: 'sent', result: result.id, url: result.url, updatedAt: this.now() })
    } catch (error) {
      // A comment that may have gone through is not posted again unasked: a duplicate is worse.
      const definite = error instanceof Rejection && DEFINITE.has(error.reason)
      return this.save({ ...write, state: definite ? 'failed' : 'uncertain', reason: reasonOf(error), updatedAt: this.now() })
    }
  }

  private record(owner: WritebackOwner, kind: SourceWrite['kind'], trigger: SourceWriteTrigger, detail: string, origin: SourceWrite['origin'], fields: Pick<SourceWrite, 'state'> & Partial<Pick<SourceWrite, 'reason' | 'result'>>): SourceWrite {
    const at = this.now()
    const { provider, instance, key } = owner.source
    return { id: randomUUID(), target: owner.target, provider, instance, key, kind, trigger, detail, origin, result: null, url: null, reason: null, createdAt: at, updatedAt: at, ...fields }
  }

  private save(write: SourceWrite, emit = true): SourceWrite {
    this.store.saveWrite(write)
    if (emit) this.emit(write.target)
    return write
  }

  private emit(target: SourceUpdateTarget): WritebackView {
    const view = this.view(target)
    this.hooks.changed(view)
    return view
  }

  private require(target: SourceUpdateTarget): { owner: WritebackOwner; writer: Writer } {
    const owner = this.hooks.owner(target)
    if (!owner) throw new Rejection('source-none', '这个任务或会话不是从来源事项来的')
    const writer = this.sources.writer(owner.source)
    if (!writer) throw new Rejection('source-writeback-unavailable', '来源不支持回写，或还没有连接')
    return { owner, writer }
  }

  private queued<T>(source: TaskSource, run: () => Promise<T>): Promise<T> {
    const key = itemKey(source)
    const result = (this.queues.get(key) ?? Promise.resolve()).catch(() => {}).then(run)
    const tail = result.catch(() => {})
    this.queues.set(key, tail)
    void tail.then(() => { if (this.queues.get(key) === tail) this.queues.delete(key) })
    return result
  }
}

function reasonOf(error: unknown): string {
  if (error instanceof Rejection && error.reason === 'source-forbidden') return `没有写权限：${error.message}`
  return error instanceof Error ? error.message : String(error)
}
