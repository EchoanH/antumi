import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { StateCreator } from 'zustand'
import { createRpcClient, initialAgentCliStatus, ModelProvider, type AgentCliStatus, type AgentKind, type Environment, type RpcConnection } from '@antumi/protocol'
import { useCore } from '../core-store'
import { setLocale } from '../i18n'
import { DEFAULT_PREFERENCES, usePreferences } from '../preferences'
import { InstalledAgentsSettings } from './InstalledAgentsSettings'

vi.hoisted(() => {
  const matchMedia = () => ({ matches: false, addEventListener() {}, removeEventListener() {} })
  vi.stubGlobal('window', { antumi: undefined, matchMedia, addEventListener() {}, removeEventListener() {} })
  vi.stubGlobal('matchMedia', matchMedia)
  vi.stubGlobal('navigator', { userAgent: 'Mac', platform: 'MacIntel' })
})

vi.mock('zustand', async (importOriginal) => {
  const zustand = await importOriginal<typeof import('zustand')>()
  return { ...zustand, create: <T>() => (initializer: StateCreator<T>) => {
    const store = zustand.create(initializer)
    return Object.assign((selector: (state: T) => unknown) => selector(store.getState()), store)
  } }
})

const check = (tool: AgentKind): Environment => ({ checks: [{ tool, status: 'ok', signedIn: null, version: '1.0.0', path: `/bin/${tool}` }], checkedAt: 0, searchPath: [] })
const render = () => renderToStaticMarkup(createElement(InstalledAgentsSettings))
const send = vi.fn()
const connection = (features: readonly string[]): RpcConnection => ({ ...createRpcClient(send), features, close() {}, closed: Promise.resolve() })

beforeEach(() => {
  send.mockClear()
  const rpc = connection(['chat-catalog-refresh'])
  useCore.setState({ ...useCore.getInitialState(), connection: 'connected', environment: check('dsh'), rpc }, true)
  usePreferences.setState(DEFAULT_PREFERENCES, true)
  setLocale('zh-CN')
})

describe('InstalledAgentsSettings', () => {
  it('offers an explicit model check without labelling unverified DSH as signed out', () => {
    const html = render()
    expect(html).toContain('已安装 · 本机模型未验证')
    expect(html).toContain('验证本机模型')
    expect(html).not.toContain('尚未确认登录状态')
    expect(html).not.toContain('登录：')
    expect(send).not.toHaveBeenCalled()
  })

  it('does not offer the catalog check for a disabled agent', () => {
    usePreferences.setState({ disabledAgents: ['dsh'] })
    expect(render()).not.toContain('验证本机模型')
  })

  it('offers a model-picker fallback when the core cannot refresh catalogs', () => {
    useCore.setState({ rpc: connection([]) })
    const html = render()
    expect(html).toContain('已安装 · 本机模型未验证')
    expect(html).toContain('沿用本机配置')
    expect(html).toContain('检查 DeepSeek Harness 的模型设置')
    expect(html).not.toContain('验证本机模型')
  })

  it('keeps the native check available alongside an Antumi provider', () => {
    const provider = ModelProvider.parse({ id: 'example', name: 'Example', preset: 'custom', anthropic: null,
      openai: { responsesUrl: 'https://example.com/v1', chatUrl: null },
      models: [{ id: 'model', label: null, contextWindow: null, maxOutput: null, efforts: [] }],
      defaultModel: 'model', smallModel: 'model', agents: ['dsh'], hasKey: true, revision: 1, createdAt: 0, updatedAt: 0 })
    useCore.setState({ modelProviders: [provider] })
    const html = render()
    expect(html).toContain('验证本机模型')
    expect(html).not.toContain('已安装 · 本机模型未验证')
  })

  it('offers a release Antumi was not checked with, naming the way back', () => {
    const status = (compatibility: AgentCliStatus['compatibility']): AgentCliStatus => ({ ...initialAgentCliStatus('dsh'), currentVersion: '1.0.0', latestVersion: '1.1.0',
      path: '/bin/dsh', channel: 'npm', availability: 'available', canUpgrade: true, checkedAt: 1, compatibility })
    useCore.setState({ rpc: connection(['agent-cli-maintenance']), agentCli: { dsh: status({ checkedVersion: '1.0.0', newer: 'latest', rollbackCommand: 'npm install -g dsh@1.0.0' }) } })
    const html = render()
    expect(html).toContain('可更新至 1.1.0')
    expect(html).toContain('Antumi 验证到 1.0.0，还没验证过 1.1.0。')
    expect(html).toContain('npm install -g dsh@1.0.0')
    expect(html).toContain('>升级<')
    useCore.setState({ agentCli: { dsh: status({ checkedVersion: '0.9.0', newer: 'current', rollbackCommand: null }) } })
    expect(render()).toContain('这个版本比 Antumi 验证过的 0.9.0 新。用不了时可以退回 0.9.0。')
    useCore.setState({ agentCli: { dsh: status(null) } })
    expect(render()).not.toContain('验证过')
  })

  it('keeps the account guidance for other agents', () => {
    useCore.setState({ environment: check('codex') })
    expect(render()).toContain('尚未确认登录状态')
    expect(render()).not.toContain('验证本机模型')
  })
})
