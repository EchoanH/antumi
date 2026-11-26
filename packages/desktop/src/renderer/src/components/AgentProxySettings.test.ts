import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { StateCreator } from 'zustand'
import { AGENT_KINDS, createRpcClient, DEFAULT_AGENT_PROXY_SETTINGS, type AgentKind, type ChatSettings, type Environment, type RpcConnection } from '@antumi/protocol'
import { useCore } from '../core-store'
import { setLocale } from '../i18n'
import { AgentProxySettings, isGlobalProxyEffective, partitionProxyAgents, proxySummaryLines, proxyTestErrorText } from './AgentProxySettings'

vi.hoisted(() => {
  const matchMedia = () => ({ matches: false, addEventListener() {}, removeEventListener() {} })
  vi.stubGlobal('window', { antumi: undefined, matchMedia, addEventListener() {}, removeEventListener() {} })
  vi.stubGlobal('matchMedia', matchMedia)
  vi.stubGlobal('navigator', { userAgent: 'Windows', platform: 'Win32' })
})

vi.mock('zustand', async (importOriginal) => {
  const zustand = await importOriginal<typeof import('zustand')>()
  return {
    ...zustand,
    create: <T>() => (initializer: StateCreator<T>) => {
      const store = zustand.create(initializer)
      return Object.assign((selector: (state: T) => unknown) => selector(store.getState()), store)
    }
  }
})

const send = vi.fn()
const connection = (features: readonly string[]): RpcConnection => ({ ...createRpcClient(send), features, close() {}, closed: Promise.resolve() })
const makeEnv = (installed: readonly AgentKind[]): Environment => ({
  checks: AGENT_KINDS.map((tool) => ({
    tool,
    status: installed.includes(tool) ? 'ok' : 'missing',
    signedIn: null,
    version: installed.includes(tool) ? '1.0.0' : null,
    path: installed.includes(tool) ? `/bin/${tool}` : null
  })),
  checkedAt: 1,
  searchPath: []
})

const baseChatSettings = (agentProxy = DEFAULT_AGENT_PROXY_SETTINGS): ChatSettings => ({
  promptSuggestions: true,
  agentProxy
})

const render = () => renderToStaticMarkup(createElement(AgentProxySettings))

beforeEach(() => {
  send.mockClear()
  useCore.setState({
    ...useCore.getInitialState(),
    connection: 'connected',
    rpc: connection(['agent-proxy']),
    chatSettings: baseChatSettings(),
    environment: makeEnv(['codex', 'claude', 'antigravity', 'dsh'])
  }, true)
  setLocale('zh-CN')
})

afterEach(() => {
  setLocale('zh-CN')
})

describe('AgentProxySettings', () => {
  it('renders global proxy modes, test action, and all registered CLIs dynamically from AGENT_KINDS', () => {
    const html = render()
    expect(html).toContain('全局代理')
    expect(html).toContain('不使用代理')
    expect(html).toContain('跟随系统代理')
    expect(html).toContain('手动配置代理')
    expect(html).toContain('测试代理')
    expect(html).toContain('Codex')
    expect(html).toContain('Claude Code')
    expect(html).toContain('Antigravity')
    expect(html).toContain('DeepSeek Harness')
    expect(html).toContain('未安装的 CLI')
    expect(html).toContain('无法绕过系统级 TUN、虚拟网卡或透明代理')
  })

  it('shows warning when a CLI uses useProxy while global mode is none', () => {
    useCore.setState({
      chatSettings: baseChatSettings({
        ...DEFAULT_AGENT_PROXY_SETTINGS,
        mode: 'none',
        agents: { antigravity: 'useProxy', codex: 'noProxy' }
      })
    })
    const html = render()
    expect(html).toContain('全局未配置有效代理')
    expect(html).toContain('移除子进程继承的代理环境变量')
  })

  it('renders manual simple and advanced fields cleanly', () => {
    useCore.setState({
      chatSettings: baseChatSettings({
        ...DEFAULT_AGENT_PROXY_SETTINGS,
        mode: 'manual',
        manual: { url: 'http://127.0.0.1:7897', advanced: false, httpProxy: '', httpsProxy: '', allProxy: '', noProxy: '' }
      })
    })
    const simpleHtml = render()
    expect(simpleHtml).toContain('http://127.0.0.1:7897')
    expect(simpleHtml).not.toContain('id="proxy-http"')

    useCore.setState({
      chatSettings: baseChatSettings({
        ...DEFAULT_AGENT_PROXY_SETTINGS,
        mode: 'manual',
        manual: { url: '', advanced: true, httpProxy: 'http://127.0.0.1:7897', httpsProxy: 'http://127.0.0.1:7897', allProxy: 'socks5://127.0.0.1:7898', noProxy: 'localhost,.corp' }
      })
    })
    const advancedHtml = render()
    expect(advancedHtml).toContain('id="proxy-http"')
    expect(advancedHtml).toContain('id="proxy-https"')
    expect(advancedHtml).toContain('id="proxy-all"')
    expect(advancedHtml).toContain('id="proxy-no"')
    expect(advancedHtml).toContain('socks5://127.0.0.1:7898')
  })

  it('renders cleanly in English locale', () => {
    setLocale('en')
    const html = render()
    expect(html).toContain('Global proxy')
    expect(html).toContain('Follow system')
    expect(html).toContain('Per-CLI proxy policies')
    expect(html).toContain('Test proxy')
  })

  it('partitions registered CLIs dynamically and evaluates global proxy readiness accurately', () => {
    const part = partitionProxyAgents(makeEnv(['codex', 'antigravity']))
    expect(part.installed).toEqual(['codex', 'antigravity'])
    expect(part.installed.length + part.missing.length).toBe(AGENT_KINDS.length)
    expect(partitionProxyAgents(null).installed).toEqual([...AGENT_KINDS])

    expect(isGlobalProxyEffective('none', DEFAULT_AGENT_PROXY_SETTINGS.manual, null)).toBe(false)
    expect(isGlobalProxyEffective('manual', { ...DEFAULT_AGENT_PROXY_SETTINGS.manual, url: 'http://127.0.0.1:7897' }, null)).toBe(true)
    expect(isGlobalProxyEffective('manual', DEFAULT_AGENT_PROXY_SETTINGS.manual, null)).toBe(false)
    expect(isGlobalProxyEffective('system', DEFAULT_AGENT_PROXY_SETTINGS.manual, {
      os: { available: true, httpProxy: 'http://127.0.0.1:7897', httpsProxy: 'http://127.0.0.1:7897', allProxy: null, noProxy: [], source: 'windows-registry' },
      env: { present: false, httpProxy: null, httpsProxy: null, allProxy: null, noProxy: null },
      globalReady: true,
      effectiveGlobal: { available: true, httpProxy: 'http://127.0.0.1:7897', httpsProxy: 'http://127.0.0.1:7897', allProxy: null, noProxy: [] },
      checkedAt: 1
    })).toBe(true)

    expect(proxySummaryLines({ httpProxy: 'http://127.0.0.1:7897', httpsProxy: 'http://127.0.0.1:7897', allProxy: 'socks5://127.0.0.1:7898', noProxy: ['localhost'] })).toEqual([
      'HTTP / HTTPS: http://127.0.0.1:7897',
      'ALL / SOCKS: socks5://127.0.0.1:7898',
      'NO_PROXY: localhost'
    ])
    expect(proxyTestErrorText('auth-required')).toContain('407')
    expect(proxyTestErrorText('connection-refused')).toContain('连接被拒绝')
  })
})
