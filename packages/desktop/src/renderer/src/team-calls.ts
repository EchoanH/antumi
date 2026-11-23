import { useMemo, useSyncExternalStore } from 'react'
import type { RpcConnection, SquadCall } from '@antumi/protocol'
import { useCore } from './core-store'
import { conversationRecordFeed } from './conversation-record-feed'

const EMPTY: { calls: readonly SquadCall[] | null; error: string | null } = { calls: null, error: null }
const EMPTY_FEED = { getSnapshot: () => EMPTY, subscribe: (_listener: () => void) => () => {} }
function createFeed(rpc: RpcConnection, id: string) {
  return conversationRecordFeed(() => rpc.call('squadCalls.list', { id }), (receive) => rpc.on('squadCalls.changed', ({ call }) => { if (call.parentId === id) receive(call) }))
}
const feeds = new WeakMap<RpcConnection, Map<string, ReturnType<typeof createFeed>>>()
export function useTeamCalls(id: string | null) {
  const rpc = useCore((state) => state.rpc)
  const feed = useMemo(() => {
    if (!rpc || !id || !rpc.features.includes('squad-calls')) return EMPTY_FEED
    let pool = feeds.get(rpc)
    if (!pool) { pool = new Map(); feeds.set(rpc, pool) }
    let found = pool.get(id)
    if (!found) { found = createFeed(rpc, id); pool.set(id, found) }
    return found
  }, [rpc, id])
  return useSyncExternalStore(feed.subscribe, feed.getSnapshot, EMPTY_FEED.getSnapshot)
}
