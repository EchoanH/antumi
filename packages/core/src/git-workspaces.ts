import { access } from 'node:fs/promises'
import path from 'node:path'
import { gte } from 'semver'
import type { GitWorkspace } from '@antumi/protocol'
import { git } from './git-changes'
import { execFileAsync } from './hidden-exec'

const WORKTREE_NUL_VERSION = '2.36.0'

// Git before 2.36 only has line records; keep NUL records where paths can contain newlines.
export async function gitWorktreeFields(directory: string): Promise<string[]> {
  const output = await git(directory, ['--version'])
  const version = /^git version (\d+\.\d+\.\d+)/.exec(output)?.[1]
  if (!version) throw new Error(`Unrecognized Git version: ${output.trim()}`)
  const nul = gte(version, WORKTREE_NUL_VERSION)
  const listing = await git(directory, ['worktree', 'list', '--porcelain', ...(nul ? ['-z'] : [])])
  return listing.split(nul ? '\0' : '\n')
}

// Git for Windows prints forward slashes; use the same path representation as the filesystem.
export function worktreeFieldPath(field: string): string | null {
  return field.startsWith('worktree ') && field.length > 9 ? path.normalize(field.slice(9)) : null
}

export async function removeGitWorktree(checkout: string): Promise<void> {
  const output = await git(checkout, ['rev-parse', '--git-common-dir'])
  const common = path.resolve(checkout, output.replace(/\r?\n$/, ''))
  // Git cannot remove its own working directory on Windows. The shared Git directory is outside
  // any linked worktree and still knows it; do not override Git's checks with --force.
  await execFileAsync('git', ['-C', common, '--git-dir=.', 'worktree', 'remove', path.resolve(checkout)])
}

export async function gitWorkspaces(directory: string): Promise<GitWorkspace[]> {
  const fields = await gitWorktreeFields(directory)
  const entries: GitWorkspace[] = []
  let current: GitWorkspace | undefined
  for (const field of fields) {
    const worktree = worktreeFieldPath(field)
    if (worktree !== null) {
      current = { path: worktree, branch: null, detached: false, locked: false, missing: false, conversationIds: [], planning: worktree.split(path.sep).includes('.planning') }
      entries.push(current)
    } else if (current) {
      if (field.startsWith('branch ')) current.branch = field.slice(7).replace(/^refs\/heads\//, '')
      if (field === 'detached') current.detached = true
      if (field === 'locked' || field.startsWith('locked ')) current.locked = true
    }
  }
  await Promise.all(entries.map(async (entry) => { entry.missing = !await access(entry.path).then(() => true, () => false) }))
  return entries
}
