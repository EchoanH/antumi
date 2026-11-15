import readline from 'node:readline'
import { z } from 'zod'
import { connectRpc, coreUrl } from '@antumi/protocol'
import { readCoreEndpoint } from '@antumi/protocol/node'
import { CHANNEL_TOOLS } from './channel-tools'

// Antumi's MCP server as an agent locked down for a chat platform's asker is given it: the tools
// of the registry and nothing else. Every call is run by core, over a connection that says at its
// first word what it is for and is from then on held to that one conversation's tools: a fault
// here cannot reach anything else of core (docs/CHANNELS.md).

const Message = z.object({ id: z.union([z.string(), z.number()]).optional(), method: z.string(), params: z.unknown().optional() })
const CallParams = z.object({ name: z.string(), arguments: z.unknown().optional() })
const InitializeParams = z.object({ protocolVersion: z.string() })
const FALLBACK_PROTOCOL_VERSION = '2024-11-05'

type Reply = { jsonrpc: '2.0'; id: string | number | null; result?: unknown; error?: { code: number; message: string } }

export function channelMcpHandler(call: (tool: string, args: unknown) => Promise<{ text: string; isError: boolean }>) {
  const specs = CHANNEL_TOOLS.map(({ name, description, inputSchema }) => ({ name, description, inputSchema, annotations: { readOnlyHint: true } }))
  return async (line: string): Promise<Reply | null> => {
    let raw: unknown
    try { raw = JSON.parse(line) } catch { return { jsonrpc: '2.0', id: null, error: { code: -32700, message: 'parse error' } } }
    const message = Message.safeParse(raw)
    if (!message.success) return { jsonrpc: '2.0', id: null, error: { code: -32600, message: 'invalid request' } }
    const { id, method, params } = message.data
    if (id === undefined) return null
    const reply = (result: unknown): Reply => ({ jsonrpc: '2.0', id, result })
    switch (method) {
      case 'initialize': {
        const requested = InitializeParams.safeParse(params)
        return reply({ protocolVersion: requested.success ? requested.data.protocolVersion : FALLBACK_PROTOCOL_VERSION, capabilities: { tools: {} }, serverInfo: { name: 'antumi', version: '0.0.0' } })
      }
      case 'ping':
        return reply({})
      case 'tools/list':
        return reply({ tools: specs })
      case 'tools/call': {
        const asked = CallParams.safeParse(params)
        if (!asked.success || !specs.some((spec) => spec.name === asked.data.name)) return { jsonrpc: '2.0', id, error: { code: -32602, message: 'unknown tool' } }
        const result = await call(asked.data.name, asked.data.arguments).catch(() => ({ text: '读取失败', isError: true }))
        return reply({ content: [{ type: 'text', text: result.text }], isError: result.isError })
      }
      default:
        return { jsonrpc: '2.0', id, error: { code: -32601, message: `method not found: ${method}` } }
    }
  }
}

// Each call connects anew, as the full server does, so a core restart between calls is harmless.
export async function serveChannelMcp(home: string | undefined, conversationId: string): Promise<void> {
  const handle = channelMcpHandler(async (tool, args) => {
    const endpoint = await readCoreEndpoint(home)
    if (!endpoint) return { text: 'Antumi core 没有运行', isError: true }
    const rpc = await connectRpc(coreUrl(endpoint), { kind: 'channel-tools', conversationId })
    try {
      return await rpc.call('channelTools.call', { conversationId, tool, arguments: args })
    } finally {
      rpc.close()
    }
  })
  const lines = readline.createInterface({ input: process.stdin, crlfDelay: Number.POSITIVE_INFINITY })
  for await (const line of lines) {
    if (!line.trim()) continue
    const response = await handle(line)
    if (response) process.stdout.write(`${JSON.stringify(response)}\n`)
  }
}
