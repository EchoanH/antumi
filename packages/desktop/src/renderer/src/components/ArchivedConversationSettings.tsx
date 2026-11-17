import { useId, useMemo, useState } from 'react'
import type { Conversation } from '@antumi/protocol'
import { t } from '../i18n'
import { selectConversation, useCore } from '../core-store'
import { agentLabel } from '../labels'
import { timeAgo } from '../conversation-state'
import { archivedByProject, type ArchivedGroup } from '../archived-conversations'
import { deleteConversations } from './ConversationActions'
import { AgentIcon, ChevronRightIcon } from './icons'
import { Spinner } from './Spinner'
import { projectName } from './ProjectPicker'

// Picked by row, by project or all at once, then deleted together. Rows leave as core says they went.
export function ArchivedConversationSettings() {
  const connected = useCore((s) => s.connection === 'connected')
  const conversations = useCore((s) => s.conversations)
  const groups = useMemo(() => archivedByProject(Object.values(conversations), projectName), [conversations])
  const [chosen, setChosen] = useState<ReadonlySet<string>>(new Set())
  const [query, setQuery] = useState('')
  const [expanded, setExpanded] = useState<ReadonlyMap<string, boolean>>(new Map())
  const [busy, setBusy] = useState(false)

  const needle = query.trim().toLowerCase()
  const visible = needle
    ? groups.flatMap((group) => {
      const found = group.project && projectName(group.project).toLowerCase().includes(needle)
        ? group.conversations
        : group.conversations.filter((conversation) => conversation.title.toLowerCase().includes(needle))
      return found.length ? [{ ...group, conversations: found }] : []
    })
    : groups
  const all = groups.flatMap((group) => group.conversations)
  const picked = all.filter((conversation) => chosen.has(conversation.id))
  const shown = visible.flatMap((group) => group.conversations.map((conversation) => conversation.id))
  const shownPicked = shown.filter((id) => chosen.has(id)).length
  const isExpanded = (key: string) => expanded.get(key) ?? (Boolean(needle) || groups.length === 1)

  const toggle = (ids: readonly string[], on: boolean) => setChosen((current) => {
    const next = new Set(current)
    ids.forEach((id) => (on ? next.add(id) : next.delete(id)))
    return next
  })

  const remove = async () => {
    if (!picked.length || busy) return
    setBusy(true)
    try {
      await deleteConversations(picked.map((conversation) => conversation.id))
    } finally {
      // What went is gone from the store; only what is still archived stays picked.
      const left = new Set(Object.values(useCore.getState().conversations).filter((each) => each.archivedAt != null).map((each) => each.id))
      setChosen((current) => new Set([...current].filter((id) => left.has(id))))
      setBusy(false)
    }
  }

  if (!connected) return <p className="settings-empty">{t('ChatCommandSettings.connectToAntumiCoreToView')}</p>
  if (groups.length === 0) return <p className="settings-empty">{t('ArchivedConversationSettings.none')}</p>
  return (
    <>
      <div className="session-import-toolbar">
        <input className="input session-import-search" value={query} onChange={(event) => { setQuery(event.target.value); setExpanded(new Map()) }}
          placeholder={t('ArchivedConversationSettings.search')} aria-label={t('ArchivedConversationSettings.search')} />
      </div>
      <div className="session-import-list-actions">
        <input type="checkbox" checked={shown.length > 0 && shownPicked === shown.length} disabled={!shown.length || busy}
          ref={(input) => { if (input) input.indeterminate = shownPicked > 0 && shownPicked < shown.length }}
          onChange={(event) => toggle(shown, event.target.checked)} aria-label={t('ArchivedConversationSettings.selectAll')} />
        <span className="session-import-summary">{t('ArchivedConversationSettings.summary', { projects: visible.length, count: shown.length })}</span>
        <button type="button" className="button ghost" disabled={visible.every((group) => isExpanded(group.key))} onClick={() => setExpanded(new Map(visible.map((group) => [group.key, true])))}>{t('SessionImportSettings.expandAll')}</button>
        <button type="button" className="button ghost" disabled={visible.every((group) => !isExpanded(group.key))} onClick={() => setExpanded(new Map(visible.map((group) => [group.key, false])))}>{t('SessionImportSettings.collapseAll')}</button>
      </div>
      {visible.length === 0 ? <p className="settings-empty">{t('ArchivedConversationSettings.noneMatch')}</p>
        : visible.map((group) => (
          <ArchivedGroupRows key={group.key} group={group} chosen={chosen} busy={busy} expanded={isExpanded(group.key)} toggle={toggle}
            onExpand={() => setExpanded((current) => new Map(current).set(group.key, !isExpanded(group.key)))} />
        ))}
      <div className="session-import-actions">
        <span className="session-import-summary" aria-live="polite">
          <span>{t('SessionImportSettings.selectedCount', { count: picked.length })}</span>
          {picked.length > shownPicked && <span> · {t('SessionImportSettings.hiddenSelected', { count: picked.length - shownPicked })}</span>}
        </span>
        {picked.length > 0 && <button type="button" className="button ghost" disabled={busy} onClick={() => setChosen(new Set())}>{t('SessionImportSettings.clearSelection')}</button>}
        <button type="button" className="button danger" disabled={!picked.length || busy} onClick={() => void remove()}>
          {busy ? <><Spinner />{t('ArchivedConversationSettings.deleting')}</> : t('ArchivedConversationSettings.deleteSelected', { count: picked.length })}
        </button>
      </div>
    </>
  )
}

function ArchivedGroupRows({ group, chosen, busy, expanded, toggle, onExpand }: {
  group: ArchivedGroup
  chosen: ReadonlySet<string>
  busy: boolean
  expanded: boolean
  toggle: (ids: readonly string[], on: boolean) => void
  onExpand: () => void
}) {
  const listId = useId()
  const ids = group.conversations.map((conversation) => conversation.id)
  const selected = ids.filter((id) => chosen.has(id)).length
  const all = selected === ids.length
  const name = group.project ? projectName(group.project) : t('ArchivedConversationSettings.noProject')
  return (
    <section className="session-import-group">
      <div className="session-import-folder">
        <input type="checkbox" checked={all} disabled={busy} onChange={(event) => toggle(ids, event.target.checked)}
          ref={(input) => { if (input) input.indeterminate = selected > 0 && !all }}
          aria-label={t('ArchivedConversationSettings.selectProject', { value1: name })} />
        <button type="button" className="session-import-folder-toggle" aria-expanded={expanded} aria-controls={listId} onClick={onExpand}>
          <ChevronRightIcon />
          <span className="settings-project-name">{name}</span>
          {group.project && <span className="settings-project-path mono" title={group.project}>{group.project}</span>}
          <span className="session-import-count">{t('ArchivedConversationSettings.count', { count: ids.length })}</span>
          {selected > 0 && <span className="session-import-selected">{t('SessionImportSettings.selectedCount', { count: selected })}</span>}
        </button>
      </div>
      <ul id={listId} className="settings-project-list" hidden={!expanded}>
        {expanded && group.conversations.map((conversation) => <ArchivedRow key={conversation.id} conversation={conversation} checked={chosen.has(conversation.id)} busy={busy} toggle={toggle} />)}
      </ul>
    </section>
  )
}

function ArchivedRow({ conversation, checked, busy, toggle }: { conversation: Conversation; checked: boolean; busy: boolean; toggle: (ids: readonly string[], on: boolean) => void }) {
  return (
    <li className="settings-project session-import-row">
      <input type="checkbox" checked={checked} disabled={busy} onChange={(event) => toggle([conversation.id], event.target.checked)}
        aria-label={t('SessionImportSettings.select', { value1: conversation.title })} />
      <span className="session-import-agent" title={agentLabel(conversation.agent)}><AgentIcon agent={conversation.agent} /></span>
      <span className="session-import-title" title={conversation.title}>{conversation.title}</span>
      <span className="muted session-import-time" title={t('ArchivedConversationSettings.archivedAt')}>{timeAgo(conversation.archivedAt ?? conversation.updatedAt, Date.now())}</span>
      <button type="button" className="button ghost" onClick={() => selectConversation(conversation.id)}>{t('SessionImportSettings.open')}</button>
    </li>
  )
}
