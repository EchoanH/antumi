import type { CoreEndpoint } from '@antumi/protocol'
import type { BackendLinkEnds } from './backend-link'
import type { LinuxBackendPlace } from './linux-backend'

// The app's side of a backend on another Linux machine, for as long as the app runs: started once,
// found again when it went (the distro was shut down, the server rebooted), and reached through
// the tunnel. What is particular to the machine (WSL's paths, an SSH host's name) is its
// subclass's.

export type BackendStart<P, E> = { ok: true; place: P; endpoint: CoreEndpoint } | { ok: false; problem: E }

// What a session runs through; tests stand theirs in.
export type BackendSessionParts<O, P, E> = {
  ensure(options: O): Promise<BackendStart<P, E>>
  coreEndpoint(place: P): Promise<CoreEndpoint | null>
  replaceDaemon(place: P, version: string): Promise<void>
  link(place: P, log?: (line: string) => void): { connect(ends: BackendLinkEnds): Promise<boolean>; corePort(): number | null; socksPort?(): Promise<number>; stop(): void }
  now(): number
}

export type BackendSessionOptions = { version: string; log?: (line: string) => void }

// Asking the machine costs a wsl.exe or an ssh and a Node each time, and a renderer that lost core
// asks often.
const ENDPOINT_FRESH_MS = 3000
// A backend that will not start is not tried again sooner than this.
const RESTART_EVERY_MS = 20_000

export class BackendSession<O extends BackendSessionOptions, P extends LinuxBackendPlace, E> {
  protected place: P | null = null
  private link: ReturnType<BackendSessionParts<O, P, E>['link']> | null = null
  private browserHost: BackendLinkEnds['browserHost'] = null
  private known: { endpoint: CoreEndpoint; at: number } | null = null
  private starting: Promise<E | null> | null = null
  private startedAt = 0
  private stopped = false

  constructor(protected readonly options: O, private readonly parts: BackendSessionParts<O, P, E>) {}

  // Installs and starts the backend where it is not there yet. Null once core answers.
  start(): Promise<E | null> {
    this.starting ??= this.begin().finally(() => { this.starting = null })
    return this.starting
  }

  private async begin(): Promise<E | null> {
    this.startedAt = this.parts.now()
    const started = await this.parts.ensure(this.options)
    if (!started.ok) return started.problem
    if (this.stopped) return null
    this.place = started.place
    this.link ??= this.parts.link(started.place, this.options.log)
    this.known = { endpoint: started.endpoint, at: this.parts.now() }
    await this.join(started.endpoint)
    return null
  }

  private join(endpoint: CoreEndpoint): Promise<boolean> {
    return this.link?.connect({ corePort: endpoint.port, browserHost: this.browserHost }) ?? Promise.resolve(false)
  }

  // Core as this machine reaches it: its endpoint, with the tunnel's port here in place of its own
  // there. Null while it cannot be reached; a core that went is started again by asking.
  async endpoint(): Promise<CoreEndpoint | null> {
    const place = this.place
    if (!place || this.stopped) return null
    const now = this.parts.now()
    let endpoint = this.known && now - this.known.at < ENDPOINT_FRESH_MS ? this.known.endpoint : await this.parts.coreEndpoint(place)
    if (!endpoint) {
      this.known = null
      if (now - this.startedAt >= RESTART_EVERY_MS) void this.start()
      return null
    }
    if (!this.known || this.known.endpoint !== endpoint) this.known = { endpoint, at: now }
    if (!(await this.join(endpoint))) return null
    const port = this.link?.corePort() ?? null
    return port === null ? null : { ...endpoint, port }
  }

  // The version of the core last found there, when it said.
  coreVersion(): string | null {
    return this.known?.endpoint.version ?? null
  }

  // The browser host once it listens here, which core then reaches through the tunnel.
  setBrowserHost(host: BackendLinkEnds['browserHost']): void {
    this.browserHost = host
    if (this.known) void this.join(this.known.endpoint)
  }

  // Where the built-in browser's proxy listens here, its connections made from there; null where
  // the link makes none (WSL: Windows reaches a distro's ports itself).
  async socksPort(): Promise<number | null> {
    return this.link?.socksPort ? this.link.socksPort() : null
  }

  async replaceOldDaemon(): Promise<void> {
    if (this.place && !this.stopped) await this.parts.replaceDaemon(this.place, this.options.version)
  }

  // Lets go of the tunnel; daemon and core run on, as they do when a local app quits.
  stop(): void {
    this.stopped = true
    this.link?.stop()
    this.link = null
  }
}
