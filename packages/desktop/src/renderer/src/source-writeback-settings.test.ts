import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { beforeEach, expect, it, vi } from 'vitest'
import { EMPTY_WRITEBACK, createRpcClient, type RpcConnection } from '@antumi/protocol'
import { useCore } from './core-store'
import { SourceWritebackSettings } from './components/SourceWritebackSettings'

vi.mock('./core-store', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./core-store')>()
  return { ...actual, useCore: Object.assign((selector: (state: import('./core-store').CoreState) => unknown) => selector(actual.useCore.getState()), actual.useCore) }
})

beforeEach(() => {
  useCore.setState(useCore.getInitialState(), true)
  const rpc: RpcConnection = { ...createRpcClient(() => {}), features: ['source-writeback-per-type'], close: () => {}, closed: new Promise(() => {}) }
  useCore.setState({ rpc })
})

it('lists configured and unconfigured types without a common rule editor', () => {
  const html = renderToStaticMarkup(createElement(SourceWritebackSettings, {
    provider: 'demo', instance: 'default', config: { ...EMPTY_WRITEBACK, start: { status: 'Old Common Status' } },
    types: [{ id: 'bug', label: '缺陷' }, { id: 'task', label: '任务' }, { id: 'pr', label: 'Pull Request', mode: 'off' }],
    lanes: [{ typeId: 'bug', name: '缺陷', mode: 'on', review: { status: 'Resolved', comment: true } }]
  }))
  expect(html).toContain('提交验收时 → Resolved')
  expect(html).toContain('未配置')
  expect(html).toContain('Pull Request')
  expect(html).toContain('不回写')
  expect(html).not.toContain('Old Common Status')
  expect(html).not.toContain('所有类型')
  expect(html).not.toContain('<details open')
})

it('keeps a configured type editable when the plugin no longer lists it, including its scope', () => {
  const html = renderToStaticMarkup(createElement(SourceWritebackSettings, {
    provider: 'demo', instance: 'default', config: EMPTY_WRITEBACK,
    lanes: [{ typeId: 'old', scopeId: 'APP', name: '旧类型', mode: 'on', start: { status: 'Doing' } }]
  }))
  expect(html).toContain('旧类型 · APP')
  expect(html).toContain('Doing')
})

it('explains why there is no editor when type information is unavailable', () => {
  const html = renderToStaticMarkup(createElement(SourceWritebackSettings, { provider: 'demo', instance: 'default', config: EMPTY_WRITEBACK }))
  expect(html).toContain('还没有可配置的事项类型')
  expect(html).not.toContain('开始执行时，状态改为')
})
