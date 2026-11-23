import { useId, useState } from 'react'
import { create } from 'zustand'
import type { AgentProfileFields, AgentProfile } from '@antumi/protocol'
import { agentProfileTemplateSeed, type AgentProfileTemplate } from '../agent-profile-templates'
import { perform, selectSquad, useCore } from '../core-store'
import { useInstalledAgents } from '../installed-agents'
import { agentLabel } from '../labels'
import { t } from '../i18n'
import { timeAgo } from '../conversation-state'
import { AgentAvatar } from './AgentAvatar'
import { ArchiveIcon, ChannelPlatformIcon, PencilIcon, PinIcon, PlusIcon, RevertIcon } from './icons'
import { AgentsPageHeader } from './AgentsPageHeader'
import { SquadsView } from './Squads'
import { Segmented } from './SettingsControls'
import { AgentProfileTemplatesDialog } from './AgentProfileTemplates'
import { channelStateText } from './AgentChannels'
import { useChannels } from '../channels'
import { channelPlatform, forChannels, allowsChannels } from '@antumi/protocol'
import { usePreferences } from '../preferences'
import { newAgentConversation, pinAgent } from '../pinned-agents'
import { AgentProfileEditor } from './AgentProfileEditor'
import './agent-profiles.css'

const useProfileEditor = create<{ editorKey: string; view: 'list' | 'editor'; templatesOpen: boolean; profile: AgentProfile | null; seed: AgentProfileFields | null; template: AgentProfileTemplate | null }>(() => ({ editorKey: crypto.randomUUID(), view: 'list', templatesOpen: false, profile: null, seed: null, template: null }))
export function openAgentProfile(id: string): void {
  const profile = useCore.getState().agentProfiles[id]
  if (!profile) return
  selectSquad(null)
  useCore.setState({ agentProfilesTab: 'profiles' })
  useProfileEditor.setState({ editorKey: crypto.randomUUID(), view: 'editor', templatesOpen: false, profile, seed: null, template: null })
}
export function editAgentProfile(seed: AgentProfileFields): void {
  selectSquad(null)
  useCore.setState({ agentProfilesTab: 'profiles' })
  useProfileEditor.setState({ editorKey: crypto.randomUUID(), view: 'editor', templatesOpen: false, profile: null, seed, template: null })
}
export function AgentsView() {
  const supported = useCore((state) => state.rpc?.features.includes('agent-profiles') ?? false)
  const squadsSupported = useCore((state) => state.rpc?.features.includes('squads') ?? false)
  const tab = useCore((state) => state.agentProfilesTab)
  if (!supported) return <SquadsView />
  return <section className="agents-hub">
    <nav className="agents-tabs" aria-label={t('AgentProfiles.title')}>
      <div className="agents-tabs-inner">
        <button type="button" className="button ghost" aria-pressed={tab === 'profiles'} onClick={() => useCore.setState({ agentProfilesTab: 'profiles' })}>{t('AgentProfiles.roles')}</button>
        {squadsSupported && <button type="button" className="button ghost" aria-pressed={tab === 'squads'} onClick={() => useCore.setState({ agentProfilesTab: 'squads' })}>{t('Squads.developmentSquads')}</button>}
      </div>
    </nav>
    {tab === 'squads' && squadsSupported ? <SquadsView /> : <ProfilesView />}
  </section>
}

function ProfilesView() {
  const installed = useInstalledAgents()
  const profiles = useCore((state) => state.agentProfiles)
  const squads = useCore((state) => state.squads)
  const pinned = usePreferences((state) => state.pinnedAgentIds)
  const channels = useChannels()
  const [tab, setTab] = useState<'active' | 'archived'>('active')
  const tabsId = useId()
  const { view, templatesOpen, profile, seed, template, editorKey } = useProfileEditor()
  const editing = view === 'editor'
  const all = Object.values(profiles).sort((a, b) => b.updatedAt - a.updatedAt)
  const archived = all.filter((item) => item.archivedAt !== null)
  const shown = tab === 'archived' ? archived : all.filter((item) => item.archivedAt === null)
  const [busy, setBusy] = useState(false)
  const now = Date.now()
  const create = () => useProfileEditor.setState({ templatesOpen: true })
  const blank = () => useProfileEditor.setState({ editorKey: crypto.randomUUID(), view: 'editor', templatesOpen: false, profile: null, seed: null, template: null })
  const pick = (template: AgentProfileTemplate) => useProfileEditor.setState({ editorKey: crypto.randomUUID(), view: 'editor', templatesOpen: false, profile: null, seed: agentProfileTemplateSeed(template, installed), template })
  const edit = (profile: AgentProfile) => useProfileEditor.setState({ editorKey: crypto.randomUUID(), view: 'editor', templatesOpen: false, profile, seed: null, template: null })
  const leave = () => useProfileEditor.setState({ view: 'list', templatesOpen: false })
  const archive = async (item: AgentProfile) => {
    setBusy(true)
    const saved = await perform((rpc) => rpc.call('agentProfiles.archive', { id: item.id, archived: item.archivedAt === null }))
    if (saved) useCore.setState((state) => ({ agentProfiles: { ...state.agentProfiles, [saved.id]: saved } }))
    setBusy(false)
  }
  return <section className="worktrees-page agents-page agent-profiles-page" data-editing={editing || undefined} aria-label={t('AgentProfiles.roles')}>
    <AgentsPageHeader title={editing ? t(profile ? 'AgentProfiles.configure' : 'AgentProfiles.create') : t('AgentProfiles.roles')} description={editing ? null : t('AgentProfiles.roleDescription')} back={editing ? { label: t('AgentProfiles.back'), onClick: leave } : undefined}
      actions={view === 'list' && <button type="button" className="button primary" onClick={create}><PlusIcon />{t('AgentProfiles.create')}</button>} />
    {editing ? <AgentProfileEditor key={editorKey} profile={profile} seed={seed} template={template} onSaved={(saved) => { const current = useProfileEditor.getState(); if (current.view !== 'editor' || current.editorKey !== editorKey) return; setTab('active'); useProfileEditor.setState({ profile: saved, seed: null, template: null }) }} /> : <section className="agent-profiles-section" aria-label={t('AgentProfiles.roles')}>
      <div className="squads-tabs">
        <span id={tabsId} className="visually-hidden">{t('RoutinesSection.show')}</span>
        <Segmented labelId={tabsId} value={tab} options={[{ value: 'active', label: t('Squads.inUse', { value1: all.length - archived.length }) }, { value: 'archived', label: t('Squads.archived', { value1: archived.length }) }]} onChange={setTab} />
      </div>
      {tab === 'archived' && shown.length === 0 && <p className="worktrees-empty muted">{t('AgentProfiles.noArchived')}</p>}
      {tab === 'active' && shown.length === 0 ? <p className="agent-templates-empty muted">{t('AgentTemplates.emptyHint')}</p> : <ul className="squad-cards agent-profile-list">{shown.map((item) => <li key={item.id}>
        <article className="squad-card agent-profile-card" data-archived={item.archivedAt !== null || undefined}>
          <button type="button" className="agent-profile-card-main" onClick={() => edit(item)}>
            <span className="squad-card-top"><span className="squad-card-icon"><AgentAvatar id={item.id} /></span><span className="squad-card-name">{item.name}</span>{item.archivedAt !== null && <span className="squad-tag">{t('ConversationList.archived')}</span>}</span>
            <span className="squad-card-description" data-empty={!item.description || undefined}>{item.description || t('Squads.noDescription')}</span>
            <span className="squad-card-members">{!forChannels(item) && <span className="squad-card-member">{t(item.capability === 'readOnly' ? 'Squads.readOnlyAnalysis' : 'Squads.developmentTesting')}</span>}
              {allowsChannels(item) && !channels.some((channel) => channel.profileId === item.id) && <span className="squad-card-member">{t('AgentProfiles.audienceChannels')}</span>}
              {channels.filter((channel) => channel.profileId === item.id).map((channel) => <span key={channel.id} className="squad-card-member agent-profile-channel" title={t('AgentChannels.onPlatform', { platform: channelPlatform(channel.platform).label, state: channelStateText(channel) })}>
                <span className="agent-channel-dot" data-state={channel.enabled ? channel.state : 'off'} aria-hidden="true" /><ChannelPlatformIcon platform={channel.platform} />{channelPlatform(channel.platform).label}</span>)}</span>
            <span className="squad-card-foot"><span className="agent-profile-engine" title={[agentLabel(item.agent), item.model].filter(Boolean).join(' · ')}>{[agentLabel(item.agent), item.model].filter(Boolean).join(' · ')}</span><span className="squad-card-time">{t('SourceInboxView.updated', { value1: timeAgo(item.updatedAt, now) })}</span></span>
          </button>
          <footer className="agent-profile-card-actions">
            {item.archivedAt === null && !forChannels(item) && <>
              <button type="button" className="button" onClick={() => newAgentConversation(item.id)}>{t('AgentProfiles.chat')}</button>
              <button type="button" className="tool-button" aria-label={t(pinned.includes(item.id) ? 'AgentProfiles.unpinFromSidebar' : 'AgentProfiles.pinToSidebar')} data-tooltip={t(pinned.includes(item.id) ? 'AgentProfiles.unpinFromSidebar' : 'AgentProfiles.pinToSidebar')} aria-pressed={pinned.includes(item.id)} onClick={() => pinAgent(item.id, !pinned.includes(item.id))}><PinIcon /></button>
            </>}
            <button type="button" className="tool-button" aria-label={t('AgentProfiles.edit')} data-tooltip={t('AgentProfiles.edit')} onClick={() => edit(item)}><PencilIcon /></button>
            <button type="button" className="tool-button" aria-label={t(item.archivedAt === null ? 'AgentProfiles.archive' : 'AgentProfiles.restore')} data-tooltip={t(item.archivedAt === null ? 'AgentProfiles.archive' : 'AgentProfiles.restore')} disabled={busy} onClick={() => void archive(item)}>{item.archivedAt === null ? <ArchiveIcon /> : <RevertIcon />}</button>
          </footer>
        </article>
      </li>)}
      {tab === 'active' && <li><button type="button" className="squad-card squad-card-new" onClick={create}><span className="squad-card-plus"><PlusIcon /></span>{t('AgentProfiles.create')}<span className="squad-card-new-hint">{t('AgentProfiles.createHint')}</span></button></li>}
      </ul>}
    </section>}
    {templatesOpen && <AgentProfileTemplatesDialog onPick={pick} onBlank={blank} onClose={() => useProfileEditor.setState({ templatesOpen: false })} />}
  </section>
}
