import { z } from 'zod'
import { AgentKind } from './agent'

export const GLOBAL_PROXY_MODES = ['none', 'system', 'manual'] as const
export const GlobalProxyMode = z.enum(GLOBAL_PROXY_MODES)
export type GlobalProxyMode = z.infer<typeof GlobalProxyMode>
export const AGENT_PROXY_POLICIES = ['followGlobal', 'useProxy', 'noProxy'] as const
export const AgentProxyPolicy = z.enum(AGENT_PROXY_POLICIES)
export type AgentProxyPolicy = z.infer<typeof AgentProxyPolicy>
export const ProxyAddress = z.string().trim().max(2048)
export const NoProxyValue = z.string().trim().max(4096)
export const ManualProxyConfig = z.object({
  url: ProxyAddress.default(''), advanced: z.boolean().default(false),
  httpProxy: ProxyAddress.default(''), httpsProxy: ProxyAddress.default(''),
  allProxy: ProxyAddress.default(''), noProxy: NoProxyValue.default('')
})
export type ManualProxyConfig = z.infer<typeof ManualProxyConfig>
export const AgentProxySettings = z.object({
  mode: GlobalProxyMode.default('system'),
  manual: ManualProxyConfig.default({ url: '', advanced: false, httpProxy: '', httpsProxy: '', allProxy: '', noProxy: '' }),
  agents: z.partialRecord(AgentKind, AgentProxyPolicy).default({})
})
export type AgentProxySettings = z.infer<typeof AgentProxySettings>
export const DEFAULT_AGENT_PROXY_SETTINGS: AgentProxySettings = {
  mode: 'system',
  manual: { url: '', advanced: false, httpProxy: '', httpsProxy: '', allProxy: '', noProxy: '' },
  agents: {}
}
export const SystemProxySource = z.enum(['windows-registry', 'macos-scutil', 'linux-gsettings', 'none'])
export type SystemProxySource = z.infer<typeof SystemProxySource>
export const DetectedProxySnapshot = z.object({
  available: z.boolean(), httpProxy: z.string().nullable(), httpsProxy: z.string().nullable(),
  allProxy: z.string().nullable(), noProxy: z.array(z.string())
})
export type DetectedProxySnapshot = z.infer<typeof DetectedProxySnapshot>
export const AgentProxyStatus = z.object({
  os: DetectedProxySnapshot.extend({ source: SystemProxySource }),
  env: z.object({ present: z.boolean(), httpProxy: z.string().nullable(), httpsProxy: z.string().nullable(), allProxy: z.string().nullable(), noProxy: z.string().nullable() }),
  globalReady: z.boolean(), effectiveGlobal: DetectedProxySnapshot, checkedAt: z.number()
})
export type AgentProxyStatus = z.infer<typeof AgentProxyStatus>
export const AgentProxyTestErrorCode = z.enum(['no-proxy-configured', 'invalid-proxy-url', 'unsupported-protocol', 'auth-required', 'connection-refused', 'timeout', 'tls-error', 'dns-error', 'network-error'])
export type AgentProxyTestErrorCode = z.infer<typeof AgentProxyTestErrorCode>
export const AgentProxyTestResult = z.object({
  ok: z.boolean(), proxyUsed: z.string().nullable(), targetUrl: z.string(), statusCode: z.number().int().nullable(),
  latencyMs: z.number().int().nonnegative(), errorCode: AgentProxyTestErrorCode.nullable(), message: z.string().nullable()
})
export type AgentProxyTestResult = z.infer<typeof AgentProxyTestResult>
export const SUPPORTED_PROXY_PROTOCOLS = ['http:', 'https:', 'socks5:', 'socks5h:', 'socks:'] as const
export function normalizeProxyUrl(raw: string): { ok: true; url: string | null } | { ok: false; error: 'invalid-proxy-url' | 'unsupported-protocol' } {
  if (/[\r\n\0\t]/.test(raw)) return { ok: false, error: 'invalid-proxy-url' }
  let candidate = raw.trim()
  if (!candidate) return { ok: true, url: null }
  if (/\s/.test(candidate)) return { ok: false, error: 'invalid-proxy-url' }
  const scheme = /^([a-z][a-z0-9+.-]*):\/\//i.exec(candidate)?.[1]
  if (scheme) {
    if (!SUPPORTED_PROXY_PROTOCOLS.some((p) => p === scheme.toLowerCase() + ':')) return { ok: false, error: 'unsupported-protocol' }
  } else {
    if (!/^(?:[^:/@?#]+|\[[0-9a-f:.]+\]):[0-9]+$/i.test(candidate)) return { ok: false, error: 'invalid-proxy-url' }
    candidate = 'http://' + candidate
  }
  try {
    const url = new URL(candidate)
    const authority = candidate.split('://')[1]?.split(/[/?#]/)[0] ?? ''
    const port = /:([0-9]*)$/.exec(authority)?.[1]
    if (!url.hostname || (port !== undefined && (!port || Number(port) < 1 || Number(port) > 65535))) return { ok: false, error: 'invalid-proxy-url' }
    return { ok: true, url: candidate }
  } catch { return { ok: false, error: 'invalid-proxy-url' } }
}
export function validateAgentProxySettings(settings: Pick<AgentProxySettings, 'mode' | 'manual'>): { ok: true } | { ok: false; field: 'url' | 'httpProxy' | 'httpsProxy' | 'allProxy' | 'noProxy'; error: 'invalid-proxy-url' | 'unsupported-protocol' } {
  if (/[\r\n\0]/.test(settings.manual.noProxy)) return { ok: false, field: 'noProxy', error: 'invalid-proxy-url' }
  if (settings.mode !== 'manual') return { ok: true }
  const fields = settings.manual.advanced ? ['httpProxy', 'httpsProxy', 'allProxy'] as const : ['url'] as const
  for (const field of fields) {
    const check = normalizeProxyUrl(settings.manual[field])
    if (!check.ok) return { ok: false, field, error: check.error }
  }
  return { ok: true }
}
export function sanitizeProxyErrorMessage(text: string): string {
  return text.replace(/([a-z][a-z0-9+.-]*:\/\/)([^\s/]*@)/gi, '$1***@')
}
export function redactProxyUrl(raw: string | null | undefined): string | null {
  if (!raw?.trim()) return null
  const redacted = sanitizeProxyErrorMessage(raw)
  return redacted.includes('://') ? redacted : redacted.replace(/^[^\s/]*@/, '***@')
}
export const LOOPBACK_NO_PROXY = ['localhost', '127.0.0.1', '::1'] as const
export function parseNoProxyEntries(raw: string): string[] {
  const seen = new Set<string>()
  return raw.split(/[,;\s]+/).filter((entry) => {
    if (!entry || seen.has(entry.toLowerCase())) return false
    seen.add(entry.toLowerCase())
    return true
  })
}
export function formatCliNoProxy(entries: readonly string[]): string {
  return parseNoProxyEntries([...LOOPBACK_NO_PROXY, ...entries.map((p) => p.trim()).filter((p) => p.toLowerCase() !== '<local>' && p !== '127.*').map((p) => p.replace(/^\*\./, '.'))].join(',')).join(',')
}
export function hasEffectiveManualProxy(manual: ManualProxyConfig): boolean {
  return (manual.advanced ? [manual.httpProxy, manual.httpsProxy, manual.allProxy] : [manual.url]).some((raw) => { const result = normalizeProxyUrl(raw); return result.ok && Boolean(result.url) })
}
