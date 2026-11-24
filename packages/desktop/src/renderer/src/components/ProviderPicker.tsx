import { t } from '../i18n'
import { agentDescriptor, MODEL_PROVIDER_PRESETS, type AgentKind } from '@antumi/protocol'
import { setSettingsOpen, useCore } from '../core-store'
import { agentLabel } from '../labels'
import { servingProviders } from '../model-provider-choice'
import { ChatPicker, type PickerSize } from './ChatPicker'

// An empty selection preserves the agent's native account or provider configuration.
export function ProviderPicker({ agent, value, onChange, disabled = false, placement, size }: {
  agent: AgentKind
  value: string | null
  onChange: (providerId: string | null) => void
  disabled?: boolean
  placement?: 'above' | 'below'
  size?: PickerSize
}) {
  const providers = servingProviders(useCore((s) => s.modelProviders), agent)
  if (agentDescriptor(agent).capabilities.modelProviders.length === 0) return null
  const picked = providers.some((provider) => provider.id === value) ? value : null
  return (
    <ChatPicker
      label={t('ProviderPicker.provider')}
      value={picked ?? ''}
      placeholder={t('ProviderPicker.ownAccount', { value1: agentLabel(agent) })}
      disabled={disabled}
      placement={placement}
      size={size}
      options={[
        { value: '', label: t('ProviderPicker.ownAccount', { value1: agentLabel(agent) }), description: t('ProviderPicker.ownAccountDescription', { value1: agentLabel(agent) }) },
        ...providers.map((provider) => ({
          value: provider.id,
          label: provider.name,
          description: [provider.defaultModel, provider.preset !== 'custom' && !MODEL_PROVIDER_PRESETS[provider.preset].verified ? t('ModelProviderSettings.unverified') : null].filter(Boolean).join(' · ')
        }))
      ]}
      onChange={(next) => onChange(next || null)}
      footer={(close) => (
        <button type="button" role="menuitem" className="menu-item" onClick={() => { close(); setSettingsOpen(true, 'model-providers') }}>{t('ProviderPicker.manage')}</button>
      )}
    />
  )
}
