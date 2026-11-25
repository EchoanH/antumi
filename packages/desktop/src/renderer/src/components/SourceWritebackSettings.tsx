import { useEffect, useId, useState } from 'react'
import { EMPTY_WRITEBACK, NO_WRITEBACK_OPTIONS, translatedText, WRITEBACK_STAGES, type SourceWritebackConfig, type WritebackLane, type WritebackOptions, type WritebackRuleHints, type WritebackStage, type WritebackType } from '@antumi/protocol'
import { perform, useCore } from '../core-store'
import { getLocale, t } from '../i18n'
import { CloseIcon } from './icons'

const CUSTOM = '\u0000custom'

type Rules = Pick<SourceWritebackConfig, WritebackStage>
type Saved = { rules: SourceWritebackConfig; lanes: WritebackLane[]; options: WritebackOptions }
// A type a lane can be made for: one the plugin lists, or one seen in the inbox.
export type LaneType = Pick<WritebackType, 'id' | 'label'> & Partial<Pick<WritebackType, 'mode' | 'rules' | 'translations'>>

const laneKey = (lane: Pick<WritebackLane, 'typeId' | 'scopeId'>) => `${lane.typeId}\u0000${lane.scopeId ?? ''}`
const rulesOf = (lane: WritebackLane, own: SourceWritebackConfig): Rules => ({ start: lane.start ?? own.start, review: lane.review ?? own.review, done: lane.done ?? own.done })

// The three stages of one set of rules: the source's own, or one type's lane. What each stage
// offers comes from the plugin (hints): its statuses to pick from, or none at all.
function StageFields({ rules, hints, comments, onChange }: { rules: Rules; hints: WritebackRuleHints | undefined; comments: boolean; onChange: (rules: Rules) => void }) {
  const id = useId()
  // Stages showing a text box for a name the presets do not hold.
  const [typing, setTyping] = useState<ReadonlySet<WritebackStage>>(() => typed(rules, hints))
  const setStatus = (stage: WritebackStage, status: string) => onChange({ ...rules, [stage]: { ...rules[stage], status } })
  const statusField = (stage: WritebackStage, label: string) => {
    const hint = hints?.[stage]
    if (hint === false) return null
    const stageHint = hint ? translatedText(hint, getLocale()) : undefined
    const presets = (hint?.presets ?? []).map((preset) => ({ value: preset.value, label: translatedText(preset, getLocale()).label }))
    const custom = hint?.custom ?? true
    const value = rules[stage].status
    const known = presets.some((preset) => preset.value === value)
    const placeholder = stageHint?.placeholder ?? 'In Progress | 处理中'
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
        {typing.has(stage) && <input className="input" value={value} maxLength={500} placeholder={placeholder} autoComplete="off" spellCheck={false} aria-label={label}
          onChange={(event) => setStatus(stage, event.target.value)} />}
      </> : <input id={`${id}-${stage}`} className="input" value={value} maxLength={500} placeholder={placeholder} autoComplete="off" spellCheck={false}
        onChange={(event) => setStatus(stage, event.target.value)} />}
      {/* The plugin no longer offers it, often because it did someone else's step (closing a bug). */}
      {!custom && value && !known && presets.length > 0 && <p className="settings-field-hint" data-warning>{t('SourceWriteback.staleStatus')}</p>}
      {stageHint?.hint && <p className="settings-field-hint">{stageHint.hint}</p>}
      {stage === 'done' && <p className="settings-field-hint">{t('SourceWriteback.doneHint')}</p>}
    </div>
  }
  const commentToggle = (stage: 'review' | 'done', label: string) => comments && <label className="source-writeback-comment-toggle">
    <input type="checkbox" checked={rules[stage].comment} onChange={(event) => onChange({ ...rules, [stage]: { ...rules[stage], comment: event.target.checked } })} />
    {label}
  </label>
  // A stage the tracker has no status for keeps its comment, under the stage's own name.
  const stage = (key: 'review' | 'done', statusLabel: string, triggerLabel: string) => hints?.[key] === false
    ? comments && <div className="settings-field"><span className="settings-field-label">{triggerLabel}</span>{commentToggle(key, t('SourceWriteback.postSummaryAlone'))}</div>
    : <>{statusField(key, statusLabel)}{commentToggle(key, t('SourceWriteback.postSummary'))}</>
  return <>
    {statusField('start', t('SourceWriteback.onStart'))}
    {stage('review', t('SourceWriteback.onReview'), t('SourceWriteback.trigger.review'))}
    {stage('done', t('SourceWriteback.onDone'), t('SourceWriteback.trigger.done'))}
  </>
}

// A source's rules for writing back to issues as their tasks start, go for review and are accepted:
// its own, and where the user sets one, a lane for a single issue type.
export function SourceWritebackSettings({ provider, instance, config, hints, comments = true, lanes, options, types = [] }: {
  provider: string; instance: string; config: SourceWritebackConfig | undefined; hints?: WritebackRuleHints | undefined; comments?: boolean | undefined
  lanes?: readonly WritebackLane[] | undefined; options?: WritebackOptions | undefined; types?: readonly LaneType[] | undefined
}) {
  const id = useId()
  const laned = useCore((state) => state.rpc?.features.includes('source-writeback-lanes') ?? false)
  const saved: Saved = { rules: config ?? EMPTY_WRITEBACK, lanes: [...(lanes ?? [])], options: options ?? NO_WRITEBACK_OPTIONS }
  const savedKey = JSON.stringify(saved)
  const [draft, setDraft] = useState(saved)
  const [busy, setBusy] = useState(false)
  // Bumped when what is saved changes under the form, so stage fields start afresh from it.
  const [generation, setGeneration] = useState(0)
  useEffect(() => { setDraft(saved); setGeneration((known) => known + 1) }, [savedKey])
  const dirty = JSON.stringify(draft) !== savedKey
  const save = async () => {
    setBusy(true)
    await perform((rpc) => rpc.call('sources.saveWriteback', { provider, instance, config: draft.rules, ...(laned ? { lanes: draft.lanes, options: draft.options } : {}) }))
    setBusy(false)
  }
  const typeOf = (typeId: string) => types.find((type) => type.id === typeId)
  const typeLabel = (lane: WritebackLane) => { const type = typeOf(lane.typeId); return type ? translatedText(type, getLocale()).label : lane.name || lane.typeId }
  const free = types.filter((type) => !draft.lanes.some((lane) => lane.typeId === type.id && lane.scopeId === undefined))
  const addLane = (typeId: string) => {
    const type = typeOf(typeId)
    if (!type) return
    // Blank to begin with: nothing is moved for the type until the user says where to.
    const lane: WritebackLane = { typeId, name: type.label, mode: 'on', start: { status: '' }, review: { status: '', comment: draft.rules.review.comment }, done: { status: '', comment: false } }
    setDraft((known) => ({ ...known, lanes: [...known.lanes, lane] }))
  }
  const setLane = (key: string, change: (lane: WritebackLane) => WritebackLane) => setDraft((known) => ({ ...known, lanes: known.lanes.map((lane) => (laneKey(lane) === key ? change(lane) : lane)) }))
  const setOption = (option: keyof WritebackOptions, value: boolean) => setDraft((known) => ({ ...known, options: { ...known.options, [option]: value } }))
  const freeText = WRITEBACK_STAGES.some((key) => { const hint = hints?.[key]; return hint !== false && (!hint?.presets.length || hint.custom) })
  return <section className="auto-investigation-settings source-writeback-settings">
    <span className="settings-field-label">{t('SourceWriteback.rules')}</span>
    <p className="settings-field-hint">{t('SourceWriteback.rulesHint')}{freeText ? `${getLocale() === 'en' ? ' ' : ''}${t('SourceWriteback.namesHint')}` : ''}</p>
    {laned && <p className="settings-field-hint">{t('SourceWriteback.ownershipHint')}</p>}
    {laned && <label className="source-writeback-comment-toggle">
      <input type="checkbox" checked={draft.options.dryRun} onChange={(event) => setOption('dryRun', event.target.checked)} />
      {t('SourceWriteback.dryRun')}
    </label>}
    {laned && <label className="source-writeback-comment-toggle">
      <input type="checkbox" checked={draft.options.sharedCounts} onChange={(event) => setOption('sharedCounts', event.target.checked)} />
      {t('SourceWriteback.sharedCounts')}
    </label>}
    {laned && (draft.lanes.length > 0 || types.length > 0) && <span className="settings-field-label">{t('SourceWriteback.allTypes')}</span>}
    <StageFields key={`own-${generation}`} rules={draft.rules} hints={hints} comments={comments} onChange={(rules) => setDraft((known) => ({ ...known, rules: { ...known.rules, ...rules } }))} />
    {laned && draft.lanes.map((lane) => {
      const key = laneKey(lane)
      return <fieldset key={`${key}-${generation}`} className="source-writeback-lane">
        <legend className="source-writeback-lane-head">
          <span className="settings-field-label">{t('SourceWriteback.laneFor', { type: typeLabel(lane) })}</span>
          <select className="input" aria-label={t('SourceWriteback.laneMode', { type: typeLabel(lane) })} value={lane.mode} onChange={(event) => { const mode = event.target.value === 'off' ? 'off' : 'on'; setLane(key, (known) => ({ ...known, mode })) }}>
            <option value="on">{t('SourceWriteback.laneOn')}</option>
            <option value="off">{t('SourceWriteback.laneOff')}</option>
          </select>
          <button type="button" className="tool-button" aria-label={t('SourceWriteback.removeLane', { type: typeLabel(lane) })} data-tooltip={t('SourceWriteback.removeLane', { type: typeLabel(lane) })}
            onClick={() => setDraft((known) => ({ ...known, lanes: known.lanes.filter((each) => laneKey(each) !== key) }))}><CloseIcon /></button>
        </legend>
        {lane.mode === 'on' && <StageFields rules={rulesOf(lane, draft.rules)} hints={typeOf(lane.typeId)?.rules ?? hints} comments={comments} onChange={(rules) => setLane(key, (known) => ({ ...known, ...rules }))} />}
      </fieldset>
    })}
    {laned && free.length > 0 && <div className="settings-field">
      <label className="settings-field-label" htmlFor={`${id}-add`}>{t('SourceWriteback.addLane')}</label>
      <select id={`${id}-add`} className="input" value="" onChange={(event) => addLane(event.target.value)}>
        <option value="">{t('SourceWriteback.pickType')}</option>
        {free.map((type) => <option key={type.id} value={type.id}>{translatedText(type, getLocale()).label}{type.mode === 'off' ? t('SourceWriteback.typeOffNote') : ''}</option>)}
      </select>
    </div>}
    {/* The guidance shapes the summary, which only ever goes out as a comment. */}
    {comments && <div className="settings-field">
      <label className="settings-field-label" htmlFor={`${id}-guidance`}>{t('SourceWriteback.guidance')}</label>
      <textarea id={`${id}-guidance`} className="input settings-textarea" rows={2} maxLength={1000} value={draft.rules.guidance} placeholder={t('SourceWriteback.guidancePlaceholder')}
        onChange={(event) => { const guidance = event.target.value; setDraft((known) => ({ ...known, rules: { ...known.rules, guidance } })) }} />
      <p className="settings-field-hint">{t('SourceWriteback.guidanceHint')}</p>
    </div>}
    <div className="settings-form-footer">
      <button type="button" className="button" disabled={busy || !dirty} onClick={() => void save()}>{busy ? t('SourceWriteback.saving') : t('SourceWriteback.save')}</button>
    </div>
  </section>
}

// Stages whose saved name is none of the presets, so they open on the text box.
function typed(rules: Rules, hints: WritebackRuleHints | undefined): ReadonlySet<WritebackStage> {
  return new Set(WRITEBACK_STAGES.filter((stage) => {
    const hint = hints?.[stage]
    return !!hint && hint.custom && hint.presets.length > 0 && !!rules[stage].status && !hint.presets.some((preset) => preset.value === rules[stage].status)
  }))
}
