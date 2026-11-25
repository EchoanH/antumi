import { DatabaseSync } from 'node:sqlite'
import { z } from 'zod'
import { SourceReport, SourceWrite, type SourceUpdateTarget } from '@antumi/protocol'
import type { TaskWriteLink } from './task-store'

const JsonRow = z.object({ data: z.string() })
const targetKey = (target: SourceUpdateTarget) => `${target.kind}:${target.id}`
export const itemKey = (write: Pick<SourceWrite, 'provider' | 'instance' | 'key'>) => `${write.provider}/${write.instance}/${write.key}`

// A task's status change still to be written back to its issue. It says only which stage the task
// came to: what that means for the issue is worked out when it is delivered, from the issue as it
// then is. Each half is done once it has its answer or was given up on.
export const SourceIntent = z.object({
  trigger: z.enum(['start', 'review', 'done']),
  createdAt: z.number(),
  attempts: z.number().int().nonnegative().default(0),
  statusDone: z.boolean().default(false),
  commentDone: z.boolean().default(false),
  // The failed status move a retry stands in for.
  lastWrite: z.string().nullable().default(null)
})
export type SourceIntent = z.infer<typeof SourceIntent>
export type StoredIntent = SourceIntent & { id: number; taskId: string; nextAt: number }
const IntentRow = z.object({ id: z.number(), task_id: z.string(), next_at: z.number(), data: z.string() })
const insertIntent = (db: DatabaseSync, taskId: string, intent: SourceIntent) =>
  db.prepare('INSERT INTO source_intents(task_id,next_at,data) VALUES (?,0,?)').run(taskId, JSON.stringify(SourceIntent.parse(intent)))

// The schema is migrated by TaskStore before this connection opens.
export class SourceWritebackStore {
  private readonly db: DatabaseSync
  constructor(file: string) {
    this.db = new DatabaseSync(file)
    this.db.exec('PRAGMA journal_mode = WAL; PRAGMA busy_timeout = 5000')
  }
  close(): void { this.db.close() }

  writes(target: SourceUpdateTarget, limit = 50): SourceWrite[] {
    return this.db.prepare('SELECT data FROM source_writes WHERE target=? ORDER BY created_at DESC LIMIT ?').all(targetKey(target), limit)
      .map((row) => SourceWrite.parse(JSON.parse(JsonRow.parse(row).data)))
  }
  write(id: string): SourceWrite | undefined {
    const row = this.db.prepare('SELECT data FROM source_writes WHERE id=?').get(id)
    return row ? SourceWrite.parse(JSON.parse(JsonRow.parse(row).data)) : undefined
  }
  // Writes a rule already made for this target, so a task moved back and forth posts once.
  ruleWrites(target: SourceUpdateTarget): SourceWrite[] {
    return this.db.prepare("SELECT data FROM source_writes WHERE target=? AND json_extract(data,'$.trigger')<>'manual'").all(targetKey(target))
      .map((row) => SourceWrite.parse(JSON.parse(JsonRow.parse(row).data)))
  }
  // Comment ids Antumi posted on an issue, which comment sync takes as already read.
  postedComments(provider: string, instance: string, key: string): Set<string> {
    const rows = this.db.prepare("SELECT json_extract(data,'$.result') AS id FROM source_writes WHERE item=? AND json_extract(data,'$.kind')='comment' AND json_extract(data,'$.state')='sent'").all(itemKey({ provider, instance, key }))
    return new Set(rows.flatMap((row) => (typeof row.id === 'string' ? [row.id] : [])))
  }
  saveWrite(write: SourceWrite): void {
    const parsed = SourceWrite.parse(write)
    this.db.prepare('INSERT INTO source_writes(id,target,item,created_at,data) VALUES (?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET data=excluded.data')
      .run(parsed.id, targetKey(parsed.target), itemKey(parsed), parsed.createdAt, JSON.stringify(parsed))
  }
  // A write still pending when core stopped never got its answer.
  settleInterrupted(now: number): void {
    const rows = this.db.prepare("SELECT data FROM source_writes WHERE json_extract(data,'$.state')='pending'").all()
    for (const row of rows) {
      const write = SourceWrite.parse(JSON.parse(JsonRow.parse(row).data))
      this.saveWrite({ ...write, state: 'uncertain', reason: 'Antumi 在写入完成前退出，结果待确认', updatedAt: now })
    }
  }

  // An intent for TaskStore to save with the status change it comes from.
  intentLink(taskId: string, trigger: SourceIntent['trigger'], at: number): TaskWriteLink {
    return { write: (db) => { insertIntent(db, taskId, SourceIntent.parse({ trigger, createdAt: at })) } }
  }
  addIntent(taskId: string, trigger: SourceIntent['trigger'], at: number): void {
    insertIntent(this.db, taskId, SourceIntent.parse({ trigger, createdAt: at }))
  }
  // Oldest first, so a task's stages are written back in the order it went through them.
  dueIntents(now: number): StoredIntent[] {
    return this.db.prepare('SELECT id, task_id, next_at, data FROM source_intents WHERE next_at<=? ORDER BY id').all(now).map((raw) => {
      const row = IntentRow.parse(raw)
      return { ...SourceIntent.parse(JSON.parse(row.data)), id: row.id, taskId: row.task_id, nextAt: row.next_at }
    })
  }
  nextIntentAt(): number | null {
    const at = this.db.prepare('SELECT MIN(next_at) AS at FROM source_intents').get()?.at
    return typeof at === 'number' ? at : null
  }
  saveIntent({ id, taskId: _taskId, nextAt, ...intent }: StoredIntent): void {
    this.db.prepare('UPDATE source_intents SET next_at=?, data=? WHERE id=?').run(nextAt, JSON.stringify(SourceIntent.parse(intent)), id)
  }
  dropIntent(id: number): void {
    this.db.prepare('DELETE FROM source_intents WHERE id=?').run(id)
  }

  report(target: SourceUpdateTarget): SourceReport | null {
    const row = this.db.prepare('SELECT data FROM source_reports WHERE target=?').get(targetKey(target))
    return row ? SourceReport.parse(JSON.parse(JsonRow.parse(row).data)) : null
  }
  saveReport(target: SourceUpdateTarget, report: SourceReport): void {
    this.db.prepare('INSERT INTO source_reports(target,data) VALUES (?,?) ON CONFLICT(target) DO UPDATE SET data=excluded.data')
      .run(targetKey(target), JSON.stringify(SourceReport.parse(report)))
  }
}
