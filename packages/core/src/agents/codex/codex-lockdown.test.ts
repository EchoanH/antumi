import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { AgentLaunch, AgentStage } from '../agent-adapter'
import { CodexAppServer } from './codex-app-server'
import { codexCommand } from './codex-command'
import { prepareCodexLockdown } from './codex-lockdown'

const launch: AgentLaunch = {
  providerSessionId: null, resume: false, handoffPath: null, extraProjects: [],
  instructions: 'Answer only from the project tools.',
  mcp: { command: 'node', args: ['mcp.mjs', '--tool-set', 'channel'], env: { ELECTRON_RUN_AS_NODE: '1' } },
  lockdown: { tools: ['project_read'] }
}

describe('Codex channel launch', () => {
  let root: string
  let stage: AgentStage
  beforeEach(() => {
    root = mkdtempSync(path.join(os.tmpdir(), 'antumi-codex-lockdown-'))
    stage = { sessionsRoot: root, conversationId: 'conversation', stageId: 'stage', planOnly: false }
  })
  afterEach(() => rmSync(root, { recursive: true, force: true }))

  it('starts only the channel MCP tools, without native tools or account configuration', () => {
    const command = codexCommand({ ...launch, account: { id: 'work', env: { CODEX_HOME: '/hostile/account', SECRET: 'hostile-secret' } } })
    expect(command.env).toBeUndefined()
    expect(command.args).toEqual(expect.arrayContaining([
      '--strict-config', 'features.shell_tool=false', 'features.unified_exec=false', 'features.view_image=false',
      'features.multi_agent=false', 'features.multi_agent_v2=false', 'features.plugins=false', 'features.hooks=false',
      'features.apps=false', 'features.skip_host_skill_discovery=true', 'web_search="disabled"', 'project_doc_max_bytes=0',
      'approval_policy="never"', 'sandbox_mode="read-only"',
      'mcp_servers.antumi={command="node",args=["mcp.mjs","--tool-set","channel"],enabled_tools=["project_read"],env={"ELECTRON_RUN_AS_NODE"="1"}}'
    ]))
  })

  it('shares only credentials with the selected account and only its own history between stages', async () => {
    const account = path.join(root, 'account')
    mkdirSync(account)
    writeFileSync(path.join(account, 'auth.json'), '{"tokens":{}}')
    writeFileSync(path.join(account, 'config.toml'), 'hostile=true')
    writeFileSync(path.join(account, 'AGENTS.md'), 'hostile instructions')
    const request = { ...launch, account: { id: 'work', env: { CODEX_HOME: account } } }
    const prepared = await prepareCodexLockdown(stage, request, async () => 'codex-cli 0.160.1\n')
    const home = prepared.env!.CODEX_HOME!
    expect(home).not.toBe(account)
    expect(readdirSync(home).sort()).toEqual(['auth.json', 'sessions'])
    expect(prepared.env!.HOME).toBe(home)
    writeFileSync(path.join(home, 'auth.json'), '{"tokens":{"refreshed":true}}')
    expect(readFileSync(path.join(account, 'auth.json'), 'utf8')).toContain('refreshed')
    writeFileSync(path.join(home, 'sessions', 'rollout.jsonl'), 'history')
    const next = await prepareCodexLockdown({ ...stage, stageId: 'next' }, request, async () => 'codex-cli 0.161.0')
    expect(readFileSync(path.join(next.env!.CODEX_HOME!, 'sessions', 'rollout.jsonl'), 'utf8')).toBe('history')
    expect(realpathSync(path.join(home, 'sessions'))).toBe(realpathSync(path.join(root, 'conversation', 'codex-sessions')))
    expect(existsSync(path.join(account, 'sessions'))).toBe(false)
  })

  it.each(['codex-cli 0.159.0', 'codex-cli 0.160.0', 'codex-cli 0.160.1-alpha', 'unrecognized'])('refuses an unverified CLI (%s) before preparing or starting it', async (version) => {
    await expect(prepareCodexLockdown(stage, launch, async () => version)).rejects.toMatchObject({ reason: 'agent-no-lockdown' })
    expect(existsSync(path.join(root, 'conversation'))).toBe(false)
  })

  it('leaves ordinary Codex starts alone', async () => {
    const { lockdown: _lockdown, ...ordinary } = launch
    expect(await prepareCodexLockdown(stage, ordinary, async () => { throw new Error('should not run') })).toEqual({})
  })
})

describe('Codex channel protocol', () => {
  function opened(resume: string | null = null) {
    const driver = new CodexAppServer('stage', {
      cwd: '/private/channel', extraDirs: ['/hostile/project'], resume, lockdown: true,
      instructions: launch.instructions, allowBypass: true, preferred: { permissionMode: 'bypass', model: 'gpt-6' }
    })
    const send = () => { const frames = driver.due(); frames.forEach((frame) => driver.apply({ dir: 'out', at: 1, frame })); return frames }
    send()
    driver.apply({ dir: 'in', at: 2, frame: { id: 'antumi-init', result: {} } })
    const frames = send()
    driver.apply({ dir: 'in', at: 3, frame: { id: 'antumi-thread', result: { thread: { id: 'thread' } } } })
    return { driver, frames }
  }

  it.each([null, 'previous-thread'])('uses only its channel prompt, a read-only sandbox and no approvals, including on resume (%s)', (resume) => {
    const { driver, frames } = opened(resume)
    expect(frames).toContainEqual({ id: 'antumi-thread', method: resume ? 'thread/resume' : 'thread/start', params: {
      ...(resume ? { threadId: resume, excludeTurns: true } : { environments: [] }),
      cwd: '/private/channel', approvalPolicy: 'never', sandbox: 'read-only', model: 'gpt-6',
      baseInstructions: launch.instructions, developerInstructions: ''
    } })
    expect(JSON.stringify(frames)).not.toContain('skills/list')
    const { wire } = driver.send('/review main', [{ id: 'image', width: 1, height: 1, path: '/attachments/screenshot.png', mime: 'image/png', read: () => new Uint8Array() }])
    expect(wire).toMatchObject({ method: 'turn/start', params: {
      approvalPolicy: 'never', sandboxPolicy: { type: 'readOnly', networkAccess: false }, environments: [],
      input: [{ type: 'text', text: '/review main' }, { type: 'localImage', path: '/attachments/screenshot.png' }]
    } })
    expect(JSON.stringify(wire)).not.toContain('/hostile/project')
    const state = driver.items.list().find((item) => item.kind === 'state')
    expect(state).toMatchObject({ permissionMode: 'readOnly', permissionModes: ['readOnly'], commands: [] })
  })
})
