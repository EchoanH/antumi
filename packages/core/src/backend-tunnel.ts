import { mkdir, readdir, readFile, rm, stat } from 'node:fs/promises'
import path from 'node:path'
import type { Readable, Writable } from 'node:stream'
// Relative, not '@antumi/protocol/node': the helper is bundled alone, and the package index would
// bring zod and every schema with it.
import { writePrivateJson } from '../../protocol/src/node/private-file'
import { listenLoopback, openStdioTunnel, readFirstLine, sentinelLine, TUNNEL_TARGETS, type TunnelHelperConfig } from '../../protocol/src/node/stdio-tunnel'

// The tunnel helper the app starts on the backend's machine, a WSL distro or an SSH host
// (backend-tunnel-main.ts, docs/WSL.md 连接, docs/REMOTE.md). It reads its config as the first line of stdin, answers with the sentinel line on stdout,
// and from then on both carry only tunnel frames.

export type TunnelHelper = {
  port: number | null
  // Tears the tunnel down and removes the endpoint file if it is still this helper's.
  stop(): Promise<void>
  // Settles once the tunnel is down and the file handled: the app hung up, or stop() was called.
  stopped: Promise<Error | null>
}

export function parseTunnelHelperConfig(text: string): TunnelHelperConfig {
  let raw: unknown
  try {
    raw = JSON.parse(text)
  } catch {
    throw new Error('config is not JSON')
  }
  if (!isObject(raw)) throw new Error('config is not an object')
  const config: TunnelHelperConfig = {}
  if (raw.listen !== undefined) {
    const listen = raw.listen
    if (!isObject(listen)) throw new Error('listen is not an object')
    const { endpointFile, endpoint } = listen
    if (endpointFile !== undefined && (typeof endpointFile !== 'string' || !path.isAbsolute(endpointFile))) throw new Error('listen.endpointFile is not an absolute path')
    if (endpoint !== undefined && !isObject(endpoint)) throw new Error('listen.endpoint is not an object')
    if ((endpointFile === undefined) !== (endpoint === undefined)) throw new Error('listen.endpointFile and listen.endpoint go together')
    config.listen = endpointFile === undefined || endpoint === undefined ? {} : { endpointFile, endpoint }
  }
  if (raw.dial !== undefined) {
    const dial = raw.dial
    if (!isObject(dial) || typeof dial.port !== 'number' || !Number.isInteger(dial.port) || dial.port < 1 || dial.port > 65535) throw new Error('dial.port is not a port')
    config.dial = { port: dial.port }
  }
  if (raw.connect !== undefined) {
    if (raw.connect !== true) throw new Error('connect is not true')
    config.connect = true
  }
  if (!config.listen && !config.dial && !config.connect) throw new Error('config has neither listen, dial nor connect')
  return config
}

// Whether a process still exists: only ESRCH says it does not (EPERM is one of someone else's).
function running(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch (error) {
    return !(error instanceof Error && 'code' in error && error.code === 'ESRCH')
  }
}

// Throws on a config it cannot read or a file it cannot write; nothing has reached stdout then.
// `alive` says whether another helper's process still runs; tests stand theirs in.
export async function startTunnelHelper(options: { stdin: Readable; stdout: Writable; pid?: number; alive?: (pid: number) => boolean }): Promise<TunnelHelper> {
  const pid = options.pid ?? process.pid
  const alive = options.alive ?? running
  const { line, rest } = await readFirstLine(options.stdin, { maxBytes: 64 * 1024 })
  const config = parseTunnelHelperConfig(line)
  const server = config.listen ? await listenLoopback(0) : null
  const address = server?.address()
  const port = address && typeof address === 'object' ? address.port : null
  const endpointFile = config.listen?.endpointFile

  // The sentinel goes out before the file names the port: a connection core makes after reading
  // the file opens a frame, which must not come ahead of the sentinel.
  options.stdout.write(sentinelLine(port))
  const tunnel = await openStdioTunnel({
    input: options.stdin,
    output: options.stdout,
    head: rest,
    offers: server ? [{ target: TUNNEL_TARGETS.app, server }] : [],
    dials: config.dial ? { [TUNNEL_TARGETS.helper]: config.dial.port } : {},
    connects: config.connect === true
  })

  const stopped = tunnel.closed.then(async (reason) => {
    server?.close()
    if (endpointFile) await withdrawEndpoint(endpointFile, pid, alive).catch(() => {})
    return reason
  })
  if (endpointFile && port !== null) {
    try {
      await publishEndpoint(endpointFile, pid, { ...config.listen?.endpoint, port, pid })
    } catch (error) {
      tunnel.close()
      await stopped
      throw error
    }
  }
  return {
    port,
    stop: async () => {
      tunnel.close()
      await stopped
    },
    stopped
  }
}

// Several apps may reach one backend: a server two computers use (docs/REMOTE.md). Each helper
// keeps its endpoint in hosts/<pid>.json beside the file, and the file names the newest one: core
// uses the app that came last, and the one before when that one leaves.
const registryOf = (file: string) => path.join(path.dirname(file), 'hosts')

async function publishEndpoint(file: string, pid: number, endpoint: Record<string, unknown>): Promise<void> {
  await mkdir(registryOf(file), { recursive: true, mode: 0o700 })
  await writePrivateJson(path.join(registryOf(file), `${pid}.json`), endpoint)
  await writePrivateJson(file, endpoint)
}

async function readJson(file: string): Promise<unknown> {
  try {
    return JSON.parse(await readFile(file, 'utf8'))
  } catch {
    return null
  }
}

// Takes this helper's entry away; the file, if still this helper's, then names the newest helper
// still running, or goes. One a successor has taken is left as it is.
async function withdrawEndpoint(file: string, pid: number, alive: (pid: number) => boolean): Promise<void> {
  const registry = registryOf(file)
  await rm(path.join(registry, `${pid}.json`), { force: true })
  const current = await readJson(file)
  if (!isObject(current) || current.pid !== pid) return
  let newest: { endpoint: Record<string, unknown>; at: number } | null = null
  for (const name of await readdir(registry).catch(() => [])) {
    const entry = path.join(registry, name)
    const endpoint = await readJson(entry)
    if (!isObject(endpoint) || typeof endpoint.pid !== 'number' || !alive(endpoint.pid)) {
      // What a helper that was killed left behind.
      await rm(entry, { force: true })
      continue
    }
    const at = (await stat(entry).catch(() => null))?.mtimeMs ?? 0
    if (!newest || at > newest.at) newest = { endpoint, at }
  }
  if (newest) await writePrivateJson(file, newest.endpoint)
  else await rm(file, { force: true })
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}
