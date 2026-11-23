import { z } from 'zod'

// Where the app's backend (daemon and core) runs: on this machine, inside a WSL distro, or on a
// server reached over SSH, with the app as its client (docs/WSL.md, docs/REMOTE.md). Chosen in
// Settings, kept by main, applied at the next start.
export const BackendLocation = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('local') }),
  z.object({ kind: z.literal('wsl'), distro: z.string().min(1).max(200) }),
  // What ssh takes as the destination: `user@host` or an alias of ~/.ssh/config.
  z.object({ kind: z.literal('ssh'), host: z.string().min(1).max(255).regex(/^[^-\s][^\s]*$/) })
])
export type BackendLocation = z.infer<typeof BackendLocation>

// Why a backend on another Linux machine did not start, whichever reaches it: what that machine
// lacks, or what went wrong putting the backend there.
export const LinuxBackendProblem = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('arch'), arch: z.string() }),
  z.object({ kind: z.literal('login-environment') }),
  z.object({ kind: z.literal('node-missing') }),
  z.object({ kind: z.literal('node-old'), version: z.string(), path: z.string() }),
  // No Node new enough there, and the one Antumi installs could not be put there either.
  z.object({ kind: z.literal('node-download'), detail: z.string() }),
  z.object({ kind: z.literal('install'), detail: z.string() }),
  // node-pty does not load there: a libc older than the one it was compiled against, mostly.
  z.object({ kind: z.literal('pty'), detail: z.string() }),
  z.object({ kind: z.literal('start'), detail: z.string() })
])
export type LinuxBackendProblem = z.infer<typeof LinuxBackendProblem>

// Why a backend in WSL did not start, for the renderer to say what to do about it.
export const WslBackendProblem = z.discriminatedUnion('kind', [
  // No wsl.exe, so no WSL on this machine.
  z.object({ kind: z.literal('wsl-unavailable') }),
  // wsl.exe would not say: nothing is known, least of all that the distro is gone.
  z.object({ kind: z.literal('wsl-unknown'), detail: z.string() }),
  z.object({ kind: z.literal('distro-missing'), distro: z.string() }),
  z.object({ kind: z.literal('distro-wsl1'), distro: z.string() }),
  ...LinuxBackendProblem.options
])
export type WslBackendProblem = z.infer<typeof WslBackendProblem>

// Why a backend on an SSH host did not start.
export const SshBackendProblem = z.discriminatedUnion('kind', [
  // No ssh client on this machine.
  z.object({ kind: z.literal('ssh-unavailable') }),
  // The host's key is unknown or changed: the user checks it in a terminal once.
  z.object({ kind: z.literal('ssh-host-key'), detail: z.string() }),
  // No key ssh could log in with and no prompt to ask for one.
  z.object({ kind: z.literal('ssh-auth'), detail: z.string() }),
  z.object({ kind: z.literal('ssh-unreachable'), detail: z.string() }),
  z.object({ kind: z.literal('os'), os: z.string() }),
  // systemd kills a user's processes when their last session ends, and this user does not linger:
  // the backend would go with the connection.
  z.object({ kind: z.literal('linger') }),
  ...LinuxBackendProblem.options
])
export type SshBackendProblem = z.infer<typeof SshBackendProblem>

export type BackendProblem = WslBackendProblem | SshBackendProblem

// Where a backend runs that is not on this machine.
export const RemoteBackend = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('wsl'), distro: z.string() }),
  z.object({ kind: z.literal('ssh'), host: z.string() })
])
export type RemoteBackend = z.infer<typeof RemoteBackend>

export const BackendLocationState = z.object({
  // Whether this app can run its backend in WSL at all: Windows, installed, carrying the archive.
  wsl: z.boolean(),
  // Whether it can run it on an SSH host: installed, carrying the archives, with an ssh client.
  ssh: z.boolean(),
  chosen: BackendLocation,
  // Where the backend this app talks to runs now: the chosen place, or this machine when the one
  // chosen did not start.
  running: z.enum(['local', 'wsl', 'ssh']),
  // The distros to choose from; null when wsl.exe would not say.
  distros: z.array(z.object({ name: z.string(), version: z.union([z.literal(1), z.literal(2)]), isDefault: z.boolean() })).nullable(),
  problem: z.union([WslBackendProblem, SshBackendProblem]).nullable(),
  // A server's backend newer than this app, kept for the other computers using it: this app is
  // the one to update. Null otherwise. Optional only for a main of before it.
  newerBackend: z.string().nullable().optional()
})
export type BackendLocationState = z.infer<typeof BackendLocationState>
