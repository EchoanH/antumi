import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import type { DaemonEvent } from '@antumi/protocol/node'

const callbacks = vi.hoisted(() => ({
  env: new Map<string, string | undefined>(),
  data: (_text: string) => {},
  exit: (_event: { exitCode: number }) => {}
}))

vi.mock('node-pty', () => ({
  spawn: (_file: string, _args: string[], options: { env?: NodeJS.ProcessEnv }) => {
    callbacks.env = new Map(Object.entries(options.env ?? {}))
    return {
      onData: (handler: (text: string) => void) => { callbacks.data = handler },
      onExit: (handler: (event: { exitCode: number }) => void) => { callbacks.exit = handler },
      write: () => {}, resize: () => {}, kill: () => {}
    }
  }
}))

import { createSessionHost } from './session-host'

describe('PTY output offsets', () => {
  it('reports monotonic offsets and the bounded attach range', () => {
    const events: DaemonEvent[] = []
    const host = createSessionHost((event) => events.push(event))
    const { sessionId } = host.handlers.spawn({ command: process.execPath, args: [], cwd: '/tmp', env: {}, cols: 80, rows: 24 })
    callbacks.data('abc')
    callbacks.data('def')
    expect(events).toEqual([
      { event: 'data', sessionId, offset: 0, data: 'abc' },
      { event: 'data', sessionId, offset: 3, data: 'def' }
    ])
    const large = 'x'.repeat(600 * 1024)
    callbacks.data(large)
    const attached = host.handlers.attach({ sessionId })
    expect(attached.endOffset).toBe(6 + large.length)
    expect(attached.buffer.length).toBe(512 * 1024)
    expect(attached.bufferStart).toBe(attached.endOffset - attached.buffer.length)
    expect(attached.io).toBe('pty')
    callbacks.exit({ exitCode: 7 })
    expect(host.handlers.attach({ sessionId }).exitCode).toBe(7)
  })

  it('refuses a command it cannot find instead of reporting a silent exit', () => {
    const host = createSessionHost(() => {})
    expect(() => host.handlers.spawn({ command: 'claude-not-installed', args: [], cwd: '/tmp', env: { PATH: '/nowhere' }, cols: 80, rows: 24 }))
      .toThrow('command-not-found')
  })
})

function pipeHost(lifecycle?: { version: string; leave(): void }) {
  const events: DaemonEvent[] = []
  const waiters: Array<() => void> = []
  const host = createSessionHost((event) => {
    events.push(event)
    waiters.splice(0).forEach((wake) => wake())
  }, undefined, lifecycle)
  const until = async (done: () => boolean, timeoutMs = 5000) => {
    const deadline = Date.now() + timeoutMs
    while (!done()) {
      if (Date.now() > deadline) throw new Error('timed out waiting for the child')
      await new Promise<void>((resolve) => {
        waiters.push(resolve)
        setTimeout(resolve, 50)
      })
    }
  }
  const spawn = (script: string) =>
    host.handlers.spawnPipe({ command: process.execPath, args: ['-e', script], cwd: process.cwd(), env: {} }).sessionId
  const stdout = (sessionId: string) =>
    events.flatMap((event) => (event.event === 'data' && event.sessionId === sessionId ? [event] : []))
  const exited = (sessionId: string) => events.some((event) => event.event === 'exit' && event.sessionId === sessionId)
  return { host, events, until, spawn, stdout, exited }
}

describe('pipe sessions', () => {
  it('starts a clean pipe with none of its own environment but what a process needs', async () => {
    const { host, until, stdout } = pipeHost()
    process.env.ANTUMI_TEST_SECRET = 'leaked'
    try {
      const sessionId = host.handlers.spawnPipeClean({
        command: process.execPath, args: ['-e', `process.stdout.write(JSON.stringify({ secret: process.env.ANTUMI_TEST_SECRET ?? null, given: process.env.GIVEN, path: Boolean(process.env.PATH ?? process.env.Path) }))`],
        cwd: process.cwd(), env: { GIVEN: 'yes' }
      }).sessionId
      await until(() => stdout(sessionId).length > 0)
      expect(JSON.parse(stdout(sessionId).map((event) => event.data).join(''))).toEqual({ secret: null, given: 'yes', path: true })
    } finally {
      delete process.env.ANTUMI_TEST_SECRET
    }
  })

  it('passes stdin through and counts stdout offsets in characters', async () => {
    const { host, until, spawn, stdout } = pipeHost()
    const sessionId = spawn(`process.stdin.setEncoding('utf8'); process.stdin.on('data', (d) => process.stdout.write(d.toUpperCase()))`)
    host.handlers.write({ sessionId, data: 'héllo\n' })
    await until(() => stdout(sessionId).map((event) => event.data).join('') === 'HÉLLO\n')
    const chunks = stdout(sessionId)
    expect(chunks[0]?.offset).toBe(0)
    expect(host.handlers.attach({ sessionId })).toMatchObject({ io: 'pipe', buffer: 'HÉLLO\n', bufferStart: 0, endOffset: 6, exited: false })
    host.handlers.kill({ sessionId })
  })

  it('keeps a character whole when its bytes arrive in separate chunks', async () => {
    const { until, spawn, stdout, exited } = pipeHost()
    const sessionId = spawn(`process.stdout.write(Buffer.from([0xe4, 0xb8])); setTimeout(() => process.stdout.write(Buffer.from([0xad, 0x0a])), 50)`)
    await until(() => exited(sessionId))
    expect(stdout(sessionId).map((event) => event.data).join('')).toBe('中\n')
  })

  it('reports stderr, the real exit code, and lets core release the session after it ends', async () => {
    const { host, events, until, spawn, exited } = pipeHost()
    const sessionId = spawn(`process.stderr.write('not signed in'); process.exitCode = 3`)
    expect(() => host.handlers.release({ sessionId })).toThrow('session-running')
    await until(() => exited(sessionId))
    expect(events).toContainEqual({ event: 'stderr', sessionId, data: 'not signed in' })
    expect(events).toContainEqual({ event: 'exit', sessionId, exitCode: 3 })
    expect(host.handlers.attach({ sessionId })).toMatchObject({ exited: true, exitCode: 3, stderr: 'not signed in' })
    host.handlers.release({ sessionId })
    expect(host.handlers.list({}).sessions.map((session) => session.sessionId)).not.toContain(sessionId)
  })

  it('survives writing to a child that closed its stdin', async () => {
    const { host, until, spawn, exited } = pipeHost()
    const sessionId = spawn(`process.stdin.destroy(); setTimeout(() => {}, 300)`)
    await new Promise((resolve) => setTimeout(resolve, 100))
    for (let i = 0; i < 20; i++) host.handlers.write({ sessionId, data: 'x'.repeat(64 * 1024) })
    await until(() => exited(sessionId))
  })

  it.skipIf(process.platform === 'win32')('kills what the agent started along with it', async () => {
    const { host, until, spawn, stdout, exited } = pipeHost()
    const sessionId = spawn(
      `const c = require('node:child_process').spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore' }); process.stdout.write(String(c.pid) + '\\n'); setInterval(() => {}, 1000)`
    )
    await until(() => stdout(sessionId).some((event) => event.data.includes('\n')))
    const grandchild = Number(stdout(sessionId).map((event) => event.data).join('').trim())
    host.handlers.kill({ sessionId })
    await until(() => exited(sessionId))
    await until(() => {
      try {
        process.kill(grandchild, 0)
        return false
      } catch {
        return true
      }
    })
  })

  it.runIf(process.platform === 'win32')('stops the main process when the Windows tree killer is unavailable', async () => {
    const { host, until, spawn, stdout, exited } = pipeHost()
    const root = mkdtempSync(path.join(tmpdir(), 'antumi-no-taskkill-'))
    const sessionId = spawn("process.stdout.write('ready'); setTimeout(() => {}, 10_000)")
    try {
      await until(() => stdout(sessionId).length > 0)
      vi.stubEnv('SystemRoot', root)
      host.handlers.kill({ sessionId })
      vi.unstubAllEnvs()
      await until(() => exited(sessionId), 2000)
    } finally {
      vi.unstubAllEnvs()
      if (!exited(sessionId)) host.handlers.kill({ sessionId })
      rmSync(root, { recursive: true, force: true })
    }
  })

  it('refuses a command it cannot find', () => {
    const host = createSessionHost(() => {})
    expect(() => host.handlers.spawnPipe({ command: 'codex-not-installed', args: [], cwd: '/tmp', env: { PATH: '/nowhere' } }))
      .toThrow('command-not-found')
  })
})

describe('retiring for an update', () => {
  it('says what it is, refuses while anything runs, and leaves once nothing does', async () => {
    const leave = vi.fn()
    const { host, until, stdout, exited } = pipeHost({ version: '9.9.9', leave })
    expect(host.handlers.info({})).toEqual({ version: '9.9.9', pid: process.pid, features: ['agent-cli-maintenance', 'clean-pipe', 'unset-env'] })
    const keep = `process.stdout.write('ready'); setTimeout(() => {}, 20_000)`
    const owner = 'conversation:11111111-1111-4111-8111-111111111111'
    const agent = host.handlers.spawnPipe({ command: process.execPath, args: ['-e', keep], cwd: process.cwd(), env: { ANTUMI_OWNER: owner } }).sessionId
    try {
      await until(() => stdout(agent).length > 0)
      // Whose it is, for a core that lost track of it.
      expect(host.handlers.list({}).sessions.find((session) => session.sessionId === agent)?.owner).toBe(owner)
      expect(host.handlers.retire({})).toEqual({ retired: false, live: 1, blockers: [{ sessionId: agent }] })
      host.handlers.kill({ sessionId: agent })
      await until(() => exited(agent), 8000)
      expect(host.handlers.retire({})).toEqual({ retired: true, live: 0, blockers: [] })
      expect(() => host.handlers.spawnPipe({ command: process.execPath, args: ['-e', keep], cwd: process.cwd(), env: {} })).toThrow('daemon-retiring')
      expect(() => host.handlers.spawn({ command: process.execPath, args: [], cwd: process.cwd(), env: {}, cols: 80, rows: 24 })).toThrow('daemon-retiring')
      expect(host.handlers.retire({})).toEqual({ retired: true, live: 0, blockers: [] })
      await new Promise((resolve) => setTimeout(resolve, 100))
      expect(leave).toHaveBeenCalledOnce()
    } finally {
      if (!exited(agent)) host.handlers.kill({ sessionId: agent })
    }
  }, 15_000)
})

describe('CLI upgrade admission', () => {
  const launch = { command: process.execPath, args: [], cwd: process.cwd(), env: {}, cols: 80, rows: 24 }
  const upgradeId = '00000000-0000-4000-8000-000000000001'

  it('blocks an upgrade for a live agent, including an idle PTY, but ignores exited processes', () => {
    const host = createSessionHost(() => {})
    host.handlers.spawn({ ...launch, agent: 'codex' })
    expect(() => host.handlers.spawnCliUpgrade({ ...launch, agent: 'codex', upgradeId })).toThrow('agent-cli-active')
    callbacks.exit({ exitCode: 0 })
    const upgrade = host.handlers.spawnCliUpgrade({ ...launch, agent: 'codex', upgradeId })
    expect(host.handlers.attach(upgrade)).toMatchObject({ agent: 'codex', upgradeId, exited: false })
    callbacks.exit({ exitCode: 0 })
  })

  it('atomically prevents same-agent starts and concurrent upgrades while allowing other agents and terminals', () => {
    const host = createSessionHost(() => {})
    const upgrade = host.handlers.spawnCliUpgrade({ ...launch, agent: 'codex', upgradeId })
    const finishUpgrade = callbacks.exit
    expect(() => host.handlers.spawnPipe({ ...launch, agent: 'codex' })).toThrow('agent-cli-maintenance-running')
    expect(() => host.handlers.spawn({ ...launch, agent: 'codex' })).toThrow('agent-cli-maintenance-running')
    expect(() => host.handlers.spawnCliUpgrade({ ...launch, agent: 'claude', upgradeId })).toThrow('agent-cli-maintenance-running')
    expect(() => host.handlers.spawn({ ...launch, agent: 'claude' })).not.toThrow()
    expect(() => host.handlers.spawn(launch)).not.toThrow()
    finishUpgrade({ exitCode: 0 })
    expect(host.handlers.attach(upgrade).exited).toBe(true)
    expect(() => host.handlers.spawn({ ...launch, agent: 'codex' })).not.toThrow()
  })

  it('retains a cancellation reason until the actual exit and keeps the admission lock meanwhile', () => {
    const host = createSessionHost(() => {})
    const upgrade = host.handlers.spawnCliUpgrade({ ...launch, agent: 'codex', upgradeId })
    host.handlers.kill(upgrade)
    expect(host.handlers.attach(upgrade)).toMatchObject({ stopReason: 'cancelled', exited: false })
    expect(() => host.handlers.spawn({ ...launch, agent: 'codex' })).toThrow('agent-cli-maintenance-running')
    callbacks.exit({ exitCode: 143 })
  })

  it('times out an upgrade in the daemon, even with no core connected', () => {
    vi.useFakeTimers()
    try {
      const host = createSessionHost(() => {})
      const upgrade = host.handlers.spawnCliUpgrade({ ...launch, agent: 'codex', upgradeId })
      vi.advanceTimersByTime(5 * 60_000)
      expect(host.handlers.attach(upgrade)).toMatchObject({ stopReason: 'timed-out', exited: false })
      callbacks.exit({ exitCode: 143 })
      expect(host.handlers.attach(upgrade).exited).toBe(true)
    } finally { vi.useRealTimers() }
  })
})

const proxyKeys = ['HTTP_PROXY', 'HTTPS_PROXY', 'ALL_PROXY', 'NO_PROXY', 'http_proxy', 'https_proxy', 'all_proxy', 'no_proxy', 'npm_config_proxy', 'npm_config_https_proxy', 'npm_config_noproxy', 'NPM_CONFIG_PROXY', 'NPM_CONFIG_HTTPS_PROXY', 'NPM_CONFIG_NOPROXY']
describe('proxy launch environment', () => {
  it.each(['spawnPipe', 'spawnPipeClean'] as const)('%s clears inherited overrides before injecting canonical proxy variables', async (method) => {
    const { host, until, stdout, exited } = pipeHost()
    const script = 'process.stdout.write(JSON.stringify(Object.fromEntries(' + JSON.stringify(proxyKeys) + '.map(key => [key, process.env[key] ?? null]))))'
    const env = { HTTP_PROXY: 'http://proxy:7897', HTTPS_PROXY: 'http://proxy:7897', NO_PROXY: 'localhost,127.0.0.1,::1' }
    const { sessionId } = host.handlers[method]({ command: process.execPath, args: ['-e', script], cwd: process.cwd(), env, unsetEnv: proxyKeys, agent: 'codex' })
    await until(() => exited(sessionId))
    const result = JSON.parse(stdout(sessionId).map((event) => event.data).join(''))
    expect(result).toMatchObject(env)
    expect(result.ALL_PROXY).toBeNull()
    expect(result.npm_config_proxy).toBeNull()
    if (process.platform !== 'win32') expect(result.http_proxy).toBeNull()
    host.handlers.release({ sessionId })
    const direct = host.handlers[method]({ command: process.execPath, args: ['-e', script], cwd: process.cwd(), env: {}, unsetEnv: proxyKeys, agent: 'codex' }).sessionId
    await until(() => exited(direct))
    expect(Object.values(JSON.parse(stdout(direct).map((event) => event.data).join(''))).every((value) => value === null)).toBe(true)
    host.handlers.release({ sessionId: direct })
  })
  it.each(['spawn', 'spawnCliUpgrade'] as const)('%s strips proxy overrides and allows explicit env to replace them', (method) => {
    const host = createSessionHost(() => {})
    const launch = { command: process.execPath, args: [], cwd: process.cwd(), env: { HTTP_PROXY: 'http://proxy:7897', NO_PROXY: 'localhost,127.0.0.1,::1' }, unsetEnv: proxyKeys, cols: 80, rows: 24, agent: 'codex' as const, upgradeId: 'proxy-upgrade' }
    if (method === 'spawn') host.handlers.spawn(launch)
    else host.handlers.spawnCliUpgrade(launch)
    expect(callbacks.env.get('HTTP_PROXY')).toBe('http://proxy:7897')
    expect(callbacks.env.get('NO_PROXY')).toBe('localhost,127.0.0.1,::1')
    expect(callbacks.env.has('HTTPS_PROXY')).toBe(false)
    expect(callbacks.env.has('npm_config_proxy')).toBe(false)
    if (process.platform !== 'win32') expect(callbacks.env.has('http_proxy')).toBe(false)
    callbacks.exit({ exitCode: 0 })
  })
})
