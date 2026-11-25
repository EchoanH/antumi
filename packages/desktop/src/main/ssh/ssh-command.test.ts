import { ChildProcess, execFileSync, type SpawnOptions } from 'node:child_process'
import { existsSync } from 'node:fs'
import path from 'node:path'
import { PassThrough } from 'node:stream'
import { describe, expect, it } from 'vitest'
import { remoteCommand, runOverSsh, shellQuote, sshArgs, sshExecutable, validSshDestination, type SshHost } from './ssh-command'

class FakeChild extends ChildProcess {
  readonly out = new PassThrough()
  readonly err = new PassThrough()
  constructor() {
    super()
    this.stdin = new PassThrough()
    this.stdout = this.out
    this.stderr = this.err
  }
  override kill(): boolean {
    return true
  }
}

function fakeHost(controlDir: string | null, reply: (args: string[], options: SpawnOptions) => { code: number; stdout?: string; stderr?: string; holdStreams?: boolean }) {
  const calls: string[][] = []
  const host: SshHost = {
    platform: 'darwin',
    env: {},
    isFile: (file) => file === '/usr/bin/ssh',
    controlDir,
    spawn(_file, args, options) {
      calls.push(args)
      const child = new FakeChild()
      const answer = reply(args, options)
      setImmediate(() => {
        child.out.write(answer.stdout ?? '')
        child.err.write(answer.stderr ?? '')
        if (!answer.holdStreams) {
          child.out.end()
          child.err.end()
        }
        child.emit('exit', answer.code, null)
      })
      return child
    }
  }
  return { host, calls }
}

// The shells a server's user may log in with, as found here.
const POSIX_SHELLS = ['/bin/sh', '/bin/bash', '/bin/zsh', '/opt/homebrew/bin/fish', '/usr/bin/fish', '/usr/local/bin/fish']

// Git for Windows provides an actual POSIX shell to exercise the server-side command.
function testShells(): string[] {
  if (process.platform !== 'win32') return POSIX_SHELLS.filter((shell) => existsSync(shell))
  const gitExecPath = execFileSync('git', ['--exec-path'], { encoding: 'utf8' }).trim()
  return ['sh.exe', 'bash.exe'].map((shell) => path.resolve(gitExecPath, '../../../bin', shell)).filter((shell) => existsSync(shell))
}

const SHELLS = testShells()

describe('remoteCommand', () => {
  const tricky = ['plain', 'two words', "it's", 'a"b', '$HOME', '`id`', '$(id)', 'back\\slash', 'line\nbreak', '!bang', '*', '~', '', '中文', '--', '-n', "'\\''"]

  it('reaches the program with every argument as given, whichever shell the login is', () => {
    expect(SHELLS.length).toBeGreaterThan(0)
    for (const shell of SHELLS) {
      const out = execFileSync(shell, ['-c', remoteCommand(['/usr/bin/printf', '%s\\0', ...tricky])], { encoding: 'utf8' })
      expect(out.split('\0').slice(0, -1), shell).toEqual(tricky)
    }
  })

  it('sets the environment it is given, and refuses a name that is not one', () => {
    const shell = SHELLS[0]
    if (!shell) throw new Error('no POSIX shell to test the remote command')
    const out = execFileSync(shell, ['-c', remoteCommand(['/bin/sh', '-c', 'printf %s "$GREETING"'], { GREETING: "it's $HOME" })], { encoding: 'utf8' })
    expect(out).toBe("it's $HOME")
    expect(() => remoteCommand(['x'], { 'A B': '1' })).toThrow('ssh-bad-env-name')
    expect(() => remoteCommand([])).toThrow('ssh-empty-command')
  })

  it('shows the login shell only base64, in single quotes', () => {
    const command = remoteCommand(['echo', "'; rm -rf / #"])
    expect(command).toMatch(/^\/bin\/sh -c 'eval "\$\(echo [A-Za-z0-9+/=]+ \| base64 -d\)"'$/)
  })

  it('quotes for sh', () => {
    expect(shellQuote("a'b")).toBe("'a'\\''b'")
  })
})

describe('sshArgs', () => {
  it('never prompts, ignores what the config sets for a login, and shares connections where it can', () => {
    const { host } = fakeHost('/home/me/.antumi/ssh', () => ({ code: 0 }))
    const args = sshArgs(host, 'dev@box', 'cmd')
    expect(args.slice(-3)).toEqual(['--', 'dev@box', 'cmd'])
    for (const option of ['BatchMode=yes', 'RemoteCommand=none', 'ClearAllForwardings=yes', 'RequestTTY=no', 'ControlMaster=auto', 'ControlPath=/home/me/.antumi/ssh/%C']) expect(args).toContain(option)
    expect(args[0]).toBe('-T')
    expect(sshArgs({ ...host, controlDir: null }, 'box', 'cmd').some((arg) => arg.startsWith('Control'))).toBe(false)
  })

  it('takes no destination that reads as an option or holds a space', () => {
    expect(validSshDestination('dev@box')).toBe(true)
    expect(validSshDestination('box.example.com')).toBe(true)
    for (const bad of ['', '-oProxyCommand=evil', 'a b', 'a\nb', 'x'.repeat(256)]) expect(validSshDestination(bad), bad).toBe(false)
    const { host } = fakeHost(null, () => ({ code: 0 }))
    expect(() => sshArgs(host, '-oProxyCommand=evil', 'cmd')).toThrow('ssh-bad-destination')
  })

  it('finds ssh by its absolute path only', () => {
    const { host } = fakeHost(null, () => ({ code: 0 }))
    expect(sshExecutable(host)).toBe('/usr/bin/ssh')
    expect(sshExecutable({ ...host, isFile: () => false })).toBeNull()
    expect(sshExecutable({ ...host, platform: 'win32', env: { SystemRoot: 'D:\\Win' }, isFile: (file) => file === 'D:\\Win\\System32\\OpenSSH\\ssh.exe' })).toBe('D:\\Win\\System32\\OpenSSH\\ssh.exe')
  })
})

describe('runOverSsh', () => {
  it('feeds stdin and reads the answer', async () => {
    const { host, calls } = fakeHost(null, () => ({ code: 0, stdout: 'hi\n' }))
    const result = await runOverSsh(host, 'box', ['/bin/true'], { input: 'secret' })
    expect(result).toEqual({ code: 0, stdout: 'hi\n', stderr: '', timedOut: false })
    // The secret went to stdin, not the command line.
    expect(calls[0]?.join(' ')).not.toContain('secret')
  })

  it('does not wait on streams a shared connection keeps open', async () => {
    const { host } = fakeHost('/tmp/x', () => ({ code: 0, stdout: 'done', holdStreams: true }))
    const started = Date.now()
    expect(await runOverSsh(host, 'box', ['/bin/true'])).toMatchObject({ code: 0, stdout: 'done' })
    expect(Date.now() - started).toBeLessThan(3000)
  })

  it('says so when there is no ssh', async () => {
    const { host } = fakeHost(null, () => ({ code: 0 }))
    expect(await runOverSsh({ ...host, isFile: () => false }, 'box', ['/bin/true'])).toMatchObject({ code: null, stderr: 'ssh not found' })
  })
})
