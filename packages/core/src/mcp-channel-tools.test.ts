import { describe, expect, it } from 'vitest'
import { CHANNEL_TOOL_NAMES } from './channel-tools'
import { channelMcpHandler } from './mcp-channel-tools'

describe('channel MCP readiness', () => {
  it('reports ready only once the client lists project tools', async () => {
    let ready = false
    const handle = channelMcpHandler(async () => ({ text: '', isError: false }), async () => { ready = true })
    await handle(JSON.stringify({ id: 1, method: 'initialize', params: { protocolVersion: '2024-11-05' } }))
    expect(ready).toBe(false)
    expect(await handle(JSON.stringify({ id: 2, method: 'tools/list' }))).toMatchObject({ result: { tools: CHANNEL_TOOL_NAMES.map((name) => expect.objectContaining({ name, annotations: { readOnlyHint: true } })) } })
    expect(ready).toBe(true)
    const denied = await handle(JSON.stringify({ id: 3, method: 'tools/call', params: { name: 'terminal_run', arguments: { command: 'cat /etc/passwd' } } }))
    expect(denied).toMatchObject({ error: { code: -32602 } })
  })
})
