import { describe, expect, it } from 'vitest'
import { createRpcClient, RpcFrame, type RpcConnection } from '@antumi/protocol'
import { sourceToolsOverCore } from './mcp-source-tools'
import { antumiReadTools } from './agent-command'

describe('source_report', () => {
  const calls: unknown[] = []
  const rpc: Pick<RpcConnection, 'call'> = { call: async (_method: string, params: unknown) => { calls.push(params); return {} as never } }
  const [tool] = sourceToolsOverCore((action) => action(rpc as RpcConnection), 'chat-1')

  it('still takes a summary alone, as before it could say how the work ended', async () => {
    calls.length = 0
    const result = await tool!.run({ summary: ' Fixed the redirect. ' })
    expect(result.isError).toBe(false)
    expect(calls).toEqual([{ conversationId: 'chat-1', text: 'Fixed the redirect.' }])
  })

  it('passes on how the work ended and how to verify it, and refuses an outcome it does not know', async () => {
    calls.length = 0
    await tool!.run({ summary: 'Fixed.', outcome: 'delivered', verification: 'Sign out and in again.' })
    expect(calls).toEqual([{ conversationId: 'chat-1', text: 'Fixed.', outcome: 'delivered', verification: 'Sign out and in again.' }])
    expect((await tool!.run({ summary: 'Fixed.', outcome: 'closed' })).isError).toBe(true)
    expect(calls).toHaveLength(1)
    expect(tool!.spec.inputSchema.required).toEqual(['summary'])
  })
  it('validates and forwards a repair proposal without executing it', async () => {
    calls.length = 0
    const fix = { decision: 'repair', evidence: 'A failing redirect test', plan: 'Preserve the return URL' }
    expect((await tool!.run({ summary: 'Located the defect.', fix })).isError).toBe(false)
    expect(calls).toEqual([{ conversationId: 'chat-1', text: 'Located the defect.', fix }])
    expect((await tool!.run({ summary: 'Located.', fix: { ...fix, decision: 'execute_shell' } })).isError).toBe(true)
    expect((await tool!.run({ summary: 'Located.', fix: { ...fix, plan: 'x'.repeat(4001) } })).isError).toBe(true)
    expect(calls).toHaveLength(1)
  })

  it('forwards the coordinator task choice and rejects attempts to set permissions', async () => {
    calls.length = 0
    const task = { title: 'Repair redirect', details: 'Preserve the URL and add coverage.', agent: 'claude', model: 'worker-model', effort: 'high', repos: [{ path: '/api', startRef: 'refs/heads/develop' }] }
    const fix = { decision: 'repair', evidence: 'Failing redirect test', plan: 'Repair the API', task }
    expect((await tool!.run({ summary: 'Located.', fix })).isError).toBe(false)
    expect(calls).toEqual([{ conversationId: 'chat-1', text: 'Located.', fix }])
    for (const invalid of [{ ...task, permissionMode: 'bypass' }, { ...task, agent: 'unknown' }, { ...task, repos: [] }]) {
      expect((await tool!.run({ summary: 'Located.', fix: { ...fix, task: invalid } })).isError).toBe(true)
    }
    expect(calls).toHaveLength(1)
  })

})

it('discovers registered projects and usable workers, then queries the selected worker catalog', async () => {
  const calls: { method: string; params: unknown }[] = []
  const catalog = { models: [{ id: 'worker-model', label: 'Worker', description: null, efforts: ['high'], isDefault: true }] }
  const rpc = createRpcClient((text) => {
    const request = RpcFrame.parse(JSON.parse(text))
    if (!('method' in request) || !('id' in request)) throw new Error('Expected request')
    calls.push({ method: request.method, params: request.params })
    const responses: Record<string, unknown> = {
      'projects.recent': ['/api', '/web'],
      'system.environment': { checks: [
        { tool: 'claude', status: 'ok', version: '1', path: '/bin/claude', signedIn: true },
        { tool: 'codex', status: 'ok', version: '1', path: '/bin/codex', signedIn: true },
        { tool: 'cursor', status: 'ok', version: '1', path: '/bin/cursor', signedIn: true, problem: 'probe-failed' }
      ], searchPath: [], checkedAt: 1 },
      'system.chatSettings': { promptSuggestions: false, disabledAgents: ['codex'] },
      'modelProviders.list': [],
      'conversations.chatCatalog': catalog
    }
    if (!(request.method in responses)) throw new Error(`Unexpected call: ${request.method}`)
    rpc.receive(JSON.stringify({ jsonrpc: '2.0', id: request.id, result: responses[request.method] }))
  })
  const connection: RpcConnection = { ...rpc, features: [], close: () => {}, closed: Promise.resolve() }
  const tools = sourceToolsOverCore((action) => action(connection), 'hub')
  const options = tools.find((tool) => tool.spec.name === 'source_task_options')!
  const query = tools.find((tool) => tool.spec.name === 'source_task_catalog')!
  const result = await options.run({})
  expect(result.isError).toBe(false)
  expect(JSON.parse(result.content[0]!.text)).toMatchObject({ projects: ['/api', '/web'], agents: [{ agent: 'claude' }] })
  expect(JSON.parse(result.content[0]!.text).agents).toHaveLength(1)
  expect(JSON.parse((await query.run({ agent: 'claude' })).content[0]!.text)).toEqual(catalog)
  expect(calls.at(-1)).toEqual({ method: 'conversations.chatCatalog', params: { agent: 'claude' } })
  for (const tool of [options, query]) {
    expect(tool.spec.annotations.readOnlyHint).toBe(true)
    expect(antumiReadTools(false)).toContain(tool.spec.name)
  }
})
