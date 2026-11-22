import { projectColorKey } from './project-colors'
import { MAX_PROJECT_NAME, setPreference, usePreferences } from './preferences'

export function projectFolderName(projectPath: string): string {
  return projectPath.split(/[\\/]/).filter(Boolean).at(-1) ?? projectPath
}

// Read outside React too: App re-renders when a name changes, as it does for the language.
export function projectName(projectPath: string): string {
  return usePreferences.getState().projectNames[projectColorKey(projectPath)] ?? projectFolderName(projectPath)
}

// Only this window's label: the folder, its worktrees and what agents see keep the folder's name.
// Its own folder name, or nothing, puts that back.
export function renameProject(projectPath: string, name: string): void {
  const next = { ...usePreferences.getState().projectNames }
  const key = projectColorKey(projectPath)
  const trimmed = name.trim().slice(0, MAX_PROJECT_NAME)
  if (trimmed === '' || trimmed === projectFolderName(projectPath)) delete next[key]
  else next[key] = trimmed
  setPreference('projectNames', next)
}
