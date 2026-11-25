import { DatabaseSync } from 'node:sqlite'

// Test fixtures that inspect persisted state must release their file handles before teardown.
export function withTestDatabase<T>(file: string, useDatabase: (database: DatabaseSync) => T): T {
  const database = new DatabaseSync(file)
  try {
    return useDatabase(database)
  } finally {
    database.close()
  }
}
