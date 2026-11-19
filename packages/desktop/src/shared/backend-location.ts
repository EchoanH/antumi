import { z } from 'zod'

// Where the app's backend (daemon and core) runs: on this machine, or inside a WSL distro with the
// app as its client (docs/WSL.md). Chosen in Settings, kept by main, applied at the next start.
export const BackendLocation = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('local') }),
  z.object({ kind: z.literal('wsl'), distro: z.string().min(1).max(200) })
])
export type BackendLocation = z.infer<typeof BackendLocation>

// Why a backend in WSL did not start, for the renderer to say what to do about it.
export const WslBackendProblem = z.discriminatedUnion('kind', [
  // No wsl.exe, so no WSL on this machine.
  z.object({ kind: z.literal('wsl-unavailable') }),
  // wsl.exe would not say: nothing is known, least of all that the distro is gone.
  z.object({ kind: z.literal('wsl-unknown'), detail: z.string() }),
  z.object({ kind: z.literal('distro-missing'), distro: z.string() }),
  z.object({ kind: z.literal('distro-wsl1'), distro: z.string() }),
  z.object({ kind: z.literal('arch'), arch: z.string() }),
  z.object({ kind: z.literal('login-environment') }),
  z.object({ kind: z.literal('node-missing') }),
  z.object({ kind: z.literal('node-old'), version: z.string(), path: z.string() }),
  z.object({ kind: z.literal('install'), detail: z.string() }),
  // node-pty does not load there: a libc older than the one it was compiled against, mostly.
  z.object({ kind: z.literal('pty'), detail: z.string() }),
  z.object({ kind: z.literal('start'), detail: z.string() })
])
export type WslBackendProblem = z.infer<typeof WslBackendProblem>

export const BackendLocationState = z.object({
  // Whether this app can run its backend in WSL at all: Windows, installed, carrying the archive.
  supported: z.boolean(),
  chosen: BackendLocation,
  // Where the backend this app talks to runs now: the chosen place, or this machine when the one
  // in WSL did not start.
  running: z.enum(['local', 'wsl']),
  // The distros to choose from; null when wsl.exe would not say.
  distros: z.array(z.object({ name: z.string(), version: z.union([z.literal(1), z.literal(2)]), isDefault: z.boolean() })).nullable(),
  problem: WslBackendProblem.nullable()
})
export type BackendLocationState = z.infer<typeof BackendLocationState>
