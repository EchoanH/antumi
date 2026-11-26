import { realpath, stat } from 'node:fs/promises'
import path from 'node:path'
import type { ProjectChoice } from '@antumi/protocol'
import { checkoutKey } from './git-repository'
import { gitWorkspaces } from './git-workspaces'

// Inspect only the requested checkouts; listing managed worktrees also scans changes and disk usage.
export async function describeProjects(paths: readonly string[]): Promise<ProjectChoice[]> {
  return Promise.all([...new Set(paths)].map(async (projectPath): Promise<ProjectChoice> => {
    const plain = { path: projectPath, worktree: false, source: null, branch: null }
    try {
      const root = await checkoutKey(projectPath)
      if (!root || !(await stat(path.join(root, '.git'))).isFile()) return plain
      const workspaces = await gitWorkspaces(root)
      const current = workspaces.find((entry) => path.normalize(entry.path) === root)
      const main = workspaces[0]
      // Submodules also have a .git file, but are their own main working tree.
      if (!current || !main || current === main) return plain
      const relative = path.relative(root, await realpath(projectPath))
      const source = path.join(main.path, relative)
      const readable = !main.missing && await stat(path.join(main.path, '.git')).then((entry) => entry.isDirectory() || entry.isFile(), () => false)
        && await stat(source).then((entry) => entry.isDirectory(), () => false)
      return { path: projectPath, worktree: true, source: readable ? source : null, branch: current.branch }
    } catch {
      return plain
    }
  }))
}
