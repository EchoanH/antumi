import { AgentProxySettings } from '@antumi/protocol'
import { AgentProxyService, setActiveAgentProxy } from '../../agent-proxy'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { mkdir, mkdtemp, readFile, readdir, realpath, rm, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { antigravityAccounts, antigravityAccountSignedIn, antigravityLoginScript } from './antigravity-account'
import { antigravity } from './antigravity-adapter'
import * as backendRuntime from './antigravity-backend'
import * as credentials from './antigravity-credentials'
import { UsageFetchError } from '../../usage-source'
import { antigravityTokenFile } from './antigravity-runtime'
import { readAntigravityUsage } from './antigravity-usage'
import * as runtime from './antigravity-runtime'
import { ANTIGRAVITY_STRIPPED_ENV, agyCliCommand, agyCliTokenFile, antigravityMetaFile, antigravitySettingsFile, backendDataDir, ensureOAuthSettings, setAntigravityRuntimeMode } from './antigravity-backend'
import { clearAgyAccessTokenCache, refreshAgyCliAccessTokenSilently, resolveCredentialIdentity, readAntigravityIdentity, clearAntigravityCredentials, readManagedCredential, readAgyCliCredential, readAntigravityMeta, refreshHash, syncAfterAntigravityLogin, syncForAntigravityBackendSwitch, writePrivateJson } from './antigravity-credentials'
import { AgentAccountStore, type AccountDeps } from '../../agent-accounts'

let root: string
let own: string
const credential = { client_id: 'client', client_secret: 'secret', refresh_token: 'refresh' }
beforeEach(async () => {
  // macOS's tmpdir is behind a symlink; the tests compare real paths.
  root = await realpath(await mkdtemp(path.join(os.tmpdir(), 'antumi-agy-accounts-')))
  own = path.join(root, 'own')
  vi.stubEnv('GEMINI_HOME', own)
  setAntigravityRuntimeMode('managed-acp')
  clearAgyAccessTokenCache()
  vi.spyOn(backendRuntime, 'activeAntigravityBackend').mockImplementation(async () => backendRuntime.getAntigravityRuntimeMode() === 'agy-cli' ? 'agy-cli' : 'managed-acp')
  vi.stubGlobal('fetch', vi.fn(async (url: string | URL | Request) => {
    const address = String(url)
    if (address.endsWith('/token')) return Response.json({ access_token: 'access', expires_in: 3600 })
    if (address.endsWith('/userinfo')) return Response.json({ id: 'google-sub', email: 'work@example.com' })
    return Response.json({})
  }))
})
afterEach(async () => {
  vi.restoreAllMocks()
  vi.unstubAllEnvs()
  vi.unstubAllGlobals()
  setAntigravityRuntimeMode('managed-acp')
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
  const cliSessions = path.join(backendDataDir('agy-cli', home), 'conversations')
  await mkdir(cliSessions, { recursive: true })
  await writeFile(path.join(cliSessions, 'preserved.db'), 'history')
  await accounts.remove('antigravity', 'work')
  expect(await readFile(path.join(backendDataDir('agy-cli'), 'archived-conversations', 'work', 'preserved.db'), 'utf8')).toBe('history')
  expect(accounts.activeOf('antigravity')).toBe('default')
  expect(await realpath(path.join(own, 'antigravity-acp', 'conversations'))).toBeTruthy()
})

const agyCredential = (refresh = 'refresh', access = 'access') => ({ token: { access_token: access, token_type: 'Bearer', refresh_token: refresh, expiry: '2099-01-01T00:00:00Z' }, auth_method: 'consumer' })

it('keeps agy sessions, locks, runtime files and identity metadata private', async () => {
  await mkdir(backendDataDir('agy-cli'), { recursive: true })
  await writeFile(antigravityMetaFile(), '{}')
  await writeFile(path.join(own, 'runtime.lock'), 'locked')
  await mkdir(path.join(own, 'tmp'))
  const home = path.join(root, 'isolated')
  await antigravityAccounts.prepare(home)
  expect(await realpath(backendDataDir('agy-cli', home))).toBe(backendDataDir('agy-cli', home))
  await expect(readFile(antigravityMetaFile(home))).rejects.toMatchObject({ code: 'ENOENT' })
  await expect(readFile(path.join(home, 'runtime.lock'))).rejects.toMatchObject({ code: 'ENOENT' })
  const command = agyCliCommand('/bin/agy', home, true)
  expect(command.args).toEqual(['acp', '--login', '--gemini-dir', home, '--app-data-dir', 'antigravity-cli-acp'])
  expect(command.env).toEqual({ GEMINI_HOME: home, AGY_CLI_FORCE_FILE_TOKEN_STORAGE: '1', AGY_CLI_DISABLE_AUTO_UPDATE: 'true' })
  expect(command.env).not.toHaveProperty('SSH_CONNECTION')
})

it('syncs verified managed login once and keeps access-token-only refreshes untouched', async () => {
  await writePrivateJson(antigravityTokenFile(), credential)
  await syncAfterAntigravityLogin(undefined, 'managed-acp')
  expect((await readAgyCliCredential())?.token.refresh_token).toBe('refresh')
  expect(await readAntigravityMeta()).toMatchObject({ verified: { sub: 'google-sub', email: 'work@example.com' }, syncBaseline: { authoritative: 'managed-acp' } })
  await writePrivateJson(agyCliTokenFile(), agyCredential('refresh', 'refreshed-access'))
  const before = await readFile(agyCliTokenFile(), 'utf8')
  vi.mocked(fetch).mockClear()
  await syncForAntigravityBackendSwitch(undefined, 'agy-cli')
  expect(await readFile(agyCliTokenFile(), 'utf8')).toBe(before)
  expect(fetch).not.toHaveBeenCalled()
  expect(await antigravityAccounts.identity(undefined)).toEqual({ email: 'work@example.com' })
  expect(fetch).not.toHaveBeenCalled()
})

it('converts agy login using an on-disk OAuth template and skips conversion without one', async () => {
  const home = path.join(root, 'agy-only')
  await writePrivateJson(agyCliTokenFile(home), agyCredential())
  await syncAfterAntigravityLogin(home, 'agy-cli')
  expect(await readManagedCredential(home)).toBeNull()
  expect(await antigravityAccountSignedIn(home, 'managed-acp')).toBe(false)
  await writePrivateJson(antigravityTokenFile(), credential)
  expect(await antigravityAccountSignedIn(home, 'managed-acp')).toBe(true)
  await syncForAntigravityBackendSwitch(home, 'managed-acp')
  expect(await readManagedCredential(home)).toMatchObject(credential)
  expect(JSON.parse(await readFile(antigravitySettingsFile('managed-acp', home), 'utf8')).auth.type).toBe('oauth-personal')
})

it('preserves conflicting credentials on switch and resolves them after explicit login', async () => {
  await writePrivateJson(antigravityTokenFile(), credential)
  await writePrivateJson(agyCliTokenFile(), agyCredential('other', 'other-access'))
  vi.mocked(fetch).mockImplementation(async (_url, init) => Response.json(String(new Headers(init?.headers).get('Authorization')).includes('other-access') ? { id: 'other-sub' } : String(_url).endsWith('/token') ? { access_token: 'access', expires_in: 3600 } : { id: 'google-sub' }))
  const before = await Promise.all([antigravityTokenFile(), agyCliTokenFile()].map(file => readFile(file, 'utf8')))
  await expect(syncForAntigravityBackendSwitch(undefined, 'agy-cli')).rejects.toMatchObject({ reason: 'antigravity-account-conflict' })
  expect(await Promise.all([antigravityTokenFile(), agyCliTokenFile()].map(file => readFile(file, 'utf8')))).toEqual(before)
  await syncAfterAntigravityLogin(undefined, 'agy-cli')
  expect((await readManagedCredential())?.refresh_token).toBe('other')
  expect(await readFile(agyCliTokenFile(), 'utf8')).toBe(before[1])
  expect(await readAntigravityMeta()).toMatchObject({ verified: { sub: 'other-sub' }, syncBaseline: { authoritative: 'agy-cli', managedRefreshHash: refreshHash('other'), agyCliRefreshHash: refreshHash('other') } })
})

it('propagates exactly one changed refresh token and refuses two independent changes', async () => {
  await writePrivateJson(antigravityTokenFile(), credential)
  await syncAfterAntigravityLogin(undefined, 'managed-acp')
  await writePrivateJson(agyCliTokenFile(), agyCredential('rotated'))
  await syncForAntigravityBackendSwitch(undefined, 'managed-acp')
  expect((await readManagedCredential())?.refresh_token).toBe('rotated')
  expect((await readAntigravityMeta())?.syncBaseline?.agyCliRefreshHash).toBe(refreshHash('rotated'))
  await writePrivateJson(antigravityTokenFile(), { ...credential, refresh_token: 'changed-m' })
  await writePrivateJson(agyCliTokenFile(), agyCredential('changed-a'))
  await expect(syncForAntigravityBackendSwitch(undefined, 'agy-cli')).rejects.toMatchObject({ reason: 'antigravity-account-conflict' })
})

it('requires a file token after agy login and clears both formats and metadata on logout', async () => {
  await expect(syncAfterAntigravityLogin(undefined, 'agy-cli')).rejects.toThrow('file-based token')
  await writePrivateJson(antigravityTokenFile(), credential)
  await syncAfterAntigravityLogin(undefined, 'managed-acp')
  const logout = await antigravityAccounts.authCommand?.('logout', own)
  if (!logout) throw new Error('missing logout')
  await promisify(execFile)(logout.command, logout.args, { env: { ...process.env, ...logout.env } })
  for (const file of [antigravityTokenFile(), agyCliTokenFile(), antigravityMetaFile()]) await expect(readFile(file)).rejects.toMatchObject({ code: 'ENOENT' })
  await clearAntigravityCredentials()
})

it('keeps quota reads in memory, discovers projects and never syncs credentials', async () => {
  setAntigravityRuntimeMode('agy-cli')
  await writePrivateJson(agyCliTokenFile(), agyCredential('quota-only'))
  const before = await readFile(agyCliTokenFile(), 'utf8')
  vi.mocked(fetch).mockImplementation(async (url) => Response.json(String(url).endsWith(':loadCodeAssist') ? { cloudaicompanionProject: 'quota-project' } : { groups: [{ buckets: [{ bucketId: 'gemini-5h', remainingFraction: 0.5 }] }] }))
  expect(await readAntigravityUsage()).toMatchObject({ signedIn: true, windows: [{ usedPercent: 50 }] })
  expect(await readFile(agyCliTokenFile(), 'utf8')).toBe(before)
  await expect(readFile(antigravityTokenFile())).rejects.toMatchObject({ code: 'ENOENT' })
  await expect(readFile(antigravityMetaFile())).rejects.toMatchObject({ code: 'ENOENT' })
})

it('merges OAuth settings without removing unrelated fields', async () => {
  await writePrivateJson(antigravitySettingsFile('agy-cli'), { model: 'chosen', auth: { extra: true } })
  await ensureOAuthSettings('agy-cli')
  expect(JSON.parse(await readFile(antigravitySettingsFile('agy-cli'), 'utf8'))).toEqual({ model: 'chosen', auth: { extra: true, type: 'oauth-personal' } })
})


it('preserves the sync baseline during identity reads so an agy rotation wins', async () => {
  await writePrivateJson(antigravityTokenFile(), credential)
  await syncAfterAntigravityLogin(undefined, 'managed-acp')
  const baseline = (await readAntigravityMeta())?.syncBaseline
  await writePrivateJson(agyCliTokenFile(), agyCredential('R2'))
  setAntigravityRuntimeMode('agy-cli')
  expect(await readAntigravityIdentity()).toMatchObject({ sub: 'google-sub' })
  expect((await readAntigravityMeta())?.syncBaseline).toEqual(baseline)
  await syncForAntigravityBackendSwitch(undefined, 'managed-acp')
  expect((await readManagedCredential())?.refresh_token).toBe('R2')
  expect((await readAgyCliCredential())?.token.refresh_token).toBe('R2')
})

it('serializes settings and sync writes on the same canonical home without deadlocking', async () => {
  await writePrivateJson(antigravityTokenFile(), credential)
  await writePrivateJson(antigravitySettingsFile('agy-cli'), { model: 'chosen', auth: { extra: true } })
  await Promise.all([
    ensureOAuthSettings('agy-cli', path.join(own, '.')),
    syncForAntigravityBackendSwitch(own, 'agy-cli'),
    ensureOAuthSettings('agy-cli', own)
  ])
  expect(JSON.parse(await readFile(antigravitySettingsFile('agy-cli'), 'utf8'))).toEqual({ model: 'chosen', auth: { extra: true, type: 'oauth-personal' } })
  expect((await readAgyCliCredential())?.token.refresh_token).toBe('refresh')
  expect((await readdir(backendDataDir('agy-cli'))).some(name => name.endsWith('.tmp'))).toBe(false)
})

it('refuses to overwrite credentials rotated during asynchronous identity verification', async () => {
  await writePrivateJson(antigravityTokenFile(), credential)
  await syncAfterAntigravityLogin(undefined, 'managed-acp')
  await writePrivateJson(agyCliTokenFile(), agyCredential('R2'))
  let rotated = false
  const fetchImpl: typeof fetch = async url => {
    if (String(url).endsWith('/token')) return Response.json({ access_token: 'access', expires_in: 3600 })
    if (!rotated) { rotated = true; await writePrivateJson(agyCliTokenFile(), agyCredential('R3')) }
    return Response.json({ id: 'google-sub' })
  }
  await expect(syncForAntigravityBackendSwitch(undefined, 'managed-acp', { fetchImpl })).rejects.toMatchObject({ reason: 'antigravity-account-conflict' })
  expect((await readManagedCredential())?.refresh_token).toBe('refresh')
  expect((await readAgyCliCredential())?.token.refresh_token).toBe('R3')
  rotated = false
  await expect(syncAfterAntigravityLogin(undefined, 'agy-cli', { fetchImpl: async () => {
    await writePrivateJson(agyCliTokenFile(), agyCredential('R4'))
    return Response.json({ id: 'google-sub' })
  } })).rejects.toMatchObject({ reason: 'antigravity-account-conflict' })
  expect((await readManagedCredential())?.refresh_token).toBe('refresh')
})

it('uses the backend captured by login even when settings change before completion', async () => {
  setAntigravityRuntimeMode('agy-cli')
  vi.spyOn(backendRuntime, 'requireAgyCli').mockResolvedValue('/bin/agy')
  const login = await antigravityAccounts.authCommand?.('login', own)
  expect(login?.backend).toBe('agy-cli')
  expect(login?.unsetEnv).toEqual(expect.arrayContaining(['GEMINI_API_KEY', 'GOOGLE_CLOUD_PROJECT']))
  expect(login?.env).not.toHaveProperty('SSH_CONNECTION')
  await writePrivateJson(antigravityTokenFile(), credential)
  await writePrivateJson(agyCliTokenFile(), agyCredential('login-wins'))
  setAntigravityRuntimeMode('managed-acp')
  await antigravityAccounts.afterLogin?.(own, login?.backend)
  expect((await readManagedCredential())?.refresh_token).toBe('login-wins')
  expect((await readAntigravityMeta())?.syncBaseline?.authoritative).toBe('agy-cli')
})

it('keeps offline decoded JWT email as a hint and never trusts its sub', async () => {
  const idToken = 'header.' + Buffer.from(JSON.stringify({ sub: 'forged-sub', email: 'hint@example.com' })).toString('base64url') + '.signature'
  await writePrivateJson(agyCliTokenFile(), { ...agyCredential(), id_token: idToken })
  vi.mocked(fetch).mockRejectedValue(new Error('offline'))
  await syncAfterAntigravityLogin(undefined, 'agy-cli')
  expect(await readAntigravityMeta()).toMatchObject({ verified: null, emailHint: 'hint@example.com' })
  setAntigravityRuntimeMode('agy-cli')
  expect(await readAntigravityIdentity()).toEqual({ sub: null, email: 'hint@example.com' })
  expect(await resolveCredentialIdentity('agy-cli')).toMatchObject({ sub: null, email: null, emailHint: 'hint@example.com', verified: false })
  await writePrivateJson(antigravityTokenFile(), { ...credential, refresh_token: 'other' })
  await expect(syncForAntigravityBackendSwitch(undefined, 'managed-acp')).rejects.toMatchObject({ reason: 'antigravity-account-conflict' })
  expect((await readManagedCredential())?.refresh_token).toBe('other')
})

it('does not trust legacy identity metadata without a verified refresh hash', async () => {
  await writePrivateJson(agyCliTokenFile(), agyCredential())
  await writePrivateJson(antigravityMetaFile(), { version: 1, sub: 'legacy-sub', email: 'legacy@example.com', authoritative: 'agy-cli', agyCliRefreshHash: refreshHash('refresh'), managedRefreshHash: null, updatedAt: Date.now() })
  expect(await readAntigravityMeta()).toMatchObject({ verified: null, syncBaseline: null })
  expect(await resolveCredentialIdentity('agy-cli')).toMatchObject({ verified: false, sub: null })
})

it('archives removed account files without replacing existing history or sharing agy databases', async () => {
  const home = path.join(root, 'added')
  await antigravityAccounts.prepare(home)
  const sessions = path.join(backendDataDir('agy-cli', home), 'conversations')
  await mkdir(sessions)
  await writeFile(path.join(sessions, 'session.db'), 'first database')
  await writeFile(path.join(sessions, 'session.meta'), 'first metadata')
  const archive = path.join(backendDataDir('agy-cli'), 'archived-conversations', 'added')
  await antigravityAccounts.beforeRemove?.(home)
  expect(await readFile(path.join(archive, 'session.db'), 'utf8')).toBe('first database')
  expect(await readdir(sessions)).toEqual([])
  await writeFile(path.join(sessions, 'session.db'), 'second database')
  await writeFile(path.join(sessions, 'session.meta'), 'second metadata')
  await antigravityAccounts.beforeRemove?.(home)
  const files = await readdir(archive)
  const second = files.find(name => name.endsWith('session.db') && name !== 'session.db')
  expect(second).toBeTruthy()
  expect(await readFile(path.join(archive, second!), 'utf8')).toBe('second database')
  expect(await readFile(path.join(archive, second!.replace(/\.db$/, '.meta')), 'utf8')).toBe('second metadata')
  expect(await readFile(path.join(archive, 'session.db'), 'utf8')).toBe('first database')
  expect(await realpath(sessions)).toBe(sessions)
  await expect(readFile(path.join(backendDataDir('managed-acp'), 'conversations', 'session.db'))).rejects.toMatchObject({ code: 'ENOENT' })
})

it('deduplicates silent refresh by refresh hash, caches it only in memory, and cleans its temporary home', async () => {
  const agy = agyCredential('silent-success', '')
  await writePrivateJson(agyCliTokenFile(), agy)
  const before = await readFile(agyCliTokenFile(), 'utf8')
  let tmp = ''
  const runSilentAgyAuth = vi.fn(async (tmpHome: string) => {
    tmp = tmpHome
    expect(tmpHome).not.toBe(own)
    expect(JSON.parse(await readFile(antigravitySettingsFile('agy-cli', tmpHome), 'utf8'))).toEqual({ auth: { type: 'oauth-personal' } })
    expect(await readAgyCliCredential(tmpHome)).toEqual(agy)
    await writePrivateJson(agyCliTokenFile(tmpHome), agyCredential('silent-success', 'fresh-bearer'))
    return { ok: true }
  })
  const deps = { executable: '/fake/agy', runSilentAgyAuth }
  const answers = await Promise.all([refreshAgyCliAccessTokenSilently(agy, deps), refreshAgyCliAccessTokenSilently(agy, deps)])
  expect(answers[0]).toEqual(answers[1])
  expect(answers[0]?.accessToken).toBe('fresh-bearer')
  await refreshAgyCliAccessTokenSilently(agy, deps)
  expect(runSilentAgyAuth).toHaveBeenCalledTimes(1)
  expect(await readFile(agyCliTokenFile(), 'utf8')).toBe(before)
  await expect(readdir(tmp)).rejects.toMatchObject({ code: 'ENOENT' })
  clearAgyAccessTokenCache(agy.token.refresh_token)
  await refreshAgyCliAccessTokenSilently(agy, deps)
  expect(runSilentAgyAuth).toHaveBeenCalledTimes(2)
})

it.each([
  { message: 'invalid_grant', timedOut: false, code: 'auth-expired' },
  { message: 'token has been expired or revoked', timedOut: false, code: 'auth-expired' },
  { message: '-32603 No browser is available here', timedOut: false, code: 'request-failed' },
  { message: 'ENOTFOUND network failure', timedOut: false, code: 'request-failed' },
  { message: 'invalid_grant', timedOut: true, code: 'request-failed' }
])('classifies silent refresh failure $message (timeout=$timedOut) as $code', async ({ message, timedOut, code }) => {
  const agy = agyCredential('silent-failure', '')
  await expect(refreshAgyCliAccessTokenSilently(agy, { executable: '/fake/agy', runSilentAgyAuth: async tmp => {
    const log = path.join(backendDataDir('agy-cli', tmp), 'log')
    await mkdir(log)
    await writeFile(path.join(log, 'auth.log'), message)
    return { ok: false, timedOut, errorMessage: 'No browser is available here' }
  } })).rejects.toMatchObject({ code })
})

it('classifies missing CLI/spawn failures as request-failed', async () => {
  await expect(refreshAgyCliAccessTokenSilently(agyCredential('missing-cli', ''), { executable: '/missing/agy', runSilentAgyAuth: async () => { throw new Error('spawn ENOENT') } })).rejects.toMatchObject({ code: 'request-failed' })
})

it.each(['request-failed', 'auth-expired'] as const)('propagates silent quota refresh failures as %s', async code => {
  setAntigravityRuntimeMode('agy-cli')
  await writePrivateJson(agyCliTokenFile(), agyCredential('quota-failure-' + code, ''))
  const error = new UsageFetchError(code, 'refresh unavailable')
  vi.spyOn(credentials, 'refreshAgyCliAccessTokenSilently').mockRejectedValue(error)
  await expect(readAntigravityUsage()).rejects.toBe(error)
})

it('distinguishes project/quota fetch failures from valid empty quota windows', async () => {
  setAntigravityRuntimeMode('agy-cli')
  await writePrivateJson(agyCliTokenFile(), agyCredential('load-failure'))
  vi.mocked(fetch).mockRejectedValue(new Error('network unavailable'))
  await expect(readAntigravityUsage()).rejects.toMatchObject({ code: 'request-failed' })
  await writePrivateJson(agyCliTokenFile(), agyCredential('summary-failure'))
  vi.mocked(fetch).mockImplementation(async url => String(url).endsWith(':loadCodeAssist') ? Response.json({ cloudaicompanionProject: 'quota-project' }) : Response.json({}, { status: 503 }))
  await expect(readAntigravityUsage()).rejects.toMatchObject({ code: 'request-failed' })
  vi.mocked(fetch).mockImplementation(async () => Response.json({ groups: [] }))
  expect(await readAntigravityUsage()).toEqual({ signedIn: true, windows: [], plan: null })
})

for (const backend of ['agy-cli', 'managed-acp'] as const) for (const policy of ['useProxy', 'noProxy'] as const) {
  it(backend + ' login applies ' + policy + ' and keeps Antigravity stripped variables', async () => {
    setAntigravityRuntimeMode(backend)
    vi.spyOn(backendRuntime, 'requireAgyCli').mockResolvedValue('/bin/agy')
    vi.spyOn(runtime, 'requireAntigravity').mockResolvedValue('/managed/agy_acp_server')
    const proxy = new AgentProxyService(AgentProxySettings.parse({ mode: 'system', agents: { antigravity: policy } }), { platform: 'win32', env: { HTTPS_PROXY: 'http://stale:80' }, run: async () => '    ProxyEnable    REG_DWORD    0x1\n    ProxyServer    REG_SZ    127.0.0.1:7897' })
    await proxy.start()
    setActiveAgentProxy(proxy)
    const signIn = vi.fn<AccountDeps['signIn']>(async () => ({ id: 'login', sessionId: 'login-session', cwd: root, title: 'login', createdAt: 0, command: null, exited: false, exitCode: null }))
    const store = new AgentAccountStore(path.join(root, 'proxy-accounts.json'), path.join(root, 'proxy-accounts'), { signIn, waitForExit: () => new Promise(() => {}), accountChanged: () => {}, changed: () => {} })
    try {
      await store.load()
      await store.login('antigravity', 'default')
      const call = signIn.mock.calls.at(-1)
      if (!call) throw new Error('login terminal was not opened')
      const [command, env, , agent, , unsetEnv] = call
      expect(agent).toBe('antigravity')
      expect(unsetEnv).toEqual(expect.arrayContaining([...ANTIGRAVITY_STRIPPED_ENV, 'HTTP_PROXY', 'HTTPS_PROXY', 'npm_config_proxy']))
      if (policy === 'useProxy') expect(env).toMatchObject({ HTTP_PROXY: 'http://127.0.0.1:7897', HTTPS_PROXY: 'http://127.0.0.1:7897', NO_PROXY: 'localhost,127.0.0.1,::1' })
      else { expect(env).not.toHaveProperty('HTTP_PROXY'); expect(env).not.toHaveProperty('HTTPS_PROXY') }
      if (backend === 'agy-cli') expect(command).toMatchObject({ command: '/bin/agy', args: expect.arrayContaining(['acp', '--login']) })
      else expect(command).toMatchObject({ command: process.execPath, args: ['-e', antigravityLoginScript, '/managed/agy_acp_server'] })
    } finally { setActiveAgentProxy(null); await proxy.close() }
  })
}
