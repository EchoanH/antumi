import { useEffect, useState } from 'react'
import type { ProjectChoice, RpcConnection } from '@antumi/protocol'
import { perform, useCore } from './core-store'

export function plainProject(path: string): ProjectChoice {
  return { path, worktree: false, source: null, branch: null }
}

// Preserve each selected path. Only the suggestions gain their copy's source project.
export function sourceProjects(choices: readonly ProjectChoice[]): ProjectChoice[] {
  const sources = new Map<string, ProjectChoice>()
  for (const choice of choices) {
    const source = choice.worktree ? choice.source : choice.path
    if (source && !sources.has(source)) sources.set(source, plainProject(source))
  }
  return [...sources.values()]
}

export function availableProjects(choices: readonly ProjectChoice[], selected: readonly string[]): {
  sources: ProjectChoice[]
  copies: ProjectChoice[]
} {
  return {
    sources: sourceProjects(choices).filter((choice) => !selected.includes(choice.path)),
    copies: choices.filter((choice) => choice.worktree && !selected.includes(choice.path))
  }
}

export async function recentProjectChoices(rpc: RpcConnection): Promise<ProjectChoice[]> {
  const recent = await rpc.call('projects.recent', {})
  return rpc.features.includes('project-choices')
    ? rpc.call('projects.describe', { paths: recent })
    : recent.map(plainProject)
}

export function useProjectDescriptions(paths: readonly string[]): readonly ProjectChoice[] {
  const rpc = useCore((s) => s.rpc)
  const key = JSON.stringify(paths)
  const [choices, setChoices] = useState<readonly ProjectChoice[]>([])
  useEffect(() => {
    let active = true
    const paths: string[] = JSON.parse(key)
    setChoices([])
    if (paths.length && rpc?.features.includes('project-choices')) {
      void perform(() => rpc.call('projects.describe', { paths })).then((found) => {
        if (active && found) setChoices(found)
      })
    }
    return () => { active = false }
  }, [key, rpc])
  return paths.map((path) => choices.find((choice) => choice.path === path) ?? plainProject(path))
}
