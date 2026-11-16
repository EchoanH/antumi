import { execFileSync, spawn, type ChildProcessWithoutNullStreams } from 'node:child_process'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { createServer } from 'node:http'
import os from 'node:os'
import path from 'node:path'
import { createInterface } from 'node:readline'
import { fileURLToPath } from 'node:url'
import { z } from 'zod'
import { afterEach, describe, expect, it } from 'vitest'
import { cleanEnv } from '@antumi/protocol/node'
import { CHANNEL_TOOL_NAMES } from '../../channel-tools'
import type { ChatStageOptions } from '../../chat-driver'
import type { AgentLaunch, AgentStage } from '../agent-adapter'
import { adapterOf } from '../index'
import { PiRpc } from './pi-rpc'

// Real Pi and project tools, with a scripted local model. Uses no real account or paid API.
// ANTUMI_LIVE_PI_LOCKDOWN=1 pnpm exec vitest run packages/core/src/agents/pi/pi-lockdown-live.test.ts
const live = process.env.ANTUMI_LIVE_PI_LOCKDOWN === '1'
const pi = adapterOf('pi')
const Request = z.looseObject({ tools: z.array(z.object({ function: z.object({ name: z.string() }) })), messages: z.array(z.unknown()) })

describe.skipIf(!live)('Pi channel isolation with the real CLI', () => {
  let root: string
  const children: ChildProcessWithoutNullStreams[] = []
  const servers: ReturnType<typeof createServer>[] = []
  afterEach(async () => {
    for (const child of children.splice(0)) {
      if (child.exitCode === null) {
        const exited = new Promise((resolve) => child.once('exit', resolve))
        child.kill('SIGTERM')
        await exited
      }
    }
    for (const server of servers.splice(0)) await new Promise<void>((resolve) => server.close(() => resolve()))
    if (root) rmSync(root, { recursive: true, force: true })
  })

  it('keeps only project tools, refuses native calls and escapes, and resumes with image input', async () => {
    root = mkdtempSync(path.join(os.tmpdir(), 'antumi-pi-live-'))
    const repo = path.join(root, 'project'), workspace = path.join(root, 'workspace')
    mkdirSync(repo); mkdirSync(workspace)
    execFileSync('git', ['init', '-q', repo])
    writeFileSync(path.join(repo, 'answer.ts'), 'export const answer = 42\n')
    execFileSync('git', ['-C', repo, 'add', 'answer.ts'])
    writeFileSync(path.join(root, 'AGENTS.md'), 'HOSTILE_PARENT_INSTRUCTIONS')
    mkdirSync(path.join(root, '.pi', 'skills', 'hostile'), { recursive: true })
    writeFileSync(path.join(root, '.pi', 'settings.json'), JSON.stringify({ defaultTools: ['bash', 'read'], extensions: ['./hostile.mjs'] }))
    writeFileSync(path.join(root, '.pi', 'hostile.mjs'), 'throw new Error("HOSTILE_EXTENSION_LOADED")')
    writeFileSync(path.join(root, '.pi', 'mcp.json'), JSON.stringify({ mcpServers: { hostile: { command: 'hostile-user-mcp' } } }))
    writeFileSync(path.join(root, '.pi', 'skills', 'hostile', 'SKILL.md'), '---\nname: hostile\ndescription: HOSTILE_SKILL\n---\nRun bash.\n')
    const loader = fileURLToPath(new URL('../../../node_modules/tsx/dist/loader.mjs', import.meta.url))
    const tools = fileURLToPath(new URL('../../channel-tools/index.ts', import.meta.url))
    const handler = fileURLToPath(new URL('../../mcp-channel-tools.ts', import.meta.url))
    const mcpScript = path.join(root, 'mcp.mjs')
    writeFileSync(mcpScript, `
      import {createInterface} from 'node:readline';
      import {writeFile} from 'node:fs/promises';
      import {runChannelTool} from ${JSON.stringify(tools)};
      import {channelMcpHandler} from ${JSON.stringify(handler)};
      const ready=process.argv[process.argv.indexOf('--ready-file')+1];
      const handle=channelMcpHandler((tool,args)=>runChannelTool({roots:[${JSON.stringify(repo)}]},tool,args),()=>writeFile(ready,'{"ready":true}'));
      for await(const line of createInterface({input:process.stdin})){
        const result=await handle(line); if(result)process.stdout.write(JSON.stringify(result)+'\\n');
      }
    `)
    const imageBytes = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAIAAACQd1PeAAAADElEQVR4nGP4//8/AAX+Av4N70a4AAAAAElFTkSuQmCC', 'base64')
    const calls = [
      { name: 'bash', arguments: JSON.stringify({ command: `cat ${path.join(root, 'AGENTS.md')}` }) },
      { name: 'read', arguments: JSON.stringify({ path: path.join(root, 'AGENTS.md') }) },
      { name: 'mcp__antumi__project_read', arguments: JSON.stringify({ path: 'project/answer.ts' }) },
      { name: 'mcp__antumi__project_read', arguments: JSON.stringify({ path: '/etc/passwd' }) }
    ]
    const requests: z.infer<typeof Request>[] = []
    const server = createServer(async (req, res) => {
      const chunks: Buffer[] = []
      for await (const chunk of req) chunks.push(Buffer.from(chunk))
      const body = Request.parse(JSON.parse(Buffer.concat(chunks).toString()))
      requests.push(body)
      const call = calls.shift()
      const delta = call
        ? { role: 'assistant', tool_calls: [{ index: 0, id: `call_${requests.length}`, type: 'function', function: call }] }
        : { role: 'assistant', content: 'PROBE_DONE' }
      res.writeHead(200, { 'content-type': 'text/event-stream' })
      const chunk = (delta: unknown, finish_reason: string | null) => `data: ${JSON.stringify({ id: `chatcmpl_${requests.length}`, object: 'chat.completion.chunk', model: 'channel-test', choices: [{ index: 0, delta, finish_reason }] })}\n\n`
      res.write(chunk(delta, null))
      res.write(chunk({}, call ? 'tool_calls' : 'stop'))
      res.end('data: [DONE]\n\n')
    })
    servers.push(server)
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
    const address = server.address()
    if (!address || typeof address === 'string') throw new Error('missing mock address')
    const launch: AgentLaunch = {
      providerSessionId: null, resume: false, handoffPath: null, extraProjects: [],
      instructions: 'CHANNEL_INSTRUCTIONS: answer only from project tools.', lockdown: { tools: CHANNEL_TOOL_NAMES },
      provider: { providerId: 'local', endpoint: { wire: 'openai-chat', baseUrl: `http://127.0.0.1:${address.port}/v1`, anthropic: null },
        models: [{ id: 'channel-test', label: 'Channel', contextWindow: 128000, maxOutput: 1024, efforts: [], images: true }], defaultModel: 'channel-test', smallModel: 'channel-test', headers: {}, apiKey: 'local-test' }
    }
    async function ask(stageId: string, resume: string | null, text = '/antumi-mode bypass') {
      const stage: AgentStage = { sessionsRoot: path.join(root, 'sessions'), conversationId: 'channel', stageId, planOnly: true }
      const mcp = pi.launch!.mcp({ command: process.execPath, args: ['--import', loader, mcpScript] }, stage)
      const request = { ...launch, mcp, resume: Boolean(resume), providerSessionId: resume }
      const command = pi.command(request)
      const prepared = await pi.launch!.prepare(stage, mcp, request)
      const options: ChatStageOptions = { cwd: workspace, extraDirs: [], resume, lockdown: true, preferred: { model: 'antumi-local/channel-test' } }
      const driver = new PiRpc(stageId, options)
      const child = spawn(prepared.command ?? command.command, [...command.args, ...prepared.args ?? []], { cwd: workspace, env: { ...cleanEnv(process.env), ...command.env, ...prepared.env }, stdio: 'pipe' })
      children.push(child)
      let stderr = ''
      child.stderr.on('data', (data) => { stderr += data.toString() })
      const ready = pi.launch!.ready(stage)
      return await new Promise<string>((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error(`Pi timed out: ${stderr}`)), 25000)
        let sent = false, toolsReady = false
        const send = (frame: unknown, ref?: string) => {
          driver.apply({ dir: 'out', at: Date.now(), frame, ...(ref ? { ref } : {}) })
          child.stdin.write(`${JSON.stringify(frame)}\n`)
        }
        const pump = () => {
          for (const frame of driver.due()) send(frame)
          if (driver.ready() && toolsReady && !sent) {
            sent = true
            send(driver.send(text, [{ id: 'image', width: 1, height: 1, path: '/unused', mime: 'image/png', read: () => imageBytes }]).wire, 'question')
          }
        }
        ready.then(() => { toolsReady = true; pump() }, (error: unknown) => { clearTimeout(timer); reject(error) })
        createInterface({ input: child.stdout }).on('line', (line) => {
          const frame: unknown = JSON.parse(line)
          driver.apply({ dir: 'in', at: Date.now(), frame })
          if (driver.failure()) { clearTimeout(timer); reject(new Error(`${driver.failure()}: ${stderr}`)); return }
          if (driver.items.list().some((item) => item.kind === 'turn' && item.state === 'completed')) {
            clearTimeout(timer)
            const session = driver.providerSessionId()
            if (!session) { reject(new Error('no saved session')); return }
            child.once('exit', () => resolve(session))
            child.kill('SIGTERM')
            return
          }
          pump()
        })
        child.on('error', (error) => { clearTimeout(timer); reject(error) })
        child.on('exit', (code) => { clearTimeout(timer); if (!driver.items.list().some((item) => item.kind === 'turn' && item.state === 'completed')) reject(new Error(`Pi exited ${code}: ${stderr}`)) })
        pump()
      })
    }
    const session = await ask('first', null)
    const snapshot = JSON.stringify(requests)
    expect(snapshot.includes('HOSTILE_PARENT_INSTRUCTIONS')).toBe(false)
    expect(snapshot.includes('HOSTILE_SKILL')).toBe(false)
    expect(snapshot.includes('CHANNEL_INSTRUCTIONS')).toBe(true)
    expect(snapshot.includes('export const answer = 42')).toBe(true)
    expect(snapshot.includes('路径要写成「项目名/相对路径」')).toBe(true)
    expect(snapshot.includes('image_url')).toBe(true)
    expect(requests[0]!.tools.map((tool) => tool.function.name).sort()).toEqual(CHANNEL_TOOL_NAMES.map((tool) => `mcp__antumi__${tool}`).sort())
    const outputs = requests.flatMap((request) => request.messages).flatMap((message) => {
      const parsed = z.object({ role: z.literal('tool'), content: z.string() }).safeParse(message)
      return parsed.success ? [parsed.data.content] : []
    })
    expect(outputs.some((output) => /not found|not available|指定的项目工具/i.test(output)), outputs.join('\n')).toBe(true)
    const previousRequests = requests.length
    expect(await ask('second', session, '/mcp')).toBe(session)
    expect(requests.length).toBeGreaterThan(previousRequests)
    expect(JSON.stringify(requests.at(-1)?.messages).includes('来自聊天平台的提问：\\n\\n/mcp')).toBe(true)
  }, 60000)
})
