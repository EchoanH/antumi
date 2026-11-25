import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { describeProjects } from './project-choices'

const git = (dir: string, ...args: string[]) => execFileSync('git', ['-C', dir, ...args], { stdio: 'pipe' })

describe('project choices', () => {
  let root: string
  let source: string
  let copy: string
  beforeEach(() => {
    root = realpathSync(mkdtempSync(path.join(os.tmpdir(), 'antumi-project-choices-')))
    source = path.join(root, 'source', 'magi')
    copy = path.join(root, 'worktrees', 'magi')
    mkdirSync(source, { recursive: true })
    git(source, 'init', '-q', '-b', 'main')
    git(source, 'config', 'user.name', 'Test')
    git(source, 'config', 'user.email', 'test@example.com')
    mkdirSync(path.join(source, 'src'))
    writeFileSync(path.join(source, 'src', 'app.ts'), 'export {}\n')
    git(source, 'add', '.')
    git(source, 'commit', '-qm', 'initial')
    git(source, 'worktree', 'add', '-qb', 'feature/picker', copy)
  })
  afterEach(() => rmSync(root, { recursive: true, force: true }))

  it('identifies a copy through Git, including a branch change, without changing requested paths', async () => {
    expect(await describeProjects([copy, source, copy])).toEqual([
      { path: copy, source, worktree: true, branch: 'feature/picker' },
      { path: source, source: null, worktree: false, branch: null }
    ])
    git(copy, 'switch', '-qc', 'new-branch')
    expect(await describeProjects([copy])).toEqual([{ path: copy, source, worktree: true, branch: 'new-branch' }])
  })

  it('preserves a selected subdirectory instead of expanding access to the repository root', async () => {
    expect(await describeProjects([path.join(copy, 'src')])).toEqual([
      { path: path.join(copy, 'src'), source: path.join(source, 'src'), worktree: true, branch: 'feature/picker' }
    ])
  })

  it('recognizes detached copies and keeps copies whose main folder has disappeared', async () => {
    git(copy, 'checkout', '-q', '--detach')
    expect((await describeProjects([copy]))[0]).toMatchObject({ worktree: true, branch: null, source })
    rmSync(path.join(source, 'src'), { recursive: true })
    expect((await describeProjects([path.join(copy, 'src')]))[0]).toMatchObject({ worktree: true, source: null })
  })

  it('does not mistake an ordinary folder, unavailable folder, or separate git directory for a copy', async () => {
    const ordinary = path.join(root, 'ordinary', 'magi')
    const missing = path.join(root, 'missing')
    mkdirSync(ordinary, { recursive: true })
    const separate = path.join(root, 'separate')
    mkdirSync(separate)
    git(separate, 'init', '-q', '--separate-git-dir', path.join(root, 'git-data'))
    expect(await describeProjects([ordinary, missing, separate])).toEqual(
      [ordinary, missing, separate].map((entry) => ({ path: entry, source: null, branch: null, worktree: false }))
    )
  })

  it.skipIf(process.platform === 'win32')('keeps a symbolic link as the selected path while resolving its source', async () => {
    const link = path.join(root, 'linked-copy')
    symlinkSync(copy, link)
    expect(await describeProjects([link])).toEqual([{ path: link, source, worktree: true, branch: 'feature/picker' }])
  })
})
