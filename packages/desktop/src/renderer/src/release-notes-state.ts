import { create } from 'zustand'
import changelog from '../../../../../CHANGELOG.md?raw'
import app from '../../../../../package.json'
import { releaseNotes } from '../../shared/release-notes'
import { appVersion } from './desktop-bridge'

export const useReleaseNotes = create<{ open: boolean; ready: boolean; release: { version: string; notes: string } }>(() => ({
  open: false, ready: false, release: { version: app.version, notes: releaseNotes(changelog, app.version) }
}))

export async function loadCurrentRelease(): Promise<void> {
  const version = await appVersion() ?? app.version
  useReleaseNotes.setState({ ready: true, release: { version, notes: releaseNotes(changelog, version) } })
}

export function openReleaseNotes(): void {
  useReleaseNotes.setState({ open: true })
}
