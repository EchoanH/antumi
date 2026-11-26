import { realpath, stat } from 'node:fs/promises'
import path from 'node:path'
import type { ProjectChoice } from '@antumi/protocol'
import { checkoutKey } from './git-repository'
import { gitWorkspaces } from './git-workspaces'

const plainProject = (projectPath: string): ProjectChoice => ({ path: projectPath, worktree: false, source: null, branch: null })

// Save each identity as it is known: a slow copy must not hold back the source cache.
export async function describeProjects(paths: readonly string[], onChoice?: (choice: ProjectChoice) => void, previous: readonly ProjectChoice[] = []): Promise<ProjectChoice[]> {
  const known = new Map(previous.map((choice) => [choice.path, choice]))
  return Promise.all([...new Set(paths)].map(async (projectPath) => {
    let choice: ProjectChoice
    try { choice = await describeProject(projectPath) }
    catch { return known.get(projectPath) ?? plainProject(projectPath) }
    onChoice?.(choice)
    return choice
  }))
}

async function describeProject(projectPath: string): Promise<ProjectChoice> {
  // An unavailable folder must not turn a cached copy into a permanent source suggestion.
  await stat(projectPath)
  const root = await checkoutKey(projectPath)
  if (!root || !(await stat(path.join(root, '.git'))).isFile()) return plainProject(projectPath)
  const workspaces = await gitWorkspaces(root)
  const current = workspaces.find((entry) => path.normalize(entry.path) === root)
  const main = workspaces[0]
  // Submodules also have a .git file, but are their own main working tree.
  if (!current || !main || current === main) return plainProject(projectPath)
  const relative = path.relative(root, await realpath(projectPath))
  const source = path.join(main.path, relative)
  const readable = !main.missing && await stat(path.join(main.path, '.git')).then((entry) => entry.isDirectory() || entry.isFile(), () => false)
    && await stat(source).then((entry) => entry.isDirectory(), () => false)
  return { path: projectPath, worktree: true, source: readable ? source : null, branch: current.branch }
}
