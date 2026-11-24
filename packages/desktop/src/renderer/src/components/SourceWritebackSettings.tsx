import { useEffect, useId, useState } from 'react'
import { EMPTY_WRITEBACK, translatedText, WRITEBACK_STAGES, type SourceWritebackConfig, type WritebackRuleHints, type WritebackStage } from '@antumi/protocol'
import { perform } from '../core-store'
import { getLocale, t } from '../i18n'

const CUSTOM = '\u0000custom'

// A source's rules for writing back to issues as their tasks start, go for review and are accepted.
// What each stage offers comes from the plugin (hints): its statuses to pick from, or none at all.
export function SourceWritebackSettings({ provider, instance, config, hints, comments = true }: { provider: string; instance: string; config: SourceWritebackConfig | undefined; hints?: WritebackRuleHints | undefined; comments?: boolean | undefined }) {
  const id = useId()
  const saved = config ?? EMPTY_WRITEBACK
  const savedKey = JSON.stringify(saved)
  const [draft, setDraft] = useState(saved)
  const [busy, setBusy] = useState(false)
  // Stages showing a text box for a name the presets do not hold.
  const [typing, setTyping] = useState<ReadonlySet<WritebackStage>>(() => typed(saved, hints))
  useEffect(() => { setDraft(saved); setTyping(typed(saved, hints)) }, [savedKey])
  const dirty = JSON.stringify(draft) !== savedKey
  const save = async () => {
    setBusy(true)
    await perform((rpc) => rpc.call('sources.saveWriteback', { provider, instance, config: draft }))
    setBusy(false)
  }
  const setStatus = (stage: WritebackStage, status: string) => setDraft((known) => ({ ...known, [stage]: { ...known[stage], status } }))
  const statusField = (stage: WritebackStage, label: string) => {
    const hint = hints?.[stage]
    if (hint === false) return null
    const stageHint = hint ? translatedText(hint, getLocale()) : undefined
    const presets = (hint?.presets ?? []).map((preset) => ({ value: preset.value, label: translatedText(preset, getLocale()).label }))
    const custom = hint?.custom ?? true
    const value = draft[stage].status
    const known = presets.some((preset) => preset.value === value)
    const input = <input id={`${id}-${stage}`} className="input" value={value} maxLength={500} placeholder={stageHint?.placeholder ?? 'In Progress | 处理中'} autoComplete="off" spellCheck={false}
      onChange={(event) => setStatus(stage, event.target.value)} />
    return <div className="settings-field">
      <label className="settings-field-label" htmlFor={`${id}-${stage}`}>{label}</label>
      {presets.length ? <>
        <select id={`${id}-${stage}`} className="input" value={typing.has(stage) ? CUSTOM : value} onChange={(event) => {
          const picked = event.target.value
          setTyping((stages) => { const next = new Set(stages); if (picked === CUSTOM) next.add(stage); else next.delete(stage); return next })
          if (picked !== CUSTOM) setStatus(stage, picked)
        }}>
          <option value="">{t('SourceWriteback.keepStatus')}</option>
          {presets.map((preset) => <option key={preset.value} value={preset.value}>{preset.label}</option>)}
          {/* A name saved before the plugin listed its statuses stays visible rather than silently dropped. */}
          {!custom && value && !known && <option value={value}>{value}</option>}
          {custom && <option value={CUSTOM}>{t('SourceWriteback.customStatus')}</option>}
        </select>
        {typing.has(stage) && <input className="input" value={value} maxLength={500} placeholder={stageHint?.placeholder ?? 'In Progress | 处理中'} autoComplete="off" spellCheck={false} aria-label={label}
          onChange={(event) => setStatus(stage, event.target.value)} />}
      </> : input}
      {stageHint?.hint && <p className="settings-field-hint">{stageHint.hint}</p>}
    </div>
  }
  const commentToggle = (stage: 'review' | 'done', label: string) => comments && <label className="source-writeback-comment-toggle">
    <input type="checkbox" checked={draft[stage].comment} onChange={(event) => { const comment = event.target.checked; setDraft((known) => ({ ...known, [stage]: { ...known[stage], comment } })) }} />
    {label}
  </label>
  // A stage the tracker has no status for keeps its comment, under the stage's own name.
  const stage = (key: 'review' | 'done', statusLabel: string, triggerLabel: string) => hints?.[key] === false
    ? comments && <div className="settings-field"><span className="settings-field-label">{triggerLabel}</span>{commentToggle(key, t('SourceWriteback.postSummaryAlone'))}</div>
    : <>{statusField(key, statusLabel)}{commentToggle(key, t('SourceWriteback.postSummary'))}</>
  const freeText = WRITEBACK_STAGES.some((key) => { const hint = hints?.[key]; return hint !== false && (!hint?.presets.length || hint.custom) })
  return <section className="auto-investigation-settings source-writeback-settings">
    <span className="settings-field-label">{t('SourceWriteback.rules')}</span>
    <p className="settings-field-hint">{t('SourceWriteback.rulesHint')}{freeText ? `${getLocale() === 'en' ? ' ' : ''}${t('SourceWriteback.namesHint')}` : ''}</p>
    {statusField('start', t('SourceWriteback.onStart'))}
    {stage('review', t('SourceWriteback.onReview'), t('SourceWriteback.trigger.review'))}
    {stage('done', t('SourceWriteback.onDone'), t('SourceWriteback.trigger.done'))}
    {/* The guidance shapes the summary, which only ever goes out as a comment. */}
    {comments && <div className="settings-field">
      <label className="settings-field-label" htmlFor={`${id}-guidance`}>{t('SourceWriteback.guidance')}</label>
      <textarea id={`${id}-guidance`} className="input settings-textarea" rows={2} maxLength={1000} value={draft.guidance} placeholder={t('SourceWriteback.guidancePlaceholder')}
        onChange={(event) => { const guidance = event.target.value; setDraft((known) => ({ ...known, guidance })) }} />
      <p className="settings-field-hint">{t('SourceWriteback.guidanceHint')}</p>
    </div>}
    <div className="settings-form-footer">
      <button type="button" className="button" disabled={busy || !dirty} onClick={() => void save()}>{busy ? t('SourceWriteback.saving') : t('SourceWriteback.save')}</button>
    </div>
  </section>
}

// Stages whose saved name is none of the presets, so they open on the text box.
function typed(config: SourceWritebackConfig, hints: WritebackRuleHints | undefined): ReadonlySet<WritebackStage> {
  return new Set(WRITEBACK_STAGES.filter((stage) => {
    const hint = hints?.[stage]
    return !!hint && hint.custom && hint.presets.length > 0 && !!config[stage].status && !hint.presets.some((preset) => preset.value === config[stage].status)
  }))
}
