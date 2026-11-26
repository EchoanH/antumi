import { create } from 'zustand'

type PermissionSwitchState = { switching: Record<string, string> }
const usePermissionSwitchStore = create<PermissionSwitchState>()(() => ({ switching: {} }))

export function beginPermissionSwitch(conversationId: string, mode: string): void {
  usePermissionSwitchStore.setState((state) => ({ switching: { ...state.switching, [conversationId]: mode } }))
}

export function endPermissionSwitch(conversationId: string): void {
  usePermissionSwitchStore.setState((state) => {
    if (!(conversationId in state.switching)) return state
    const { [conversationId]: _done, ...rest } = state.switching
    return { switching: rest }
  })
}

export function usePermissionSwitching(conversationId: string): string | null {
  return usePermissionSwitchStore((state) => state.switching[conversationId] ?? null)
}
