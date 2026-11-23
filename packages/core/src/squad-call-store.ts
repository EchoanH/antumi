import { DatabaseSync } from 'node:sqlite'
import { SquadCall } from '@antumi/protocol'
import type { TaskCreationLink } from './task-store'
import { Rejection } from './rejection'

export class SquadCallStore {
  private readonly db: DatabaseSync
  constructor(file: string) { this.db = new DatabaseSync(file); this.db.exec('PRAGMA journal_mode = WAL') }
  close(): void { this.db.close() }
  list(parentId?: string): SquadCall[] {
    const rows = parentId
      ? this.db.prepare('SELECT data FROM squad_calls WHERE parent_id = ? ORDER BY rowid DESC').all(parentId)
      : this.db.prepare('SELECT data FROM squad_calls ORDER BY rowid DESC').all()
    return rows.map((row) => SquadCall.parse(JSON.parse(String(row.data))))
  }
  get(id: string): SquadCall {
    const row = this.db.prepare('SELECT data FROM squad_calls WHERE id = ?').get(id)
    if (!row) throw new Rejection('squad-call-not-found', '团队调用不存在')
    return SquadCall.parse(JSON.parse(String(row.data)))
  }
  forTask(taskId: string): SquadCall | null {
    const row = this.db.prepare('SELECT data FROM squad_calls WHERE task_id = ?').get(taskId)
    return row ? SquadCall.parse(JSON.parse(String(row.data))) : null
  }
  link(call: SquadCall): TaskCreationLink {
    return { id: call.taskId, write: (db) => { db.prepare('INSERT INTO squad_calls(id, parent_id, ref, task_id, data) VALUES (?, ?, ?, ?, ?)').run(call.id, call.parentId, call.ref, call.taskId, JSON.stringify(call)) } }
  }
  patch(id: string, fields: Partial<SquadCall>): SquadCall {
    const call = SquadCall.parse({ ...this.get(id), ...fields, updatedAt: Date.now() })
    this.db.prepare('UPDATE squad_calls SET data = ? WHERE id = ?').run(JSON.stringify(call), id)
    return call
  }
}
