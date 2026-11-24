import { useEffect, useId, useState } from 'react'
import { MAX_WRITEBACK_COMMENT, type SourceTransitions, type SourceUpdateTarget, type SourceWrite } from '@antumi/protocol'
import { perform, useCore } from '../core-store'
import { t } from '../i18n'
import { dayAndTime } from '../labels'

const key = (target: SourceUpdateTarget) => `${target.kind}:${target.id}`

export function useSourceWriteback(target: SourceUpdateTarget | null) {
  const supported = useCore((state) => state.rpc?.features.includes('source-writeback') ?? false)
  const view = useCore((state) => (target ? state.sourceWriteback[key(target)] : undefined))
  const scope = target ? key(target) : null
  useEffect(() => {
    if (!supported || !target) return
    void perform((rpc) => rpc.call('sources.writeback', { target })).then((loaded) => {
      if (loaded) useCore.setState((state) => ({ sourceWriteback: { ...state.sourceWriteback, [key(loaded.target)]: loaded } }))
    })
  }, [supported, scope])
  return supported && view?.supported ? view : null
}

function writeLabel(write: SourceWrite): string {
  const excerpt = write.detail.replace(/\s+/g, ' ').trim()
  const what = write.kind === 'status'
    ? t('SourceWriteback.statusTo', { status: write.result ?? write.detail })
    : excerpt ? t('SourceWriteback.commentedText', { text: excerpt.length > 24 ? `${excerpt.slice(0, 24)}…` : excerpt }) : t('SourceWriteback.commented')
  return `${t(`SourceWriteback.trigger.${write.trigger}`)} · ${what}`
}

// Writing back to the issue a task or an investigation came from: moving its status, posting a
// comment (by default the summary its agent drafted), and what has been written so far.
export function SourceWritebackPanel({ target }: { target: SourceUpdateTarget }) {
  const view = useSourceWriteback(target)
  const source = useCore((state) => (target.kind === 'task' ? state.tasks[target.id]?.source : state.conversations[target.id]?.source))
  const ids = useId()
  const [transitions, setTransitions] = useState<SourceTransitions | null>(null)
  const [choice, setChoice] = useState('')
  const [draft, setDraft] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const [showReport, setShowReport] = useState(false)
  useEffect(() => { setTransitions(null); setDraft(null); setChoice('') }, [target.kind, target.id])
  if (!view || !source) return null
  const act = async (run: () => Promise<unknown>) => { setBusy(true); try { await run() } finally { setBusy(false) } }
  const loadStatuses = () => act(async () => {
    const loaded = await perform((rpc) => rpc.call('sources.writebackTransitions', { target }))
    if (loaded) { setTransitions(loaded); setChoice(loaded.options[0]?.id ?? '') }
  })
  const move = () => act(async () => {
    const write = await perform((rpc) => rpc.call('sources.writebackTransition', { target, id: choice }))
    if (write) setTransitions(null)
  })
  const post = () => act(async () => {
    const text = draft?.trim()
    if (!text) return
    const write = await perform((rpc) => rpc.call('sources.writebackComment', { target, markdown: text }))
    if (write && write.state !== 'failed') setDraft(null)
  })
  const retry = (id: string) => act(() => perform((rpc) => rpc.call('sources.writebackRetry', { id })))
  const report = view.report

  return <section className="source-writeback" aria-label={t('SourceWriteback.title', { source: source.name })}>
    <header className="source-writeback-header">
      <span className="settings-field-label">{t('SourceWriteback.title', { source: source.name })}</span>
      {transitions && <span className="source-writeback-status">{t('SourceWriteback.current', { status: transitions.status })}</span>}
    </header>
    <div className="source-writeback-actions">
      {transitions
        ? transitions.options.length === 0
          ? <span className="muted">{t('SourceWriteback.noMoves')}</span>
          : <>
            <label className="visually-hidden" htmlFor={`${ids}-status`}>{t('SourceWriteback.changeStatus')}</label>
            <select id={`${ids}-status`} className="input" value={choice} disabled={busy} onChange={(event) => setChoice(event.target.value)}>
              {transitions.options.map((option) => <option key={option.id} value={option.id}>{option.action && option.action !== option.name ? `${option.name}（${option.action}）` : option.name}</option>)}
            </select>
            <button type="button" className="button" disabled={busy || !choice} onClick={() => void move()}>{t('SourceWriteback.apply')}</button>
            <button type="button" className="button ghost" disabled={busy} onClick={() => setTransitions(null)}>{t('SourceWriteback.cancel')}</button>
          </>
        : <button type="button" className="button ghost" disabled={busy} aria-busy={busy || undefined} onClick={() => void loadStatuses()}>{t('SourceWriteback.changeStatus')}</button>}
      {draft === null && view.comments && <button type="button" className="button ghost" disabled={busy} onClick={() => setDraft(report?.text ?? '')}>{t('SourceWriteback.writeComment')}</button>}
    </div>
    {draft !== null && <div className="source-writeback-composer">
      <label className="settings-field-label" htmlFor={`${ids}-comment`}>{t('SourceWriteback.comment')}</label>
      <textarea id={`${ids}-comment`} className="input settings-textarea" rows={5} maxLength={MAX_WRITEBACK_COMMENT} value={draft} disabled={busy} onChange={(event) => setDraft(event.target.value)} />
      <p className="settings-field-hint">{t('SourceWriteback.publicHint', { source: source.name })}</p>
      <div className="source-writeback-actions">
        <button type="button" className="button primary" disabled={busy || !draft.trim()} onClick={() => void post()}>{t('SourceWriteback.post')}</button>
        <button type="button" className="button ghost" disabled={busy} onClick={() => setDraft(null)}>{t('SourceWriteback.cancel')}</button>
      </div>
    </div>}
    {report && <div className="source-writeback-report">
      <button type="button" className="link-button" aria-expanded={showReport} onClick={() => setShowReport(!showReport)}>{t('SourceWriteback.report', { time: dayAndTime(report.updatedAt) })}</button>
      {showReport && <p className="source-writeback-report-text">{report.text}</p>}
    </div>}
    {view.writes.length > 0 && <ul className="source-writeback-log">
      {view.writes.slice(0, 10).map((write) => <li key={write.id} data-state={write.state}>
        <span>{writeLabel(write)}</span>
        <span className="muted">{t(`SourceWriteback.state.${write.state}`)} · {dayAndTime(write.createdAt)}</span>
        {write.reason && <span className="muted">{write.reason}</span>}
        {write.url && <a className="link-button" href={write.url} target="_blank" rel="noreferrer">{t('SourceWriteback.open')}</a>}
        {(write.state === 'failed' || write.state === 'uncertain') && <button type="button" className="link-button" disabled={busy} onClick={() => void retry(write.id)}>{t('SourceWriteback.retry')}</button>}
      </li>)}
    </ul>}
  </section>
}
