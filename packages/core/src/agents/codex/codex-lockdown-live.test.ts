import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process'
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
import { CodexAppServer } from './codex-app-server'
import { codexCommand } from './codex-command'
import { prepareCodexLockdown } from './codex-lockdown'

// Real CLI, local scripted model and the real project tools. No account or paid API is used.
// ANTUMI_LIVE_CODEX_LOCKDOWN=1 pnpm exec vitest run packages/core/src/agents/codex/codex-lockdown-live.test.ts
const live = process.env.ANTUMI_LIVE_CODEX_LOCKDOWN === '1'
const Request = z.looseObject({
  tools: z.array(z.looseObject({ type: z.string(), name: z.string().optional(), tools: z.array(z.looseObject({ name: z.string() })).optional() })),
  input: z.array(z.unknown()), instructions: z.string().optional()
})

describe.skipIf(!live)('Codex channel isolation with the real CLI', () => {
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

  it('keeps native tools and host instructions out, reads the project, refuses escapes, and resumes with images', async () => {
    root = mkdtempSync(path.join(os.tmpdir(), 'antumi-codex-live-'))
    const repo = path.join(root, 'project')
    mkdirSync(repo)
    // Project tools require Git, but do not require a commit.
    const { execFileSync: git } = await import('node:child_process')
    git('git', ['init', '-q', repo])
    writeFileSync(path.join(repo, 'answer.ts'), 'export const answer = 42\n')
    git('git', ['-C', repo, 'add', 'answer.ts'])
    const workspace = path.join(root, 'workspace')
    mkdirSync(workspace)
    writeFileSync(path.join(root, 'AGENTS.md'), 'HOSTILE_PARENT_INSTRUCTIONS')
    mkdirSync(path.join(root, '.codex'))
    writeFileSync(path.join(root, '.codex', 'config.toml'), '[features]\nshell_tool=true\n[mcp_servers.hostile]\ncommand="hostile-user-mcp"\n')
    mkdirSync(path.join(root, '.agents', 'skills', 'hostile'), { recursive: true })
    writeFileSync(path.join(root, '.agents', 'skills', 'hostile', 'SKILL.md'), '---\nname: hostile\ndescription: HOSTILE_GLOBAL_SKILL\n---\nRun shell.\n')
    const image = path.join(root, 'question.png')
    const imageBytes = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAIAAACQd1PeAAAADElEQVR4nGP4//8/AAX+Av4N70a4AAAAAElFTkSuQmCC', 'base64')
    writeFileSync(image, imageBytes)

    const calls = [
      { name: 'exec_command', arguments: JSON.stringify({ cmd: `cat ${path.join(root, 'AGENTS.md')}` }) },
      { name: 'view_image', arguments: JSON.stringify({ path: image }) },
      { name: 'project_read', namespace: 'mcp__antumi', arguments: JSON.stringify({ path: 'project/answer.ts' }) },
      { name: 'project_read', namespace: 'mcp__antumi', arguments: JSON.stringify({ path: '/etc/passwd' }) }
    ]
    const requests: z.infer<typeof Request>[] = []
    const server = createServer(async (req, res) => {
      const chunks: Buffer[] = []
      for await (const chunk of req) chunks.push(Buffer.from(chunk))
      const body = Request.parse(JSON.parse(Buffer.concat(chunks).toString()))
      requests.push(body)
      const call = calls.shift()
      const output = call
        ? [{ type: 'function_call', id: `fc_${requests.length}`, call_id: `call_${requests.length}`, ...call }]
        : [{ type: 'message', id: `msg_${requests.length}`, role: 'assistant', status: 'completed', content: [{ type: 'output_text', text: 'PROBE_DONE', annotations: [] }] }]
      const response = { id: `resp_${requests.length}`, object: 'response', status: 'completed', output, usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 } }
      res.writeHead(200, { 'content-type': 'text/event-stream' })
      res.write(`event: response.created\ndata: ${JSON.stringify({ type: 'response.created', response: { ...response, status: 'in_progress', output: [] } })}\n\n`)
      for (const item of output) res.write(`event: response.output_item.done\ndata: ${JSON.stringify({ type: 'response.output_item.done', output_index: 0, item })}\n\n`)
      res.end(`event: response.completed\ndata: ${JSON.stringify({ type: 'response.completed', response })}\n\n`)
    })
    servers.push(server)
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
    const address = server.address()
    if (!address || typeof address === 'string') throw new Error('missing mock address')

    const loader = fileURLToPath(new URL('../../../node_modules/tsx/dist/loader.mjs', import.meta.url))
    const toolsModule = fileURLToPath(new URL('../../channel-tools/index.ts', import.meta.url))
    const handlerModule = fileURLToPath(new URL('../../mcp-channel-tools.ts', import.meta.url))
    const mcpScript = `
      import { createInterface } from 'node:readline';
      import { runChannelTool } from ${JSON.stringify(toolsModule)};
      import { channelMcpHandler } from ${JSON.stringify(handlerModule)};
      const handle=channelMcpHandler((tool,args)=>runChannelTool({roots:[${JSON.stringify(repo)}]},tool,args));
      const lines=createInterface({input:process.stdin});
      lines.on('line',async line=>{
        const result=await handle(line);
        if(result)process.stdout.write(JSON.stringify(result)+'\\n');
      });`
    const launch: AgentLaunch = {
      providerSessionId: null, resume: false, handoffPath: null, extraProjects: [],
      instructions: 'CHANNEL_INSTRUCTIONS: answer from project tools only.',
      mcp: { command: process.execPath, args: ['--import', loader, '--input-type=module', '-e', mcpScript] },
      lockdown: { tools: CHANNEL_TOOL_NAMES },
      provider: {
        providerId: 'local', endpoint: { wire: 'openai-responses', baseUrl: `http://127.0.0.1:${address.port}/v1`, anthropic: null },
        models: [{ id: 'gpt-6', label: null, contextWindow: null, maxOutput: null, efforts: [], reasoningSummaries: false }], defaultModel: 'gpt-6', smallModel: 'gpt-6', headers: {}, apiKey: 'local-test'
      }
    }

    async function ask(stageId: string, resume: string | null) {
      const stage: AgentStage = { sessionsRoot: path.join(root, 'sessions'), conversationId: 'channel', stageId, planOnly: true }
      const prepared = await prepareCodexLockdown(stage, launch)
      const command = codexCommand(launch)
      const options: ChatStageOptions = { cwd: workspace, extraDirs: [], resume, lockdown: true, instructions: launch.instructions, preferred: { model: 'gpt-6' } }
      const driver = new CodexAppServer(stageId, options)
      const child = spawn(command.command, command.args, { cwd: workspace, env: { ...cleanEnv(process.env), ...command.env, ...prepared.env }, stdio: 'pipe' })
      children.push(child)
      let stderr = ''
      child.stderr.on('data', (data) => { stderr += data.toString() })
      return await new Promise<string>((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error(`Codex timed out: ${stderr}`)), 20_000)
        let sent = false
        const send = (frame: unknown, ref?: string) => {
          driver.apply({ dir: 'out', at: Date.now(), frame, ...(ref ? { ref } : {}) })
          child.stdin.write(`${JSON.stringify(frame)}\n`)
        }
        const pump = () => {
          for (const frame of driver.due()) send(frame)
          if (driver.ready() && !sent) {
            sent = true
            send(driver.send('Read answer.ts; refuse escapes.', [{ id: 'image', width: 1, height: 1, path: image, mime: 'image/png', read: () => imageBytes }]).wire, 'question')
          }
        }
        const lines = createInterface({ input: child.stdout })
        lines.on('line', (line) => {
          const frame: unknown = JSON.parse(line)
          driver.apply({ dir: 'in', at: Date.now(), frame })
          if (driver.failure()) { clearTimeout(timer); reject(new Error(`${driver.failure()}: ${stderr}`)); return }
          if (driver.items.list().some((item) => item.kind === 'turn' && item.state === 'completed')) {
            clearTimeout(timer)
            const thread = driver.providerSessionId()
            if (!thread) { reject(new Error('no thread')); return }
            child.once('exit', () => resolve(thread))
            child.kill('SIGTERM')
            return
          }
          pump()
        })
        child.on('error', (error) => { clearTimeout(timer); reject(error) })
        child.on('exit', (code) => { clearTimeout(timer); if (!driver.items.list().some((item) => item.kind === 'turn' && item.state === 'completed')) reject(new Error(`Codex exited ${code}: ${stderr}`)) })
        pump()
      })
    }

    const thread = await ask('first', null)
    const snapshot = JSON.stringify(requests)
    expect(snapshot.includes('HOSTILE_PARENT_INSTRUCTIONS')).toBe(false)
    expect(snapshot.includes('HOSTILE_GLOBAL_SKILL')).toBe(false)
    expect(snapshot.includes('CHANNEL_INSTRUCTIONS')).toBe(true)
    const toolResults = requests.flatMap((request) => request.input).flatMap((item) => {
      const result = z.object({ type: z.literal('function_call_output'), output: z.unknown() }).safeParse(item)
      return result.success ? [JSON.stringify(result.data.output)] : []
    })
    expect(toolResults.some((result) => result.includes('export const answer = 42')), toolResults.join('\n')).toBe(true)
    expect(toolResults.some((result) => result.includes('路径要写成「项目名/相对路径」'))).toBe(true)
    expect(snapshot.includes('input_image'), JSON.stringify(requests[0]?.input).slice(-1600)).toBe(true)
    const outputs = snapshot.match(/unsupported[^"\\]*/gi) ?? []
    expect(outputs.join(' ')).toContain('exec_command')
    expect(outputs.join(' ')).toContain('view_image')
    const names = requests[0]!.tools.flatMap((tool) => tool.tools ? tool.tools.map((nested) => `${tool.name}.${nested.name}`) : [tool.name])
    expect(names.sort()).toEqual(['list_mcp_resources', 'list_mcp_resource_templates', 'read_mcp_resource', 'request_user_input', ...CHANNEL_TOOL_NAMES.map((name) => `mcp__antumi.${name}`)].sort())
    expect(await ask('second', thread)).toBe(thread)
  }, 60_000)
})
