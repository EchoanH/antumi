import { useEffect, useId, useMemo, useRef, useState } from 'react'
import { useOccludesBrowser } from '../browser-occlusion'
import { closeContactAuthor, contactAuthor, useContactAuthor } from '../contact-author'
import { appVersion } from '../desktop-bridge'
import { getLocale, t, useLocale } from '../i18n'
import { githubIssueUrl, supportReport } from '../support-report'
import wechatContact from '../assets/wechat-contact.jpg'
import { CloseIcon } from './icons'

export function SupportActions({ error = '' }: { error?: string }) {
  const version = useContactAuthor((state) => state.version)
  const locale = useLocale((state) => state.locale)
  const platform = typeof window !== 'undefined' ? window.antumi?.platform ?? navigator.platform : 'unknown'
  const issueUrl = useMemo(() => githubIssueUrl(supportReport(error, version, platform, locale), error, locale), [error, version, platform, locale])
  return <span className="support-actions">
    <button type="button" className="link-button" onClick={() => contactAuthor(error)}>{t('ContactAuthor.title')}</button>
    <a className="link-button" href={issueUrl} target="_blank" rel="noopener noreferrer" aria-label={t('ContactAuthor.createIssue')}>GitHub Issue</a>
  </span>
}

// Mounted once per window, outside transient errors and other dialogs.
export function ContactAuthorDialog() {
  useLocale((state) => state.locale)
  const request = useContactAuthor((state) => state.request)
  useEffect(() => {
    let active = true
    void appVersion().then((version) => { if (active) useContactAuthor.setState({ version }) })
    return () => { active = false }
  }, [])
  return request ? <ContactForm key={request.error} error={request.error} /> : null
}

function ContactForm({ error }: { error: string }) {
  useOccludesBrowser()
  const dialog = useRef<HTMLDialogElement>(null)
  const titleId = useId()
  const descriptionId = useId()
  const version = useContactAuthor((state) => state.version)
  const [copying, setCopying] = useState(false)
  const [copied, setCopied] = useState<'idle' | 'done' | 'failed'>('idle')
  const report = supportReport(error, version, window.antumi?.platform ?? navigator.platform, getLocale())
  useEffect(() => {
    const element = dialog.current
    const previousFocus = document.activeElement
    element?.showModal()
    return () => {
      element?.close()
      if (previousFocus instanceof HTMLElement && previousFocus.isConnected) previousFocus.focus()
    }
  }, [])
  const copy = async () => {
    setCopying(true)
    try { await navigator.clipboard.writeText(report); setCopied('done') }
    catch { setCopied('failed') }
    finally { setCopying(false) }
  }
  return <dialog ref={dialog} className="modal contact-author-dialog" aria-labelledby={titleId} aria-describedby={descriptionId}
    onCancel={(event) => { event.preventDefault(); closeContactAuthor() }}
    onClick={(event) => { if (event.target === event.currentTarget) closeContactAuthor() }}>
    <div className="modal-body">
      <header className="modal-header">
        <h2 id={titleId}>{t('ContactAuthor.title')}</h2>
        <button type="button" className="icon-button modal-close" aria-label={t('BackdropPicker.close')} onClick={closeContactAuthor}><CloseIcon /></button>
      </header>
      <p id={descriptionId} className="muted">{t('ContactAuthor.description')}</p>
      <img className="contact-author-qr" src={wechatContact} alt={t('SupportSettings.wechatQr')} width={240} height={240} />
      <details className="contact-author-report">
        <summary>{t('ContactAuthor.preview')}</summary>
        <p className="muted">{t('ContactAuthor.reportHint')}</p>
        <textarea className="input" readOnly aria-label={t('ContactAuthor.preview')} value={report} rows={6} />
      </details>
      <div className="contact-author-actions">
        <span role="status" className="muted">{copied === 'done' ? t('ContactAuthor.copied') : copied === 'failed' ? t('ContactAuthor.copyFailed') : ''}</span>
        <button type="button" className="button" disabled={copying} onClick={() => void copy()}>{t('ContactAuthor.copy')}</button>
      </div>
    </div>
  </dialog>
}
