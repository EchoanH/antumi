import { useEffect } from 'react'
import { create } from 'zustand'
import type { Channel } from '@antumi/protocol'
import { perform, useCore } from './core-store'

// Agents' channels on chat platforms (docs/CHANNELS.md), as core holds them: read once per
// connection, then kept current by core's own word of every change.
const useChannelStore = create<{ channels: Channel[]; loaded: boolean }>(() => ({ channels: [], loaded: false }))

export function useChannelsSupported(): boolean {
  return useCore((state) => state.rpc?.features.includes('channels') ?? false)
}

export function setChannels(channels: Channel[]): void {
  useChannelStore.setState({ channels, loaded: true })
}

// Every channel, or none where core has no channels.
export function useChannels(): Channel[] {
  const rpc = useCore((state) => state.rpc)
  const supported = useChannelsSupported()
  useEffect(() => {
    if (!rpc || !supported) return
    let live = true
    const off = rpc.on('channels.changed', ({ channels }) => { if (live) setChannels(channels) })
    void perform((link) => link.call('channels.list', {})).then((channels) => { if (live && channels) setChannels(channels) })
    return () => {
      live = false
      off()
    }
  }, [rpc, supported])
  return useChannelStore((state) => state.channels)
}
