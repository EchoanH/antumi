import { createServer, type Server } from 'node:http'
import { connect, type Socket } from 'node:net'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { ProxyAgent, getGlobalDispatcher, setGlobalDispatcher } from 'undici'
import { AGENT_KINDS, AGENT_PROXY_POLICIES, GLOBAL_PROXY_MODES, AgentProxySettings, type GlobalProxyMode } from '@antumi/protocol'
import { AgentProxyService, PROXY_UNSET_KEYS, applyActiveAgentProxy, blankProxyUnset, buildActiveAgentChildEnv, buildProxyEnvVars, proxyTestErrorCode, readExplicitEnvProxy, refreshActiveAgentProxy, resolveAgentProxy, setActiveAgentProxy } from './agent-proxy'
import type { ProxyHost } from './system-proxy'

const osProxy = { http: 'http://os:8080', https: 'http://os:8443', socks: 'socks5://os:1080', bypass: ['*.corp'] }
const settings = (mode: GlobalProxyMode = 'manual') => AgentProxySettings.parse({ mode, manual: { url: 'http://user:secret@manual:7897', noProxy: '*.corp;<local>;127.*' } })
const host: ProxyHost = { platform: 'linux', env: {}, run: async () => { throw new Error('no settings') } }
const services: AgentProxyService[] = []
afterEach(async () => { setActiveAgentProxy(null); await Promise.all(services.splice(0).map((service) => service.close())) })
const service = (config = settings(), onHost = host) => { const value = new AgentProxyService(config, onHost); services.push(value); return value }

describe('agent proxy policy matrix', () => {
  for (const mode of GLOBAL_PROXY_MODES) for (const policy of AGENT_PROXY_POLICIES) for (const inherited of [false, true]) {
    it(mode + ' / ' + policy + ' / inherited=' + inherited, () => {
      const config = { ...settings(mode), agents: { codex: policy } }
      const result = resolveAgentProxy(config, 'codex', { env: inherited ? { HTTPS_PROXY: 'http://inherited:80', NO_PROXY: '.env' } : {}, osProxy, platform: 'linux' })
      if (policy === 'noProxy') expect(result).toMatchObject({ mode: 'direct', env: {}, unsetEnv: [...PROXY_UNSET_KEYS], httpProxy: null, httpsProxy: null, allProxy: null, bypass: [] })
      else if (policy === 'followGlobal' && inherited) expect(result).toMatchObject({ mode: 'inherit-env', env: {}, unsetEnv: [], httpsProxy: 'http://inherited:80', httpProxy: null, bypass: ['.env'] })
      else if (mode === 'none') expect(result).toMatchObject({ mode: 'direct', env: {}, unsetEnv: policy === 'useProxy' ? [...PROXY_UNSET_KEYS] : [], warning: policy === 'useProxy' ? 'global-proxy-unavailable' : undefined })
      else expect(result).toMatchObject({ mode: 'inject', unsetEnv: [...PROXY_UNSET_KEYS], httpsProxy: mode === 'system' ? osProxy.https : 'http://user:secret@manual:7897', env: { NO_PROXY: 'localhost,127.0.0.1,::1,.corp' } })
    })
  }
  it('isolates policies across every registered CLI', () => {
    const config = AgentProxySettings.parse({ ...settings(), agents: { antigravity: 'useProxy', codex: 'noProxy', claude: 'followGlobal', dsh: 'noProxy' } })
    for (const agent of AGENT_KINDS) {
      const result = resolveAgentProxy(config, agent, { env: { HTTP_PROXY: 'http://env:80' }, osProxy, platform: 'linux' })
      expect(result.mode).toBe(agent === 'codex' || agent === 'dsh' ? 'direct' : agent === 'antigravity' ? 'inject' : 'inherit-env')
    }
  })
  it('supports advanced fields, empty uppercase fallback, and Windows case-insensitive lookup', () => {
    const config = AgentProxySettings.parse({ mode: 'manual', manual: { advanced: true, httpProxy: 'host:8080', allProxy: 'socks5h://host:1080' } })
    expect(resolveAgentProxy(config, 'codex', { env: {}, osProxy, platform: 'win32' })).toMatchObject({ httpProxy: 'http://host:8080', httpsProxy: null, allProxy: 'socks5h://host:1080' })
    expect(readExplicitEnvProxy({ HTTP_PROXY: ' ', http_proxy: 'http://lower:80' }, 'linux').http).toBe('http://lower:80')
    expect(readExplicitEnvProxy({ Http_Proxy: ' http://mixed:80 ' }, 'win32').http).toBe('http://mixed:80')
    expect(readExplicitEnvProxy({ Http_Proxy: 'http://mixed:80' }, 'linux').present).toBe(false)
  })
})
it.each(['win32', 'darwin', 'linux'] as const)('constructs canonical proxy env on %s', (platform) => {
  const env = buildProxyEnvVars({ http: 'http://p:80', https: 'http://p:81', all: 'socks5://p:1080', bypass: ['*.corp', '<local>', '127.*'] }, platform)
  expect(env.NO_PROXY).toBe('localhost,127.0.0.1,::1,.corp')
  if (platform === 'win32') expect(Object.keys(env)).toEqual(['NO_PROXY', 'HTTP_PROXY', 'HTTPS_PROXY', 'ALL_PROXY'])
  else for (const key of ['HTTP_PROXY', 'HTTPS_PROXY', 'ALL_PROXY', 'NO_PROXY']) expect(env[key.toLowerCase()]).toBe(env[key])
})
it('removes stale caller and inherited overrides while keeping unrelated launch exclusions', () => {
  const config = AgentProxySettings.parse({ ...settings(), agents: { codex: 'useProxy', dsh: 'noProxy' } })
  const value = service(config, { ...host, platform: 'win32', env: { Http_Proxy: 'old', npm_config_proxy: 'stale', Path: 'bin', SECRET: 'secret' } })
  const result = value.applyToLaunch('codex', { hTtP_pRoXy: 'stale', npm_config_proxy: 'old', GIVEN: 'yes' }, ['SECRET'])
  expect(result.env).toMatchObject({ HTTP_PROXY: config.manual.url, GIVEN: 'yes' })
  expect(result.env.hTtP_pRoXy).toBeUndefined()
  const child = value.buildChildEnv('codex', result.env, result.unsetEnv)
  expect(child.SECRET).toBeUndefined()
  expect(child.Path).toBe('bin')
  expect(Object.keys(child).filter((key) => key.toLowerCase() === 'http_proxy')).toEqual(['HTTP_PROXY'])
  expect(value.buildChildEnv('dsh', { HTTPS_PROXY: 'stale' })).not.toHaveProperty('HTTPS_PROXY')
  expect(result.unsetEnv).toContain('SECRET')
  setActiveAgentProxy(value)
  expect(applyActiveAgentProxy('dsh').unsetEnv).toContain('npm_config_proxy')
})
it('reports redacted OS, inherited, and draft global settings and applies updates immediately', async () => {
  let reads = 0
  const value = service(settings('system'), { platform: 'win32', env: { HTTPS_PROXY: 'http://env:secret@env:80' }, run: async () => { reads++; return '    ProxyEnable    REG_DWORD    0x1\n    ProxyServer    REG_SZ    user:secret@os:8080' } })
  const status = await value.status()
  expect(status).toMatchObject({ globalReady: true, os: { source: 'windows-registry', httpProxy: 'http://***@os:8080' }, env: { httpsProxy: 'http://***@env:80' } })
  expect(JSON.stringify(status)).not.toContain('secret')
  await value.status(); expect(reads).toBe(1)
  await value.status(true); expect(reads).toBe(2)
  await value.updateSettings(settings('none'))
  expect((await value.status()).globalReady).toBe(false)
  expect((await value.test()).errorCode).toBe('no-proxy-configured')
})

it('refreshes expired system settings before launch and deduplicates simultaneous checks', async () => {
  let now = 100_000, reads = 0, enabled = true
  const clock = vi.spyOn(Date, 'now').mockImplementation(() => now)
  const value = service(settings('system'), {
    platform: 'win32', env: {}, run: async () => {
      reads++
      return '    ProxyEnable    REG_DWORD    ' + (enabled ? '0x1' : '0x0') + '\n    ProxyServer    REG_SZ    127.0.0.1:7897'
    }
  })
  setActiveAgentProxy(value)
  try {
    await refreshActiveAgentProxy()
    expect(reads).toBe(1)
    expect(value.applyToLaunch('codex').env.HTTP_PROXY).toBe('http://127.0.0.1:7897')
    enabled = false
    now += 2_999
    await value.ensureFresh()
    expect(reads).toBe(1)
    now++
    await Promise.all([value.ensureFresh(), value.ensureFresh(), refreshActiveAgentProxy()])
    expect(reads).toBe(2)
    expect(value.applyToLaunch('codex').env).toEqual({})
    enabled = true
    await refreshActiveAgentProxy(0)
    expect(reads).toBe(3)
    expect(value.applyToLaunch('codex').env.HTTP_PROXY).toBe('http://127.0.0.1:7897')
    await value.updateSettings(settings('none'))
    const previousReads = reads
    await value.ensureFresh(0)
    expect(reads).toBe(previousReads)
  } finally { clock.mockRestore() }
})

it('forwards custom inherited env separately from overrides with and without an active service', () => {
  const inherited = { HTTP_PROXY: 'http://old:8080', KEEP: 'caller', DROP: 'excluded' }
  expect(buildActiveAgentChildEnv('codex', { EXTRA: 'yes' }, ['DROP'], inherited)).toEqual({ HTTP_PROXY: 'http://old:8080', KEEP: 'caller', EXTRA: 'yes' })
  const value = service(AgentProxySettings.parse({ ...settings(), agents: { codex: 'noProxy' } }))
  setActiveAgentProxy(value)
  expect(buildActiveAgentChildEnv('codex', { EXTRA: 'yes' }, ['DROP'], inherited)).toEqual({ KEEP: 'caller', EXTRA: 'yes' })
  expect(inherited).toEqual({ HTTP_PROXY: 'http://old:8080', KEEP: 'caller', DROP: 'excluded' })
})

it.each(['ftp://example.com/', 'file:///tmp/proxy-test', 'data:text/plain,test'])('rejects non-HTTP(S) test targets: %s', async (targetUrl) => {
  expect(await service().test({ targetUrl })).toMatchObject({ ok: false, targetUrl, proxyUsed: null, statusCode: null, latencyMs: 0, errorCode: 'invalid-proxy-url' })
})

async function listen(server: Server): Promise<number> {
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const address = server.address()
  if (!address || typeof address === 'string') throw new Error('missing port')
  return address.port
}
async function proxyFixture(redirectHost?: string) {
  const sockets = new Set<Socket>()
  const target = createServer((request, response) => {
    if (redirectHost && request.url === '/redirect') response.writeHead(302, { location: 'http://' + redirectHost + ':' + port + '/direct' })
    else response.writeHead(204)
    response.end()
  })
  const port = await listen(target)
  let reject = false
  const connections: Array<{ target: string | undefined; authorization: string | undefined }> = []
  const proxy = createServer()
  proxy.on('connect', (request, client, head) => {
    connections.push({ target: request.url, authorization: request.headers['proxy-authorization'] })
    if (reject) { client.end('HTTP/1.1 407 Proxy Authentication Required\r\nConnection: close\r\n\r\n'); return }
    const upstream = connect(port, '127.0.0.1', () => { client.write('HTTP/1.1 200 Connection Established\r\n\r\n'); if (head.length) upstream.write(head); upstream.pipe(client); client.pipe(upstream) })
    sockets.add(upstream)
    upstream.on('error', () => client.destroy())
    client.on('error', () => upstream.destroy())
    client.on('close', () => upstream.destroy())
  })
  for (const server of [target, proxy]) server.on('connection', (socket) => { sockets.add(socket); socket.on('close', () => sockets.delete(socket)) })
  const proxyPort = await listen(proxy)
  return { port, proxyPort, connections, reject: () => { reject = true }, close: async () => { for (const socket of sockets) socket.destroy(); await Promise.all([target, proxy].map((server) => new Promise<void>((resolve) => server.close(() => resolve())))) } }
}
it('tests real authenticated HTTP CONNECT proxies and maps failures without leaking credentials', async () => {
  const fixture = await proxyFixture()
  const url = 'http://user:secret@127.0.0.1:' + fixture.proxyPort
  const value = service(AgentProxySettings.parse({ mode: 'manual', manual: { url } }))
  try {
    const result = await value.test({ targetUrl: 'http://upstream.invalid/' })
    expect(result).toMatchObject({ ok: true, statusCode: 204, errorCode: null, proxyUsed: 'http://***@127.0.0.1:' + fixture.proxyPort })
    expect(result.latencyMs).toBeGreaterThanOrEqual(0)
    expect(fixture.connections[0]?.authorization).toBe('Basic ' + Buffer.from('user:secret').toString('base64'))
    const httpOnly = AgentProxySettings.parse({ mode: 'manual', manual: { advanced: true, httpProxy: url } })
    expect(await value.test({ settings: httpOnly })).toMatchObject({ ok: true, targetUrl: 'http://cp.cloudflare.com/generate_204' })
    fixture.reject()
    expect(await value.test({ targetUrl: 'http://upstream.invalid/' })).toMatchObject({ ok: false, statusCode: 407, errorCode: 'auth-required' })
    const closed = createServer(); const closedPort = await listen(closed); await new Promise<void>((resolve) => closed.close(() => resolve()))
    const refused = await value.test({ settings: { mode: 'manual', manual: { ...settings().manual, url: 'http://user:secret@127.0.0.1:' + closedPort } }, targetUrl: 'http://upstream.invalid/' })
    expect(refused).toMatchObject({ ok: false, errorCode: 'connection-refused' })
    expect(JSON.stringify(refused)).not.toContain('secret')
    expect((await value.test({ settings: { mode: 'manual', manual: { ...settings().manual, url: '' } } })).errorCode).toBe('no-proxy-configured')
    expect((await value.test({ settings: { mode: 'manual', manual: { ...settings().manual, url: 'ftp://host:21' } } })).errorCode).toBe('unsupported-protocol')
  } finally { await fixture.close() }
})
it('routes scoped requests through proxy, bypasses loopback and noProxy, and ignores Core global dispatcher', async () => {
  const fixture = await proxyFixture()
  const value = service(AgentProxySettings.parse({ mode: 'manual', manual: { url: 'http://127.0.0.1:' + fixture.proxyPort }, agents: { codex: 'useProxy', dsh: 'noProxy' } }))
  const previous = getGlobalDispatcher()
  const poison = new ProxyAgent('http://127.0.0.1:1')
  setGlobalDispatcher(poison)
  try {
    expect((await value.fetchForAgent('codex', 'http://upstream.invalid/')).status).toBe(204)
    expect(fixture.connections).toHaveLength(1)
    await expect(value.fetchForAgent('dsh', 'http://upstream.invalid/', { signal: AbortSignal.timeout(2000) })).rejects.toThrow()
    expect(fixture.connections).toHaveLength(1)
    for (const agent of ['codex', 'dsh'] as const) expect((await value.fetchForAgent(agent, 'http://127.0.0.1:' + fixture.port + '/oauth/callback')).status).toBe(204)
    await value.updateSettings(AgentProxySettings.parse({ mode: 'none' }))
    expect((await value.fetchForAgent('codex', 'http://127.0.0.1:' + fixture.port)).status).toBe(204)
    expect(fixture.connections).toHaveLength(1)
  } finally { setGlobalDispatcher(previous); await poison.close(); await fixture.close() }
})
it.each(['socks5', 'socks5h', 'socks'])('accepts undici 7 SOCKS scheme %s without treating it as HTTP', async (scheme) => {
  const value = service(AgentProxySettings.parse({ mode: 'manual', manual: { url: scheme + '://127.0.0.1:1' }, agents: { codex: 'useProxy' } }))
  const result = await value.test({ targetUrl: 'http://upstream.invalid/' })
  expect(result.errorCode).toBe('connection-refused')
  expect(result.message).not.toContain('Invalid URL')
})

it.each([false, true])('materializes inherited proxy variables and exclusions for clean=%s launches', (clean) => {
  const value = service(settings('none'), { ...host, env: { HTTPS_PROXY: 'http://explicit:7897', NO_PROXY: '*.corp', SECRET: 'must-not-copy' } })
  const launch = value.applyToLaunch('claude', { GIVEN: 'yes' }, ['ANTIGRAVITY_API_KEY'], clean)
  expect(launch.env).toMatchObject({ HTTPS_PROXY: 'http://explicit:7897', NO_PROXY: 'localhost,127.0.0.1,::1,.corp', GIVEN: 'yes' })
  expect(launch.env).not.toHaveProperty('SECRET')
  expect(launch.env).not.toHaveProperty('ALL_PROXY')
  expect(launch.unsetEnv).toEqual(['ANTIGRAVITY_API_KEY', ...PROXY_UNSET_KEYS])
})

it.each([
  ['Proxy response (407) !== 200', 'auth-required'],
  ['ECONNREFUSED', 'connection-refused'],
  ['TimeoutError', 'timeout'],
  ['AbortError', 'timeout'],
  ['ETIMEDOUT', 'timeout'],
  ['SOCKS5 connection timeout', 'timeout'],
  ['DEPTH_ZERO_SELF_SIGNED_CERT', 'tls-error'],
  ['UNABLE_TO_VERIFY_LEAF_SIGNATURE', 'tls-error'],
  ['ERR_TLS_CERT_ALTNAME_INVALID', 'tls-error'],
  ['ENOTFOUND', 'dns-error'],
  ['EAI_AGAIN', 'dns-error'],
  ['ECONNRESET', 'network-error']
] as const)('classifies nested proxy errors: %s', (code, expected) => {
  expect(proxyTestErrorCode(new Error('fetch failed', { cause: Object.assign(new Error('request failed'), { code }) }))).toBe(expected)
})

it.each(['win32', 'linux'] as const)('materializes the caller inherited environment on %s', (platform) => {
  const value = service(settings('none'), { ...host, platform, env: { HTTPS_PROXY: 'http://core:80' } })
  const inherited = { HTTP_PROXY: 'http://caller:8080', NO_PROXY: '.caller', KEEP: 'caller' }
  const child = value.buildChildEnv('codex', { EXTRA: 'yes' }, [], inherited)
  expect(child).toMatchObject({ HTTP_PROXY: 'http://caller:8080', NO_PROXY: 'localhost,127.0.0.1,::1,.caller', KEEP: 'caller', EXTRA: 'yes' })
  expect(child).not.toHaveProperty('HTTPS_PROXY')
  const launch = value.applyToLaunch('codex', {}, [], false, inherited)
  expect(launch.env.HTTP_PROXY).toBe('http://caller:8080')
  expect(launch.unsetEnv).toEqual([...PROXY_UNSET_KEYS])
})

it.each(['noProxy', 'useProxy'] as const)('clears all npm HTTP and bypass variants under %s', (policy) => {
  const npmEnv = { npm_config_http_proxy: 'http://stale:80', npm_config_no_proxy: '*', NPM_CONFIG_HTTP_PROXY: 'http://stale:81', NPM_CONFIG_NO_PROXY: '*' }
  for (const platform of ['win32', 'linux'] as const) {
    const value = service({ ...settings(), agents: { codex: policy } }, { ...host, platform, env: npmEnv })
    const launch = value.applyToLaunch('codex', npmEnv)
    const child = value.buildChildEnv('codex', npmEnv)
    for (const key of Object.keys(npmEnv)) {
      expect(launch.unsetEnv).toContain(key)
      expect(launch.env).not.toHaveProperty(key)
      expect(child).not.toHaveProperty(key)
    }
  }
})

it('refreshes the active OS proxy at the requested max age boundary', async () => {
  let now = 100_000
  const clock = vi.spyOn(Date, 'now').mockImplementation(() => now)
  const run = vi.fn(async () => '    ProxyEnable    REG_DWORD    0x1\n    ProxyServer    REG_SZ    os:8080')
  const value = service(settings('system'), { platform: 'win32', env: {}, run })
  setActiveAgentProxy(value)
  try {
    await value.ensureFresh(50)
    now += 49
    await refreshActiveAgentProxy(50)
    expect(run).toHaveBeenCalledTimes(1)
    now++
    await refreshActiveAgentProxy(50)
    expect(run).toHaveBeenCalledTimes(2)
  } finally { clock.mockRestore() }
})

it('dispatches a proxied redirect to loopback directly', async () => {
  const fixture = await proxyFixture('127.0.0.1')
  const value = service(AgentProxySettings.parse({ mode: 'manual', manual: { url: 'http://127.0.0.1:' + fixture.proxyPort } }))
  try {
    const response = await value.fetchForAgent('codex', 'http://upstream.invalid/redirect')
    await response.body?.cancel()
    expect(response.status).toBe(204)
    expect(response.url).toBe('http://127.0.0.1:' + fixture.port + '/direct')
    expect(fixture.connections.map((connection) => connection.target)).toEqual(['upstream.invalid:80'])
  } finally { await fixture.close() }
})

it('keeps a proxy the launch names itself under followGlobal, and only there', () => {
  const value = service(settings(), { ...host, env: { HTTPS_PROXY: 'http://inherited:80' } })
  const given = value.applyToLaunch('claude', { HTTPS_PROXY: 'http://account:3128', GIVEN: 'yes' })
  expect(given.env).toMatchObject({ HTTPS_PROXY: 'http://account:3128', https_proxy: 'http://account:3128', GIVEN: 'yes' })
  expect(given.unsetEnv).toEqual([...PROXY_UNSET_KEYS])
  const forced = service(AgentProxySettings.parse({ ...settings(), agents: { claude: 'useProxy' } })).applyToLaunch('claude', { HTTPS_PROXY: 'http://account:3128' })
  expect(forced.env.HTTPS_PROXY).toBe('http://user:secret@manual:7897')
})
it.each(['win32', 'linux'] as const)('blanks proxy variables for a daemon without unset-env on %s', (platform) => {
  const result = blankProxyUnset({ env: { HTTPS_PROXY: 'http://p:1' }, unsetEnv: ['SECRET', ...PROXY_UNSET_KEYS] }, platform)
  expect(result.unsetEnv).toEqual(['SECRET'])
  expect(result.env.HTTPS_PROXY).toBe('http://p:1')
  expect(result.env.HTTP_PROXY).toBe('')
  if (platform === 'win32') expect(Object.keys(result.env).filter((key) => key.toUpperCase() === 'HTTPS_PROXY')).toEqual(['HTTPS_PROXY'])
  else expect(result.env.https_proxy).toBe('')
})
