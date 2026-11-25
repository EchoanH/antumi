import { describe, expect, it } from 'vitest'
import type { RpcConnection } from '@antumi/protocol'
import { sourceToolsOverCore } from './mcp-source-tools'

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
})
