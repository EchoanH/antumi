import { vi } from 'vitest'
import { parseLinuxGsettingsProxy, readOsProxySettings, useSystemProxy } from './system-proxy'
import http from 'node:http'
import net from 'node:net'
import { afterEach, describe, expect, it } from 'vitest'
import { fetch } from 'undici'
import { bypassed, envProxy, parseMacProxy, parseWindowsProxy, proxyFor, readProxySettings, systemProxyDispatcher, type ProxySettings } from './system-proxy'

const REG = (lines: string) => `\r\nHKEY_CURRENT_USER\\Software\\Microsoft\\Windows\\CurrentVersion\\Internet Settings\r\n${lines}\r\n`

describe('reading the system proxy', () => {
  it('reads Windows Internet Settings, one server for all schemes or per scheme, off when disabled', () => {
    expect(parseWindowsProxy(REG('    ProxyEnable    REG_DWORD    0x1\r\n    ProxyServer    REG_SZ    127.0.0.1:7890\r\n    ProxyOverride    REG_SZ    localhost;127.*;10.*;<local>')))
      .toEqual({ http: 'http://127.0.0.1:7890', https: 'http://127.0.0.1:7890', socks: null, bypass: ['localhost', '127.*', '10.*', '<local>'] })
    expect(parseWindowsProxy(REG('    ProxyEnable    REG_DWORD    0x1\r\n    ProxyServer    REG_SZ    http=127.0.0.1:8080;https=127.0.0.1:8443;socks=127.0.0.1:1080')))
      .toEqual({ http: 'http://127.0.0.1:8080', https: 'http://127.0.0.1:8443', socks: 'socks5://127.0.0.1:1080', bypass: [] })
    expect(parseWindowsProxy(REG('    ProxyEnable    REG_DWORD    0x1\r\n    ProxyServer    REG_SZ    socks=127.0.0.1:1080'))).toEqual({ http: null, https: null, socks: 'socks5://127.0.0.1:1080', bypass: [] })
    expect(parseWindowsProxy(REG('    ProxyEnable    REG_DWORD    0x0\r\n    ProxyServer    REG_SZ    127.0.0.1:7890'))).toEqual({ http: null, https: null, socks: null, bypass: [] })
  })

  it('reads macOS proxy settings with their exceptions', () => {
    const text = `<dictionary> {
  ExceptionsList : <array> {
    0 : 192.168.0.0/16
    1 : *.local
  }
  ExcludeSimpleHostnames : 1
  HTTPEnable : 1
  HTTPPort : 7890
  HTTPProxy : 127.0.0.1
  HTTPSEnable : 1
  HTTPSPort : 7890
  HTTPSProxy : 127.0.0.1
  SOCKSEnable : 0
}`
    expect(parseMacProxy(text)).toEqual({ http: 'http://127.0.0.1:7890', https: 'http://127.0.0.1:7890', socks: null, bypass: ['192.168.0.0/16', '*.local', '<local>'] })
    expect(parseMacProxy('<dictionary> {\n  HTTPEnable : 0\n  HTTPSEnable : 0\n}')).toEqual({ http: null, https: null, socks: null, bypass: [] })
  })

  it('lets environment variables the user set win over the system', async () => {
    expect(envProxy({ https_proxy: 'proxy.corp:3128', NO_PROXY: '.corp, intranet' })).toEqual({ http: null, https: 'http://proxy.corp:3128', socks: null, bypass: ['.corp', 'intranet'] })
    expect(envProxy({})).toBeNull()
    const settings = await readProxySettings({ platform: 'win32', env: { HTTPS_PROXY: 'http://env:1' }, run: async () => { throw new Error('not asked') } })
    expect(settings.https).toBe('http://env:1')
    expect(await readProxySettings({ platform: 'win32', env: {}, run: async () => { throw new Error('no reg') } })).toEqual({ http: null, https: null, socks: null, bypass: [] })
  })

  it('sends loopback and listed hosts direct, the rest through the proxy for their scheme', () => {
    const bypass = ['*.local', '<local>', '.corp', '10.0.0.0/8', 'example.org']
    for (const host of ['localhost', '127.0.0.1', '::1', 'printer.local', 'intranet', 'git.corp', '10.2.3.4', 'example.org', 'api.example.org']) expect(bypassed(host, bypass)).toBe(true)
    for (const host of ['github.com', '11.0.0.1', 'notexample.org']) expect(bypassed(host, bypass)).toBe(false)
    const settings: ProxySettings = { http: 'http://p:1', https: 'http://p:2', bypass }
    expect(proxyFor(settings, new URL('https://github.com/x'))).toBe('http://p:2')
    expect(proxyFor(settings, new URL('http://github.com/x'))).toBe('http://p:1')
    expect(proxyFor(settings, new URL('https://git.corp/x'))).toBeNull()
  })
})

describe('routing requests', () => {
  const servers: { close(): void }[] = []
  afterEach(() => { for (const server of servers.splice(0)) server.close() })

  function listen<T extends net.Server>(server: T): Promise<number> {
    servers.push(server)
    return new Promise((resolve) => server.listen(0, '127.0.0.1', () => {
      const address = server.address()
      resolve(typeof address === 'object' && address ? address.port : 0)
    }))
  }

  it('tunnels a request through the proxy the settings name, and goes direct when they name none', async () => {
    const target = await listen(http.createServer((_request, response) => response.end('hello')))
    const tunnelled: string[] = []
    // Any host it is asked for, it reaches the local target: the client never resolves it itself.
    const proxy = http.createServer()
    proxy.on('connect', (request: http.IncomingMessage, socket: net.Socket) => {
      tunnelled.push(request.url ?? '')
      const upstream = net.connect(target, '127.0.0.1', () => {
        socket.write('HTTP/1.1 200 Connection Established\r\n\r\n')
        upstream.pipe(socket)
        socket.pipe(upstream)
      })
    })
    const proxyPort = await listen(proxy)
    let settings: ProxySettings = { http: `http://127.0.0.1:${proxyPort}`, https: null, bypass: [] }
    const dispatcher = systemProxyDispatcher(() => settings)
    expect(await (await fetch('http://plugins.example:80/zip', { dispatcher })).text()).toBe('hello')
    expect(tunnelled).toEqual(['plugins.example:80'])
    settings = { http: null, https: null, socks: null, bypass: [] }
    expect(await (await fetch(`http://127.0.0.1:${target}/`, { dispatcher })).text()).toBe('hello')
    expect(tunnelled).toHaveLength(1)
    await dispatcher.close()
  })
})

it('reads SOCKS-only OS proxies and Linux gsettings independently of environment', async () => {
  expect(parseWindowsProxy(REG('    ProxyEnable    REG_DWORD    0x1\r\n    ProxyServer    REG_SZ    socks5h://localhost:1080'))).toMatchObject({ http: null, https: null, socks: 'socks5h://localhost:1080' })
  expect(parseMacProxy('  SOCKSEnable : 1\n  SOCKSProxy : localhost\n  SOCKSPort : 1080')).toMatchObject({ socks: 'socks5://localhost:1080' })
  expect(parseLinuxGsettingsProxy("'manual'", "'proxy'", '8080', "'secure'", '8443', "'socks'", '1080', "['localhost', '*.local']")).toEqual({ http: 'http://proxy:8080', https: 'http://secure:8443', socks: 'socks5://socks:1080', bypass: ['localhost', '*.local'] })
  expect(parseLinuxGsettingsProxy("'auto'", '', '0', '', '0', '', '0', '[]')).toMatchObject({ http: null, https: null, socks: null })
  const host = { platform: 'win32' as const, env: { HTTPS_PROXY: 'http://env:80' }, run: async () => REG('    ProxyEnable    REG_DWORD    0x1\r\n    ProxyServer    REG_SZ    os:8080') }
  expect((await readOsProxySettings(host)).settings.https).toBe('http://os:8080')
  expect((await readProxySettings(host)).https).toBe('http://env:80')
  expect(envProxy({ HTTPS_PROXY: ' ', https_proxy: 'http://lower:80', ALL_PROXY: 'socks5://all:1080' })).toMatchObject({ https: 'http://lower:80', socks: null })
  const values: Record<string, string> = { 'mode': "'manual'", 'org.gnome.system.proxy.http/host': "'host'", 'org.gnome.system.proxy.http/port': '8080' }
  const linux = await readOsProxySettings({ platform: 'linux', env: {}, run: async (_command, args) => values[args[1] + '/' + args[2]] ?? values[args[2] ?? ''] ?? "''" })
  expect(linux).toMatchObject({ source: 'linux-gsettings', settings: { http: 'http://host:8080' } })
  expect(await readOsProxySettings({ platform: 'linux', env: {}, run: async () => { throw new Error('missing') } })).toEqual({ settings: { http: null, https: null, socks: null, bypass: [] }, source: 'none' })
})
it('redacts credentials when logging the Core system proxy', async () => {
  const { getGlobalDispatcher, setGlobalDispatcher } = await import('undici')
  const previous = getGlobalDispatcher()
  const log = vi.spyOn(console, 'log').mockImplementation(() => {})
  vi.useFakeTimers()
  try {
    await useSystemProxy({ platform: 'win32', env: { HTTPS_PROXY: 'http://user:secret@localhost:8080' }, run: async () => '' })
    expect(log).toHaveBeenCalledWith('[antumi-core] proxy for its own requests: http://***@localhost:8080')
    expect(JSON.stringify(log.mock.calls)).not.toContain('secret')
    await getGlobalDispatcher().close()
  } finally { setGlobalDispatcher(previous); vi.clearAllTimers(); vi.useRealTimers(); log.mockRestore() }
})

it.each(['ALL_PROXY', 'all_proxy'])('keeps the Core OS HTTP proxy when only %s is inherited', async (key) => {
  const env = { [key]: 'socks5://env:1080' }
  expect(envProxy(env)).toBeNull()
  const settings = await readProxySettings({ platform: 'win32', env, run: async () => REG('    ProxyEnable    REG_DWORD    0x1\r\n    ProxyServer    REG_SZ    os:8080') })
  expect(settings).toEqual({ http: 'http://os:8080', https: 'http://os:8080', socks: null, bypass: [] })
})
