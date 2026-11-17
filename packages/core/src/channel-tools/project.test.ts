import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { CHANNEL_TOOL_NAMES, runChannelTool } from './index'
import { holdsSecret, projectsOf } from './project'

describe('project tools', () => {
  let base: string
  let scope: { roots: string[] }
  const call = (name: string, args: unknown) => runChannelTool(scope, name, args)

  beforeAll(() => {
    base = realpathSync(mkdtempSync(path.join(os.tmpdir(), 'antumi-channel-tools-')))
    const app = path.join(base, 'app')
    const write = (file: string, text: string) => {
      mkdirSync(path.dirname(path.join(app, file)), { recursive: true })
      writeFileSync(path.join(app, file), text)
    }
    write('src/auth.ts', 'export function login() {\n  return fetchToken()\n}\n')
    write('src/deep/util.ts', 'export const NEEDLE = 1\n')
    write('README.md', '# App\nLogin lives in src/auth.ts\n')
    write('.gitignore', 'dist/\nlocal.txt\n')
    write('dist/bundle.js', 'console.log("NEEDLE built")\n')
    write('local.txt', 'ignored NEEDLE\n')
    write('.env', 'API_KEY=NEEDLE-secret\n')
    write('config/secrets.yaml', 'password: NEEDLE\n')
    write('keys/server.pem', '-----BEGIN PRIVATE KEY-----\n')
    write('untracked.md', 'not added yet, NEEDLE\n')
    writeFileSync(path.join(app, 'image.bin'), Buffer.from([1, 2, 0, 3]))
    writeFileSync(path.join(base, 'outside.txt'), 'outside NEEDLE\n')
    symlinkSync(path.join(base, 'outside.txt'), path.join(app, 'escape.txt'))
    symlinkSync(base, path.join(app, 'up'))
    execFileSync('git', ['init', '-q'], { cwd: app })
    execFileSync('git', ['add', 'src', 'README.md', '.gitignore', 'escape.txt', 'up', 'image.bin'], { cwd: app })
    execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-q', '-m', 'init'], { cwd: app })
    mkdirSync(path.join(base, 'plain'))
    writeFileSync(path.join(base, 'plain', 'a.txt'), 'not a repo\n')
    scope = { roots: [app, path.join(base, 'plain')] }
  })
  afterAll(() => rmSync(base, { recursive: true, force: true }))

  it('names the tools an agent is allowed', () => {
    expect(CHANNEL_TOOL_NAMES).toEqual(['project_list', 'project_search', 'project_read', 'task_create'])
  })

  it('lists projects, then a folder a level at a time, without what git ignores or what holds secrets', async () => {
    expect((await call('project_list', {})).text).toBe('app/\nplain/')
    const top = (await call('project_list', { path: 'app' })).text.split('\n')
    expect(top).toEqual(['src/', '.gitignore', 'escape.txt', 'image.bin', 'README.md', 'untracked.md', 'up'])
    expect((await call('project_list', { path: 'app/src' })).text).toBe('deep/\nauth.ts')
  })

  it('reads a file with line numbers, and a range of it', async () => {
    const whole = await call('project_read', { path: 'app/src/auth.ts' })
    expect(whole).toMatchObject({ isError: false, target: 'app/src/auth.ts:1-3' })
    expect(whole.text).toBe('1\texport function login() {\n2\t  return fetchToken()\n3\t}')
    const part = await call('project_read', { path: 'app/src/auth.ts', startLine: 2, endLine: 2 })
    expect(part.text).toBe('2\t  return fetchToken()\n（app/src/auth.ts 共 3 行，这是第 2–2 行）')
  })

  it('reads nothing outside the project, however the path is written', async () => {
    for (const bad of ['app/../outside.txt', '../outside.txt', '/etc/passwd', 'app//src', 'nope/x', 'app/escape.txt', 'app/up/outside.txt', `app/${path.join(base, 'outside.txt')}`]) {
      const result = await call('project_read', { path: bad })
      expect(result.isError, bad).toBe(true)
      expect(result.text, bad).not.toContain('outside NEEDLE')
    }
    expect((await call('project_list', { path: 'app/up' })).isError).toBe(true)
  })

  it('withholds ignored files, secrets and git\'s own folder', async () => {
    for (const withheld of ['app/.env', 'app/config/secrets.yaml', 'app/keys/server.pem', 'app/dist/bundle.js', 'app/local.txt', 'app/.git/config', 'app/.git']) {
      const read = await call('project_read', { path: withheld })
      expect(read.isError, withheld).toBe(true)
      expect(read.text, withheld).not.toMatch(/NEEDLE|PRIVATE KEY|repositoryformatversion/)
    }
    expect((await call('project_list', { path: 'app/.git' })).isError).toBe(true)
  })

  it('refuses a binary file and a folder that is not a git repo', async () => {
    expect((await call('project_read', { path: 'app/image.bin' })).text).toContain('二进制')
    expect((await call('project_read', { path: 'plain/a.txt' })).text).toContain('不是 Git 仓库')
  })

  it('searches tracked and new files, never ignored ones or secrets', async () => {
    const found = await call('project_search', { query: 'needle' })
    expect(found.text.split('\n').sort()).toEqual(['app/src/deep/util.ts:1:export const NEEDLE = 1', 'app/untracked.md:1:not added yet, NEEDLE'])
    expect((await call('project_search', { query: 'login', glob: '*.ts' })).text).toBe('app/src/auth.ts:1:export function login() {')
    expect((await call('project_search', { query: 'log[a-z]+\\(', regex: true, path: 'app/src' })).text).toBe('app/src/auth.ts:1:export function login() {')
    expect((await call('project_search', { query: 'nothing-like-this' })).text).toBe('没有找到')
  })

  it('takes a search term as text, not as an option or a pathspec', async () => {
    expect((await call('project_search', { query: '--open-files-in-pager=touch /tmp/pwned' })).text).toBe('没有找到')
    expect((await call('project_search', { query: 'x', glob: '../*' })).isError).toBe(true)
    expect((await call('project_search', { query: 'x', glob: ':(top)**' })).isError).toBe(true)
  })

  it('answers a wrong call as the tool, without throwing', async () => {
    expect(await call('project_read', {})).toMatchObject({ isError: true })
    expect(await call('shell', { command: 'id' })).toMatchObject({ isError: true, text: '没有工具 shell' })
  })

  it('knows a secret by its name and numbers projects of one name', () => {
    for (const name of ['.env', '.env.local', 'a/b/id_rsa', 'x/Secrets.json', 'deploy/server.KEY', '.ssh/config', 'a/.git/HEAD', 'credentials']) expect(holdsSecret(name), name).toBe(true)
    for (const name of ['src/env.ts', 'docs/secretary.md', 'keys.ts', 'README.md']) expect(holdsSecret(name), name).toBe(false)
    expect(projectsOf({ roots: ['/a/web', '/b/web'] }).map((each) => each.name)).toEqual(['web', 'web-2'])
  })
})
