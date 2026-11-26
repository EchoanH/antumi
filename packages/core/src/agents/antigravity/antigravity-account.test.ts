import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { antigravityAccounts, antigravityAccountSignedIn, antigravityLoginScript } from './antigravity-account'
import { antigravity } from './antigravity-adapter'
import { antigravityTokenFile } from './antigravity-runtime'
import { readAntigravityUsage } from './antigravity-usage'
import * as runtime from './antigravity-runtime'
import { AgentAccountStore } from '../../agent-accounts'

let root: string
let own: string
const credential = { client_id: 'client', client_secret: 'secret', refresh_token: 'refresh' }
beforeEach(async () => {
  root = await mkdtemp(path.join(os.tmpdir(), 'antumi-agy-accounts-'))
  own = path.join(root, 'own')
  vi.stubEnv('GEMINI_HOME', own)
})
afterEach(async () => {
  vi.restoreAllMocks()
  vi.unstubAllEnvs()
  await rm(root, { recursive: true, force: true })
})

it('isolates credentials, shares history, and uses the selected account for launches and usage', async () => {
  await mkdir(path.dirname(antigravityTokenFile()), { recursive: true })
  await writeFile(antigravityTokenFile(), JSON.stringify(credential))
  await writeFile(path.join(own, 'GEMINI.md'), 'rules')
  const home = path.join(root, 'other')
  await antigravityAccounts.prepare(home)
  expect(await antigravityAccountSignedIn()).toBe(true)
  expect(await antigravityAccountSignedIn(home)).toBe(false)
  expect(await readAntigravityUsage(home)).toEqual({ signedIn: false })
  expect(await realpath(path.join(home, 'antigravity-acp', 'conversations'))).toBe(await realpath(path.join(own, 'antigravity-acp', 'conversations')))
  expect(await readFile(path.join(home, 'GEMINI.md'), 'utf8')).toBe('rules')
  await writeFile(antigravityTokenFile(home), JSON.stringify({ ...credential, refresh_token: 'other' }))
  expect(await antigravityAccountSignedIn(home)).toBe(true)
  expect(await readAntigravityUsage(home)).toEqual({ signedIn: true, windows: [], plan: null })
  expect(antigravity.command({ providerSessionId: null, resume: false, handoffPath: null, extraProjects: [], account: { id: 'other', env: antigravityAccounts.env(home) } }).env).toMatchObject({ GEMINI_HOME: home, AGY_ACP_FORCE_FILE_STORAGE: '1' })
  const logout = await antigravityAccounts.authCommand?.('logout')
  if (!logout) throw new Error('missing sign-out')
  await promisify(execFile)(logout.command, logout.args, { env: { ...process.env, ...antigravityAccounts.env(home) } })
  expect(await antigravityAccountSignedIn(home)).toBe(false)
  expect(await antigravityAccountSignedIn()).toBe(true)
})

it.skipIf(process.platform === 'win32')('authenticates over ACP without creating a session, and reports protocol errors', async () => {
  const server = path.join(root, 'server.cjs')
  await writeFile(server, `#!${process.execPath}\nconst { createInterface } = require('node:readline');
createInterface({ input: process.stdin }).on('line', line => {
  const frame = JSON.parse(line);
  const valid = frame.id === 1 ? frame.method === 'initialize' : frame.id === 2 && frame.method === 'authenticate' && frame.params.methodId === 'oauth-personal';
  console.log(JSON.stringify({ jsonrpc: '2.0', id: frame.id, ...(valid && !process.env.FAIL_AUTH ? { result: {} } : { error: { message: 'auth rejected' } }) }));
});`, { mode: 0o755 })
  // The script launches a native executable, as the actual ACP server is shipped.
  const run = promisify(execFile)
  const result = await run(process.execPath, ['-e', antigravityLoginScript, server], { timeout: 5000 })
  expect(result.stdout).toContain('Google sign-in complete.')
  await expect(run(process.execPath, ['-e', antigravityLoginScript, server], { env: { ...process.env, FAIL_AUTH: '1' }, timeout: 5000 })).rejects.toMatchObject({ code: 1, stderr: expect.stringContaining('auth rejected') })
})

it('adds, reloads, activates and removes an account through the shared account store', async () => {
  vi.spyOn(runtime, 'requireAntigravity').mockResolvedValue('/managed/agy_acp_server')
  const signIn = vi.fn()
  const changed = vi.fn()
  const accounts = new AgentAccountStore(path.join(root, 'accounts.json'), path.join(root, 'accounts'), {
    signIn, waitForExit: async () => 0, accountChanged: changed, changed: () => {}, newId: () => 'work',
    signOut: async (command, args, env) => { await promisify(execFile)(command, args, { env: { ...process.env, ...env } }) }
  })
  // Keep the terminal pending until the test has written its sign-in.
  let finish: (code: number) => void = () => {}
  signIn.mockResolvedValue({ id: 'login' })
  const deps = { waitForExit: () => new Promise<number>(resolve => { finish = resolve }) }
  const store = new AgentAccountStore(path.join(root, 'accounts.json'), path.join(root, 'accounts'), {
    signIn, ...deps, accountChanged: changed, changed: () => {}, newId: () => 'work',
    signOut: async (command, args, env) => { await promisify(execFile)(command, args, { env: { ...process.env, ...env } }) }
  })
  await store.add('antigravity', 'Work')
  const home = store.home('antigravity', 'work')!
  expect(signIn.mock.calls[0]?.[0]).toMatchObject({ command: process.execPath, args: ['-e', antigravityLoginScript, '/managed/agy_acp_server'] })
  expect(signIn.mock.calls[0]?.[1]).toMatchObject({ GEMINI_HOME: home, AGY_ACP_FORCE_FILE_STORAGE: '1' })
  await writeFile(antigravityTokenFile(home), JSON.stringify(credential))
  finish(0)
  await vi.waitFor(() => expect(changed).toHaveBeenCalledWith('antigravity', 'work', false))
  await store.activate('antigravity', 'work')
  await accounts.load()
  expect(accounts.activeOf('antigravity')).toBe('work')
  expect(await accounts.launch('antigravity')).toEqual({ id: 'work', env: { GEMINI_HOME: home } })
  await accounts.remove('antigravity', 'work')
  expect(accounts.activeOf('antigravity')).toBe('default')
  expect(await realpath(path.join(own, 'antigravity-acp', 'conversations'))).toBeTruthy()
})
