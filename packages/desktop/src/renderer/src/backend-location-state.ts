import { useEffect } from 'react'
import { create } from 'zustand'
import type { BackendLocation, BackendLocationState } from '../../shared/backend-location'
import { backendLocation } from './desktop-bridge'

// What main says of where the backend runs; null until it has, and outside Electron. `dismissed`
// lasts for this start only: the notice comes back with the next one if the problem does.
export const useBackendLocation = create<{ state: BackendLocationState | null; reading: boolean; dismissed: boolean }>()(() => ({ state: null, reading: false, dismissed: false }))

// Re-asks main, which lists the distros afresh; a failed read keeps what was known.
export async function readBackendLocation(): Promise<void> {
  useBackendLocation.setState({ reading: true })
  try {
    const state = await backendLocation()
    if (state) useBackendLocation.setState({ state })
  } finally {
    useBackendLocation.setState({ reading: false })
  }
}

export function useBackendLocationFeed(): void {
  useEffect(() => { void readBackendLocation() }, [])
}

export function useBackendLocationShown(): boolean {
  return useBackendLocation((s) => (s.state?.wsl || s.state?.ssh) ?? false)
}

export function dismissBackendLocationNotice(): void {
  useBackendLocation.setState({ dismissed: true })
}

// A place other than this machine.
export type RemoteLocation = Exclude<BackendLocation, { kind: 'local' }>

// The place the user chose when this machine's backend runs instead, because the one there did
// not start: the tasks they see are not the ones they expect. Null otherwise.
export function notStarted(state: BackendLocationState | null): RemoteLocation | null {
  if (!state || state.chosen.kind === 'local' || state.running !== 'local' || !state.problem) return null
  return state.chosen
}

export function sameLocation(a: BackendLocation, b: BackendLocation): boolean {
  if (a.kind === 'local' || b.kind === 'local') return a.kind === b.kind
  if (a.kind === 'ssh' || b.kind === 'ssh') return a.kind === 'ssh' && b.kind === 'ssh' && a.host === b.host
  return a.distro === b.distro
}
