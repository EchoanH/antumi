import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import { z } from 'zod'
import type { ChatItem } from '@antumi/protocol'
import type { ChatRecord, ChatStageOptions } from '../../chat-driver'
import { AcpDriver } from '../acp/acp-driver'
import { antigravityDialect } from './antigravity-dialect'
import { antigravity } from './antigravity-adapter'
import * as antigravityRuntime from './antigravity-runtime'
import * as chatCatalog from '../../chat-catalog'

// As Antigravity ACP 1.4.1 answered on darwin-arm64 (2026-10-22), trimmed to what Antumi reads.
const initialized = {
  protocolVersion: 1,
  agentCapabilities: { loadSession: true, promptCapabilities: { image: true, audio: true, embeddedContext: true }, mcpCapabilities: { http: true, sse: true }, sessionCapabilities: { list: {}, resume: {} }, auth: { logout: {} } },
  authMethods: [{ id: 'oauth-personal', name: 'Log in with Google' }, { id: 'oauth-business', name: 'Log in with Gemini Enterprise' }, { id: 'gemini-api-key', name: 'Gemini API key' }, { id: 'agent-platform', name: 'Gemini Enterprise Agent Platform' }],
  agentInfo: { name: 'antigravity-acp', title: 'Google Antigravity', version: '1.4.1' }
}
const modes = [{ id: 'default', name: 'Default' }, { id: 'auto_edit', name: 'Auto Edit' }, { id: 'yolo', name: 'YOLO' }]
const opened = {
  sessionId: 'dfd164ec-2ebf-4623-8400-51e4627faaad',
  modes: { currentModeId: 'default', availableModes: modes },
  configOptions: [
    { id: 'model', name: 'Model', category: 'model', type: 'select', currentValue: 'gemini-3.8-flash', options: [{ value: 'gemini-3.8-flash', name: 'Gemini 3.8 Flash' }, { value: 'gemini-3.1-pro', name: 'Gemini 3.1 Pro' }] },
    { id: 'thinking_level', name: 'Thinking Level', category: 'thought_level', type: 'select', currentValue: 'high', options: [{ value: 'low', name: 'Low' }, { value: 'medium', name: 'Medium' }, { value: 'high', name: 'High' }] },
    { id: 'mode', name: 'Session Mode', category: 'mode', type: 'select', currentValue: 'default', options: modes.map(({ id, name }) => ({ value: id, name })) }
  ]
}

const Request = z.looseObject({ id: z.union([z.string(), z.number()]).optional(), method: z.string().optional(), params: z.unknown().optional() })
const items = <K extends ChatItem['kind']>(driver: AcpDriver, kind: K) => driver.items.list().filter((item): item is Extract<ChatItem, { kind: K }> => item.kind === kind)

function start(options: Partial<ChatStageOptions> = {}) {
  const driver = new AcpDriver(antigravityDialect, 'stage', { cwd: '/project', extraDirs: [], resume: null, ...options })
  const records: ChatRecord[] = []
  const apply = (record: ChatRecord) => { records.push(record); driver.apply(record) }
  const receive = (frame: unknown) => apply({ dir: 'in', at: records.length, frame })
  const due = () => driver.due().map((frame) => { apply({ dir: 'out', at: records.length, frame }); return Request.parse(frame) })
  const sent = [...due()]
  receive({ id: 'antigravity-init', result: initialized })
  sent.push(...due())
  receive({ id: 'antigravity-auth', result: {} })
  sent.push(...due())
  receive({ id: 'antigravity-session', result: opened })
  sent.push(...due())
  return { driver, apply, receive, due, sent, records }
}

function configFor(model: string, levels: string[] | null, mode = 'default', models = ['gemini-3.8-flash', 'gemini-3.1-pro']) {
  return { configOptions: [
    { id: 'model', name: 'Model', category: 'model', currentValue: model, options: models.map((value) => ({ value, name: value })) },
    ...(levels ? [{ id: 'thinking_level', name: 'Thinking Level', category: 'thought_level', currentValue: levels[0], options: levels.map((value) => ({ value, name: value })) }] : []),
    { id: 'mode', name: 'Session Mode', category: 'mode', currentValue: mode, options: modes.map(({ id, name }) => ({ value: id, name })) }
  ] }
}

describe('Antigravity ACP', () => {
  it('skips the catalog when signed out and removes only its probe session files when signed in', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'antumi-antigravity-catalog-'))
    const previousHome = process.env.GEMINI_HOME
    const sessions = path.join(root, 'antigravity-acp', 'conversations')
    const probeSessionId = 'probe-session'
    const keepSessionId = 'keep-session'
    const three = ['low', 'medium', 'high']
    const four = [...three, 'xhigh']
    const runtime = vi.spyOn(antigravityRuntime, 'requireAntigravity').mockResolvedValue(process.execPath)
    // Exercise the adapter and real driver without launching the installed server.
    const probe = vi.spyOn(chatCatalog, 'probeChatCatalog').mockImplementation(async (driver, command, cwd, timeoutMs) => {
      expect(command.command).toBe(process.execPath)
      expect(cwd).toBe(root)
      expect(timeoutMs).toBe(60_000)
      const answer = (result: unknown) => {
        const frames = driver.due()
        expect(frames).toHaveLength(1)
        const frame = Request.parse(frames[0])
        driver.apply({ dir: 'out', at: 0, frame })
        driver.apply({ dir: 'in', at: 0, frame: { id: frame.id, result } })
        return frame
      }
      answer(initialized)
      answer({})
      expect(answer({ sessionId: probeSessionId, ...configFor('gemini-3.8-flash', three) }).method).toBe('session/new')
      await Promise.all(['.db', '.db-wal', '.db-shm', '.meta'].map((suffix) => writeFile(path.join(sessions, probeSessionId + suffix), 'probe data')))
      expect(answer(configFor('gemini-3.1-pro', four)).params).toMatchObject({ configId: 'model', value: 'gemini-3.1-pro' })
      expect(driver.due()).toEqual([])
      return chatCatalog.catalogOf(driver.items.list())
    })
    try {
      process.env.GEMINI_HOME = root
      const catalog = antigravity.catalog
      if (!catalog) throw new Error('missing Antigravity catalog')
      expect(await catalog(root)).toBeNull()
      expect(runtime).not.toHaveBeenCalled()
      expect(probe).not.toHaveBeenCalled()

      await mkdir(sessions, { recursive: true })
      await writeFile(path.join(root, 'antigravity-acp', 'acp_token.json'), '{}')
      await writeFile(path.join(sessions, keepSessionId + '.db'), 'existing session')
      expect((await catalog(root))?.models.map((model) => [model.id, model.efforts, model.isDefault])).toEqual([
        ['gemini-3.8-flash', three, true], ['gemini-3.1-pro', four, false]
      ])
      expect(runtime).toHaveBeenCalledTimes(1)
      expect(probe).toHaveBeenCalledTimes(1)
      expect(await readdir(sessions)).toEqual([keepSessionId + '.db'])
      expect(await readFile(path.join(sessions, keepSessionId + '.db'), 'utf8')).toBe('existing session')
    } finally {
      runtime.mockRestore()
      probe.mockRestore()
      if (previousHome === undefined) delete process.env.GEMINI_HOME
      else process.env.GEMINI_HOME = previousHome
      await rm(root, { recursive: true, force: true })
    }
  })

  it('probes each model once without MCP or extra directories and keeps the opening default', () => {
    const driver = new AcpDriver(antigravityDialect, 'catalog', { cwd: '/project', extraDirs: ['/other'], resume: null, mcp: { command: 'node', args: ['mcp.js'] } }, true)
    const receive = (frame: unknown) => driver.apply({ dir: 'in', at: 0, frame })
    const take = () => {
      const frames = driver.due()
      expect(driver.due()).toEqual(frames)
      expect(frames).toHaveLength(1)
      const frame = Request.parse(frames[0])
      driver.apply({ dir: 'out', at: 0, frame })
      expect(driver.due()).toEqual([])
      return frame
    }
    receive({ id: take().id, result: { ...initialized, agentCapabilities: { sessionCapabilities: { additionalDirectories: true } } } })
    receive({ id: take().id, result: {} })
    const opening = take()
    expect(opening.method).toBe('session/new')
    expect(opening.params).toEqual({ cwd: '/project', mcpServers: [] })
    const models = ['gemini-3.8-flash', 'four', 'three', 'none', 'error', 'ack', 'four']
    const three = ['low', 'medium', 'high']
    const four = [...three, 'xhigh']
    receive({ id: opening.id, result: { sessionId: 'probe', ...configFor(models[0]!, three, 'default', models) } })
    for (const [model, levels] of [['four', four], ['three', three], ['none', null], ['error', null], ['ack', null]] as const) {
      expect(items(driver, 'state').at(-1)?.models ?? []).toEqual([])
      const probe = take()
      expect(probe.method).toBe('session/set_config_option')
      expect(probe.params).toEqual({ sessionId: 'probe', configId: 'model', value: model })
      receive(model === 'error' ? { id: probe.id, error: { code: -32602, message: 'unavailable' } } : { id: probe.id, result: model === 'ack' ? {} : configFor(model, levels ? [...levels] : null, 'default', [...new Set(models)]) })
    }
    expect(driver.due()).toEqual([])
    expect(driver.failure()).toBeNull()
    expect(items(driver, 'notice')).toEqual([])
    expect(items(driver, 'user')).toEqual([])
    expect(items(driver, 'state').at(-1)?.models.map((model) => [model.id, model.efforts, model.isDefault])).toEqual([
      ['gemini-3.8-flash', three, true], ['four', four, false], ['three', three, false], ['none', [], false], ['error', [], false], ['ack', [], false]
    ])
  })

  it('applies saved mode, model and its newly exposed effort in order and replays them', () => {
    const options = { cwd: '/project', extraDirs: [], resume: null, preferred: { permissionMode: 'acceptEdits' as const, model: 'gemini-3.1-pro', effort: 'xhigh' } }
    const { driver, receive, due, sent, records } = start(options)
    const mode = sent.at(-1)
    expect(mode?.params).toMatchObject({ configId: 'mode', value: 'auto_edit' })
    expect(driver.ready()).toBe(false)
    receive({ id: mode?.id, result: configFor('gemini-3.8-flash', ['low', 'medium', 'high'], 'auto_edit') })
    const model = due()[0]
    expect(model?.params).toMatchObject({ configId: 'model', value: 'gemini-3.1-pro' })
    receive({ id: model?.id, result: configFor('gemini-3.1-pro', ['low', 'medium', 'high', 'xhigh'], 'auto_edit') })
    const effort = due()[0]
    expect(effort?.params).toMatchObject({ configId: 'thinking_level', value: 'xhigh' })
    expect(driver.ready()).toBe(false)
    receive({ id: effort?.id, result: {} })
    expect(due()).toEqual([])
    expect(driver.ready()).toBe(true)
    expect(items(driver, 'state').at(-1)).toMatchObject(options.preferred)
    const replay = new AcpDriver(antigravityDialect, 'stage', options)
    records.forEach((record) => replay.apply(record))
    expect(replay.ready()).toBe(true)
    expect(replay.due()).toEqual([])
    expect(items(replay, 'state').at(-1)).toMatchObject(options.preferred)
  })

  it('retains earlier models’ efforts and clears levels omitted by a full model update', () => {
    const { driver, apply, receive } = start()
    const switchTo = (model: string, levels: string[] | null) => {
      const frame = Request.parse(driver.setOption('model', model)[0])
      apply({ dir: 'out', at: 10, frame })
      receive({ id: frame.id, result: configFor(model, levels) })
    }
    switchTo('gemini-3.1-pro', ['low', 'medium', 'high', 'xhigh'])
    expect(items(driver, 'state').at(-1)?.models.map((model) => model.efforts)).toEqual([['low', 'medium', 'high'], ['low', 'medium', 'high', 'xhigh']])
    receive({ method: 'session/update', params: { sessionId: opened.sessionId, update: { sessionUpdate: 'config_option_update', configOptions: [configFor('gemini-3.1-pro', null, 'auto_edit').configOptions.at(-1)] } } })
    expect(items(driver, 'state').at(-1)?.models[1]?.efforts).toEqual(['low', 'medium', 'high', 'xhigh'])
    receive({ method: 'session/update', params: { sessionId: opened.sessionId, update: { sessionUpdate: 'config_option_update', ...configFor('gemini-3.1-pro', null) } } })
    expect(items(driver, 'state').at(-1)?.effort).toBeNull()
    switchTo('gemini-3.8-flash', ['low', 'medium', 'high'])
    expect(items(driver, 'state').at(-1)?.models.map((model) => model.efforts)).toEqual([['low', 'medium', 'high'], []])
  })

  it('signs in with Google, then opens a session with Antumi’s MCP server', () => {
    const { driver, sent } = start({ mcp: { command: 'node', args: ['mcp.js'] } })
    expect(sent.map((frame) => frame.method)).toEqual(['initialize', 'authenticate', 'session/new'])
    expect(sent[1]?.params).toEqual({ methodId: 'oauth-personal' })
    expect(sent[2]?.params).toMatchObject({ cwd: '/project', mcpServers: [{ name: 'antumi', command: 'node', args: ['mcp.js'] }] })
    expect(driver.ready()).toBe(true)
    const state = items(driver, 'state').at(-1)
    expect(state?.models.map((model) => model.id)).toEqual(['gemini-3.8-flash', 'gemini-3.1-pro'])
    expect(state?.permissionMode).toBe('ask')
  })

  it('switches to Auto Edit for acceptEdits', () => {
    const { driver, receive, due, sent } = start({ preferred: { permissionMode: 'acceptEdits' } })
    const change = sent.at(-1)
    expect(change?.method).toBe('session/set_config_option')
    expect(change?.params).toMatchObject({ configId: 'mode', value: 'auto_edit' })
    receive({ id: change?.id, result: { configOptions: opened.configOptions.map((config) => config.id === 'mode' ? { ...config, currentValue: 'auto_edit' } : config) } })
    due()
    expect(driver.ready()).toBe(true)
    expect(items(driver, 'state').at(-1)?.permissionMode).toBe('acceptEdits')
  })

  it('refuses to start a stage that must stay read-only, having no such mode', () => {
    const { driver } = start({ readOnly: true })
    expect(driver.ready()).toBe(false)
    expect(driver.failure()).toBeTruthy()
  })

  it('names the other projects only on the wire of its first prompt', () => {
    const { driver } = start({ extraDirs: ['/other'] })
    const { wire, logged } = driver.send('hello')
    expect(JSON.stringify(wire)).toContain('- /other')
    expect(JSON.stringify(logged)).not.toContain('/other')
  })

  it('shows a command by its command line', () => {
    const { driver, apply, receive } = start()
    apply({ dir: 'out', at: 10, frame: driver.send('list the files').logged })
    receive({ jsonrpc: '2.0', method: 'session/update', params: { sessionId: opened.sessionId, update: { sessionUpdate: 'tool_call', toolCallId: 't1', title: 'ls -la', kind: 'execute', status: 'pending', rawInput: { command_line: 'ls -la', working_dir: '/project' } } } })
    receive({ jsonrpc: '2.0', method: 'session/update', params: { sessionId: opened.sessionId, update: { sessionUpdate: 'tool_call_update', toolCallId: 't1', status: 'completed', rawOutput: { combinedOutput: 'total 0', exitCode: 0 } } } })
    const tool = items(driver, 'tool').find((item) => item.id === 'tool:t1')
    expect(tool).toMatchObject({ name: 'commandExecution', title: 'ls -la', status: 'done', execution: { status: 'completed', exitCode: 0 } })
    expect(JSON.stringify(tool?.input)).toContain('ls -la')
  })
})
