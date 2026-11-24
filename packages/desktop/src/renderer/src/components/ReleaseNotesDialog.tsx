import { useEffect, useId, useRef, useState } from 'react'
import { PROJECT_GITHUB_URL } from '@antumi/protocol'
import { releaseHighlights, shouldAnnounceRelease } from '../../../shared/release-notes'
import { useOccludesBrowser } from '../browser-occlusion'
import { useCore } from '../core-store'
import { t } from '../i18n'
import { setPreference, usePreferences } from '../preferences'
import { loadCurrentRelease, openReleaseNotes, useReleaseNotes } from '../release-notes-state'
import { ChatMarkdown } from './ChatMarkdown'
import { CloseIcon } from './icons'

export function ReleaseNotesDialog() {
  const open = useReleaseNotes((s) => s.open)
  const ready = useReleaseNotes((s) => s.ready)
  const currentRelease = useReleaseNotes((s) => s.release)
  // Older installations have no version marker yet; don't mistake a fresh setup for an upgrade.
  const existingInstallation = useRef(usePreferences.getState().guideSeen)
  useEffect(() => { void loadCurrentRelease() }, [])
  useEffect(() => {
    if (!ready || import.meta.env.DEV || !window.antumi) return
    const previous = usePreferences.getState().releaseNotesVersion
    const announce = shouldAnnounceRelease(previous, currentRelease.version, existingInstallation.current)
    if ((previous === null && !announce) || (announce && !currentRelease.notes)) {
      setPreference('releaseNotesVersion', currentRelease.version)
      return
    }
    if (!announce) return
    let lastInput = Date.now()
    const input = () => { lastInput = Date.now() }
    const timer = setInterval(() => {
      if (!shouldAnnounceRelease(usePreferences.getState().releaseNotesVersion, currentRelease.version, existingInstallation.current)) { clearInterval(timer); return }
      const state = useCore.getState()
      const setup = usePreferences.getState().setup.status
      const hasRequest = Object.values(state.conversations).some((conversation) => conversation.chat?.request)
      const focused = document.activeElement
      const hasDraft = focused instanceof HTMLInputElement || focused instanceof HTMLTextAreaElement ? focused.value.trim().length > 0 : focused instanceof HTMLElement && focused.isContentEditable && Boolean(focused.textContent?.trim())
      const occupied = hasDraft || document.querySelector('dialog[open], [popover]:popover-open') || focused?.closest('.xterm')
      if (state.connection !== 'connected' || !state.environment || setup === 'new' || setup === 'active' || hasRequest || occupied || !document.hasFocus() || Date.now() - lastInput < 3000) return
      clearInterval(timer)
      openReleaseNotes()
    }, 1000)
    document.addEventListener('input', input)
    document.addEventListener('keydown', input)
    return () => {
      clearInterval(timer)
      document.removeEventListener('input', input)
      document.removeEventListener('keydown', input)
    }
  }, [ready, currentRelease])
  return open ? <ReleaseDialog /> : null
}

function ReleaseDialog() {
  useOccludesBrowser()
  const currentRelease = useReleaseNotes((s) => s.release)
  const dialog = useRef<HTMLDialogElement>(null)
  const titleId = useId()
  const [full, setFull] = useState(false)
  const highlights = releaseHighlights(currentRelease.notes)
  const close = () => {
    const previous = usePreferences.getState().releaseNotesVersion
    if (previous === null || shouldAnnounceRelease(previous, currentRelease.version)) setPreference('releaseNotesVersion', currentRelease.version)
    useReleaseNotes.setState({ open: false })
  }
  useEffect(() => {
    const element = dialog.current
    element?.showModal()
    return () => element?.close()
  }, [])
  return <dialog ref={dialog} className="modal release-notes-dialog" aria-labelledby={titleId}
    onCancel={(event) => { event.preventDefault(); close() }}
    onClick={(event) => { if (event.target === event.currentTarget) close() }}>
    <div className="modal-body">
      <header className="modal-header">
        <h2 id={titleId}>{t('Updates.updatedTo', { version: currentRelease.version })}</h2>
        <button type="button" className="icon-button modal-close" aria-label={t('BackdropPicker.close')} onClick={close}><CloseIcon /></button>
      </header>
      <div className="release-notes-content">
        {currentRelease.notes ? <ChatMarkdown text={full || highlights.length === 0 ? currentRelease.notes : highlights.map((line) => `- ${line}`).join('\n')} highlight={false} /> : <p className="muted">{t('Updates.noNotes')}</p>}
      </div>
      <div className="update-actions">
        <button type="button" className="button ghost" onClick={() => setFull(!full)}>{full ? t('Updates.highlights') : t('Updates.fullChangelog')}</button>
        <a className="button ghost" href={`${PROJECT_GITHUB_URL}/releases/tag/v${currentRelease.version}`} target="_blank" rel="noreferrer">{t('AppUpdate.releasePage')}</a>
        <button type="button" className="button primary" onClick={close}>{t('Updates.gotIt')}</button>
      </div>
    </div>
  </dialog>
}
