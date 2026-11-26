import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { checkoutKey, checkoutKeys } from './git-repository'

const git = (dir: string, ...args: string[]) => execFileSync('git', ['-C', dir, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim()
const gitTop = (dir: string) => { try { return realpathSync(git(dir, 'rev-parse', '--show-toplevel')) } catch { return null } }

describe('checkoutKey', () => {
  let root: string
  beforeEach(() => { root = realpathSync(mkdtempSync(path.join(os.tmpdir(), 'antumi-checkout-key-'))) })
  afterEach(() => { rmSync(root, { recursive: true, force: true }) })

  it('finds the checkout git would, without git where the layout is plain', async () => {
    const repo = path.join(root, 'repo')
    git(root, 'init', '-q', '-b', 'main', repo)
    git(repo, '-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-q', '--allow-empty', '-m', 'initial')
    const worktree = path.join(root, 'linked worktree')
    git(repo, 'worktree', 'add', '-q', '-b', 'topic', worktree)
    const bare = path.join(root, 'origin.git')
    git(root, 'init', '-q', '--bare', bare)
    const broken = path.join(root, 'broken')
    mkdirSync(broken); writeFileSync(path.join(broken, '.git'), 'gitdir: ./nowhere\n')
    const plain = path.join(root, 'plain')
    for (const dir of [path.join(repo, 'nested', 'deep'), path.join(worktree, 'nested'), plain]) mkdirSync(dir, { recursive: true })
    symlinkSync(path.join(repo, 'nested'), path.join(root, 'link'), process.platform === 'win32' ? 'junction' : 'dir')
    const dirs = [repo, path.join(repo, 'nested', 'deep'), path.join(repo, '.git'), path.join(repo, '.git', 'refs'), worktree, path.join(worktree, 'nested'), bare, broken, plain, root, path.join(root, 'link')]
    for (const dir of dirs) expect(await checkoutKey(dir), dir).toBe(gitTop(dir))
    expect(await checkoutKey(path.join(root, 'missing'))).toBeNull()
    expect(await checkoutKeys([repo, path.join(repo, 'nested'), worktree, repo])).toEqual(new Map([[repo, repo], [path.join(repo, 'nested'), repo], [worktree, worktree]]))
  })
})
