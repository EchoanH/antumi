import { useEffect } from 'react'
import { create } from 'zustand'
import { mergeCliStatuses } from './agent-cli-state'
import { receivePlugins, useCore } from './core-store'

export const useMaintenanceUpdates = create<{ checking: boolean; error: string | null }>(() => ({ checking: false, error: null }))
let checkingRpc: ReturnType<typeof useCore.getState>['rpc'] = null

export async function checkMaintenanceUpdates(refresh = false): Promise<void> {
  const rpc = useCore.getState().rpc
  if (!rpc || checkingRpc === rpc) return
  checkingRpc = rpc
  useMaintenanceUpdates.setState({ checking: true, error: null })
  try {
    const results = await Promise.allSettled([
      rpc.features.includes('agent-cli-maintenance') ? rpc.call('system.agentCliStatus', { refresh }).then((statuses) => {
        if (useCore.getState().rpc === rpc) useCore.setState((s) => ({ agentCli: mergeCliStatuses(s.agentCli, statuses) }))
      }) : undefined,
      rpc.features.includes('plugin-update-check') ? rpc.call('plugins.checkUpdates', { refresh }).then((plugins) => {
        if (useCore.getState().rpc === rpc) receivePlugins(plugins)
      }) : undefined
    ])
    const failure = results.find((result) => result.status === 'rejected')
    if (failure?.status === 'rejected') throw failure.reason
  } catch (error) {
    if (useCore.getState().rpc === rpc) useMaintenanceUpdates.setState({ error: error instanceof Error ? error.message : String(error) })
  } finally {
    if (checkingRpc === rpc) {
      checkingRpc = null
      useMaintenanceUpdates.setState({ checking: false })
    }
  }
}

// Only the workspace subscribes, so panel windows never start another polling loop.
export function useMaintenancePolling(): void {
  const rpc = useCore((s) => s.rpc)
  useEffect(() => {
    if (!rpc) return
    const first = setTimeout(() => void checkMaintenanceUpdates(), 8000)
    const interval = setInterval(() => void checkMaintenanceUpdates(), 60 * 60_000)
    return () => { clearTimeout(first); clearInterval(interval) }
  }, [rpc])
}
