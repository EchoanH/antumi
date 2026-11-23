// This folder's modules against a real ssh and a real Linux server: what the unit tests can only
// assume (the login shell, detaching from the session, the tunnel over ssh's stdio). Skipped
// unless pointed at a server it may install a backend on:
//
//   ANTUMI_SSH_SMOKE=<destination> ANTUMI_SSH_SMOKE_BACKEND=<pack-linux-backend's output folder> \
//   [ANTUMI_SSH_SMOKE_CONFIG=<ssh config file>] pnpm vitest run packages/desktop/src/main/ssh/ssh-smoke.test.ts
//
// The config file stands in for ~/.ssh/config, to reach a throwaway server (docs/REMOTE.md 验证).
import { mkdtempSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { afterAll, describe, expect, it } from 'vitest'
import { coreUrl, PROTOCOL_VERSION, type CoreEndpoint } from '@antumi/protocol'
import { bundledLinuxBackend, type LinuxArch } from '../linux-backend/bundled-archive'
import { fetchNodeInto } from '../linux-backend/managed-node'
import { ensureSshBackend, sshCoreEndpoint, sshTarget, type SshBackendPlace } from './ssh-backend'
import { nodeSshHost, runOverSsh, type SshHost } from './ssh-command'
import { SshSession } from './ssh-session'

const destination = process.env.ANTUMI_SSH_SMOKE ?? ''
const folder = process.env.ANTUMI_SSH_SMOKE_BACKEND ?? ''
const config = process.env.ANTUMI_SSH_SMOKE_CONFIG

// Short, as a socket path must be: /tmp rather than the system's long temporary folder.
const controlDir = mkdtempSync('/tmp/antumi-ssh-')
const real = nodeSshHost(controlDir)
const host: SshHost = config ? { ...real, spawn: (file, args, options) => real.spawn(file, ['-F', config, ...args], options) } : real
const version = folder ? String(JSON.parse(readFileSync(join(folder, `backend-linux-${process.arch === 'x64' ? 'x64' : 'arm64'}.json`), 'utf8')).version) : ''
const archive = (arch: LinuxArch) => bundledLinuxBackend(folder, arch, '')
// Node fetched here for a server that cannot download it, kept apart from the app's own cache.
const fetchNode = fetchNodeInto(mkdtempSync('/tmp/antumi-node-'))
const options = { destination, version, archive, host, fetchNode }

function rpc(endpoint: Pick<CoreEndpoint, 'port' | 'token'>, method: string, params: unknown): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const socket = new WebSocket(coreUrl(endpoint))
    const timer = setTimeout(() => { socket.close(); reject(new Error(`${method} timed out`)) }, 30_000)
    socket.onerror = () => { clearTimeout(timer); reject(new Error(`${method}: no connection on port ${String(endpoint.port)}`)) }
    socket.onopen = () => socket.send(JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }))
    socket.onmessage = (event) => {
      const message: unknown = JSON.parse(String(event.data))
      if (typeof message !== 'object' || message === null || !('id' in message) || message.id !== 1) return
      clearTimeout(timer)
      socket.close()
      if ('error' in message) reject(new Error(`${method}: ${JSON.stringify(message.error)}`))
      else resolve('result' in message ? message.result : null)
    }
  })
}

const run = (script: string) => runOverSsh(host, destination, ['/bin/sh', '-c', script])
// Ends the connection ssh shares, as when the app quits or the network drops.
const dropSharedConnection = () => new Promise<void>((resolve) => {
  const child = host.spawn('/usr/bin/ssh', ['-o', `ControlPath=${join(controlDir, '%C')}`, '-O', 'exit', '--', destination], { stdio: 'ignore' })
  child.on('exit', () => resolve())
})

describe.skipIf(!destination || !folder)('a backend on a real SSH host', () => {
  let place: SshBackendPlace | null = null
  let pid = 0

  afterAll(async () => {
    await dropSharedConnection()
  })

  it('installs and starts the backend, which answers', async () => {
    const started = await ensureSshBackend(options)
    if (!started.ok) {
      const logs = await run('tail -n 20 "$HOME/.antumi/logs/core.log" "$HOME/.antumi/logs/daemon.log" 2>&1')
      throw new Error(`${JSON.stringify(started.problem)}\n${logs.stdout}`)
    }
    place = started.place
    pid = started.endpoint.pid
    // The server's own Node when it has one new enough, else the one installed for it.
    expect(place.node).toMatch(/^\/usr\/(local\/)?bin\/node$|\/\.antumi\/node\/v24\.[0-9.]+\/node$/)
    expect(place.dir).toContain(`/.antumi/backend/${version}-`)
  }, 120_000)

  it('runs core and daemon in sessions of their own, apart from ssh', async () => {
    const ps = await run('ps -eo pid,ppid,sid,args | grep -E "(core|daemon)\\.mjs" | grep -v grep')
    const lines = ps.stdout.trim().split('\n')
    expect(lines.length, ps.stdout).toBeGreaterThanOrEqual(2)
    for (const line of lines) {
      const [processId, , session] = line.trim().split(/\s+/)
      expect(processId, line).toBe(session)
    }
  })

  it('reaches core through the tunnel helper over ssh', async () => {
    const session = new SshSession(options)
    expect(await session.start()).toBeNull()
    const endpoint = await session.endpoint()
    expect(endpoint).not.toBeNull()
    const hello = await rpc(endpoint ?? { port: 0, token: '' }, 'system.hello', { protocolVersion: PROTOCOL_VERSION })
    expect(hello).toMatchObject({ protocolVersion: PROTOCOL_VERSION })
    const environment = await rpc(endpoint ?? { port: 0, token: '' }, 'system.environment', { refresh: true })
    expect(JSON.stringify(environment)).toContain('/home/')
    session.stop()
  }, 120_000)

  it('keeps the backend running when the connection goes, and finds the same core again', async () => {
    await dropSharedConnection()
    if (!place) throw new Error('not started')
    const endpoint = await sshCoreEndpoint(host, place)
    expect(endpoint?.pid).toBe(pid)
    const again = await ensureSshBackend(options)
    expect(again.ok && again.endpoint.pid).toBe(pid)
  }, 120_000)

  it('keeps the backend for an older app, as two computers sharing the server would', async () => {
    // Labels only: the core keeps reporting the version it was built as, newer than this one.
    const older = await ensureSshBackend({ ...options, version: '0.0.1' })
    expect(older.ok && older.endpoint.pid).toBe(pid)
  }, 120_000)

  it('hands the browser to the app before when the last one leaves', async () => {
    const hostFile = async () => (await run('cat "$HOME/.antumi/browser/host.json" 2> /dev/null')).stdout
    const office = new SshSession(options)
    const home = new SshSession(options)
    expect(await office.start()).toBeNull()
    office.setBrowserHost({ port: 40001, token: 'office' })
    await expect.poll(hostFile, { timeout: 15_000 }).toContain('"office"')
    expect(await home.start()).toBeNull()
    home.setBrowserHost({ port: 40002, token: 'home' })
    await expect.poll(hostFile, { timeout: 15_000 }).toContain('"home"')
    home.stop()
    await expect.poll(hostFile, { timeout: 15_000 }).toContain('"office"')
    office.stop()
    await expect.poll(hostFile, { timeout: 15_000 }).toBe('')
  }, 120_000)

  it('asks a shared connection quickly', async () => {
    await run('true')
    const began = Date.now()
    await sshTarget(host, destination).run(['/bin/true'])
    expect(Date.now() - began).toBeLessThan(1500)
  })
})
