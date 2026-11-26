import { readFile } from 'node:fs/promises'
import { z } from 'zod'
import type { UsageWindow } from '@antumi/protocol'
import { fetchUsageJson, parseJson, UsageFetchError, type UsageReading } from '../../usage-source'
import { ANTIGRAVITY_VERSION, antigravityTokenFile } from './antigravity-runtime'
import { activeAntigravityBackend } from './antigravity-backend'
import { readManagedCredential, readAgyCliCredential, readAntigravityMeta, findOAuthClientTemplate, toManagedToken, refreshHash, refreshAgyCliAccessTokenSilently, clearAgyAccessTokenCache } from './antigravity-credentials'

// What the server's own /usage asks (ccpa_client.retrieve_user_quota_summary in 1.4.1): CCPA's
// quota summary for the project its sign-in resolved. Free and Pro accounts are served from the
// daily endpoint and Cloud-ToS ones from the main one; which is not saved, so both are tried.
const ENDPOINTS = ['https://daily-cloudcode-pa.googleapis.com', 'https://cloudcode-pa.googleapis.com']
const WINDOWS: Record<string, { kind: UsageWindow['kind']; minutes: number }> = { '5h': { kind: 'session', minutes: 300 }, weekly: { kind: 'weekly', minutes: 10_080 } }
// Refreshed a minute early, so a token never expires mid-request.
const EARLY_MS = 60_000

// The sign-in the server saves (credential_manager._save_credentials): no access token, only what
// refreshes one, beside the project its onboarding resolved.
const Credential = z.looseObject({
  client_id: z.string().min(1),
  client_secret: z.string().min(1),
  refresh_token: z.string().min(1),
  token_uri: z.string().default('https://oauth2.googleapis.com/token'),
  project_id: z.string().default('')
})
type Credential = z.infer<typeof Credential>

export async function readAntigravityCredential(file = antigravityTokenFile()): Promise<Credential | null> {
  return Credential.safeParse(parseJson(await readFile(file, 'utf8').catch(() => null))).data ?? null
}

// Access tokens live an hour and the server refreshes its own only while it runs, so Antumi
// refreshes one for itself and keeps it in memory: the saved sign-in is never written.
const tokens = new Map<string, { token: string; until: number }>()

async function accessToken(credential: Credential, now = Date.now()): Promise<string> {
  const kept = tokens.get(credential.refresh_token)
  if (kept && kept.until > now) return kept.token
  const body = new URLSearchParams({ client_id: credential.client_id, client_secret: credential.client_secret, refresh_token: credential.refresh_token, grant_type: 'refresh_token' })
  let response: Response
  try {
    response = await fetch(credential.token_uri, { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body, signal: AbortSignal.timeout(10_000) })
  } catch (error) {
    throw new UsageFetchError('request-failed', error instanceof Error ? error.message : String(error))
  }
  // A revoked or expired sign-in answers invalid_grant: only signing in again helps.
  if (response.status === 400 || response.status === 401) throw new UsageFetchError('auth-expired', `${credential.token_uri} answered ${response.status}`)
  if (!response.ok) throw new UsageFetchError('request-failed', `${credential.token_uri} answered ${response.status}`)
  const granted = z.object({ access_token: z.string().min(1), expires_in: z.number().positive().default(3600) }).safeParse(await response.json())
  if (!granted.success) throw new UsageFetchError('request-failed', 'Google 的令牌响应无法识别')
  tokens.set(credential.refresh_token, { token: granted.data.access_token, until: now + granted.data.expires_in * 1000 - EARLY_MS })
  return granted.data.access_token
}

// The structured User-Agent the server sends for a client (useragent.build_user_agent), Antumi named
// as the surface: the backend attributes the call to Antigravity by it.
export function antigravityUserAgent(platform: NodeJS.Platform = process.platform, arch = process.arch): string {
  const osType = platform === 'win32' ? 'windows' : platform
  const machine = arch === 'x64' ? 'amd64' : arch
  return `antigravity/acp/${ANTIGRAVITY_VERSION} (aidev_client; os_type=${osType}; arch=${machine}; host_path=antumi/1; proxy_client=antigravity/sdk)`
}

const Bucket = z.looseObject({
  bucketId: z.string().optional(),
  window: z.string().optional(),
  remainingFraction: z.number().optional(),
  disabled: z.boolean().optional(),
  resetTime: z.string().optional()
})
const Summary = z.looseObject({ groups: z.array(z.looseObject({ displayName: z.string().optional(), buckets: z.array(z.unknown()).catch([]) })).catch([]) })

// One window per bucket with a known span and a remaining fraction. Gemini's are the account's own
// limits; another group (the shared Claude and GPT allotment) is named by its group.
export function parseAntigravityQuota(body: unknown): UsageWindow[] {
  return (Summary.safeParse(body).data?.groups ?? []).flatMap((group) => group.buckets.flatMap((raw) => {
    const bucket = Bucket.safeParse(raw).data
    if (!bucket || bucket.disabled || bucket.remainingFraction === undefined) return []
    const span = WINDOWS[bucket.window ?? ''] ?? WINDOWS[/-(5h|weekly)$/.exec(bucket.bucketId ?? '')?.[1] ?? '']
    if (!span) return []
    const reset = bucket.resetTime ? Date.parse(bucket.resetTime) : NaN
    return [{
      kind: span.kind,
      model: bucket.bucketId?.startsWith('gemini-') ? null : group.displayName ?? null,
      usedPercent: Math.round((1 - Math.min(1, Math.max(0, bucket.remainingFraction))) * 1000) / 10,
      windowMinutes: span.minutes,
      resetsAt: Number.isFinite(reset) ? reset : null
    }]
  }))
}

const projectIds = new Map<string, string>()
const Project = z.object({ cloudaicompanionProject: z.union([z.string(), z.object({ id: z.string() })]).optional() })

export async function readAntigravityUsage(home?: string): Promise<UsageReading> {
  const backend = await activeAntigravityBackend()
  const [managed, agy] = await Promise.all([readManagedCredential(home), readAgyCliCredential(home)])
  const useAgy = backend === 'agy-cli' ? agy !== null : managed === null && agy !== null
  const credential = useAgy ? null : managed
  const refreshToken = credential?.refresh_token ?? agy?.token.refresh_token
  if (!refreshToken) return { signedIn: false }
  let bearer: string
  if (credential) bearer = await accessToken(credential)
  else if (agy?.token.access_token && Date.parse(agy.token.expiry) > Date.now() + EARLY_MS) bearer = agy.token.access_token
  else {
    const template = await findOAuthClientTemplate(home)
    if (!agy) return { signedIn: false }
    const cached = tokens.get(refreshToken)
    bearer = cached && cached.until > Date.now() ? cached.token : template
      ? await accessToken(toManagedToken(agy, template))
      : (await refreshAgyCliAccessTokenSilently(agy)).accessToken
  }
  const headers = { Authorization: 'Bearer ' + bearer, 'Content-Type': 'application/json', 'User-Agent': antigravityUserAgent() }
  const meta = await readAntigravityMeta(home)
  // A stale identity cache must never supply another account's Cloud project.
  const hash = refreshHash(refreshToken)
  let project = (managed?.refresh_token === refreshToken ? managed.project_id : '') || (meta?.projectRefreshHash === hash ? meta.projectId : null) || projectIds.get(refreshToken)
  let loadFailure: unknown = null
  if (!project) {
    for (const endpoint of ENDPOINTS) {
      try {
        const data = Project.parse(await fetchUsageJson(endpoint + '/v1internal:loadCodeAssist', headers, JSON.stringify({ metadata: { ideType: 'ANTIGRAVITY', platform: 'PLATFORM_UNSPECIFIED', pluginType: 'GEMINI' } })))
        project = typeof data.cloudaicompanionProject === 'string' ? data.cloudaicompanionProject : data.cloudaicompanionProject?.id
        if (project) { projectIds.set(refreshToken, project); break }
      } catch (error) {
        if (error instanceof UsageFetchError && error.code === 'auth-expired') { tokens.delete(refreshToken); clearAgyAccessTokenCache(refreshToken); throw error }
        loadFailure = error instanceof UsageFetchError ? error : new UsageFetchError('request-failed', error instanceof Error ? error.message : String(error))
      }
    }
  }
  if (!project && loadFailure) throw loadFailure
  if (!project) return { signedIn: true, windows: [], plan: null }
  const body = JSON.stringify({ project })
  let failure: unknown = null
  for (const endpoint of ENDPOINTS) {
    try {
      const windows = parseAntigravityQuota(await fetchUsageJson(endpoint + '/v1internal:retrieveUserQuotaSummary', headers, body))
      if (windows.length) return { signedIn: true, windows, plan: null }
    } catch (error) {
      if (error instanceof UsageFetchError && error.code === 'auth-expired') { tokens.delete(refreshToken); clearAgyAccessTokenCache(refreshToken) }
      failure = error instanceof UsageFetchError ? error : new UsageFetchError('request-failed', error instanceof Error ? error.message : String(error))
    }
  }
  if (failure) throw failure
  return { signedIn: true, windows: [], plan: null }
}
