import { spawn, type ChildProcess, type SpawnOptions } from 'node:child_process'
import { mkdirSync, statSync } from 'node:fs'
import path from 'node:path'
import { envValue } from '@antumi/protocol/node'
import type { LinuxEnv, LinuxResult, LinuxRunOptions } from '../linux-backend/linux-target'

// Running programs on an SSH host through the system's own ssh (docs/REMOTE.md, 连接), so the
// user's ~/.ssh/config, agent, jump hosts and known_hosts all apply.

// What running ssh reads of this machine; tests stand theirs in.
export type SshHost = {
  platform: NodeJS.Platform
  env: NodeJS.ProcessEnv
  isFile(file: string): boolean
  spawn(file: string, args: string[], options: SpawnOptions): ChildProcess
  // Where connections are shared from; null where ssh cannot share them (Windows' OpenSSH).
  controlDir: string | null
}

export function nodeSshHost(controlDir: string | null): SshHost {
  return {
    platform: process.platform,
    env: process.env,
    isFile(file) {
      try {
        return statSync(file).isFile()
      } catch {
        return false
      }
    },
    spawn: (file, args, options) => spawn(file, args, options),
    controlDir: process.platform === 'win32' ? null : controlDir
  }
}

// The system's ssh by its absolute path, never one found on PATH or in the cwd; null without one.
export function sshExecutable(host: SshHost): string | null {
  const file = host.platform === 'win32'
    ? path.win32.join(envValue(host.env, 'SystemRoot', 'win32') ?? 'C:\\Windows', 'System32', 'OpenSSH', 'ssh.exe')
    : '/usr/bin/ssh'
  return host.isFile(file) ? file : null
}

// What the user typed as the server: `user@host` or an alias of ~/.ssh/config. Never an option.
export function validSshDestination(destination: string): boolean {
  return destination.length > 0 && destination.length <= 255 && !destination.startsWith('-') && !/[\s\x00-\x1f\x7f]/.test(destination)
}

// sh's quoting: everything literal inside single quotes, a quote itself closed, escaped, reopened.
export function shellQuote(word: string): string {
  return `'${word.replaceAll("'", `'\\''`)}'`
}

const ENV_NAME = /^[A-Za-z_][A-Za-z0-9_]*$/

// The command line ssh hands the host's login shell, which may be sh, bash, zsh or fish and quotes
// each its own way: the program, quoted for sh, goes as base64, which no shell changes, and sh
// unpacks it there.
export function remoteCommand(argv: readonly string[], env: LinuxEnv = {}): string {
  if (argv.length === 0 || !argv[0]) throw new Error('ssh-empty-command')
  const assignments = Object.entries(env).map(([key, value]) => {
    if (!ENV_NAME.test(key)) throw new Error('ssh-bad-env-name')
    return `${key}=${value}`
  })
  const words = assignments.length > 0 ? ['/usr/bin/env', ...assignments, ...argv] : [...argv]
  const script = `exec ${words.map(shellQuote).join(' ')}`
  return `/bin/sh -c 'eval "$(echo ${Buffer.from(script).toString('base64')} | base64 -d)"'`
}

// Every connection: never a prompt (there is no terminal to answer it), none of what the user's
// config sets up for an interactive login (a remote command, forwarded ports, a local command),
// and a dead link noticed within a minute. Shared connections where ssh can share them, so asking
// core where it listens costs no new handshake.
export function sshArgs(host: SshHost, destination: string, command: string): string[] {
  if (!validSshDestination(destination)) throw new Error('ssh-bad-destination')
  const options = [
    'BatchMode=yes',
    'ConnectTimeout=15',
    'ServerAliveInterval=15',
    'ServerAliveCountMax=3',
    'RequestTTY=no',
    'RemoteCommand=none',
    'ClearAllForwardings=yes',
    'PermitLocalCommand=no',
    ...(host.controlDir ? ['ControlMaster=auto', `ControlPath=${path.join(host.controlDir, '%C')}`, 'ControlPersist=300'] : [])
  ]
  return ['-T', ...options.flatMap((option) => ['-o', option]), '--', destination, command]
}

const DEFAULT_TIMEOUT_MS = 30_000
const EXIT_GRACE_MS = 1000

function prepare(host: SshHost): string | null {
  if (host.controlDir) {
    try {
      mkdirSync(host.controlDir, { recursive: true, mode: 0o700 })
    } catch {
      // ssh says what is wrong with the folder itself.
    }
  }
  return sshExecutable(host)
}

// A program on the host, run to its end. Resolves on any exit code; ssh's own failures exit 255.
export function runOverSsh(host: SshHost, destination: string, argv: readonly string[], options: LinuxRunOptions = {}): Promise<LinuxResult> {
  const file = prepare(host)
  if (!file) return Promise.resolve({ code: null, stdout: '', stderr: 'ssh not found', timedOut: false })
  return new Promise((resolve) => {
    const out: Buffer[] = []
    const err: Buffer[] = []
    let settled = false
    const settle = (code: number | null, timedOut: boolean, note = '') => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      const stderr = Buffer.concat(err).toString('utf8')
      resolve({ code, stdout: Buffer.concat(out).toString('utf8'), stderr: note ? `${stderr}${stderr ? '\n' : ''}${note}` : stderr, timedOut })
    }
    let child: ChildProcess
    try {
      child = host.spawn(file, sshArgs(host, destination, remoteCommand(argv, options.env)), { stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true })
    } catch (error) {
      resolve({ code: null, stdout: '', stderr: String(error), timedOut: false })
      return
    }
    const timer = setTimeout(() => {
      child.kill()
      settle(null, true)
    }, options.timeoutMs ?? DEFAULT_TIMEOUT_MS)
    child.stdout?.on('data', (chunk: Buffer) => out.push(chunk))
    child.stderr?.on('data', (chunk: Buffer) => err.push(chunk))
    child.on('error', (error) => settle(null, false, String(error)))
    // Once its output has ended, or a moment after it exits: the connection ssh goes on sharing in
    // the background may hold on to the streams it was started with.
    let ended = 0
    let exited: number | null | undefined
    const done = () => { if (exited !== undefined && ended === 2) settle(exited, false) }
    for (const stream of [child.stdout, child.stderr]) stream?.on('end', () => { ended += 1; done() })
    child.on('exit', (code) => {
      exited = code
      done()
      setTimeout(() => settle(code, false), EXIT_GRACE_MS).unref()
    })
    child.stdin?.on('error', () => {})
    child.stdin?.end(options.input)
  })
}

// A long-lived program on the host with piped, binary-clean stdio. Throws `ssh-not-found`.
export function spawnOverSsh(host: SshHost, destination: string, argv: readonly string[], env: LinuxEnv = {}): ChildProcess {
  const file = prepare(host)
  if (!file) throw new Error('ssh-not-found')
  return host.spawn(file, sshArgs(host, destination, remoteCommand(argv, env)), { stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true })
}
