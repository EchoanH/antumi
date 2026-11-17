import { useState } from 'react'
import { channelPlatform, type TaskChannelSource } from '@antumi/protocol'
import { loadConversation, selectConversation, useCore } from '../core-store'
import { dayAndTime } from '../labels'
import { t } from '../i18n'
import { ChevronDownIcon } from './icons'
import { MarkdownEditor } from './MarkdownEditor'

// The captured message survives removal of the channel and its conversation.
export function TaskChannelSourceCard({ source }: { source: TaskChannelSource | null | undefined }) {
  const [open, setOpen] = useState(false)
  if (!source) return null
  const title = t('TaskChannelSource.original', { platform: channelPlatform(source.platform).label })
  const showConversation = async () => {
    await loadConversation(source.conversationId)
    if (useCore.getState().conversations[source.conversationId]) selectConversation(source.conversationId)
  }
  return <section className="snapshot" data-open={open || undefined} aria-label={title}>
    <header className="snapshot-header">
      <button type="button" className="snapshot-toggle" aria-expanded={open} onClick={() => setOpen(!open)}><ChevronDownIcon />{title}</button>
      <span className="muted">{dayAndTime(source.createdAt)}</span>
      <button type="button" className="button small" onClick={() => void showConversation()}>{t('TaskChannelSource.open')}</button>
    </header>
    {open && <>
      <p className="muted">{t('TaskChannelSource.metadata', { asker: source.asker, place: source.place, message: source.messageId })}</p>
      <MarkdownEditor value={source.text || t('AgentChannels.imagesOnly')} label={title} hint="" readOnly />
    </>}
  </section>
}
