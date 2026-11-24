import { afterEach, expect, it, vi } from 'vitest'
import { initialAgentCliStatus } from '@antumi/protocol'

const core = vi.hoisted(() => ({ getState: vi.fn(), setState: vi.fn(), receivePlugins: vi.fn() }))
vi.mock('./core-store', () => ({ useCore: { getState: core.getState, setState: core.setState }, receivePlugins: core.receivePlugins }))

import { checkMaintenanceUpdates, useMaintenanceUpdates } from './maintenance-updates'

afterEach(() => {
  vi.clearAllMocks()
  useMaintenanceUpdates.setState({ checking: false, error: null })
})

it('uses feature negotiation and never calls a new method on an older core', async () => {
  const rpc = { features: [], call: vi.fn() }
  core.getState.mockReturnValue({ rpc })
  await checkMaintenanceUpdates()
  expect(rpc.call).not.toHaveBeenCalled()
})

it('checks both kinds, deduplicates in-flight requests and keeps errors local', async () => {
  let fail: (error: Error) => void = () => {}
  const plugins = new Promise<never>((_resolve, reject) => { fail = reject })
  const call = vi.fn((method: string) => method === 'plugins.checkUpdates' ? plugins : Promise.resolve([initialAgentCliStatus('codex')]))
  const rpc = { features: ['agent-cli-maintenance', 'plugin-update-check'], call }
  core.getState.mockReturnValue({ rpc, agentCli: {} })
  const first = checkMaintenanceUpdates()
  await checkMaintenanceUpdates()
  expect(call).toHaveBeenCalledTimes(2)
  expect(useMaintenanceUpdates.getState().checking).toBe(true)
  fail(new Error('offline'))
  await first
  expect(useMaintenanceUpdates.getState()).toEqual({ checking: false, error: 'offline' })
  expect(core.setState).toHaveBeenCalledTimes(1)
  expect(core.receivePlugins).not.toHaveBeenCalled()
})

it('discards replies from the previous backend without blocking a new backend check', async () => {
  let finish: (plugins: []) => void = () => {}
  const previous = new Promise<[]>((resolve) => { finish = resolve })
  const rpc = { features: ['plugin-update-check'], call: vi.fn(() => previous) }
  core.getState.mockReturnValue({ rpc })
  const checking = checkMaintenanceUpdates()
  const next = { features: ['plugin-update-check'], call: vi.fn(async () => []) }
  core.getState.mockReturnValue({ rpc: next })
  await checkMaintenanceUpdates(true)
  expect(next.call).toHaveBeenCalledWith('plugins.checkUpdates', { refresh: true })
  finish([])
  await checking
  expect(core.receivePlugins).toHaveBeenCalledTimes(1)
  expect(useMaintenanceUpdates.getState().checking).toBe(false)
})
