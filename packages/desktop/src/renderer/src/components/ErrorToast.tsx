import { useEffect, useState } from 'react'
import { dismissError } from '../core-store'
import { WarningIcon } from './icons'
import { SupportActions } from './ContactAuthor'

export const ERROR_TOAST_DURATION_MS = 5_000

export function scheduleErrorToastDismiss(dismiss: () => void): () => void {
  const timer = setTimeout(dismiss, ERROR_TOAST_DURATION_MS)
  return () => clearTimeout(timer)
}

export function ErrorToast({ message }: { message: string }) {
  const [paused, setPaused] = useState(false)
  useEffect(() => paused ? undefined : scheduleErrorToastDismiss(dismissError), [message, paused])

  return (
    <div className="toast error-toast" role="alert" aria-atomic="true"
      onMouseEnter={() => setPaused(true)} onMouseLeave={() => setPaused(false)}
      onFocusCapture={() => setPaused(true)} onBlurCapture={(event) => { if (!event.currentTarget.contains(event.relatedTarget)) setPaused(false) }}>
      <span className="toast-icon" aria-hidden="true"><WarningIcon /></span>
      <span className="toast-message">{message}</span>
      <SupportActions error={message} />
    </div>
  )
}
