import { Agent, Dispatcher, ProxyAgent, fetch } from 'undici'
import { AgentProxySettings, DEFAULT_AGENT_PROXY_SETTINGS, agentProxyPolicy, formatCliNoProxy, normalizeProxyUrl, parseNoProxyEntries, redactProxyUrl, sanitizeProxyErrorMessage, validateAgentProxySettings, type AgentKind, type AgentProxyStatus, type AgentProxyTestErrorCode, type AgentProxyTestResult, type SystemProxySource } from '@antumi/protocol'
import { withoutEnv } from '@antumi/protocol/node'
import { bypassed, readOsProxySettings, type ProxyHost, type ProxySettings } from './system-proxy'

export const PROXY_UNSET_KEYS = ['HTTP_PROXY', 'HTTPS_PROXY', 'ALL_PROXY', 'NO_PROXY', 'http_proxy', 'https_proxy', 'all_proxy', 'no_proxy', 'npm_config_proxy', 'npm_config_http_proxy', 'npm_config_https_proxy', 'npm_config_no_proxy', 'npm_config_noproxy', 'NPM_CONFIG_PROXY', 'NPM_CONFIG_HTTP_PROXY', 'NPM_CONFIG_HTTPS_PROXY', 'NPM_CONFIG_NO_PROXY', 'NPM_CONFIG_NOPROXY'] as const
export type AgentFetchInit = Omit<NonNullable<Parameters<typeof fetch>[1]>, 'dispatcher'>
type Proxy = {
  http: string | null
  https: string | null
  all: string | null
  bypass: string[]
}
const EMPTY: Proxy = { http: null, https: null, all: null, bypass: [] }
function normalized(raw: string): string | null {
  const result = normalizeProxyUrl(raw)
  return result.ok ? result.url : null
}

export function readExplicitEnvProxy(env: NodeJS.ProcessEnv, platform: NodeJS.Platform = process.platform) {
  const read = (name: string) => env[name]?.trim() || env[name.toLowerCase()]?.trim() || (platform === 'win32' ? Object.entries(env).find(([key, value]) => key.toUpperCase() === name && value?.trim())?.[1]?.trim() : '') || ''
  const http = read('HTTP_PROXY')
  const https = read('HTTPS_PROXY')
  const all = read('ALL_PROXY')
  const noProxy = read('NO_PROXY')
  return { http: http || null, https: https || null, all: all || null, bypass: parseNoProxyEntries(noProxy), noProxy: noProxy || null, present: Boolean(http || https || all) }
}
function globalProxy(settings: AgentProxySettings, os: ProxySettings): Proxy {
  if (settings.mode === 'none') return EMPTY
  if (settings.mode === 'system') return { http: os.http ? normalized(os.http) : null, https: os.https ? normalized(os.https) : null, all: os.socks ? normalized(os.socks) : null, bypass: os.bypass }
  const manual = settings.manual
  const url = normalized(manual.url)
  return { http: manual.advanced ? normalized(manual.httpProxy) : url, https: manual.advanced ? normalized(manual.httpsProxy) : url, all: manual.advanced ? normalized(manual.allProxy) : url, bypass: parseNoProxyEntries(manual.noProxy) }
}
const available = (proxy: Proxy) => Boolean(proxy.http || proxy.https || proxy.all)
export function buildProxyEnvVars(proxy: Proxy, platform: NodeJS.Platform): Record<string, string> {
  const env: Record<string, string> = { NO_PROXY: formatCliNoProxy(proxy.bypass) }
  for (const [key, value] of [['HTTP_PROXY', proxy.http], ['HTTPS_PROXY', proxy.https], ['ALL_PROXY', proxy.all]] as const) if (value) env[key] = value
  if (platform !== 'win32') for (const [key, value] of Object.entries(env)) env[key.toLowerCase()] = value
  return env
}
export function resolveAgentProxy(settings: AgentProxySettings = DEFAULT_AGENT_PROXY_SETTINGS, agent: AgentKind, context: { env: NodeJS.ProcessEnv; osProxy: ProxySettings; platform: NodeJS.Platform }) {
  const inherited = readExplicitEnvProxy(context.env, context.platform)
  const global = globalProxy(settings, context.osProxy)
  const policy = agentProxyPolicy(settings, agent)
  let mode: 'direct' | 'inject' | 'inherit-env' = 'direct'
  let proxy: Proxy = EMPTY
  let env: Record<string, string> = {}
  let unsetEnv: string[] = []
  let warning: 'global-proxy-unavailable' | undefined
  if (policy === 'noProxy') unsetEnv = [...PROXY_UNSET_KEYS]
  else if (policy === 'followGlobal' && inherited.present) {
    mode = 'inherit-env'
    proxy = inherited
  }
  else {
    if (policy === 'useProxy' || available(global)) unsetEnv = [...PROXY_UNSET_KEYS]
    if (available(global)) {
      mode = 'inject'
      proxy = global
      env = buildProxyEnvVars(proxy, context.platform)
    }
    else if (policy === 'useProxy') warning = 'global-proxy-unavailable'
  }
  return { mode, env, unsetEnv, httpProxy: proxy.http, httpsProxy: proxy.https, allProxy: proxy.all, bypass: proxy.bypass, warning }
}
// A daemon from before unset-env cannot strip what it inherited. Blanking the proxy variables is the
// closest it comes, so a proxy policy alone never stops a launch on it.
export function blankProxyUnset(launch: { env: Record<string, string>; unsetEnv: readonly string[] }, platform: NodeJS.Platform = process.platform): { env: Record<string, string>; unsetEnv: string[] } {
  const proxyKeys = new Set<string>(PROXY_UNSET_KEYS)
  const name = (key: string) => platform === 'win32' ? key.toUpperCase() : key
  const env = { ...launch.env }
  const present = new Set(Object.keys(env).map(name))
  for (const key of launch.unsetEnv) {
    if (!proxyKeys.has(key) || present.has(name(key))) continue
    env[name(key)] = ''
    present.add(name(key))
  }
  return { env, unsetEnv: launch.unsetEnv.filter((key) => !proxyKeys.has(key)) }
}
const undiciProxyUrl = (url: string) => (normalized(url) ?? url).replace(/^socks5h:/i, 'socks5:')
class AgentProxyDispatcher extends Dispatcher {
  constructor(private readonly resolved: ReturnType<typeof resolveAgentProxy>, private readonly direct: Agent, private readonly proxies: Map<string, ProxyAgent>) {
    super()
  }

  override dispatch(options: Dispatcher.DispatchOptions, handler: Dispatcher.DispatchHandler): boolean {
    const origin = options.origin === undefined ? null : new URL(String(options.origin))
    const resolved = this.resolved
    const proxy = !origin || resolved.mode === 'direct' || bypassed(origin.hostname, resolved.bypass) ? null
      : origin.protocol === 'https:' ? resolved.httpsProxy ?? resolved.allProxy
      : origin.protocol === 'http:' ? resolved.httpProxy ?? resolved.allProxy : null
    if (!proxy) return this.direct.dispatch(options, handler)
    const key = undiciProxyUrl(proxy)
    let cached = this.proxies.get(key)
    if (!cached) {
      cached = new ProxyAgent(key)
      this.proxies.set(key, cached)
    }
    return cached.dispatch(options, handler)
  }
}
export class AgentProxyService {
  private settings: AgentProxySettings
  private os: ProxySettings = { http: null, https: null, socks: null, bypass: [] }
  private source: SystemProxySource = 'none'
  private checkedAt = 0
  private refreshPending: Promise<void> | null = null
  private timer?: ReturnType<typeof setInterval>
  private readonly direct = new Agent()
  private readonly proxies = new Map<string, ProxyAgent>()
  constructor(settings: AgentProxySettings = DEFAULT_AGENT_PROXY_SETTINGS, private readonly host?: ProxyHost) {
    this.settings = AgentProxySettings.parse(settings)
  }

  private get platform() { return this.host?.platform ?? process.platform }
  private get env() { return this.host?.env ?? process.env }
  private refresh(): Promise<void> {
    if (this.refreshPending) return this.refreshPending
    this.refreshPending = readOsProxySettings(this.host).then(({ settings, source }) => {
      this.os = settings
      this.source = source
      this.checkedAt = Date.now()
    }).finally(() => { this.refreshPending = null })
    return this.refreshPending
  }
  async start(): Promise<void> {
    await this.refresh()
    this.timer ??= setInterval(() => void this.refresh(), 30_000)
    this.timer.unref()
  }
  async updateSettings(settings: AgentProxySettings = DEFAULT_AGENT_PROXY_SETTINGS): Promise<void> {
    this.settings = AgentProxySettings.parse(settings)
    await this.refresh()
  }
  async ensureFresh(maxAgeMs = 3_000): Promise<void> {
    if (this.settings.mode !== 'system' || (this.checkedAt && Date.now() - this.checkedAt < maxAgeMs)) return
    await this.refresh()
  }
  applyToLaunch(agent: AgentKind, baseEnv: Record<string, string> = {}, baseUnsetEnv: readonly string[] = [], clean = false, inheritedEnv: NodeJS.ProcessEnv = this.env) {
    const resolved = resolveAgentProxy(this.settings, agent, { env: inheritedEnv, osProxy: this.os, platform: this.platform })
    // A proxy the launch itself names (an account's or provider's env) is as explicit as the user's own.
    const given = agentProxyPolicy(this.settings, agent) === 'followGlobal' ? readExplicitEnvProxy(baseEnv, this.platform) : null
    // The daemon may have inherited a different environment before core restarted.
    const inherited = given?.present ? given : resolved.mode === 'inherit-env' ? readExplicitEnvProxy(inheritedEnv, this.platform) : null
    const unsetEnv = inherited ? [...PROXY_UNSET_KEYS] : resolved.unsetEnv
    const proxyEnv = inherited ? buildProxyEnvVars(inherited, this.platform) : resolved.env
    const env: Record<string, string> = {}
    for (const [key, value] of Object.entries(withoutEnv(baseEnv, unsetEnv, this.platform))) if (value !== undefined) env[key] = value
    Object.assign(env, proxyEnv)
    return { env, unsetEnv: [...new Set([...baseUnsetEnv, ...unsetEnv])] }
  }
  buildChildEnv(agent: AgentKind, baseEnv: Record<string, string> = {}, baseUnsetEnv: readonly string[] = [], inheritedEnv: NodeJS.ProcessEnv = this.env): NodeJS.ProcessEnv {
    const merged = this.applyToLaunch(agent, baseEnv, baseUnsetEnv, false, inheritedEnv)
    return { ...withoutEnv(inheritedEnv, [...merged.unsetEnv, ...Object.keys(merged.env)], this.platform), ...merged.env }
  }
  async fetchForAgent(agent: AgentKind, input: string | URL, init?: AgentFetchInit) {
    await this.ensureFresh()
    const resolved = resolveAgentProxy(this.settings, agent, { env: this.env, osProxy: this.os, platform: this.platform })
    const dispatcher = new AgentProxyDispatcher(resolved, this.direct, this.proxies)
    try {
      return await fetch(input, { ...init, dispatcher })
    } catch (error) {
      throw new Error(sanitizeProxyErrorMessage(errorDetails(error)))
    }
  }
  async status(refresh = false): Promise<AgentProxyStatus> {
    if (refresh || !this.checkedAt || Date.now() - this.checkedAt >= 30_000) await this.refresh()
    const snapshot = (proxy: Proxy) => ({ available: available(proxy), httpProxy: redactProxyUrl(proxy.http), httpsProxy: redactProxyUrl(proxy.https), allProxy: redactProxyUrl(proxy.all), noProxy: proxy.bypass.map(sanitizeProxyErrorMessage) })
    const inherited = readExplicitEnvProxy(this.env, this.platform)
    const global = globalProxy(this.settings, this.os)
    return { os: { ...snapshot({ http: this.os.http, https: this.os.https, all: this.os.socks ?? null, bypass: this.os.bypass }), source: this.source }, env: { present: inherited.present, httpProxy: redactProxyUrl(inherited.http), httpsProxy: redactProxyUrl(inherited.https), allProxy: redactProxyUrl(inherited.all), noProxy: inherited.noProxy ? sanitizeProxyErrorMessage(inherited.noProxy) : null }, globalReady: available(global), effectiveGlobal: snapshot(global), checkedAt: this.checkedAt }
  }
  async test(params: { settings?: Pick<AgentProxySettings, 'mode' | 'manual'>; targetUrl?: string } = {}): Promise<AgentProxyTestResult> {
    const settings = { ...this.settings, ...params.settings }
    let targetUrl = params.targetUrl ?? 'https://cp.cloudflare.com/generate_204'
    const failure = (errorCode: AgentProxyTestErrorCode, message: string, proxyUsed: string | null = null, latencyMs = 0, statusCode: number | null = null): AgentProxyTestResult => ({ ok: false, proxyUsed: redactProxyUrl(proxyUsed), targetUrl, statusCode, latencyMs, errorCode, message: sanitizeProxyErrorMessage(message) })
    if (settings.mode === 'none') return failure('no-proxy-configured', '全局代理模式为“不使用代理”')
    if (settings.mode === 'manual') {
      const check = validateAgentProxySettings(settings)
      if (!check.ok) return failure(check.error, check.field + ': ' + check.error)
    }
    if (settings.mode === 'system') await this.refresh()
    const proxy = globalProxy(settings, this.os)
    if (!params.targetUrl && !proxy.https && !proxy.all && proxy.http) targetUrl = 'http://cp.cloudflare.com/generate_204'
    const url = new URL(targetUrl)
    if (url.protocol !== 'http:' && url.protocol !== 'https:') return failure('invalid-proxy-url', '测试地址仅支持 HTTP 或 HTTPS')
    const proxyUrl = url.protocol === 'https:' ? proxy.https ?? proxy.all : proxy.http ?? proxy.all
    if (!proxyUrl) return failure('no-proxy-configured', '没有可用的代理')
    const start = Date.now()
    let dispatcher: ProxyAgent | undefined
    try {
      dispatcher = new ProxyAgent(undiciProxyUrl(proxyUrl))
      const response = await fetch(targetUrl, { method: 'HEAD', redirect: 'manual', signal: AbortSignal.timeout(10_000), dispatcher })
      await response.body?.cancel()
      if (response.status === 407) return failure('auth-required', '代理需要身份验证', proxyUrl, Date.now() - start, 407)
      return { ok: true, proxyUsed: redactProxyUrl(proxyUrl), targetUrl, statusCode: response.status, latencyMs: Date.now() - start, errorCode: null, message: null }
    } catch (error) {
      const details = errorDetails(error)
      const code = proxyTestErrorCode(error)
      return failure(code, details, proxyUrl, Date.now() - start, code === 'auth-required' ? 407 : null)
    } finally {
      await dispatcher?.destroy()
    }
  }
  async close(): Promise<void> {
    clearInterval(this.timer)
    await this.refreshPending
    await Promise.all([this.direct.close(), ...[...this.proxies.values()].map((agent) => agent.close())])
    this.proxies.clear()
  }
}
export function proxyTestErrorCode(error: unknown): AgentProxyTestErrorCode {
  const details = errorDetails(error)
  if (/407|authentication (?:failed|required)/i.test(details)) return 'auth-required'
  if (/ECONNREFUSED/.test(details)) return 'connection-refused'
  if (/timeout|timed out|AbortError|ETIMEDOUT/i.test(details)) return 'timeout'
  if (/CERT|UNABLE_TO_VERIFY_|ERR_TLS_|ERR_SSL_/.test(details)) return 'tls-error'
  if (/ENOTFOUND|EAI_AGAIN/.test(details)) return 'dns-error'
  return 'network-error'
}

function errorDetails(error: unknown): string {
  if (!(error instanceof Error)) return String(error)
  const code = 'code' in error ? String(error.code) : ''
  return [error.name, code, error.message, error.cause ? errorDetails(error.cause) : ''].filter(Boolean).join(': ')
}
let active: AgentProxyService | null = null
export function setActiveAgentProxy(service: AgentProxyService | null): void { active = service }
export function getActiveAgentProxy(): AgentProxyService | null { return active }
export async function refreshActiveAgentProxy(maxAgeMs = 3_000): Promise<void> {
  await active?.ensureFresh(maxAgeMs)
}
export function applyActiveAgentProxy(agent: AgentKind, env: Record<string, string> = {}, unsetEnv: readonly string[] = [], clean = false) { return active?.applyToLaunch(agent, env, unsetEnv, clean) ?? { env, unsetEnv: [...unsetEnv] } }
export function buildActiveAgentChildEnv(agent: AgentKind, env: NodeJS.ProcessEnv = {}, unsetEnv: readonly string[] = [], inheritedEnv?: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const defined: Record<string, string> = {}
  for (const [key, value] of Object.entries(env)) if (value !== undefined) defined[key] = value
  return active?.buildChildEnv(agent, defined, unsetEnv, inheritedEnv) ?? { ...withoutEnv(inheritedEnv ?? process.env, unsetEnv, process.platform), ...env }
}
export function fetchWithAgentProxy(agent: AgentKind, url: string | URL, init?: AgentFetchInit) { return active ? active.fetchForAgent(agent, url, init) : globalThis.fetch(url, init) }
