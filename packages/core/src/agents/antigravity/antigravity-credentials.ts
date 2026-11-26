import { createHash } from 'node:crypto'
import { mkdtemp, readFile, readdir, rm } from 'node:fs/promises'
import { spawn, execFile } from 'node:child_process'
import { createInterface } from 'node:readline'
import os from 'node:os'
import { launchFile, nodeLaunchHost, withoutEnv } from '@antumi/protocol/node'
import path from 'node:path'
import { z } from 'zod'
import { Rejection } from '../../rejection'
import { UsageFetchError } from '../../usage-source'
import { AntigravityBackend, activeAntigravityBackend, agyCliTokenFile, antigravityMetaFile, backendDataDir, ensureOAuthSettingsUnlocked, withAntigravityAccountLock, writePrivateJsonAtomic, agyCliCommand, requireAgyCli } from './antigravity-backend'

export const ManagedCredential = z.object({ client_id: z.string().min(1), client_secret: z.string().min(1), refresh_token: z.string().min(1), token_uri: z.string().default('https://oauth2.googleapis.com/token'), scopes: z.array(z.string()).optional(), project_id: z.string().default('') })
export type ManagedCredential = z.infer<typeof ManagedCredential>
export const AgyCliCredential = z.object({ token: z.object({ access_token: z.string().default(''), token_type: z.string().default('Bearer'), refresh_token: z.string().min(1), expiry: z.string().default('') }), auth_method: z.string().default('consumer'), id_token: z.string().optional() })
export type AgyCliCredential = z.infer<typeof AgyCliCredential>
export const SlotMeta = z.object({
  version: z.literal(1),
  verified: z.object({ sub: z.string().min(1), email: z.string().nullable(), refreshHash: z.string().min(1) }).nullable().default(null),
  emailHint: z.string().nullable().default(null),
  projectId: z.string().nullable().optional(),
  projectRefreshHash: z.string().nullable().optional(),
  syncBaseline: z.object({ managedRefreshHash: z.string().nullable(), agyCliRefreshHash: z.string().nullable(), authoritative: AntigravityBackend }).nullable().default(null),
  updatedAt: z.number()
})
export const refreshHash = (token: string): string => createHash('sha256').update(token).digest('hex').slice(0, 16)
const managedFile = (home?: string) => path.join(backendDataDir('managed-acp', home), 'acp_token.json')
async function readJson(file: string): Promise<unknown> {
  try { return JSON.parse(await readFile(file, 'utf8')) } catch { return null }
}
export const readManagedCredential = async (home?: string) => ManagedCredential.safeParse(await readJson(managedFile(home))).data ?? null
export const readAgyCliCredential = async (home?: string) => AgyCliCredential.safeParse(await readJson(agyCliTokenFile(home))).data ?? null
export const readAntigravityMeta = async (home?: string) => SlotMeta.safeParse(await readJson(antigravityMetaFile(home))).data ?? null
export const writePrivateJson = writePrivateJsonAtomic

const agyAccessTokens = new Map<string, { token: string; until: number }>()
const agyRefreshInFlight = new Map<string, Promise<{ accessToken: string; expiresAt: number }>>()
export function clearAgyAccessTokenCache(refreshToken?: string): void {
  if (refreshToken === undefined) agyAccessTokens.clear()
  else agyAccessTokens.delete(refreshHash(refreshToken))
}
export type SilentRefreshDeps = {
  executable?: string
  timeoutMs?: number
  runSilentAgyAuth?: (tmpHome: string, executable: string, timeoutMs: number) => Promise<{ ok: boolean; errorMessage?: string; timedOut?: boolean }>
}
const SilentFrame = z.object({ id: z.number().optional(), result: z.unknown().optional(), error: z.object({ message: z.string().optional() }).optional() })
async function runSilentAgyAuth(tmpHome: string, executable: string, timeoutMs: number): Promise<{ ok: boolean; errorMessage?: string; timedOut?: boolean }> {
  const cmd = agyCliCommand(executable, tmpHome)
  // Only this isolated background helper disables browser login via SSH_CONNECTION.
  // Normal chats and interactive login must never set it.
  const env = { ...withoutEnv(process.env, cmd.unsetEnv), ...cmd.env, SSH_CONNECTION: '127.0.0.1 0 127.0.0.1 0' }
  const launch = launchFile(cmd.command, cmd.args, env, nodeLaunchHost)
  const child = spawn(launch.file, launch.args, { env: launch.env, cwd: tmpHome, windowsHide: true, detached: process.platform !== 'win32', stdio: ['pipe', 'pipe', 'pipe'] })
  let closed = false
  const closing = new Promise<void>(resolve => child.once('close', () => { closed = true; resolve() }))
  const lines = createInterface({ input: child.stdout })
  let stderr = ''
  child.stderr.setEncoding('utf8').on('data', (chunk: string) => { stderr = (stderr + chunk).slice(-64_000) })
  try {
    return await new Promise<{ ok: boolean; errorMessage?: string; timedOut?: boolean }>(resolve => {
      let finished = false
      const finish = (result: { ok: boolean; errorMessage?: string; timedOut?: boolean }) => {
        if (finished) return
        finished = true
        clearTimeout(timer)
        resolve({ ...result, errorMessage: [result.errorMessage, stderr].filter(Boolean).join('\n') })
      }
      const timer = setTimeout(() => finish({ ok: false, timedOut: true }), timeoutMs)
      const send = (id: number, method: string, params: unknown) => child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n')
      child.once('error', error => finish({ ok: false, errorMessage: error.message }))
      child.once('close', () => finish({ ok: false, errorMessage: 'agy exited before authentication completed' }))
      child.stdin.on('error', error => finish({ ok: false, errorMessage: error.message }))
      let authenticated = false
      lines.on('line', line => {
        if (finished) return
        let raw: unknown
        try { raw = JSON.parse(line) } catch { return }
        const frame = SilentFrame.safeParse(raw).data
        if (!frame || (frame.id !== 1 && frame.id !== 2)) return
        if (frame.error) { finish({ ok: false, errorMessage: frame.error.message }); return }
        if (!('result' in frame)) return
        if (frame.id === 1 && !authenticated) { authenticated = true; send(2, 'authenticate', { methodId: 'oauth-personal' }) }
        else if (frame.id === 2 && authenticated) finish({ ok: true })
      })
      send(1, 'initialize', { protocolVersion: 1, clientInfo: { name: 'antumi', version: '1' }, clientCapabilities: {} })
    })
  } finally {
    child.stdin.end()
    const kill = (signal: NodeJS.Signals) => {
      if (!child.pid) return
      if (process.platform === 'win32') { child.kill(signal); return }
      try { process.kill(-child.pid, signal) } catch { child.kill(signal) }
    }
    if (process.platform === 'win32' && child.pid) {
      await new Promise<void>(resolve => {
        execFile('taskkill', ['/pid', String(child.pid), '/T', '/F'], { windowsHide: true, timeout: 3000 }, () => resolve())
      })
    } else kill('SIGTERM')
    const waitForClose = async () => {
      let timer: ReturnType<typeof setTimeout> | undefined
      try { await Promise.race([closing, new Promise<void>(resolve => { timer = setTimeout(resolve, 1000) })]) }
      finally { clearTimeout(timer) }
    }
    await waitForClose()
    if (!closed || process.platform !== 'win32') kill('SIGKILL')
    if (!closed) await waitForClose()
    lines.close()
  }
}
async function silentRefreshLogs(directory: string): Promise<string> {
  const entries = await readdir(directory, { withFileTypes: true }).catch(() => [])
  const logs = await Promise.all(entries.map(entry => entry.isDirectory()
    ? silentRefreshLogs(path.join(directory, entry.name))
    : readFile(path.join(directory, entry.name), 'utf8').catch(() => '')))
  return logs.join('\n')
}
export async function refreshAgyCliAccessTokenSilently(agy: AgyCliCredential, deps: SilentRefreshDeps = {}): Promise<{ accessToken: string; expiresAt: number }> {
  const hash = refreshHash(agy.token.refresh_token)
  const cached = agyAccessTokens.get(hash)
  if (cached && cached.until > Date.now()) return { accessToken: cached.token, expiresAt: cached.until + 60_000 }
  const pending = agyRefreshInFlight.get(hash)
  if (pending) return pending
  const task = (async () => {
    let tmp: string | undefined
    try {
      tmp = await mkdtemp(path.join(os.tmpdir(), 'antumi-agy-refresh-'))
      await writePrivateJson(agyCliTokenFile(tmp), agy)
      await writePrivateJson(path.join(backendDataDir('agy-cli', tmp), 'settings.json'), { auth: { type: 'oauth-personal' } })
      let result: { ok: boolean; errorMessage?: string; timedOut?: boolean }
      try {
        result = await (deps.runSilentAgyAuth ?? runSilentAgyAuth)(tmp, deps.executable ?? await requireAgyCli(), deps.timeoutMs ?? 20_000)
      } catch (error) { result = { ok: false, errorMessage: error instanceof Error ? error.message : String(error) } }
      if (result.timedOut) throw new UsageFetchError('request-failed', 'Antigravity 令牌静默刷新超时')
      if (!result.ok) {
        const logs = result.errorMessage + '\n' + await silentRefreshLogs(path.join(backendDataDir('agy-cli', tmp), 'log'))
        if (/\binvalid_grant\b|token has been expired or revoked/i.test(logs)) {
          clearAgyAccessTokenCache(agy.token.refresh_token)
          throw new UsageFetchError('auth-expired', 'Google 登录已失效（invalid_grant），请重新登录')
        }
        throw new UsageFetchError('request-failed', 'Antigravity 令牌静默刷新失败，请检查 agy 安装和网络连接')
      }
      const refreshed = await readAgyCliCredential(tmp)
      if (!refreshed?.token.access_token.trim()) throw new UsageFetchError('request-failed', 'agy 未返回访问令牌')
      const expiry = Date.parse(refreshed.token.expiry)
      const expiresAt = Number.isFinite(expiry) ? expiry : Date.now() + 3600_000
      agyAccessTokens.set(hash, { token: refreshed.token.access_token, until: expiresAt - 60_000 })
      return { accessToken: refreshed.token.access_token, expiresAt }
    } catch (error) {
      if (error instanceof UsageFetchError) throw error
      throw new UsageFetchError('request-failed', 'Antigravity 令牌静默刷新失败')
    } finally { if (tmp) await rm(tmp, { recursive: true, force: true }).catch(() => {}) }
  })()
  agyRefreshInFlight.set(hash, task)
  try { return await task }
  finally { if (agyRefreshInFlight.get(hash) === task) agyRefreshInFlight.delete(hash) }
}

const Identity = z.object({ sub: z.string().nullable().optional(), id: z.string().optional(), email: z.string().nullable().optional() })
export function decodeJwtIdentity(idToken: string | undefined): { sub: string | null; email: string | null } {
  try {
    const payload = idToken?.split('.')[1]
    const data = Identity.parse(JSON.parse(Buffer.from(payload ?? '', 'base64url').toString('utf8')))
    return { sub: data.sub ?? null, email: data.email ?? null }
  } catch { return { sub: null, email: null } }
}
export async function verifyOAuthIdentity(accessToken: string, fetchImpl = fetch): Promise<{ sub: string | null; email: string | null } | null> {
  const response = await fetchImpl('https://www.googleapis.com/oauth2/v2/userinfo', { headers: { Authorization: 'Bearer ' + accessToken }, signal: AbortSignal.timeout(10_000) })
  if (!response.ok) return null
  const data = Identity.safeParse(await response.json()).data
  return data ? { sub: data.id ?? data.sub ?? null, email: data.email ?? null } : null
}
export async function refreshManagedAccessToken(cred: ManagedCredential, fetchImpl = fetch): Promise<{ accessToken: string; expiresIn: number; idToken?: string }> {
  const response = await fetchImpl(cred.token_uri, { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams({ client_id: cred.client_id, client_secret: cred.client_secret, refresh_token: cred.refresh_token, grant_type: 'refresh_token' }), signal: AbortSignal.timeout(10_000) })
  if (!response.ok) throw new Error('Google token refresh failed: ' + response.status)
  const data = z.object({ access_token: z.string().min(1), expires_in: z.number().default(3600), id_token: z.string().optional() }).parse(await response.json())
  return { accessToken: data.access_token, expiresIn: data.expires_in, ...(data.id_token ? { idToken: data.id_token } : {}) }
}
export async function findOAuthClientTemplate(home?: string): Promise<ManagedCredential | null> {
  return await readManagedCredential(home) ?? (home === undefined ? null : await readManagedCredential())
}
export const toAgyCliToken = (managed: ManagedCredential): AgyCliCredential => ({ token: { access_token: '', token_type: 'Bearer', refresh_token: managed.refresh_token, expiry: '2000-01-01T00:00:00Z' }, auth_method: 'consumer' })
export function toManagedToken(agy: AgyCliCredential, template: Pick<ManagedCredential, 'client_id' | 'client_secret' | 'token_uri' | 'scopes'>): ManagedCredential {
  return { client_id: template.client_id, client_secret: template.client_secret, refresh_token: agy.token.refresh_token, token_uri: template.token_uri, scopes: template.scopes ?? ['https://www.googleapis.com/auth/cloud-platform', 'https://www.googleapis.com/auth/userinfo.email', 'https://www.googleapis.com/auth/aicode'], project_id: '' }
}

type CredentialIdentity = { sub: string | null; email: string | null; emailHint: string | null; verified: boolean; refreshHash: string }
export async function resolveCredentialIdentity(backend: AntigravityBackend, home?: string, options: { network?: boolean; fetchImpl?: typeof fetch } = {}): Promise<CredentialIdentity | null> {
  const managed = backend === 'managed-acp' ? await readManagedCredential(home) : null
  const agy = backend === 'agy-cli' ? await readAgyCliCredential(home) : null
  const token = managed?.refresh_token ?? agy?.token.refresh_token
  if (!token) return null
  const hash = refreshHash(token)
  const meta = await readAntigravityMeta(home)
  const decoded = decodeJwtIdentity(agy?.id_token)
  const cached = meta?.verified?.refreshHash === hash ? meta.verified : null
  if (cached && !options.network) return { ...cached, emailHint: decoded.email, verified: true }
  if (!options.network) return { sub: null, email: null, emailHint: decoded.email, verified: false, refreshHash: hash }
  let bearer = agy?.token.access_token ?? ''
  if (managed) bearer = (await refreshManagedAccessToken(managed, options.fetchImpl)).accessToken
  else if (agy && (!bearer || !(Date.parse(agy.token.expiry) > Date.now()))) {
    const template = await findOAuthClientTemplate(home)
    bearer = template
      ? (await refreshManagedAccessToken(toManagedToken(agy, template), options.fetchImpl)).accessToken
      : (await refreshAgyCliAccessTokenSilently(agy)).accessToken
  }
  const verified = await verifyOAuthIdentity(bearer, options.fetchImpl)
  return { sub: verified?.sub ?? null, email: verified?.email ?? null, emailHint: decoded.email, verified: Boolean(verified?.sub), refreshHash: hash }
}
async function credentialHashes(home?: string) {
  const [managed, agy] = await Promise.all([readManagedCredential(home), readAgyCliCredential(home)])
  return { managedRefreshHash: managed ? refreshHash(managed.refresh_token) : null, agyCliRefreshHash: agy ? refreshHash(agy.token.refresh_token) : null }
}
function verifiedMeta(identity: CredentialIdentity | null) {
  return identity?.verified && identity.sub ? { sub: identity.sub, email: identity.email, refreshHash: identity.refreshHash } : null
}
async function saveMeta(home: string | undefined, authoritative: AntigravityBackend, identity: CredentialIdentity | null): Promise<void> {
  const [managed, hashes, previous] = await Promise.all([readManagedCredential(home), credentialHashes(home), readAntigravityMeta(home)])
  const hash = authoritative === 'managed-acp' ? hashes.managedRefreshHash : hashes.agyCliRefreshHash
  const projectId = managed?.project_id || (previous?.projectRefreshHash === hash ? previous.projectId : null)
  await writePrivateJson(antigravityMetaFile(home), {
    version: 1, verified: verifiedMeta(identity), emailHint: identity?.email ?? identity?.emailHint ?? null,
    projectId, projectRefreshHash: projectId ? hash : null,
    syncBaseline: { ...hashes, authoritative }, updatedAt: Date.now()
  })
}
export async function readAntigravityIdentity(home?: string): Promise<{ email: string | null; sub: string | null }> {
  const backend = await activeAntigravityBackend()
  return withAntigravityAccountLock(home, async () => {
    const current = await resolveCredentialIdentity(backend, home)
    if (current?.verified) return { sub: current.sub, email: current.email }
    const source = current ? backend : backend === 'agy-cli' ? 'managed-acp' : 'agy-cli'
    const initial = current ?? await resolveCredentialIdentity(source, home)
    if (!initial) return { sub: null, email: null }
    const identity = await resolveCredentialIdentity(source, home, { network: true }).catch(() => initial)
    const fresh = await resolveCredentialIdentity(source, home)
    if (!identity || fresh?.refreshHash !== initial.refreshHash || identity.refreshHash !== initial.refreshHash) return { sub: null, email: fresh?.emailHint ?? null }
    const previous = await readAntigravityMeta(home)
    await writePrivateJson(antigravityMetaFile(home), {
      version: 1, verified: verifiedMeta(identity), emailHint: identity.email ?? identity.emailHint,
      projectId: previous?.projectId ?? null, projectRefreshHash: previous?.projectRefreshHash ?? null,
      // Identity observation must never become a synchronization baseline.
      syncBaseline: previous?.syncBaseline ?? null, updatedAt: Date.now()
    })
    return { sub: identity.verified ? identity.sub : null, email: identity.email ?? identity.emailHint }
  })
}
const conflict = () => new Rejection('antigravity-account-conflict', '该账号在两个 Antigravity 后端中绑定了不同的 Google 账号，已阻止自动同步以避免串号，请在设置 → 账号中重新登录该账号。')
async function convert(home: string | undefined, source: AntigravityBackend, expected: Awaited<ReturnType<typeof credentialHashes>>): Promise<boolean> {
  const [managed, agy, template] = await Promise.all([readManagedCredential(home), readAgyCliCredential(home), source === 'agy-cli' ? findOAuthClientTemplate(home) : Promise.resolve(null)])
  const current = await credentialHashes(home)
  if (current.managedRefreshHash !== expected.managedRefreshHash || current.agyCliRefreshHash !== expected.agyCliRefreshHash) throw conflict()
  if (source === 'managed-acp') {
    if (!managed || refreshHash(managed.refresh_token) !== expected.managedRefreshHash) throw conflict()
    await writePrivateJson(agyCliTokenFile(home), toAgyCliToken(managed))
    await ensureOAuthSettingsUnlocked('agy-cli', home)
  } else {
    if (!agy || refreshHash(agy.token.refresh_token) !== expected.agyCliRefreshHash) throw conflict()
    if (!template) return false
    await writePrivateJson(managedFile(home), toManagedToken(agy, template))
    await ensureOAuthSettingsUnlocked('managed-acp', home)
  }
  return true
}
export async function syncAfterAntigravityLogin(home: string | undefined, loggedInBackend: AntigravityBackend, options: { fetchImpl?: typeof fetch } = {}): Promise<void> {
  return withAntigravityAccountLock(home, async () => {
    const initial = await credentialHashes(home)
    const initialHash = loggedInBackend === 'agy-cli' ? initial.agyCliRefreshHash : initial.managedRefreshHash
    if (!initialHash) throw new Error(loggedInBackend === 'agy-cli' ? 'agy CLI did not write its file-based token; check AGY_CLI_FORCE_FILE_TOKEN_STORAGE=1' : 'Antigravity did not write its credential file')
    const identity = await resolveCredentialIdentity(loggedInBackend, home, { network: true, ...options }).catch(() => resolveCredentialIdentity(loggedInBackend, home))
    if (identity?.refreshHash !== initialHash) throw conflict()
    const converted = await convert(home, loggedInBackend, initial)
    if (!converted) await rm(managedFile(home), { force: true })
    await saveMeta(home, loggedInBackend, identity)
  })
}
export async function syncForAntigravityBackendSwitch(home: string | undefined, targetBackend: AntigravityBackend, options: { fetchImpl?: typeof fetch } = {}): Promise<void> {
  return withAntigravityAccountLock(home, async () => {
    const [managed, agy, meta] = await Promise.all([readManagedCredential(home), readAgyCliCredential(home), readAntigravityMeta(home)])
    if (!managed && !agy) return
    const initial = { managedRefreshHash: managed ? refreshHash(managed.refresh_token) : null, agyCliRefreshHash: agy ? refreshHash(agy.token.refresh_token) : null }
    const targetExists = targetBackend === 'managed-acp' ? managed : agy
    if (!managed || !agy) {
      if (targetExists) { await ensureOAuthSettingsUnlocked(targetBackend, home); return }
      const source = targetBackend === 'agy-cli' ? 'managed-acp' : 'agy-cli'
      const identity = await resolveCredentialIdentity(source, home, { network: true, ...options }).catch(() => resolveCredentialIdentity(source, home))
      if (await convert(home, source, initial)) await saveMeta(home, source, identity)
      return
    }
    if (initial.managedRefreshHash === initial.agyCliRefreshHash) { await ensureOAuthSettingsUnlocked(targetBackend, home); return }
    const mIdentity = await resolveCredentialIdentity('managed-acp', home, { network: true, ...options }).catch(() => null)
    const aIdentity = await resolveCredentialIdentity('agy-cli', home, { network: true, ...options }).catch(() => null)
    if (!mIdentity?.verified || !mIdentity.sub || !aIdentity?.verified || !aIdentity.sub || mIdentity.sub !== aIdentity.sub) throw conflict()
    const baseline = meta?.syncBaseline
    const mChanged = baseline ? baseline.managedRefreshHash !== initial.managedRefreshHash : true
    const aChanged = baseline ? baseline.agyCliRefreshHash !== initial.agyCliRefreshHash : true
    if (mChanged === aChanged) throw conflict()
    const source = mChanged ? 'managed-acp' : 'agy-cli'
    if (await convert(home, source, initial)) await saveMeta(home, source, mChanged ? mIdentity : aIdentity)
  })
}

export async function hasAnyAntigravityCredential(home?: string, backend?: AntigravityBackend): Promise<boolean> {
  const target = backend ?? await activeAntigravityBackend()
  const [managed, agy] = await Promise.all([readManagedCredential(home), readAgyCliCredential(home)])
  if (target === 'managed-acp' ? managed : agy) return true
  return target === 'agy-cli' ? managed !== null : agy !== null && await findOAuthClientTemplate(home) !== null
}
export async function clearAntigravityCredentials(home?: string): Promise<void> {
  await Promise.all([managedFile(home), agyCliTokenFile(home), antigravityMetaFile(home)].map(file => rm(file, { force: true })))
}
