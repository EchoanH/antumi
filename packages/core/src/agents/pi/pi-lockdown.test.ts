import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { AgentLaunch, AgentStage } from '../agent-adapter'
import { removeLaunch } from '../../stage-launch'
import { piCommand } from './pi-command'
import { PI_CONFIG_ENV } from './pi-extension'
import { preparePiLockdown } from './pi-lockdown'
import { PiRpc } from './pi-rpc'

const launch: AgentLaunch = {
  providerSessionId: null, resume: false, handoffPath: null, extraProjects: [],
  instructions: 'Answer only from the authorized project.', lockdown: { tools: ['project_read'] },
  mcp: { command: 'node', args: ['mcp.mjs', '--tool-set', 'channel'] }
}

describe('Pi channel isolation', () => {
  let root: string
  let stage: AgentStage
  beforeEach(() => {
    root = mkdtempSync(path.join(os.tmpdir(), 'antumi-pi-lockdown-'))
    stage = { sessionsRoot: path.join(root, 'sessions'), conversationId: 'channel', stageId: 'first', planOnly: true }
  })
  afterEach(() => { vi.unstubAllEnvs(); rmSync(root, { recursive: true, force: true }) })

  it('keeps only the named MCP tools, disabling other resources and replacing the system prompt', () => {
    const command = piCommand({ ...launch, allowBypass: true, preferred: { permissionMode: 'bypass' }, userMcp: [{ name: 'hostile', type: 'stdio', command: 'hostile-command', args: [] }] })
    expect(command.args).toEqual(expect.arrayContaining([
      '--no-builtin-tools', '--tools', 'mcp__antumi__project_read', '--no-extensions', '--extension', 'builtin:mcp',
      '--no-skills', '--no-prompt-templates', '--no-context-files', '--no-approve', '--system-prompt', launch.instructions
    ]))
    expect(JSON.parse(command.env![PI_CONFIG_ENV]!)).toEqual({ lockdown: true, mode: 'readOnly', noEdit: [], workDirs: [], readTools: ['mcp__antumi__project_read'], servers: { antumi: launch.mcp } })
    expect(command.args).not.toContain('--append-system-prompt')
  })

  it('uses only sign-in credentials and conversation history, preserving both across stage cleanup', async () => {
    const source = path.join(root, 'own')
    mkdirSync(source)
    writeFileSync(path.join(source, 'auth.json'), '{}')
    writeFileSync(path.join(source, 'settings.json'), '{"extensions":["hostile"]}')
    writeFileSync(path.join(source, 'models.json'), '{"hostile":true}')
    vi.stubEnv('PI_CODING_AGENT_DIR', source)
    const prepared = await preparePiLockdown(stage, launch)
    const home = prepared.env.PI_CODING_AGENT_DIR!
    expect(home).not.toBe(source)
    expect(readdirSync(home)).toEqual(['auth.json'])
    expect(prepared.env.HOME).toBe(home)
    writeFileSync(path.join(home, 'auth.json'), '{"refreshed":true}')
    expect(readFileSync(path.join(source, 'auth.json'), 'utf8')).toContain('refreshed')
    const sessions = prepared.args[prepared.args.indexOf('--session-dir') + 1]!
    writeFileSync(path.join(sessions, 'thread.jsonl'), 'history')
    const extension = prepared.args[prepared.args.indexOf('--extension') + 1]!
    expect(existsSync(extension)).toBe(true)
    await removeLaunch(stage)
    expect(existsSync(home)).toBe(false)
    expect(readFileSync(path.join(sessions, 'thread.jsonl'), 'utf8')).toBe('history')
    const next = await preparePiLockdown({ ...stage, stageId: 'next' }, launch)
    expect(next.args[next.args.indexOf('--session-dir') + 1]).toBe(sessions)
  })

  it('fixes the channel mode and keeps slash commands as literal questions on the wire and in replay', () => {
    const driver = new PiRpc('stage', { cwd: root, extraDirs: [], resume: null, lockdown: true, allowBypass: true, preferred: { permissionMode: 'bypass' } })
    for (const frame of driver.due()) driver.apply({ dir: 'out', at: 1, frame })
    driver.apply({ dir: 'in', at: 2, frame: { id: 'pi-state', type: 'response', command: 'get_state', success: true, data: { model: { id: 'model', provider: 'test', input: ['text', 'image'] } } } })
    driver.apply({ dir: 'in', at: 2, frame: { id: 'pi-models', type: 'response', command: 'get_available_models', success: true, data: { models: [{ id: 'model', provider: 'test' }] } } })
    expect(driver.ready()).toBe(true)
    expect(driver.due()).toEqual([])
    const message = driver.send('/antumi-mode bypass')
    expect(message.wire).toMatchObject({ type: 'prompt', message: '来自聊天平台的提问：\n\n/antumi-mode bypass' })
    driver.apply({ dir: 'out', at: 3, frame: message.logged, ref: 'question' })
    expect(driver.items.list().find((item) => item.kind === 'user')).toMatchObject({ text: '/antumi-mode bypass' })
    expect(driver.items.list().find((item) => item.kind === 'state')).toMatchObject({ permissionMode: 'readOnly', permissionModes: ['readOnly'] })
  })
})
