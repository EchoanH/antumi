import { DatabaseSync } from 'node:sqlite'
import { randomUUID } from 'node:crypto'
import { z } from 'zod'
import { Rejection } from './rejection'
import { SourceFixInfo, SourceTaskProposal, type TaskSource } from '@antumi/protocol'
import type { TaskCreationLink } from './task-store'

const Record = SourceFixInfo.extend({ id: z.string().uuid(), attempts: z.number().int().nonnegative(), revision: z.string().nullable(), transferred: z.boolean().optional(), reportAt: z.number().optional(), awaitsAnswer: z.boolean().optional(), proposal: SourceTaskProposal.optional() })
export type FixRecord = z.infer<typeof Record>
const Row = z.object({ data: z.string() })

export class SourceFixStore {
  private readonly db: DatabaseSync
  constructor(file: string) {
    this.db = new DatabaseSync(file)
    this.db.exec('PRAGMA journal_mode = WAL; PRAGMA busy_timeout = 5000')
  }
  close(): void { this.db.close() }
  list(): FixRecord[] {
    return this.db.prepare('SELECT data FROM source_fixes').all().map((row) => Record.parse(JSON.parse(Row.parse(row).data)))
  }
  get(id: string): FixRecord | null {
    const row = this.db.prepare('SELECT data FROM source_fixes WHERE id=?').get(id)
    return row ? Record.parse(JSON.parse(Row.parse(row).data)) : null
  }
  forTask(taskId: string): FixRecord | null {
    const row = this.db.prepare('SELECT data FROM source_fixes WHERE task_id=?').get(taskId)
    return row ? Record.parse(JSON.parse(Row.parse(row).data)) : null
  }
  save(record: FixRecord): FixRecord {
    const value = Record.parse(record)
    this.db.prepare('INSERT INTO source_fixes(id,task_id,data) VALUES (?,?,?) ON CONFLICT(id) DO UPDATE SET task_id=excluded.task_id,data=excluded.data')
      .run(value.id, value.taskId, JSON.stringify(value))
    return value
  }
  // The task, its source snapshot and this link commit together, so a crash cannot orphan a task.
  taskLink(record: FixRecord, source: TaskSource, allowed: () => boolean = () => true): TaskCreationLink {
    const id = randomUUID()
    return { id, write: (db) => {
      const current = db.prepare('SELECT data FROM source_fixes WHERE id=?').get(record.id)
      if (!current || Record.parse(JSON.parse(Row.parse(current).data)).state === 'handed-over' || !allowed()) throw new Rejection('source-fix-taken-over', '用户已接手或配置发生变化')
      if (db.prepare("SELECT id FROM tasks WHERE id<>? AND json_extract(source,'$.provider')=? AND json_extract(source,'$.instance')=? AND json_extract(source,'$.key')=?").get(id, source.provider, source.instance, source.key)) throw new Rejection('source-already-imported', '事项已有任务，不重复创建')
      const linked = Record.parse({ ...record, taskId: id, state: 'preparing' })
      db.prepare('UPDATE source_fixes SET task_id=?,data=? WHERE id=?').run(id, JSON.stringify(linked), record.id)
    } }
  }
}
