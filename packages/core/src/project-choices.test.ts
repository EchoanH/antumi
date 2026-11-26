import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { describeProjects } from './project-choices'
import * as gitWorkspaces from './git-workspaces'

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

  it('publishes a source identity while a copy is still being inspected', async () => {
    const original = gitWorkspaces.gitWorkspaces
    let release = () => {}
    const blocked = new Promise<void>((resolve) => { release = resolve })
    const inspect = vi.spyOn(gitWorkspaces, 'gitWorkspaces').mockImplementation(async (dir) => {
      await blocked
      return original(dir)
    })
    const publish = vi.fn()
    const loading = describeProjects([copy, source], publish)
    try {
      await vi.waitFor(() => expect(publish).toHaveBeenCalledWith({ path: source, source: null, worktree: false, branch: null }))
      expect(publish).toHaveBeenCalledTimes(1)
    } finally {
      release()
      await loading
      inspect.mockRestore()
    }
    expect(publish).toHaveBeenCalledTimes(2)
  })

  it('keeps an unavailable copy’s cached identity without saving a false source', async () => {
    const [known] = await describeProjects([copy])
    rmSync(copy, { recursive: true, force: true })
    const publish = vi.fn()
    expect(await describeProjects([copy], publish, known ? [known] : [])).toEqual([known])
    expect(publish).not.toHaveBeenCalled()
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
