import { useEffect, useId, useState } from 'react'
import { applicableWriteback, EMPTY_WRITEBACK, NO_WRITEBACK_OPTIONS, translatedText, WRITEBACK_STAGES, type SourceWritebackConfig, type WritebackLane, type WritebackOptions, type WritebackRuleHints, type WritebackStage, type WritebackType } from '@antumi/protocol'
import { perform, useCore } from '../core-store'
import { getLocale, t } from '../i18n'
import { ChatPicker } from './ChatPicker'
import { ChevronRightIcon, ListIcon } from './icons'

const CUSTOM = '\u0000custom'

type Rules = Pick<SourceWritebackConfig, WritebackStage>
type Saved = { rules: SourceWritebackConfig; lanes: WritebackLane[]; options: WritebackOptions }
// A type a lane can be made for: one the plugin lists, or one seen in the inbox.
export type LaneType = Pick<WritebackType, 'id' | 'label'> & Partial<Pick<WritebackType, 'mode' | 'rules' | 'translations'>>

const laneKey = (lane: Pick<WritebackLane, 'typeId' | 'scopeId'>) => `${lane.typeId}\u0000${lane.scopeId ?? ''}`
const rulesOf = (lane: WritebackLane): Rules => ({ start: lane.start ?? EMPTY_WRITEBACK.start, review: lane.review ?? EMPTY_WRITEBACK.review, done: lane.done ?? EMPTY_WRITEBACK.done })

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
    const editing = typing.has(stage) || (custom && !!value && !known)
    const placeholder = stageHint?.placeholder ?? 'In Progress | 处理中'
    const options = [
      { value: '', label: t('SourceWriteback.keepStatus') }, ...presets,
      ...(!custom && value && !known ? [{ value, label: value }] : []),
      ...(custom ? [{ value: CUSTOM, label: t('SourceWriteback.customStatus') }] : [])
    ]
    return <div className="settings-field">
      <label className="settings-field-label" htmlFor={`${id}-${stage}`}>{label}</label>
      {presets.length ? <>
        <ChatPicker id={`${id}-${stage}`} label={label} size="field" placement="below" value={editing ? CUSTOM : value} placeholder={t('SourceWriteback.keepStatus')} options={options} onChange={(picked) => {
          setTyping((stages) => { const next = new Set(stages); if (picked === CUSTOM) next.add(stage); else next.delete(stage); return next })
          if (picked !== CUSTOM) setStatus(stage, picked)
        }} />
        {editing && <input className="input" value={value} maxLength={500} placeholder={placeholder} autoComplete="off" spellCheck={false} aria-label={label}
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
    <div className="source-writeback-stages">
      <div className="source-writeback-stage">{statusField('start', t('SourceWriteback.onStart'))}</div>
      <div className="source-writeback-stage">{stage('review', t('SourceWriteback.onReview'), t('SourceWriteback.trigger.review'))}</div>
    </div>
    <details className="source-writeback-extra">
      <summary>{t('SourceWriteback.closingOptions')}{(rules.done.status || rules.done.comment) ? ` · ${t('SourceWriteback.configured')}` : ''}</summary>
      <div className="source-writeback-fields">{stage('done', t('SourceWriteback.onDone'), t('SourceWriteback.trigger.done'))}</div>
    </details>
  </>
}

// Each type is configured independently. The source-level config holds summary guidance only.
export function SourceWritebackSettings({ provider, instance, config, hints, comments = true, lanes, options, types = [] }: {
  provider: string; instance: string; config: SourceWritebackConfig | undefined; hints?: WritebackRuleHints | undefined; comments?: boolean | undefined
  lanes?: readonly WritebackLane[] | undefined; options?: WritebackOptions | undefined; types?: readonly LaneType[] | undefined
}) {
  const id = useId()
  const supported = useCore((state) => state.rpc?.features.includes('source-writeback-per-type') ?? false)
  const saved: Saved = { rules: { ...EMPTY_WRITEBACK, guidance: config?.guidance ?? '' }, lanes: [...(lanes ?? [])], options: options ?? NO_WRITEBACK_OPTIONS }
  const savedKey = JSON.stringify(saved)
  const [draft, setDraft] = useState(saved)
  const [busy, setBusy] = useState(false)
  const [generation, setGeneration] = useState(0)
  useEffect(() => { setDraft(saved); setGeneration((known) => known + 1) }, [savedKey])
  const dirty = JSON.stringify(draft) !== savedKey
  const save = async () => {
    setBusy(true)
    try { await perform((rpc) => rpc.call('sources.saveWriteback', { provider, instance, config: draft.rules, lanes: draft.lanes, options: draft.options })) }
    finally { setBusy(false) }
  }
  const typeOf = (typeId: string) => types.find((type) => type.id === typeId)
  const typeLabel = (lane: Pick<WritebackLane, 'typeId' | 'scopeId' | 'name'>) => {
    const type = typeOf(lane.typeId)
    const name = type ? translatedText(type, getLocale()).label : lane.name || lane.typeId
    return lane.scopeId ? `${name} · ${lane.scopeId}` : name
  }
  const entries: Pick<WritebackLane, 'typeId' | 'scopeId' | 'name'>[] = types.map((type) => ({ typeId: type.id, name: type.label }))
  for (const lane of draft.lanes) if (!entries.some((entry) => laneKey(entry) === laneKey(lane))) entries.push(lane)
  const setLane = (key: string, lane: WritebackLane | null) => setDraft((known) => ({ ...known, lanes: [...known.lanes.filter((each) => laneKey(each) !== key), ...(lane ? [lane] : [])] }))
  const setOption = (option: keyof WritebackOptions, value: boolean) => setDraft((known) => ({ ...known, options: { ...known.options, [option]: value } }))
  const summary = (lane: WritebackLane | undefined, type: LaneType | undefined) => {
    if (!lane) return t(type?.mode === 'off' ? 'SourceWriteback.laneOff' : 'SourceWriteback.unconfigured')
    if (lane.mode === 'off') return t('SourceWriteback.laneOff')
    const rules = applicableWriteback({ ...rulesOf(lane), guidance: '' }, type?.rules ?? hints, comments)
    const details = WRITEBACK_STAGES.flatMap((stage) => {
      const rule = rules[stage]
      return [rule.status ? `${t(`SourceWriteback.trigger.${stage}`)} → ${rule.status}` : '', 'comment' in rule && rule.comment ? `${t(`SourceWriteback.trigger.${stage}`)} · ${t('SourceWriteback.planComment')}` : ''].filter(Boolean)
    })
    return details.join('；') || t('SourceWriteback.noActions')
  }
  return <section className="auto-investigation-settings source-writeback-settings">
    <h3 className="source-settings-title"><ListIcon />{t('SourceWriteback.rules')}</h3>
    <p className="settings-field-hint">{t('SourceWriteback.byTypeHint')}</p>
    {!supported ? <p className="settings-field-hint">{t('SourceWriteback.upgradeCore')}</p> : <>
      {entries.length === 0 && <p className="settings-field-hint">{t('SourceWriteback.noTypes')}</p>}
      <fieldset className="source-writeback-editor" disabled={busy}>
        {entries.map((entry) => {
          const key = laneKey(entry)
          const lane = draft.lanes.find((each) => laneKey(each) === key)
          const type = typeOf(entry.typeId)
          const label = typeLabel(entry)
          const blank: WritebackLane = { ...entry, mode: 'on', ...rulesOf({ ...entry, mode: 'on' }) }
          const copies = draft.lanes.filter((each) => each.mode === 'on' && laneKey(each) !== key)
          return <details key={`${key}-${generation}`} className="source-writeback-type">
            <summary><ChevronRightIcon /><span className="settings-field-label">{label}</span><span className="source-writeback-type-summary" title={summary(lane, type)}>{summary(lane, type)}</span></summary>
            <div className="source-writeback-fields">
              <label className="settings-field">
                <span className="settings-field-label">{t('SourceWriteback.laneMode', { type: label })}</span>
                <ChatPicker label={t('SourceWriteback.laneMode', { type: label })} size="field" placement="below" value={lane?.mode ?? ''} placeholder={t('SourceWriteback.unconfigured')} options={[
                  { value: '', label: t('SourceWriteback.unconfigured') },
                  { value: 'on', label: t('SourceWriteback.laneOn') },
                  { value: 'off', label: t('SourceWriteback.laneOff') }
                ]} onChange={(mode) => {
                  setLane(key, mode === '' ? null : { ...(lane ?? blank), mode: mode === 'off' ? 'off' : 'on' })
                }} />
              </label>
              {lane?.mode === 'on' && <>
                {copies.length > 0 && <label className="settings-field">
                  <span className="settings-field-label">{t('SourceWriteback.copyFrom')}</span>
                  <ChatPicker label={t('SourceWriteback.copyFrom')} size="field" placement="below" value="" placeholder={t('SourceWriteback.pickCopy')} options={copies.map((each) => ({ value: laneKey(each), label: typeLabel(each) }))} onChange={(value) => {
                    const from = copies.find((each) => laneKey(each) === value)
                    if (from) setLane(key, { ...lane, ...rulesOf(from) })
                  }} />
                </label>}
                <StageFields rules={rulesOf(lane)} hints={type?.rules ?? hints} comments={comments} onChange={(rules) => setLane(key, { ...lane, ...rules })} />
                <p className="settings-field-hint">{t('SourceWriteback.namesHint')}</p>
              </>}
            </div>
          </details>
        })}
        <details className="source-writeback-extra">
          <summary>{t('SourceWriteback.advanced')}{draft.options.dryRun ? ` · ${t('SourceWriteback.planned')}` : ''}</summary>
          <div className="source-writeback-fields">
            <label className="source-writeback-comment-toggle"><input type="checkbox" checked={draft.options.dryRun} onChange={(event) => setOption('dryRun', event.target.checked)} />{t('SourceWriteback.dryRun')}</label>
            <label className="source-writeback-comment-toggle"><input type="checkbox" checked={draft.options.sharedCounts} onChange={(event) => setOption('sharedCounts', event.target.checked)} />{t('SourceWriteback.sharedCounts')}</label>
            <p className="settings-field-hint">{t('SourceWriteback.ownershipHint')}</p>
            {comments && <div className="settings-field">
              <label className="settings-field-label" htmlFor={`${id}-guidance`}>{t('SourceWriteback.guidance')}</label>
              <textarea id={`${id}-guidance`} className="input settings-textarea" rows={2} maxLength={1000} value={draft.rules.guidance} placeholder={t('SourceWriteback.guidancePlaceholder')}
                onChange={(event) => { const guidance = event.target.value; setDraft((known) => ({ ...known, rules: { ...known.rules, guidance } })) }} />
              <p className="settings-field-hint">{t('SourceWriteback.guidanceHint')}</p>
            </div>}
          </div>
        </details>
      </fieldset>
      <div className="settings-form-footer"><button type="button" className="button" disabled={busy || !dirty} onClick={() => void save()}>{busy ? t('SourceWriteback.saving') : t('SourceWriteback.save')}</button></div>
    </>}
  </section>
}

// Stages whose saved name is none of the presets, so they open on the text box.
function typed(rules: Rules, hints: WritebackRuleHints | undefined): ReadonlySet<WritebackStage> {
  return new Set(WRITEBACK_STAGES.filter((stage) => {
    const hint = hints?.[stage]
    return !!hint && hint.custom && hint.presets.length > 0 && !!rules[stage].status && !hint.presets.some((preset) => preset.value === rules[stage].status)
  }))
}
