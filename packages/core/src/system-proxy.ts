import { redactProxyUrl, type SystemProxySource } from '@antumi/protocol'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { Agent, Dispatcher, ProxyAgent, setGlobalDispatcher } from 'undici'

// The proxy the user set for their computer, which a browser uses and Node's fetch does not: a VPN
// in system-proxy mode leaves direct connections to GitHub timing out, so core's own requests
// (plugins, pets, release checks) go through it as the browser would. Agents are separate processes;
// which proxy they get is agent-proxy.ts's to decide.
export type ProxySettings = {
  socks?: string | null
  http: string | null
  https: string | null
  // Hosts that go direct besides loopback, as the system lists them: exact, *-globs, .suffixes,
  // and <local> for names without a dot.
  bypass: string[]
}
const NONE: ProxySettings = { http: null, https: null, socks: null, bypass: [] }
const REFRESH_MS = 30_000
const execute = promisify(execFile)

function proxyAddress(value: string): string | null {
  const trimmed = value.trim()
  if (!trimmed) return null
  return /^[a-z][a-z0-9+.-]*:\/\//i.test(trimmed) ? trimmed : `http://${trimmed}`
}

// `reg query` of Internet Settings. ProxyServer is one host:port for every scheme, or
// scheme=host:port pairs; SOCKS is kept separately for CLI agents.
export function parseWindowsProxy(text: string): ProxySettings {
  const values = new Map<string, string>()
  for (const line of text.split(/\r?\n/)) {
    const match = /^\s+(\S+)\s+REG_\w+\s+(.*)$/.exec(line)
    if (match?.[1] && match[2] !== undefined) values.set(match[1], match[2].trim())
  }
  if (Number(values.get('ProxyEnable') ?? '0') === 0) return NONE
  const server = values.get('ProxyServer') ?? ''
  const bypass = (values.get('ProxyOverride') ?? '').split(';').map((each) => each.trim()).filter(Boolean)
  if (!/^[a-z][a-z0-9+.-]*\s*=/i.test(server)) {
    const address = proxyAddress(server)
    if (address && /^socks(?:5h?)?:/i.test(address)) return { http: null, https: null, socks: address, bypass }
    return { http: address, https: address, socks: null, bypass }
  }
  const schemes = new Map(server.split(';').map((pair) => { const index = pair.indexOf('='); return [pair.slice(0, index), pair.slice(index + 1)] }).flatMap(([scheme, address]) => scheme && address ? [[scheme.trim().toLowerCase(), address]] : []))
  const http = schemes.get('http')
  const https = schemes.get('https') ?? http
  const socks = schemes.get('socks')
  return { http: http ? proxyAddress(http) : null, https: https ? proxyAddress(https) : null, socks: socks ? (/^[a-z][a-z0-9+.-]*:\/\//i.test(socks) ? socks : 'socks5://' + socks.trim()) : null, bypass }
}

// `scutil --proxy`, macOS's current proxy settings.
export function parseMacProxy(text: string): ProxySettings {
  const value = (key: string) => new RegExp(`^\\s*${key} : (.+)$`, 'm').exec(text)?.[1]?.trim() ?? null
  const proxy = (scheme: 'HTTP' | 'HTTPS') => {
    const host = value(`${scheme}Proxy`)
    const port = value(`${scheme}Port`)
    return value(`${scheme}Enable`) === '1' && host ? proxyAddress(port ? `${host}:${port}` : host) : null
  }
  const list = /ExceptionsList : <array> \{([^}]*)\}/.exec(text)?.[1] ?? ''
  const bypass = [...list.matchAll(/^\s*\d+ : (.+)$/gm)].flatMap((match) => match[1] ? [match[1].trim()] : [])
  if (value('ExcludeSimpleHostnames') === '1') bypass.push('<local>')
  const socksHost = value('SOCKSProxy')
  const socksPort = value('SOCKSPort')
  const socks = value('SOCKSEnable') === '1' && socksHost ? 'socks5://' + socksHost + (socksPort ? ':' + socksPort : '') : null
  return { http: proxy('HTTP'), https: proxy('HTTPS'), socks, bypass }
}

// HTTPS_PROXY and the like, which a user who sets them means; null when none is set.
export function envProxy(env: NodeJS.ProcessEnv): ProxySettings | null {
  const read = (name: string) => env[name]?.trim() || env[name.toLowerCase()]?.trim() || ''
  const https = read('HTTPS_PROXY')
  const http = read('HTTP_PROXY')
  if (!https && !http) return null
  const bypass = (read('NO_PROXY') ?? '').split(',').map((each) => each.trim()).filter(Boolean)
  return { http: http ? proxyAddress(http) : null, https: https ? proxyAddress(https) : http ? proxyAddress(http) : null, socks: null, bypass }
}

function loopback(host: string): boolean {
  return host === 'localhost' || host.endsWith('.localhost') || host === '::1' || host === '[::1]' || /^127\./.test(host)
}

function ipv4(text: string): number | null {
  const parts = text.split('.')
  if (parts.length !== 4 || parts.some((part) => !/^\d{1,3}$/.test(part) || Number(part) > 255)) return null
  return parts.reduce((value, part) => value * 256 + Number(part), 0)
}

// 10.0.0.0/8 and the like, as macOS lists private ranges.
function inRange(host: string, pattern: string): boolean {
  const [base, bits] = pattern.split('/')
  const address = ipv4(host)
  const network = base ? ipv4(base) : null
  const size = Number(bits)
  if (address === null || network === null || !Number.isInteger(size) || size < 0 || size > 32) return false
  const block = 2 ** (32 - size)
  return Math.floor(address / block) === Math.floor(network / block)
}

export function bypassed(host: string, bypass: readonly string[]): boolean {
  const name = host.toLowerCase()
  if (loopback(name)) return true
  return bypass.some((entry) => {
    const pattern = entry.toLowerCase()
    if (pattern === '*') return true
    if (pattern === '<local>') return !name.includes('.')
    if (pattern.includes('/')) return inRange(name, pattern)
    if (pattern.includes('*')) return new RegExp(`^${pattern.split('*').map((part) => part.replace(/[.+?^${}()|[\]\\]/g, '\\$&')).join('.*')}$`).test(name)
    const bare = pattern.replace(/^\./, '')
    return name === bare || name.endsWith(`.${bare}`)
  })
}

export function proxyFor(settings: ProxySettings, url: URL): string | null {
  if (bypassed(url.hostname, settings.bypass)) return null
  return url.protocol === 'https:' ? settings.https : url.protocol === 'http:' ? settings.http : null
}

export type ProxyHost = { platform: NodeJS.Platform; env: NodeJS.ProcessEnv; run(command: string, args: string[]): Promise<string> }
const thisHost: ProxyHost = {
  platform: process.platform,
  env: process.env,
  run: async (command, args) => (await execute(command, args, { timeout: 5000, windowsHide: true })).stdout
}

export function parseLinuxGsettingsProxy(mode: string, httpHost: string, httpPort: string, httpsHost: string, httpsPort: string, socksHost: string, socksPort: string, ignoreHosts: string): ProxySettings {
  const unquote = (value: string) => value.trim().replace(/^['"]|['"]$/g, '')
  if (unquote(mode) !== 'manual') return NONE
  const address = (host: string, port: string, scheme: string) => unquote(host) ? scheme + unquote(host) + ':' + port.trim() : null
  return { http: address(httpHost, httpPort, 'http://'), https: address(httpsHost, httpsPort, 'http://'), socks: address(socksHost, socksPort, 'socks5://'), bypass: [...ignoreHosts.matchAll(/['"]([^'"]+)['"]/g)].flatMap((match) => match[1] ? [match[1]] : []) }
}
export async function readLinuxProxy(host: ProxyHost): Promise<ProxySettings | null> {
  try {
    const get = (schema: string, key: string) => host.run('gsettings', ['get', 'org.gnome.system.proxy' + schema, key])
    const [mode, httpHost, httpPort, httpsHost, httpsPort, socksHost, socksPort, ignoreHosts] = await Promise.all([get('', 'mode'), get('.http', 'host'), get('.http', 'port'), get('.https', 'host'), get('.https', 'port'), get('.socks', 'host'), get('.socks', 'port'), get('', 'ignore-hosts')])
    return parseLinuxGsettingsProxy(mode, httpHost, httpPort, httpsHost, httpsPort, socksHost, socksPort, ignoreHosts)
  } catch { return null }
}
export async function readOsProxySettings(host: ProxyHost = thisHost): Promise<{ settings: ProxySettings; source: SystemProxySource }> {
  try {
    if (host.platform === 'win32') return { settings: parseWindowsProxy(await host.run('reg', ['query', 'HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Internet Settings'])), source: 'windows-registry' }
    if (host.platform === 'darwin') return { settings: parseMacProxy(await host.run('scutil', ['--proxy'])), source: 'macos-scutil' }
    if (host.platform === 'linux') {
      const settings = await readLinuxProxy(host)
      if (settings) return { settings, source: 'linux-gsettings' }
    }
  } catch { /* OS discovery is best effort. */ }
  return { settings: NONE, source: 'none' }
}
export async function readProxySettings(host: ProxyHost = thisHost): Promise<ProxySettings> {
  return envProxy(host.env) ?? (await readOsProxySettings(host)).settings
}

// Sends each request direct or through the proxy its host calls for, as the settings stand now.
class SystemProxyDispatcher extends Dispatcher {
  private readonly direct = new Agent()
  private readonly proxies = new Map<string, ProxyAgent>()

  constructor(private readonly settings: () => ProxySettings) {
    super()
  }

  override dispatch(options: Dispatcher.DispatchOptions, handler: Dispatcher.DispatchHandler): boolean {
    const origin = options.origin === undefined ? null : new URL(String(options.origin))
    const proxy = origin ? proxyFor(this.settings(), origin) : null
    if (!proxy) return this.direct.dispatch(options, handler)
    let agent = this.proxies.get(proxy)
    if (!agent) {
      agent = new ProxyAgent(proxy)
      this.proxies.set(proxy, agent)
    }
    return agent.dispatch(options, handler)
  }

  override async close(): Promise<void> {
    await Promise.all([this.direct.close(), ...[...this.proxies.values()].map((agent) => agent.close())])
  }

  override async destroy(): Promise<void> {
    await Promise.all([this.direct.destroy(), ...[...this.proxies.values()].map((agent) => agent.destroy())])
  }
}

export function systemProxyDispatcher(settings: () => ProxySettings): Dispatcher {
  return new SystemProxyDispatcher(settings)
}

let current: ProxySettings = NONE

// The proxy core's requests to `url` take now, for saying so when one fails.
export function currentProxyFor(url: string): string | null {
  try {
    return proxyFor(current, new URL(url))
  } catch {
    return null
  }
}

// Reads the settings now and every half minute, so a VPN switched on or off is followed without a
// restart, and routes every fetch of this process by them.
export async function useSystemProxy(host: ProxyHost = thisHost): Promise<void> {
  const refresh = async () => {
    const next = await readProxySettings(host)
    if (JSON.stringify(next) !== JSON.stringify(current)) console.log(`[antumi-core] proxy for its own requests: ${redactProxyUrl(next.https ?? next.http) ?? 'none'}`)
    current = next
  }
  await refresh()
  setGlobalDispatcher(systemProxyDispatcher(() => current))
  setInterval(() => void refresh().catch(() => {}), REFRESH_MS).unref()
}
