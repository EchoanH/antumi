import { useEffect, useId, useState } from 'react'
import {
  AGENT_KINDS, CHANNEL_DEFAULTS, CHANNEL_PLATFORMS, ChannelInput, agentDescriptor, channelPlatform,
  type AgentKind, type Channel, type ChannelCredentialKey, type ChannelPlatform, type ChannelRequest, type ChannelToolCall
} from '@antumi/protocol'
import { setChannels, useChannels, useChannelsSupported } from '../channels'
import { askConfirm } from '../confirm-dialog'
import { timeAgo } from '../conversation-state'
import { perform, useCore } from '../core-store'
import { t } from '../i18n'
import { agentLabel } from '../labels'
import { CopyButton } from './CopyButton'
import { Toggle } from './SettingsControls'
import './agent-channels.css'

// An agent's channels on chat platforms, in its own page: where colleagues may ask it, who, and
// what it reads to answer (docs/CHANNELS.md). The agent says who it is; this says where it is.

const lines = (text: string) => [...new Set(text.split(/[\s,，]+/).map((each) => each.trim()).filter(Boolean))]
const folder = (path: string) => path.split(/[\\/]/).filter(Boolean).at(-1) ?? path

export function channelStateText(channel: Pick<Channel, 'state' | 'error' | 'tenantName' | 'enabled'>): string {
  if (!channel.enabled) return t('AgentChannels.stateDisabled')
  if (channel.state === 'connected') return t('AgentChannels.stateConnected', { name: channel.tenantName ?? '' })
  if (channel.state === 'failed') return t('AgentChannels.stateFailed', { error: channel.error ?? '' })
  return t(channel.state === 'connecting' ? 'AgentChannels.stateConnecting' : 'AgentChannels.stateOff')
}

export function AgentChannels({ profileId, agent, hasProvider }: { profileId: string | null; agent: AgentKind; hasProvider: boolean }) {
  const supported = useChannelsSupported()
  const all = useChannels()
  const [open, setOpen] = useState<{ id: string | null; platform: ChannelPlatform; view: 'edit' | 'requests' } | null>(null)
  if (!supported) return null
  const channels = all.filter((each) => each.profileId === profileId)
  const able = Boolean(agentDescriptor(agent).capabilities.lockdown)
  const remove = async (channel: Channel) => {
    if (!await askConfirm({ message: t('AgentChannels.removeConfirm'), confirm: t('AgentChannels.remove'), danger: true })) return
    const left = await perform((rpc) => rpc.call('channels.remove', { id: channel.id }))
    if (left) setChannels(left)
    setOpen(null)
  }
  const toggle = async (channel: Channel, enabled: boolean) => {
    const { id, profileId: owner, platform, projectPaths, allowedUsers, allowedPlaces, allowDirect, dailyPerUser, dailyTotal, maxConcurrent, turnTimeoutSec } = channel
    const saved = await perform((rpc) => rpc.call('channels.save', { id, profileId: owner, platform, enabled, projectPaths, allowedUsers, allowedPlaces, allowDirect, dailyPerUser, dailyTotal, maxConcurrent, turnTimeoutSec }))
    if (saved) setChannels(all.map((each) => (each.id === saved.id ? saved : each)))
  }
  return <section className="agent-channels" aria-label={t('AgentChannels.title')}>
    <h3>{t('AgentChannels.title')}</h3>
    <p className="squad-block-hint muted">{t('AgentChannels.hint')}</p>
    {!able && <p className="squad-block-hint muted" role="note">{t('AgentChannels.unsupported', { agent: agentLabel(agent), agents: AGENT_KINDS.filter((kind) => agentDescriptor(kind).capabilities.lockdown).map(agentLabel).join('、') })}</p>}
    {able && !profileId && <p className="squad-block-hint muted">{t('AgentChannels.saveFirst')}</p>}
    {able && profileId && <>
      {!hasProvider && <p className="squad-block-hint muted">{t('AgentChannels.quotaHint', { agent: agentLabel(agent) })}</p>}
      <ul className="agent-channel-list">
        {channels.map((channel) => <li key={channel.id} className="agent-channel">
          <ChannelRow channel={channel} view={open?.id === channel.id ? open.view : null}
            onToggle={(enabled) => void toggle(channel, enabled)}
            onView={(view) => setOpen(open?.id === channel.id && open.view === view ? null : { id: channel.id, platform: channel.platform, view })}
            onRemove={() => void remove(channel)} />
          {open?.id === channel.id && open.view === 'edit' && <ChannelForm profileId={profileId} platform={channel.platform} channel={channel} onClose={() => setOpen(null)} />}
          {open?.id === channel.id && open.view === 'requests' && <ChannelRequests channel={channel} />}
        </li>)}
        {open?.id === null && <li className="agent-channel"><ChannelForm profileId={profileId} platform={open.platform} channel={null} onClose={() => setOpen(null)} /></li>}
      </ul>
      {open?.id !== null && <div className="agent-channel-actions">
        {CHANNEL_PLATFORMS.filter((platform) => !channels.some((each) => each.platform === platform)).map((platform) =>
          <button key={platform} type="button" className="button" onClick={() => setOpen({ id: null, platform, view: 'edit' })}>{t('AgentChannels.add', { platform: channelPlatform(platform).label })}</button>)}
      </div>}
    </>}
  </section>
}

function ChannelRow({ channel, view, onToggle, onView, onRemove }: { channel: Channel; view: 'edit' | 'requests' | null; onToggle: (enabled: boolean) => void; onView: (view: 'edit' | 'requests') => void; onRemove: () => void }) {
  const labelId = useId()
  const ready = channelPlatform(channel.platform).credentials.every(({ key }) => channel.stored.includes(key))
  const shown = channel.enabled ? channel.state : 'off'
  return <div className="agent-channel-row">
    <div className="agent-channel-name">
      <strong id={labelId}>{channelPlatform(channel.platform).label}</strong>
      <span className="agent-channel-state" data-state={shown}><span className="agent-channel-dot" data-state={shown} aria-hidden="true" />{ready ? channelStateText(channel) : t('AgentChannels.missingCredentials')}</span>
    </div>
    <div className="agent-channel-actions">
      <Toggle labelId={labelId} checked={channel.enabled} onChange={onToggle} />
      <button type="button" className="button small" aria-expanded={view === 'requests'} onClick={() => onView('requests')}>{t('AgentChannels.requests')}</button>
      <button type="button" className="button small" aria-expanded={view === 'edit'} onClick={() => onView('edit')}>{t('AgentChannels.edit')}</button>
      <button type="button" className="button small" onClick={onRemove}>{t('AgentChannels.remove')}</button>
    </div>
  </div>
}

type Draft = {
  credentials: Partial<Record<ChannelCredentialKey, string>>
  projectPaths: string[]; users: string; places: string; allowDirect: boolean
  dailyPerUser: string; dailyTotal: string; maxConcurrent: string; turnTimeoutSec: string
}

function ChannelForm({ profileId, platform, channel, onClose }: { profileId: string; platform: ChannelPlatform; channel: Channel | null; onClose: () => void }) {
  const formId = useId()
  const descriptor = channelPlatform(platform)
  const all = useChannels()
  const [projects, setProjects] = useState<string[]>([])
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [draft, setDraft] = useState<Draft>(() => ({
    credentials: {},
    projectPaths: channel?.projectPaths ?? [], users: (channel?.allowedUsers ?? []).join('\n'), places: (channel?.allowedPlaces ?? []).join('\n'), allowDirect: channel?.allowDirect ?? false,
    dailyPerUser: String(channel?.dailyPerUser ?? CHANNEL_DEFAULTS.dailyPerUser), dailyTotal: String(channel?.dailyTotal ?? CHANNEL_DEFAULTS.dailyTotal),
    maxConcurrent: String(channel?.maxConcurrent ?? CHANNEL_DEFAULTS.maxConcurrent), turnTimeoutSec: String(channel?.turnTimeoutSec ?? CHANNEL_DEFAULTS.turnTimeoutSec)
  }))
  useEffect(() => {
    void perform((rpc) => rpc.call('projects.recent', {})).then((recent) => setProjects(recent ?? []))
  }, [])
  // One it was given and is no longer recent still shows, so it can be seen and taken off.
  const offered = [...new Set([...draft.projectPaths, ...projects])]
  const save = async () => {
    const credentials = Object.fromEntries(descriptor.credentials.flatMap(({ key }) => (draft.credentials[key]?.trim() ? [[key, draft.credentials[key].trim()]] : [])))
    const parsed = ChannelInput.safeParse({
      ...(channel ? { id: channel.id } : {}), profileId, platform, enabled: channel?.enabled ?? true, credentials,
      projectPaths: draft.projectPaths, allowedUsers: lines(draft.users), allowedPlaces: lines(draft.places), allowDirect: draft.allowDirect,
      dailyPerUser: Number(draft.dailyPerUser), dailyTotal: Number(draft.dailyTotal), maxConcurrent: Number(draft.maxConcurrent), turnTimeoutSec: Number(draft.turnTimeoutSec)
    })
    if (!parsed.success) { setError(t('AgentChannels.invalid', { field: parsed.error.issues[0]?.path.join('.') ?? '' })); return }
    setBusy(true); setError(null)
    const saved = await perform((rpc) => rpc.call('channels.save', parsed.data))
    setBusy(false)
    if (!saved) { setError(useCore.getState().error); return }
    setChannels(all.some((each) => each.id === saved.id) ? all.map((each) => (each.id === saved.id ? saved : each)) : [...all, saved])
    onClose()
  }
  // Enter in a field here saves the channel, not the agent's form around it.
  const onEnter = (event: React.KeyboardEvent<HTMLInputElement>) => {
    if (event.key !== 'Enter') return
    event.preventDefault()
    void save()
  }
  const number = (key: 'dailyPerUser' | 'dailyTotal' | 'maxConcurrent' | 'turnTimeoutSec', label: string, min: number, max: number) =>
    <div className="squad-field"><label htmlFor={`${formId}-${key}`}>{label}</label><input id={`${formId}-${key}`} className="input" type="number" min={min} max={max} value={draft[key]} onKeyDown={onEnter} onChange={(event) => setDraft({ ...draft, [key]: event.target.value })} /></div>
  return <div className="agent-channel-panel">
    <div className="agent-channel-step">
      <h4>{t('AgentChannels.step1')}</h4>
      <p className="squad-block-hint muted">{t(`AgentChannels.${platform}.create`)}</p>
      <div className="agent-channel-step-actions">
        <a className="button" href={descriptor.console} target="_blank" rel="noreferrer">{t('AgentChannels.openConsole')}</a>
        {descriptor.manifest && <CopyButton text={descriptor.manifest} label={t('AgentChannels.copyManifest')}>{t('AgentChannels.copyManifest')}</CopyButton>}
      </div>
    </div>
    <div className="agent-channel-step">
      <h4>{t('AgentChannels.step2')}</h4>
      <p className="squad-block-hint muted">{t(`AgentChannels.${platform}.tokens`)}</p>
      <div className="agent-channel-grid">
        {descriptor.credentials.map(({ key, label, prefix }) => <div key={key} className="squad-field">
          <label htmlFor={`${formId}-${key}`}>{label}</label>
          <input id={`${formId}-${key}`} className="input" type="password" autoComplete="off" spellCheck={false} placeholder={channel?.stored.includes(key) ? t('AgentChannels.tokenStored') : prefix ? `${prefix}…` : ''}
            value={draft.credentials[key] ?? ''} onKeyDown={onEnter} onChange={(event) => setDraft({ ...draft, credentials: { ...draft.credentials, [key]: event.target.value } })} />
        </div>)}
      </div>
    </div>
    <div className="agent-channel-step">
      <h4>{t('AgentChannels.step3')}</h4>
      <p className="squad-block-hint muted">{t('AgentChannels.projectsHint')}</p>
      {offered.length === 0 ? <p className="squad-block-hint muted">{t('AgentChannels.noProjects')}</p> : <div className="agent-channel-projects">
        {offered.map((project) => <label key={project} className="agent-profile-check" title={project}>
          <input type="checkbox" checked={draft.projectPaths.includes(project)} onChange={(event) => setDraft({ ...draft, projectPaths: event.target.checked ? [...draft.projectPaths, project] : draft.projectPaths.filter((each) => each !== project) })} />
          <span>{folder(project)} <span className="muted">{project}</span></span>
        </label>)}
      </div>}
    </div>
    <div className="agent-channel-step">
      <h4>{t('AgentChannels.step4')}</h4>
      <div className="agent-channel-grid">
        <div className="squad-field"><label htmlFor={`${formId}-users`}>{t('AgentChannels.users')}</label><textarea id={`${formId}-users`} className="input" rows={3} spellCheck={false} value={draft.users} onChange={(event) => setDraft({ ...draft, users: event.target.value })} /></div>
        <div className="squad-field"><label htmlFor={`${formId}-places`}>{t('AgentChannels.places')}</label><textarea id={`${formId}-places`} className="input" rows={3} spellCheck={false} value={draft.places} onChange={(event) => setDraft({ ...draft, places: event.target.value })} /></div>
      </div>
      <p className="squad-block-hint muted">{t(`AgentChannels.${platform}.ids`)}</p>
      <label className="agent-profile-check"><input type="checkbox" checked={draft.allowDirect} onChange={(event) => setDraft({ ...draft, allowDirect: event.target.checked })} />{t('AgentChannels.allowDirect')}</label>
    </div>
    <div className="agent-channel-step">
      <h4>{t('AgentChannels.step5')}</h4>
      <div className="agent-channel-grid">
        {number('dailyPerUser', t('AgentChannels.dailyPerUser'), 1, 500)}
        {number('dailyTotal', t('AgentChannels.dailyTotal'), 1, 10_000)}
        {number('maxConcurrent', t('AgentChannels.maxConcurrent'), 1, 5)}
        {number('turnTimeoutSec', t('AgentChannels.turnTimeout'), 30, 1800)}
      </div>
      <p className="squad-block-hint muted">{t('AgentChannels.instructionsHint')}</p>
      <p className="squad-block-hint muted">{t('AgentChannels.offlineHint')}</p>
    </div>
    {error && <p className="modal-error" role="alert">{error}</p>}
    <div className="agent-channel-footer">
      <button type="button" className="button ghost" disabled={busy} onClick={onClose}>{t('AgentChannels.cancel')}</button>
      <button type="button" className="button primary" disabled={busy} onClick={() => void save()}>{t('AgentChannels.save')}</button>
    </div>
  </div>
}

const PAGE = 30

function ChannelRequests({ channel }: { channel: Channel }) {
  const [items, setItems] = useState<ChannelRequest[] | null>(null)
  const [before, setBefore] = useState<number | null>(null)
  const [opened, setOpened] = useState<string | null>(null)
  const now = Date.now()
  const load = async (from: number | null) => {
    const page = await perform((rpc) => rpc.call('channels.requests', { channelId: channel.id, limit: PAGE, ...(from === null ? {} : { before: from }) }))
    if (!page) return
    setItems((current) => (from === null ? page.items : [...(current ?? []), ...page.items]))
    setBefore(page.before)
  }
  useEffect(() => { void load(null) }, [channel.id])
  if (items === null) return null
  return <div className="agent-channel-panel">
    {items.length === 0 ? <p className="squad-block-hint muted">{t('AgentChannels.noRequests')}</p> : <ul className="agent-channel-requests">
      {items.map((request) => <li key={request.id}>
        <button type="button" className="agent-channel-request" aria-expanded={opened === request.id} onClick={() => setOpened(opened === request.id ? null : request.id)}>
          <span className="agent-channel-request-text">{request.text || t('AgentChannels.imagesOnly')}</span>
          <span className="agent-channel-request-meta">
            <span data-state={request.state}>{t(`AgentChannels.request.${request.state}`)}{request.refusal ? `（${refusalText(request.refusal)}）` : ''}</span>
            <span>{request.asker}{request.direct ? ` · ${t('AgentChannels.direct')}` : ` · ${request.place}`}</span>
            <span>{timeAgo(request.createdAt, now)}</span>
            {request.images > 0 && <span>{t('AgentChannels.images', { count: request.images })}</span>}
            {request.endedAt !== null && request.startedAt !== null && <span>{t('AgentChannels.seconds', { count: Math.max(1, Math.round((request.endedAt - request.startedAt) / 1000)) })}</span>}
            {request.totalTokens !== null && <span>{t('AgentChannels.tokens', { count: request.totalTokens })}</span>}
            {request.redacted && <span data-state="failed">{t('AgentChannels.redacted')}</span>}
          </span>
        </button>
        {opened === request.id && <RequestDetail request={request} />}
      </li>)}
    </ul>}
    {before !== null && <div className="agent-channel-actions"><button type="button" className="button small" onClick={() => void load(before)}>{t('AgentChannels.earlier')}</button></div>}
  </div>
}

function refusalText(refusal: string): string {
  return refusal === 'quota' ? t('AgentChannels.refusalQuota') : refusal === 'restarted' ? t('AgentChannels.refusalRestarted') : refusal === 'acl' ? t('AgentChannels.refusalAcl') : refusal
}

// What the agent answered and what it read to do so, as core wrote both down.
function RequestDetail({ request }: { request: ChannelRequest }) {
  const [answer, setAnswer] = useState<string | null>(null)
  const [reads, setReads] = useState<ChannelToolCall[] | null>(null)
  useEffect(() => {
    let live = true
    void perform((rpc) => rpc.call('channels.toolCalls', { requestId: request.id })).then((calls) => { if (live) setReads(calls ?? []) })
    const { conversationId } = request
    if (conversationId) void perform((rpc) => rpc.call('conversations.messages', { id: conversationId })).then((messages) => {
      if (live) setAnswer(messages?.findLast((message) => message.role === 'assistant' && message.eventKey === `chat:${request.id}:assistant`)?.text ?? '')
    })
    return () => { live = false }
  }, [request.id, request.conversationId])
  return <div className="agent-channel-detail">
    {answer ? <><h5>{t('AgentChannels.answer')}</h5><pre>{answer}</pre></> : null}
    <h5>{t('AgentChannels.reads')}</h5>
    {reads?.length ? <pre>{reads.map((call) => `${call.tool}  ${call.target}`).join('\n')}</pre> : <p className="squad-block-hint muted">{reads ? t('AgentChannels.noReads') : '…'}</p>}
  </div>
}
