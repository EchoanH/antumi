import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import type { CoreEndpoint } from '@antumi/protocol'
import { antumiPaths, readCoreEndpoint } from '@antumi/protocol/node'
import type { BackendLocation, BackendLocationState, WslBackendProblem } from '../shared/backend-location'
import { ensureBackend, replaceOldDaemon } from './backend'
import { readBackendLocation, writeBackendLocation } from './backend-location'
import type { WslBackendArchive } from './wsl/wsl-backend'
import { listDistros } from './wsl/wsl-distros'
import { WslSession } from './wsl/wsl-session'
import { z } from 'zod'

// The backend this app talks to, wherever the user chose to run it: on this machine as ever, or in
// a WSL distro (docs/WSL.md), with this machine's as what it falls back to when that one will not
// start. The rest of main asks here rather than which of the two it is.

export type AppBackendOptions = {
  // The user's choice, beside the app's other preferences.
  locationFile: string
  // The browser host's file when core is not on this machine to read the usual one.
  privateHostFile: string
  version: string
  packaged: boolean
  platform: NodeJS.Platform
  resources: string
}

const Manifest = z.object({ file: z.string(), sha256: z.string().regex(/^[a-f0-9]{64}$/) })

export class AppBackend {
  private chosen: BackendLocation = { kind: 'local' }
  private session: WslSession | null = null
  private problem: WslBackendProblem | null = null
  private decided: Promise<void> | null = null
  private started: Promise<void> | null = null

  constructor(private readonly options: AppBackendOptions) {}

  // The archive pack-wsl-backend made, where the installer put it; null in a build without it.
  private async archive(): Promise<WslBackendArchive | null> {
    if (this.options.platform !== 'win32' || !this.options.packaged) return null
    const folder = join(this.options.resources, 'wsl')
    try {
      const manifest = Manifest.parse(JSON.parse(await readFile(join(folder, 'backend-linux-x64.json'), 'utf8')))
      return { file: join(folder, manifest.file), sha256: manifest.sha256 }
    } catch {
      return null
    }
  }

  // Starts the backend where the user chose, once. One in WSL that will not start leaves the app
  // on this machine's, and `state` saying why.
  start(): Promise<void> {
    this.started ??= this.decide().then(() => (this.session ? undefined : ensureBackend()))
    return this.started
  }

  // Which backend this is: the one in WSL once it runs, else this machine's.
  private decide(): Promise<void> {
    this.decided ??= (async () => {
      this.chosen = await readBackendLocation(this.options.locationFile)
      const archive = this.chosen.kind === 'wsl' ? await this.archive() : null
      if (this.chosen.kind !== 'wsl' || !archive) return
      const session = new WslSession({ distro: this.chosen.distro, version: this.options.version, archive })
      this.problem = await session.start()
      if (!this.problem) {
        this.session = session
        return
      }
      console.error(`[antumi] the backend in WSL (${this.chosen.distro}) did not start: ${JSON.stringify(this.problem)}`)
      session.stop()
    })()
    return this.decided
  }

  // Re-read on every call: core rewrites its endpoint with a new port/token on restart. Nothing
  // until it is known which backend this is: the renderer must not find this machine's core while
  // the one in WSL is still starting.
  async coreEndpoint(): Promise<CoreEndpoint | null> {
    await this.decide()
    return this.session ? this.session.endpoint() : readCoreEndpoint()
  }

  async replaceOldDaemon(): Promise<void> {
    await this.decide()
    await (this.session ? this.session.replaceOldDaemon() : replaceOldDaemon())
  }

  // Where the browser host says it listens. Core in WSL is told through the tunnel instead, and a
  // core of this machine, left running from before, must not find the host as its own.
  browserHostFile(): string {
    return this.session ? this.options.privateHostFile : antumiPaths().browserHostFile
  }

  browserHostStarted(host: { port: number; token: string }): void {
    this.session?.setBrowserHost(host)
  }

  // A path chosen on this machine as core names it; null for one core cannot reach.
  toBackendPath(path: string): string | null {
    return this.session ? this.session.linuxPath(path) : path
  }

  // A path core named as this machine opens it; null for one with no spelling here.
  fromBackendPath(path: string): string | null {
    return this.session ? this.session.windowsPath(path) : path
  }

  // Where a folder dialog opens when the renderer names no place: the distro's home, or the
  // system's own choice.
  dialogStart(): string | undefined {
    return this.session?.homeFolder() ?? undefined
  }

  async state(): Promise<BackendLocationState> {
    await this.decide()
    const supported = (await this.archive()) !== null
    const listed = supported ? await listDistros() : null
    return {
      supported,
      chosen: this.chosen,
      running: this.session ? 'wsl' : 'local',
      distros: listed?.status === 'ok' ? listed.distros.map(({ name, version, isDefault }) => ({ name, version, isDefault })) : supported ? null : [],
      problem: this.problem
    }
  }

  // Kept for the next start: the app talks to one backend for as long as it runs.
  async choose(location: BackendLocation): Promise<void> {
    await writeBackendLocation(this.options.locationFile, location)
    this.chosen = location
  }

  // Lets go of the tunnel to a backend in WSL; daemon and core run on wherever they are.
  stop(): void {
    this.session?.stop()
  }
}
