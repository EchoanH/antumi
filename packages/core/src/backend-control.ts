import { existsSync } from 'node:fs'
import { createRequire } from 'node:module'
import path from 'node:path'
import type { CoreEndpoint } from '@antumi/protocol'
import { backendToStart, retireOldDaemon, runningCore } from '@antumi/protocol/node'

// The daemon depends on node-pty, core does not: a specifier held in a variable is one TypeScript
// does not resolve and esbuild leaves alone, so at run time it is found in the node_modules beside
// the bundle, as the daemon's own import is.
const NODE_PTY = 'node-pty'

export type BackendControlAnswer =
  | { start: ('daemon' | 'core')[] }
  | { endpoint: CoreEndpoint | null }
  | { node: string; arch: string; pty: true | string }

export type BackendControlOptions = {
  home?: string
  loadPty?: () => Promise<unknown>
  // Why node-pty's Linux binding itself does not load; null when it does or is not there.
  bindingError?: () => string | null
}

export const BACKEND_CONTROL_USAGE = 'usage: backend-control prepare <version> [--keep-newer] | replace-daemon <version> [--keep-newer] | endpoint | check'

// One command of backend-control (backend-control-main.ts): the answer to print, or why the
// arguments make no command.
export async function backendControl(args: string[], options: BackendControlOptions = {}): Promise<{ answer: BackendControlAnswer } | { usage: string }> {
  const [command, ...given] = args
  // On a server several computers reach, a newer backend than the asking app's stays.
  const keepNewer = (command === 'prepare' || command === 'replace-daemon') && given.at(-1) === '--keep-newer'
  const rest = keepNewer ? given.slice(0, -1) : given
  const rule = { keepNewer }
  if (command === 'prepare' && rest.length === 1 && rest[0]) return { answer: { start: await backendToStart(rest[0], options.home, rule) } }
  // As replaceOldDaemon in the desktop app: a daemon to start only once an older one left.
  if (command === 'replace-daemon' && rest.length === 1 && rest[0]) return { answer: { start: (await retireOldDaemon(rest[0], options.home, rule)) ? ['daemon'] : [] } }
  if (command === 'endpoint' && rest.length === 0) return { answer: { endpoint: await runningCore(options.home) } }
  if (command === 'check' && rest.length === 0) return { answer: { node: process.version, arch: process.arch, pty: await ptyLoads(options.loadPty, options.bindingError) } }
  return { usage: BACKEND_CONTROL_USAGE }
}

const message = (error: unknown) => (error instanceof Error ? error.message : String(error))

async function ptyLoads(load: () => Promise<unknown> = () => import(NODE_PTY), bindingError: () => string | null = linuxBindingError): Promise<true | string> {
  try {
    await load()
    return true
  } catch (error) {
    // node-pty tries each place its binding may be and keeps only the last error, a prebuild
    // folder Linux never has: the binding's own error says why it did not load, a glibc too old.
    return bindingError() ?? message(error)
  }
}

function linuxBindingError(): string | null {
  try {
    const require = createRequire(import.meta.url)
    const binding = path.join(path.dirname(require.resolve(`${NODE_PTY}/package.json`)), 'build/Release/pty.node')
    if (!existsSync(binding)) return null
    require(binding)
    return null
  } catch (error) {
    return message(error)
  }
}
