import { describe, expect, it } from 'vitest'
import { z } from 'zod'
import { createRpcClient, type RpcConnection } from '@antumi/protocol'
import { teamToolsOverCore } from './mcp-team-tools'

describe('team tools', () => {
  it('binds every operation to its own conversation and cannot accept broader permissions or arbitrary projects', async () => {
    const parent = '11111111-1111-4111-8111-111111111111'
    const squad = '22222222-2222-4222-8222-222222222222'
    const sent: { method: string; params: unknown }[] = []
    const client = createRpcClient((text) => {
      const frame = z.object({ id: z.number(), method: z.string(), params: z.unknown() }).parse(JSON.parse(text))
      sent.push(frame)
      queueMicrotask(() => client.receive(JSON.stringify({ jsonrpc: '2.0', id: frame.id,
        ...frame.method === 'squadCalls.targets' || frame.method === 'squadCalls.list' ? { result: [] } : { error: { code: -32000, message: 'Refused', data: { reason: 'squad-call-forbidden' } } }
      })))
    })
    const rpc: RpcConnection = { ...client, features: ['squad-calls'], close: () => {}, closed: new Promise(() => {}) }
    const tools = teamToolsOverCore(async (action) => action(rpc), parent)
    const run = (name: string, input: Record<string, unknown>) => tools.find((tool) => tool.spec.name === name)!.run(input)
    expect((await run('antumi_team_list', {})).isError).toBe(false)
    expect((await run('antumi_team_dispatch', { id: squad, squadId: squad, instruction: 'Do the work', ref: 'once', permissionMode: 'bypass', projectPaths: ['/private'] })).isError).toBe(true)
    expect(sent.at(-1)).toEqual({ id: expect.any(Number), method: 'squadCalls.dispatch', params: { id: parent, squadId: squad, instruction: 'Do the work', ref: 'once' } })
    await run('antumi_team_status', {})
    expect(sent.at(-1)).toMatchObject({ method: 'squadCalls.list', params: { id: parent, read: true } })
    await run('antumi_team_cancel', { id: squad, callId: squad })
    expect(sent.at(-1)).toMatchObject({ method: 'squadCalls.cancel', params: { id: parent, callId: squad } })
  })
})
