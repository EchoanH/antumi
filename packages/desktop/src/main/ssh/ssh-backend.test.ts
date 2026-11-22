import { ChildProcess } from 'node:child_process'
import { PassThrough } from 'node:stream'
import { describe, expect, it } from 'vitest'
import { connectionProblem, findSshBackendPlace, parseProbe } from './ssh-backend'
import type { SshHost } from './ssh-command'

class FakeChild extends ChildProcess {
  readonly out = new PassThrough()
  readonly err = new PassThrough()
  constructor() {
    super()
    this.stdin = new PassThrough()
    this.stdout = this.out
    this.stderr = this.err
  }
}

// The program a remote command runs, unpacked from its base64 as sh on the server would.
function scriptOf(command: string): string {
  const encoded = /echo ([A-Za-z0-9+/=]+) \|/.exec(command)?.[1] ?? ''
  return Buffer.from(encoded, 'base64').toString('utf8')
}

type Reply = { code: number; stdout?: string; stderr?: string }

// A server whose ssh answers from the script it was asked to run; one it returns nothing for exits 0.
function server(answer: (script: string) => Reply | undefined) {
  const scripts: string[] = []
  const host: SshHost = {
    platform: 'linux',
    env: {},
    isFile: (file) => file === '/usr/bin/ssh',
    controlDir: null,
    spawn(_file, args) {
      const script = scriptOf(args.at(-1) ?? '')
      scripts.push(script)
      const child = new FakeChild()
      const reply = answer(script) ?? { code: 0 }
      setImmediate(() => {
        child.out.end(reply.stdout ?? '')
        child.err.end(reply.stderr ?? '')
        child.emit('exit', reply.code, null)
      })
      return child
    }
  }
  return { host, scripts }
}

const ARCHIVE = { file: '/nowhere/backend-linux-x64.tar.gz', sha256: 'a'.repeat(64) }
const PROBE_OK = 'os=Linux\narch=x86_64\nkill=b false\nlinger=no\nuid=1000\n'

// Answers the probe, the login shell and node the way a ready server would.
function ready(overrides: (script: string) => Reply | undefined = () => undefined) {
  return server((script) => {
    const own = overrides(script)
    if (own) return own
    if (script.includes('uname -s')) return { code: 0, stdout: PROBE_OK }
    if (script.includes('getent passwd')) {
      const mark = /'(__ANTUMI_[0-9a-f]{16}_)'/.exec(script)?.[1] ?? ''
      return { code: 0, stdout: `${mark}/bin/bash\n${mark}path\n/usr/local/bin:/usr/bin\n${mark}home\n/home/dev\n${mark}end\n` }
    }
    if (script.includes('command -v "$1"')) return { code: 0, stdout: '/usr/local/bin/node\n' }
    if (script.includes('--version')) return { code: 0, stdout: 'v24.3.0\n' }
    return undefined
  })
}

const find = (host: SshHost, archive: (arch: string) => typeof ARCHIVE | null = () => ARCHIVE) =>
  findSshBackendPlace({ destination: 'dev@box', version: '0.22.0', archive: async (arch) => archive(arch), host })

describe('findSshBackendPlace', () => {
  it('finds node through the login shell and names the folder for this build', async () => {
    const { host } = ready()
    expect(await find(host)).toEqual({
      ok: true,
      archive: ARCHIVE,
      place: { destination: 'dev@box', node: '/usr/local/bin/node', home: '/home/dev', path: '/usr/local/bin:/usr/bin', dir: `/home/dev/.antumi/backend/0.22.0-${'a'.repeat(12)}` }
    })
  })

  it('takes the archive for the server\'s architecture', async () => {
    const asked: string[] = []
    const { host } = ready((script) => (script.includes('uname -s') ? { code: 0, stdout: 'os=Linux\narch=aarch64\n' } : undefined))
    await find(host, (arch) => { asked.push(arch); return ARCHIVE })
    expect(asked).toEqual(['arm64'])
  })

  it('says what is wrong with the connection or the server', async () => {
    const problem = async (overrides: (script: string) => Reply | undefined, archive?: (arch: string) => typeof ARCHIVE | null) => {
      const found = await find(ready(overrides).host, archive)
      return found.ok ? null : found.problem
    }
    expect(await problem((s) => (s.includes('uname -s') ? { code: 255, stderr: 'dev@box: Permission denied (publickey).' } : undefined))).toMatchObject({ kind: 'ssh-auth' })
    expect(await problem((s) => (s.includes('uname -s') ? { code: 255, stderr: 'Host key verification failed.' } : undefined))).toMatchObject({ kind: 'ssh-host-key' })
    expect(await problem((s) => (s.includes('uname -s') ? { code: 255, stderr: 'ssh: Could not resolve hostname box' } : undefined))).toMatchObject({ kind: 'ssh-unreachable' })
    expect(await problem((s) => (s.includes('uname -s') ? { code: 0, stdout: 'os=Darwin\narch=arm64\n' } : undefined))).toEqual({ kind: 'os', os: 'Darwin' })
    expect(await problem((s) => (s.includes('uname -s') ? { code: 0, stdout: 'os=Linux\narch=riscv64\n' } : undefined))).toEqual({ kind: 'arch', arch: 'riscv64' })
    expect(await problem(() => undefined, () => null)).toEqual({ kind: 'arch', arch: 'x86_64' })
    expect(await problem((s) => (s.includes('uname -s') ? { code: 0, stdout: 'os=Linux\narch=x86_64\nkill=b true\nlinger=no\nuid=1000\n' } : undefined))).toEqual({ kind: 'linger' })
    expect(await problem((s) => (s.includes('command -v "$1"') ? { code: 127 } : undefined))).toEqual({ kind: 'node-missing' })
    expect(await problem((s) => (s.includes('--version') ? { code: 0, stdout: 'v22.1.0\n' } : undefined))).toEqual({ kind: 'node-old', version: 'v22.1.0', path: '/usr/local/bin/node' })
  })

  it('says so when there is no ssh at all', async () => {
    const { host } = ready()
    expect(await find({ ...host, isFile: () => false })).toEqual({ ok: false, problem: { kind: 'ssh-unavailable' } })
  })
})

describe('parseProbe', () => {
  it('counts on systemd ending sessions only where it would for this user', () => {
    expect(parseProbe(PROBE_OK)).toEqual({ os: 'Linux', arch: 'x86_64', endsSessions: false })
    expect(parseProbe('os=Linux\narch=x86_64\nkill=b true\nlinger=yes\nuid=1000\n')?.endsSessions).toBe(false)
    expect(parseProbe('os=Linux\narch=x86_64\nkill=b true\nlinger=no\nuid=0\n')?.endsSessions).toBe(false)
    expect(parseProbe('os=Linux\narch=x86_64\nkill=b true\nlinger=no\nuid=1000\n')?.endsSessions).toBe(true)
    // No systemd to ask: nothing ends the backend with the session.
    expect(parseProbe('os=Linux\narch=x86_64\n')?.endsSessions).toBe(false)
    expect(parseProbe('Welcome!\n')).toBeNull()
  })
})

describe('connectionProblem', () => {
  it('tells a changed host key from a missing login', () => {
    expect(connectionProblem({ code: 255, stdout: '', stderr: '@@@ WARNING: REMOTE HOST IDENTIFICATION HAS CHANGED! @@@', timedOut: false }).kind).toBe('ssh-host-key')
    expect(connectionProblem({ code: 255, stdout: '', stderr: 'Too many authentication failures', timedOut: false }).kind).toBe('ssh-auth')
    expect(connectionProblem({ code: null, stdout: '', stderr: '', timedOut: true })).toMatchObject({ kind: 'ssh-unreachable', detail: expect.stringContaining('timed out') })
  })
})
