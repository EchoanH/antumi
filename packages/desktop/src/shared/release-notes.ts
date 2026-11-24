import { compareVersions, isVersion } from '@antumi/protocol'

export function releaseNotes(changelog: string, version: string): string {
  const sections = changelog.split(/^## /m).slice(1)
  const section = sections.find((entry) => entry.split(/\s/)[0]?.replace(/^v/, '') === version.replace(/^v/, ''))
  return section?.slice(section.indexOf('\n') + 1).trim() ?? ''
}

export function releaseHighlights(notes: string): string[] {
  return notes.split('\n').filter((line) => /^- /u.test(line)).slice(0, 5).map((line) => line.slice(2))
}

export function shouldAnnounceRelease(previous: string | null, current: string, existingInstallation = false): boolean {
  if (!isVersion(current)) return false
  if (previous === null) return existingInstallation
  return isVersion(previous) && compareVersions(current, previous) > 0
}
