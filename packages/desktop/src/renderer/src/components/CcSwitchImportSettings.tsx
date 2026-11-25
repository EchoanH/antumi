import { SupportActions } from './ContactAuthor'
import { useState } from 'react'
import { AgentKind, type ProviderImportPreview, type ProviderImportResult } from '@antumi/protocol'
import { perform } from '../core-store'
import { t } from '../i18n'
import { agentLabel } from '../labels'
import { ArrowLeftIcon } from './icons'

function appLabel(app: string): string {
  const kind = AgentKind.safeParse(app)
  return kind.success ? agentLabel(kind.data) : app
}

export function CcSwitchImportSettings({ onDone }: { onDone: () => void }) {
  const [directory, setDirectory] = useState('')
  const [preview, setPreview] = useState<ProviderImportPreview | null>(null)
  const [selected, setSelected] = useState<Set<string>>(new Set())
  const [result, setResult] = useState<ProviderImportResult | null>(null)
  const [busy, setBusy] = useState<'reading' | 'importing' | null>(null)
  const [failed, setFailed] = useState(false)

  async function scan() {
    setBusy('reading'); setFailed(false); setResult(null); setPreview(null); setSelected(new Set())
    try {
      const found = await perform((rpc) => rpc.call('modelProviders.previewCcSwitch', { ...(directory.trim() ? { directory: directory.trim() } : {}) }))
      if (!found) { setFailed(true); return }
      setPreview(found)
      setSelected(new Set(found.candidates.filter((entry) => !entry.issue).map((entry) => entry.id)))
    } finally { setBusy(null) }
  }

  async function importSelected() {
    if (!preview || !selected.size) return
    setBusy('importing'); setFailed(false)
    try {
      const imported = await perform((rpc) => rpc.call('modelProviders.importCcSwitch', { token: preview.token, ids: [...selected] }))
      if (imported) setResult(imported)
      else setFailed(true)
    } finally { setBusy(null) }
  }

  return <div className="provider-settings">
    <div className="settings-section-toolbar">
      <button type="button" className="button ghost" disabled={busy !== null} onClick={onDone}><ArrowLeftIcon />{t('CcSwitchImport.back')}</button>
      <h3>{t('CcSwitchImport.title')}</h3>
    </div>
    <p className="settings-note">{t('CcSwitchImport.hint')}</p>
    <form onSubmit={(event) => { event.preventDefault(); void scan() }}>
      <label className="settings-field">{t('CcSwitchImport.directory')}<input className="input" value={directory} placeholder="~/.cc-switch" disabled={busy !== null} onChange={(event) => setDirectory(event.target.value)} /></label>
      <p className="settings-note">{t('CcSwitchImport.locationHint')}</p>
      <button type="submit" className="button" disabled={busy !== null}>{t('CcSwitchImport.read')}</button>
    </form>
    {busy && <p className="settings-note" role="status">{t(`CcSwitchImport.${busy}`)}</p>}
    {failed && <p className="settings-note" role="alert">{t('CcSwitchImport.failed')}<SupportActions error={t('CcSwitchImport.failed')} /></p>}
    {preview && <>
      <p className="settings-note mono">{preview.directory}</p>
      {preview.candidates.length === 0 && <p className="settings-note">{t('CcSwitchImport.empty')}</p>}
      {!result && preview.candidates.map((entry) => <label key={entry.id} className="settings-row">
        <div className="settings-row-text">
          <span className="settings-row-label">{entry.name} · {appLabel(entry.app)}</span>
          {entry.endpoint && <p className="settings-row-description mono">{entry.endpoint}</p>}
          <p className="settings-row-description">{entry.issue ? t(`CcSwitchImport.issue.${entry.issue}`) : entry.models.length ? entry.models.join(' · ') : t('CcSwitchImport.fetchModels')}</p>
        </div>
        <input type="checkbox" aria-label={entry.name} disabled={busy !== null || Boolean(entry.issue)} checked={selected.has(entry.id)} onChange={(event) => {
          const checked = event.target.checked
          setSelected((earlier) => { const next = new Set(earlier); if (checked) next.add(entry.id); else next.delete(entry.id); return next })
        }} />
      </label>)}
      {!result && preview.candidates.length > 0 && <div className="settings-section-toolbar">
        <p>{t('CcSwitchImport.selected', { count: selected.size })}</p>
        <button type="button" className="button primary" disabled={busy !== null || !selected.size} onClick={() => void importSelected()}>{t('CcSwitchImport.import')}</button>
      </div>}
    </>}
    {result && <>
      <p role="status">{t('CcSwitchImport.summary', { imported: result.items.filter((entry) => entry.status === 'imported').length, skipped: result.items.filter((entry) => entry.status === 'skipped').length, failed: result.items.filter((entry) => entry.status === 'failed').length })}</p>
      {result.items.map((entry) => <div key={entry.id} className="settings-row"><div className="settings-row-text"><span className="settings-row-label">{entry.name}</span><p className="settings-row-description">{entry.issue ? t(`CcSwitchImport.issue.${entry.issue}`) : t('CcSwitchImport.imported')}</p></div></div>)}
      <button type="button" className="button" onClick={onDone}>{t('CcSwitchImport.back')}</button>
    </>}
  </div>
}
