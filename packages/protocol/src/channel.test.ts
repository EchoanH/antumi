import { describe, expect, it } from 'vitest'
import { CHANNEL_PLATFORMS, Channel, ChannelFields, ChannelInput } from './channel'
import { CHANNEL_PLATFORM_DESCRIPTORS, channelPlatform } from './channel-platforms'
import { mobileMayCall } from './mobile-access'
import { rpcSchemas, type RpcMethod } from './rpc'

const PROFILE = '11111111-1111-4111-8111-111111111111'

describe('a channel', () => {
  it('lets nobody ask until someone is named', () => {
    const fields = ChannelFields.parse({ profileId: PROFILE, platform: 'slack' })
    expect(fields).toMatchObject({ enabled: true, projectPaths: [], allowedUsers: [], allowedPlaces: [], allowDirect: false, dailyPerUser: 20 })
  })

  it('never carries a credential to a client, only which are stored', () => {
    expect(Object.keys(Channel.shape)).not.toContain('credentials')
    expect(Channel.shape.stored).toBeDefined()
  })

  it('keeps a stored credential when a save leaves it out or null', () => {
    const input = ChannelInput.parse({ profileId: PROFILE, platform: 'slack', credentials: { appToken: 'xapp-1', botToken: null } })
    expect(input.credentials).toEqual({ appToken: 'xapp-1', botToken: null })
    expect(ChannelInput.parse({ profileId: PROFILE, platform: 'slack' }).credentials).toBeUndefined()
  })

  it('refuses limits outside what a person could mean', () => {
    for (const bad of [{ dailyPerUser: 0 }, { maxConcurrent: 6 }, { turnTimeoutSec: 5 }]) {
      expect(ChannelFields.safeParse({ profileId: PROFILE, platform: 'slack', ...bad }).success, JSON.stringify(bad)).toBe(false)
    }
  })
})

describe('chat platforms', () => {
  it('describes every platform, with credentials to ask for', () => {
    for (const platform of CHANNEL_PLATFORMS) {
      const descriptor = channelPlatform(platform)
      expect(descriptor.credentials.length, platform).toBeGreaterThan(0)
      expect(descriptor.textLimit, platform).toBeGreaterThan(500)
    }
  })

  it('gives Slack a manifest asking for no more than it uses', () => {
    const manifest = JSON.parse(CHANNEL_PLATFORM_DESCRIPTORS.slack.manifest)
    expect(manifest.oauth_config.scopes.bot).toEqual(['app_mentions:read', 'chat:write', 'reactions:write', 'im:history', 'files:read'])
    expect(manifest.settings.socket_mode_enabled).toBe(true)
    expect(manifest.settings.event_subscriptions.bot_events).toEqual(['app_mention', 'message.im'])
  })

  it('gives Feishu scopes to import that ask nothing of the user and read no contacts', () => {
    const { scopes } = JSON.parse(CHANNEL_PLATFORM_DESCRIPTORS.feishu.manifest)
    expect(scopes.user).toEqual([])
    expect(scopes.tenant).toContain('im:message.group_at_msg:readonly')
    expect(scopes.tenant.filter((scope: string) => scope.startsWith('contact:') || scope === 'im:message.group_msg')).toEqual([])
  })
})

describe('channels over RPC', () => {
  it('are no phone\'s to set up, read or run tools for', () => {
    const methods = (Object.keys(rpcSchemas) as RpcMethod[]).filter((method) => method.startsWith('channels.') || method.startsWith('channelTools.'))
    expect(methods).toEqual(['channels.list', 'channels.save', 'channels.remove', 'channels.requests', 'channels.toolCalls', 'channels.readiness', 'channelTools.call'])
    for (const method of methods) expect(mobileMayCall(method, 'operate'), method).toBe(false)
  })
})
