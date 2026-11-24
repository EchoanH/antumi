import { useEffect, useId, useState } from 'react'
import { EMPTY_WRITEBACK, type SourceWritebackConfig } from '@antumi/protocol'
import { perform } from '../core-store'
import { t } from '../i18n'

// A source's rules for writing back to issues as their tasks start, go for review and are accepted.
export function SourceWritebackSettings({ provider, instance, config }: { provider: string; instance: string; config: SourceWritebackConfig | undefined }) {
  const id = useId()
  const saved = config ?? EMPTY_WRITEBACK
  const savedKey = JSON.stringify(saved)
  const [draft, setDraft] = useState(saved)
  const [busy, setBusy] = useState(false)
  useEffect(() => { setDraft(saved) }, [savedKey])
  const dirty = JSON.stringify(draft) !== savedKey
  const save = async () => {
    setBusy(true)
    await perform((rpc) => rpc.call('sources.saveWriteback', { provider, instance, config: draft }))
    setBusy(false)
  }
  const statusField = (stage: keyof SourceWritebackConfig, label: string) => <div className="settings-field">
    <label className="settings-field-label" htmlFor={`${id}-${stage}`}>{label}</label>
    <input id={`${id}-${stage}`} className="input" value={draft[stage].status} maxLength={500} placeholder="In Progress | 处理中" autoComplete="off" spellCheck={false}
      onChange={(event) => { const status = event.target.value; setDraft((known) => ({ ...known, [stage]: { ...known[stage], status } })) }} />
  </div>
  const commentToggle = (stage: 'review' | 'done') => <label className="source-writeback-comment-toggle">
    <input type="checkbox" checked={draft[stage].comment} onChange={(event) => { const comment = event.target.checked; setDraft((known) => ({ ...known, [stage]: { ...known[stage], comment } })) }} />
    {t('SourceWriteback.postSummary')}
  </label>
  return <section className="auto-investigation-settings source-writeback-settings">
    <span className="settings-field-label">{t('SourceWriteback.rules')}</span>
    <p className="settings-field-hint">{t('SourceWriteback.rulesHint')}</p>
    {statusField('start', t('SourceWriteback.onStart'))}
    {statusField('review', t('SourceWriteback.onReview'))}
    {commentToggle('review')}
    {statusField('done', t('SourceWriteback.onDone'))}
    {commentToggle('done')}
    <div className="settings-form-footer">
      <button type="button" className="button" disabled={busy || !dirty} onClick={() => void save()}>{busy ? t('SourceWriteback.saving') : t('SourceWriteback.save')}</button>
    </div>
  </section>
}
