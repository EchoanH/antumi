export function conversationRecordFeed<T extends { id: string }>(load: () => Promise<T[]>, watch: (receive: (record: T) => void) => () => void) {
  let snapshot: { calls: readonly T[] | null; error: string | null } = { calls: null, error: null }
  const listeners = new Set<() => void>()
  let stop = () => {}
  const publish = (next: typeof snapshot) => { snapshot = next; for (const listener of listeners) listener() }
  return {
    getSnapshot: () => snapshot,
    subscribe(listener: () => void) {
      listeners.add(listener)
      if (listeners.size === 1) {
        let current = true
        const changes = new Map<string, T>()
        const off = watch((record) => {
          changes.set(record.id, record)
          publish({ calls: [...(snapshot.calls ?? []).filter((item) => item.id !== record.id), record], error: null })
        })
        void load().then((records) => {
          if (current) publish({ calls: [...new Map([...records, ...changes.values()].map((record) => [record.id, record])).values()], error: null })
        }).catch((reason: unknown) => { if (current) publish({ ...snapshot, error: String(reason) }) })
        stop = () => { current = false; off() }
      }
      return () => { listeners.delete(listener); if (!listeners.size) stop() }
    }
  }
}
