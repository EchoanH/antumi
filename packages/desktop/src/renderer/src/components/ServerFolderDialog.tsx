import { useEffect, useRef, useState } from 'react'
import type { DirectoryEntry } from '@antumi/protocol'
import { useOccludesBrowser } from '../browser-occlusion'
import { useCore } from '../core-store'
import { t } from '../i18n'
import { choosable, parentFolder, pathSteps, useServerFolderDialog } from '../server-folder-dialog'
import { ArrowUpIcon, DocumentIcon, FolderIcon, PersonIcon } from './icons'

// The server's folders, listed through core (docs/REMOTE.md 路径和文件): what the system's folder
// dialog would be if it could see that machine. Every path is core's.

// Core lists any folder under these: the dialog is for the whole machine, not one project.
const EVERYWHERE = ['/']

type Listing = { path: string; entries: DirectoryEntry[]; truncated: boolean } | { path: string; error: string }

export function ServerFolderDialog() {
  const asking = useServerFolderDialog((state) => state.asking)
  return asking ? <ServerFolderForm key={`${asking.title ?? ''}${asking.start ?? ''}`} /> : null
}

function ServerFolderForm() {
  useOccludesBrowser()
  const dialog = useRef<HTMLDialogElement>(null)
  const submit = useRef<HTMLButtonElement>(null)
  const asking = useServerFolderDialog((state) => state.asking)
  const rpc = useCore((state) => state.rpc)
  const [listing, setListing] = useState<Listing | null>(null)
  const [typed, setTyped] = useState('')
  const [hidden, setHidden] = useState(false)
  const [chosenFile, setChosenFile] = useState<string | null>(null)
  const files = asking?.files
  const asked = useRef(0)

  const open = async (path: string) => {
    if (!rpc) return
    const ask = ++asked.current
    setChosenFile(null)
    try {
      const found = await rpc.call('files.list', { roots: EVERYWHERE, path })
      if (ask === asked.current) setListing({ path, ...found })
    } catch (error) {
      if (ask === asked.current) setListing({ path, error: error instanceof Error ? error.message : String(error) })
    }
    if (ask === asked.current) setTyped(path)
  }

  // Where it begins: the folder asked for if it is there, else the server's home.
  useEffect(() => {
    dialog.current?.showModal()
    void (async () => {
      if (!rpc) return
      const start = asking?.start
      const resolved = start ? await rpc.call('files.resolve', { roots: EVERYWHERE, path: start }).catch(() => null) : null
      const home = resolved?.kind === 'directory' ? null : await rpc.call('files.resolve', { roots: EVERYWHERE, path: '~' }).catch(() => null)
      await open(resolved?.kind === 'directory' ? resolved.path : home?.path ?? '/')
    })()
    return () => dialog.current?.close()
  }, [])

  // The choice takes focus once the first folder is shown: a disabled button takes none.
  const focused = useRef(false)
  useEffect(() => {
    if (!listing || focused.current) return
    focused.current = true
    submit.current?.focus()
  }, [listing])

  if (!asking) return null
  const { answer } = asking
  const path = listing?.path ?? ''
  const up = path ? parentFolder(path) : null
  const entries = listing && 'entries' in listing
    ? listing.entries.filter((entry) => (hidden || !entry.name.startsWith('.')) && (entry.kind === 'directory' || choosable(entry.name, files)))
    : []
  const picking = files?.length ? chosenFile : path || null

  return <dialog ref={dialog} className="modal server-folder-dialog" aria-labelledby="server-folder-title" onCancel={(event) => { event.preventDefault(); answer(null) }}>
    <form className="server-folder-body" onSubmit={(event) => { event.preventDefault(); if (picking) answer(picking) }}>
      <h2 id="server-folder-title">{asking.title ?? (files?.length ? t('ServerFolder.titleFile') : t('ServerFolder.title'))}</h2>
      <div className="server-folder-bar">
        <button type="button" className="icon-button" title={t('ServerFolder.up')} aria-label={t('ServerFolder.up')} disabled={!up} onClick={() => { if (up) void open(up) }}><ArrowUpIcon /></button>
        <button type="button" className="icon-button" title={t('ServerFolder.home')} aria-label={t('ServerFolder.home')} onClick={() => { void rpc?.call('files.resolve', { roots: EVERYWHERE, path: '~' }).then((home) => { if (home) void open(home.path) }).catch(() => {}) }}><PersonIcon /></button>
        <input
          className="input mono"
          aria-label={t('ServerFolder.path')}
          spellCheck={false}
          value={typed}
          onChange={(event) => setTyped(event.target.value)}
          onKeyDown={(event) => {
            if (event.key !== 'Enter') return
            event.preventDefault()
            if (typed.startsWith('/')) void open(typed)
          }}
        />
      </div>
      <nav className="server-folder-steps" aria-label={t('ServerFolder.path')}>
        {pathSteps(path).map(([name, at]) => <button key={at} type="button" onClick={() => void open(at)}>{name}</button>)}
      </nav>
      <ul className="server-folder-list" role="listbox" aria-label={path}>
        {listing === null && <li className="server-folder-note">{t('ServerFolder.loading')}</li>}
        {listing && 'error' in listing && <li className="server-folder-note" data-error>{t('ServerFolder.unreadable', { detail: listing.error })}</li>}
        {listing && 'entries' in listing && entries.length === 0 && <li className="server-folder-note">{t('ServerFolder.empty')}</li>}
        {entries.map((entry) => (
          <li key={entry.path} role="option" aria-selected={entry.path === chosenFile}>
            <button
              type="button"
              onClick={() => (entry.kind === 'directory' ? void open(entry.path) : setChosenFile(entry.path))}
              onDoubleClick={() => { if (entry.kind !== 'directory') answer(entry.path) }}
            >
              {entry.kind === 'directory' ? <FolderIcon /> : <DocumentIcon />}
              <span>{entry.name}</span>
            </button>
          </li>
        ))}
        {listing && 'truncated' in listing && listing.truncated && <li className="server-folder-note">{t('ServerFolder.truncated')}</li>}
      </ul>
      <footer className="server-folder-footer">
        <label className="server-folder-hidden"><input type="checkbox" checked={hidden} onChange={(event) => setHidden(event.target.checked)} />{t('ServerFolder.hidden')}</label>
        <button type="button" className="button" onClick={() => answer(null)}>{t('ChatCommandSettings.cancel')}</button>
        <button ref={submit} type="submit" className="button primary" disabled={!picking || (listing !== null && 'error' in listing && !files?.length)}>{files?.length ? t('ServerFolder.chooseFile') : t('ServerFolder.choose')}</button>
      </footer>
    </form>
  </dialog>
}
