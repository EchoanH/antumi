import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { StateCreator } from 'zustand'
import { createRpcClient, type RpcConnection } from '@antumi/protocol'
import { useCore } from '../core-store'
import { setLocale } from '../i18n'
import { ModelProviderSettings } from './ModelProviderSettings'
import { CcSwitchImportSettings } from './CcSwitchImportSettings'

vi.mock('zustand', async (original) => {
  const actual = await original<typeof import('zustand')>()
  return { ...actual, create: <T>() => (initializer: StateCreator<T>) => {
    const store = actual.create(initializer)
    return Object.assign((selector: (state: T) => unknown) => selector(store.getState()), store)
  } }
})

beforeEach(() => {
  setLocale('zh-CN')
  useCore.setState({ ...useCore.getInitialState(), connection: 'connected' }, true)
})

describe('CC Switch import entry', () => {
  it('is feature-gated for older cores, and available before any provider has been added', () => {
    const rpc: RpcConnection = { ...createRpcClient(() => {}), features: ['model-providers'], close() {}, closed: new Promise(() => {}) }
    useCore.setState({ rpc })
    expect(renderToStaticMarkup(createElement(ModelProviderSettings))).not.toContain('从 CC Switch 导入')
    useCore.setState({ rpc: { ...rpc, features: ['model-providers', 'cc-switch-import'] } })
    expect(renderToStaticMarkup(createElement(ModelProviderSettings))).toContain('从 CC Switch 导入')
  })

  it('explains the source and one-time copy without reading files on page load', () => {
    const send = vi.fn()
    const rpc: RpcConnection = { ...createRpcClient(send), features: ['cc-switch-import'], close() {}, closed: new Promise(() => {}) }
    useCore.setState({ rpc })
    const html = renderToStaticMarkup(createElement(CcSwitchImportSettings, { onDone() {} }))
    expect(html).toContain('一次性复制')
    expect(html).toContain('读取的是运行 Antumi 后端的电脑')
    expect(html).toContain('读取服务商')
    expect(send).not.toHaveBeenCalled()
  })
})
