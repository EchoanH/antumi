import type { ChannelCredentialKey, ChannelPlatform } from './channel'

// Everything core and the desktop know of one chat platform beyond its connector: a platform is
// added by an entry here, a connector in core's gateway and a formatter (docs/CHANNELS.md, 扩展点).
export type ChannelPlatformDescriptor = {
  label: string
  // What the user pastes in to connect, in the order asked. prefix: how a real one starts, to catch
  // two pasted the wrong way round.
  credentials: readonly { key: ChannelCredentialKey; label: string; prefix?: string }[]
  // Where its apps are made, and what to paste there to make one with everything set.
  console: string
  manifest?: string
  // One message's longest text, and the least time between two posts in one place.
  textLimit: number
  minGapMs: number
  features: { reactions: boolean }
}

const SLACK_MANIFEST = JSON.stringify({
  display_information: { name: 'Antumi' },
  features: {
    bot_user: { display_name: 'Antumi', always_online: false },
    app_home: { messages_tab_enabled: true, messages_tab_read_only_enabled: false }
  },
  oauth_config: { scopes: { bot: ['app_mentions:read', 'chat:write', 'reactions:write', 'im:history', 'files:read'] } },
  settings: {
    event_subscriptions: { bot_events: ['app_mention', 'message.im'] },
    interactivity: { is_enabled: false },
    org_deploy_enabled: false,
    socket_mode_enabled: true,
    token_rotation_enabled: false
  }
}, null, 2)

export const CHANNEL_PLATFORM_DESCRIPTORS = {
  slack: {
    label: 'Slack',
    credentials: [
      { key: 'appToken', label: 'App-Level Token', prefix: 'xapp-' },
      { key: 'botToken', label: 'Bot User OAuth Token', prefix: 'xoxb-' }
    ],
    console: 'https://api.slack.com/apps?new_app=1',
    manifest: SLACK_MANIFEST,
    textLimit: 3500,
    minGapMs: 1100,
    features: { reactions: true }
  }
} satisfies Record<ChannelPlatform, ChannelPlatformDescriptor>

export function channelPlatform(platform: ChannelPlatform): ChannelPlatformDescriptor {
  return CHANNEL_PLATFORM_DESCRIPTORS[platform]
}
