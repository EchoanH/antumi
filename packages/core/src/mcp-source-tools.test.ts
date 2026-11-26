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
  it('no longer takes a repair proposal: tasks are opened with source_task_create', async () => {
    calls.length = 0
    expect((await tool!.run({ summary: 'Located.', fix: { decision: 'repair', evidence: 'x', plan: 'y' } })).isError).toBe(false)
    expect(calls).toEqual([{ conversationId: 'chat-1', text: 'Located.' }])
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

describe('source_task_create', () => {
  const calls: { method: string; params: unknown }[] = []
  const rpc: Pick<RpcConnection, 'call'> = { call: async (method: string, params: unknown) => { calls.push({ method, params }); return { id: 'task-1', title: 'Repair redirect' } as never } }
  const tool = sourceToolsOverCore((action) => action(rpc as RpcConnection), 'hub').find((entry) => entry.spec.name === 'source_task_create')!
  const task = { title: 'Repair redirect', details: 'Preserve the URL and add coverage.', agent: 'claude', model: 'worker-model', effort: 'high', repos: [{ path: '/api', startRef: 'refs/heads/develop' }] }

  it('opens the task through core and says what it opened', async () => {
    calls.length = 0
    const result = await tool.run(task)
    expect(result.isError).toBe(false)
    expect(result.content[0]!.text).toContain('Repair redirect')
    expect(calls).toEqual([{ method: 'sources.createTask', params: { id: 'hub', task } }])
    expect(tool.spec).not.toHaveProperty('inputSchema.$schema')
  })

  it('refuses a permission, an unknown agent or no project before asking core', async () => {
    calls.length = 0
    for (const invalid of [{ ...task, permissionMode: 'bypass' }, { ...task, agent: 'unknown' }, { ...task, repos: [] }]) {
      expect((await tool.run(invalid)).isError).toBe(true)
    }
    expect(calls).toEqual([])
  })

  it('hands core\'s refusal back to the agent to correct', async () => {
    const refusing = sourceToolsOverCore(async () => { throw new Error('PR 类事项不新建任务') }, 'hub').find((entry) => entry.spec.name === 'source_task_create')!
    const result = await refusing.run(task)
    expect(result).toMatchObject({ isError: true, content: [{ text: '没有新建：PR 类事项不新建任务' }] })
  })

  it('is offered to an automatic investigation only', () => {
    expect(sourceToolsOverCore(async () => { throw new Error('unused') }, 'task-chat', { tasks: false }).map((entry) => entry.spec.name)).not.toContain('source_task_create')
  })

  it('asks the user nothing, as the source allowed it', () => {
    expect(antumiReadTools(false)).toContain('source_task_create')
  })
})
