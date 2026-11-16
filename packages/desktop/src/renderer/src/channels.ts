import { useEffect, useState } from 'react'
import { create } from 'zustand'
import type { Channel, ChannelReadiness } from '@antumi/protocol'
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

// Whether this computer can answer from a chat platform: asked again whenever the channels change
// or the window comes back, since the daemon is replaced underneath while the app stays open.
// Null where core cannot say, or has not yet.
export function useChannelReadiness(): ChannelReadiness | null {
  const rpc = useCore((state) => state.rpc)
  const supported = useCore((state) => state.rpc?.features.includes('channel-readiness') ?? false)
  const channels = useChannelStore((state) => state.channels)
  const [readiness, setReadiness] = useState<ChannelReadiness | null>(null)
  useEffect(() => {
    if (!rpc || !supported) return setReadiness(null)
    let live = true
    // A check in the background: a failure only leaves the warning as it was, never an error.
    const check = () => void rpc.call('channels.readiness', {}).then((next) => { if (live) setReadiness(next) }, () => {})
    check()
    window.addEventListener('focus', check)
    return () => {
      live = false
      window.removeEventListener('focus', check)
    }
  }, [rpc, supported, channels])
  return readiness
}
