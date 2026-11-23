import type { CoreEndpoint } from '@antumi/protocol'
import type { SshBackendProblem } from '../../shared/backend-location'
import { linuxArch, type LinuxArch } from '../linux-backend/bundled-archive'
import {
  backendFolder,
  ensureLinuxBackend,
  findLinuxBackendPlace,
  linuxCoreEndpoint,
  replaceOldLinuxDaemon,
  said,
  type LinuxBackendArchive,
  type LinuxBackendPlace
} from '../linux-backend/linux-backend'
import type { LinuxResult, LinuxTarget } from '../linux-backend/linux-target'
import type { FetchNode } from '../linux-backend/managed-node'
import { runOverSsh, spawnOverSsh, sshExecutable, type SshHost } from './ssh-command'

// Daemon and core on a server reached over SSH (docs/REMOTE.md): what the connection and the server
// must be, then the steps every Linux machine takes (linux-backend.ts), with ssh as the way in.

// Where the backend runs on the server: what a later call needs to ask it something or start more.
export type SshBackendPlace = LinuxBackendPlace & { destination: string }

export type SshBackendOptions = {
  destination: string
  // The app's version: the backend of any other is asked to leave, as backend.ts does here.
  version: string
  // The archive for the server's architecture, null for one this build carries none for.
  archive(arch: LinuxArch): Promise<LinuxBackendArchive | null>
  host: SshHost
  // This app's way to Node for a server that has none new enough and cannot download it.
  fetchNode?: FetchNode | null
  startWaitMs?: number
}

export type SshBackendStart = { ok: true; place: SshBackendPlace; endpoint: CoreEndpoint } | { ok: false; problem: SshBackendProblem }

// Off this connection's session, so a closing ssh sends it no hangup, with its output in the
// server's own logs. $1 names the log.
const LAUNCH_SCRIPT = [
  'logs="$HOME/.antumi/logs"',
  'mkdir -p -m 700 "$logs"',
  'cd "$HOME"',
  'name=$1',
  'shift',
  'if command -v setsid > /dev/null 2>&1; then',
  '  setsid nohup "$@" >> "$logs/$name.log" 2>&1 < /dev/null &',
  'else',
  '  nohup "$@" >> "$logs/$name.log" 2>&1 < /dev/null &',
  'fi'
].join('\n')

// What the server is, in one round trip: its system and architecture, and whether systemd ends a
// user's processes with their last session while this user does not linger.
const PROBE_SCRIPT = [
  'printf "os=%s\\n" "$(uname -s)"',
  'printf "arch=%s\\n" "$(uname -m)"',
  'if command -v busctl > /dev/null 2>&1 && command -v loginctl > /dev/null 2>&1; then',
  '  printf "kill=%s\\n" "$(busctl get-property org.freedesktop.login1 /org/freedesktop/login1 org.freedesktop.login1.Manager KillUserProcesses 2> /dev/null)"',
  '  printf "linger=%s\\n" "$(loginctl show-user "$(id -u)" -p Linger --value 2> /dev/null)"',
  '  printf "uid=%s\\n" "$(id -u)"',
  'fi'
].join('\n')

export function sshTarget(host: SshHost, destination: string): LinuxTarget {
  return {
    run: (argv, options) => runOverSsh(host, destination, argv, options),
    spawn: (argv, options = {}) => spawnOverSsh(host, destination, argv, options.env),
    launch(name, argv, env) {
      void runOverSsh(host, destination, ['/bin/sh', '-c', LAUNCH_SCRIPT, 'sh', name, ...argv], { env })
    }
  }
}

// What ssh's own failure (exit 255) says went wrong, as the user can act on it.
export function connectionProblem(result: LinuxResult): SshBackendProblem {
  const detail = said(result)
  if (result.code === null && result.stderr.includes('ssh not found')) return { kind: 'ssh-unavailable' }
  if (/Host key verification failed|REMOTE HOST IDENTIFICATION HAS CHANGED|No (?:\S+ )?host key is known/i.test(result.stderr)) return { kind: 'ssh-host-key', detail }
  if (/Permission denied|Too many authentication failures|no matching host key type|Authentication failed/i.test(result.stderr)) return { kind: 'ssh-auth', detail }
  return { kind: 'ssh-unreachable', detail: result.timedOut ? `timed out\n${detail}` : detail }
}

export type ServerProbe = { os: string; arch: string; endsSessions: boolean }

export function parseProbe(stdout: string): ServerProbe | null {
  const values = new Map<string, string>()
  for (const line of stdout.split(/\r?\n/)) {
    const at = line.indexOf('=')
    if (at > 0) values.set(line.slice(0, at), line.slice(at + 1).trim())
  }
  const os = values.get('os')
  const arch = values.get('arch')
  if (!os || !arch) return null
  // root is never killed (KillExcludeUsers), and a lingering user keeps their processes.
  const endsSessions = values.get('kill') === 'b true' && values.get('linger') !== 'yes' && values.get('uid') !== '0'
  return { os, arch, endsSessions }
}

// The server as the backend needs it: reachable without a prompt, Linux, an architecture this build
// carries the backend for, keeping processes past the connection, with a login shell that names a
// Node new enough. Nothing is installed or started by asking.
export async function findSshBackendPlace(options: SshBackendOptions): Promise<{ ok: true; place: SshBackendPlace; archive: LinuxBackendArchive } | { ok: false; problem: SshBackendProblem }> {
  const problem = (found: SshBackendProblem) => ({ ok: false as const, problem: found })
  if (!sshExecutable(options.host)) return problem({ kind: 'ssh-unavailable' })
  const target = sshTarget(options.host, options.destination)
  const probed = await target.run(['/bin/sh', '-c', PROBE_SCRIPT])
  if (probed.code === 255 || probed.code === null) return problem(connectionProblem(probed))
  const probe = parseProbe(probed.stdout)
  if (!probe) return problem({ kind: 'ssh-unreachable', detail: said(probed) })
  if (probe.os !== 'Linux') return problem({ kind: 'os', os: probe.os })
  const arch = linuxArch(probe.arch)
  const archive = arch ? await options.archive(arch) : null
  if (!archive) return problem({ kind: 'arch', arch: probe.arch })
  if (probe.endsSessions) return problem({ kind: 'linger' })
  const found = await findLinuxBackendPlace(target, backendFolder(options.version, archive), { arch: linuxArch(probe.arch) ?? undefined, fetchNode: options.fetchNode ?? null })
  if (!found.ok) return found
  return { ok: true, place: { ...found.place, destination: options.destination }, archive }
}

export function sshCoreEndpoint(host: SshHost, place: SshBackendPlace): Promise<CoreEndpoint | null> {
  return linuxCoreEndpoint(sshTarget(host, place.destination), place)
}

export function replaceOldSshDaemon(host: SshHost, place: SshBackendPlace, version: string): Promise<void> {
  return replaceOldLinuxDaemon(sshTarget(host, place.destination), place, version, true)
}

// ensureBackend() for the server: installs this build's backend if it is not there, asks an older
// one to leave under the same rules, starts what is missing and waits for core to answer.
export async function ensureSshBackend(options: SshBackendOptions): Promise<SshBackendStart> {
  const found = await findSshBackendPlace(options)
  if (!found.ok) return found
  const { place, archive } = found
  const started = await ensureLinuxBackend({
    target: sshTarget(options.host, place.destination),
    place,
    version: options.version,
    archive,
    where: ` on ${place.destination}`,
    keepNewer: true,
    ...(options.startWaitMs === undefined ? {} : { startWaitMs: options.startWaitMs })
  })
  return started.ok ? { ok: true, place, endpoint: started.endpoint } : started
}
