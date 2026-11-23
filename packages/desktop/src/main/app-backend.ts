import type { SpawnOptions } from 'node:child_process'
import { join } from 'node:path'
import { compareVersions, type CoreEndpoint } from '@antumi/protocol'
import { antumiPaths, readCoreEndpoint } from '@antumi/protocol/node'
import type { BackendLocation, BackendLocationState, BackendProblem, RemoteBackend } from '../shared/backend-location'
import { ensureBackend, replaceOldDaemon } from './backend'
import { readBackendLocation, writeBackendLocation } from './backend-location'
import { bundledLinuxBackend, type LinuxArch } from './linux-backend/bundled-archive'
import type { LinuxBackendArchive } from './linux-backend/linux-backend'
import { fetchNodeInto } from './linux-backend/managed-node'
import { nodeSshHost, sshExecutable } from './ssh/ssh-command'
import { putOnServer, readServerFile, serverIsDirectory, type Dropped, type ServerFile } from './ssh/ssh-files'
import { SshSession } from './ssh/ssh-session'
import { listDistros } from './wsl/wsl-distros'
import { WslSession } from './wsl/wsl-session'

// The backend this app talks to, wherever the user chose to run it: on this machine as ever, in a
// WSL distro (docs/WSL.md) or on a server over SSH (docs/REMOTE.md), with this machine's as what it
// falls back to when the chosen one will not start. The rest of main asks here rather than which
// it is.

export type AppBackendOptions = {
  // The user's choice, beside the app's other preferences.
  locationFile: string
  // The browser host's file when core is not on this machine to read the usual one.
  privateHostFile: string
  version: string
  packaged: boolean
  platform: NodeJS.Platform
  resources: string
  // Where the Linux archives are in a build that does not carry them: one made from source, pointed
  // at pack-linux-backend's output to try a remote backend.
  linuxBackendFolder?: string
  // An ssh config in place of ~/.ssh/config, from source only: to reach a throwaway server.
  sshConfig?: string
  // Where Node archives fetched for a machine that cannot download them itself are kept.
  nodeCache: string
}


export class AppBackend {
  private chosen: BackendLocation = { kind: 'local' }
  private session: WslSession | SshSession | null = null
  private problem: BackendProblem | null = null
  private decided: Promise<void> | null = null
  private started: Promise<void> | null = null

  constructor(private readonly options: AppBackendOptions) {}

  // The archive a Linux machine of this architecture takes, where the installer put it; null in a
  // build without it.
  private linuxArchive(arch: LinuxArch): Promise<LinuxBackendArchive | null> {
    if (this.options.packaged) return bundledLinuxBackend(this.options.resources, arch)
    const folder = this.options.linuxBackendFolder
    return folder ? bundledLinuxBackend(folder, arch, '') : Promise.resolve(null)
  }

  // The archive a WSL distro takes; null off Windows or in a build without it.
  private archive(): Promise<LinuxBackendArchive | null> {
    return this.options.platform === 'win32' ? this.linuxArchive('x64') : Promise.resolve(null)
  }

  private async sshSupported(): Promise<boolean> {
    if (!sshExecutable(nodeSshHost(null))) return false
    return (await this.linuxArchive('x64')) !== null || (await this.linuxArchive('arm64')) !== null
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
      const chosen = this.chosen
      let session: WslSession | SshSession
      if (chosen.kind === 'wsl') {
        const archive = await this.archive()
        if (!archive) return
        session = new WslSession({ distro: chosen.distro, version: this.options.version, archive, fetchNode: fetchNodeInto(this.options.nodeCache) })
      } else if (chosen.kind === 'ssh') {
        const real = nodeSshHost(join(antumiPaths().home, 'ssh'))
        const config = this.options.packaged ? undefined : this.options.sshConfig
        const host = config ? { ...real, spawn: (file: string, args: string[], spawnOptions: SpawnOptions) => real.spawn(file, ['-F', config, ...args], spawnOptions) } : real
        session = new SshSession({ destination: chosen.host, version: this.options.version, archive: (arch) => this.linuxArchive(arch), host, fetchNode: fetchNodeInto(this.options.nodeCache) })
      } else {
        return
      }
      this.problem = await session.start()
      if (!this.problem) {
        this.session = session
        return
      }
      console.error(`[antumi] the backend at ${JSON.stringify(chosen)} did not start: ${JSON.stringify(this.problem)}`)
      session.stop()
    })()
    return this.decided
  }

  // Re-read on every call: core rewrites its endpoint with a new port/token on restart. Nothing
  // until it is known which backend this is: the renderer must not find this machine's core while
  // the chosen one is still starting.
  async coreEndpoint(): Promise<CoreEndpoint | null> {
    await this.decide()
    return this.session ? this.session.endpoint() : readCoreEndpoint()
  }

  async replaceOldDaemon(): Promise<void> {
    await this.decide()
    await (this.session ? this.session.replaceOldDaemon() : replaceOldDaemon())
  }

  // Where the browser host says it listens. Core elsewhere is told through the tunnel instead, and
  // a core of this machine, left running from before, must not find the host as its own.
  browserHostFile(): string {
    return this.session ? this.options.privateHostFile : antumiPaths().browserHostFile
  }

  browserHostStarted(host: { port: number; token: string }): void {
    this.session?.setBrowserHost(host)
  }

  // Where the backend runs when not on this machine; null when it does.
  remote(): RemoteBackend | null {
    if (this.session instanceof WslSession) return { kind: 'wsl', distro: this.session.distro }
    if (this.session instanceof SshSession) return { kind: 'ssh', host: this.session.destination }
    return null
  }

  // A path chosen on this machine as core names it; null for one core cannot reach, which on a
  // server is every one.
  toBackendPath(path: string): string | null {
    if (this.session instanceof WslSession) return this.session.linuxPath(path)
    return this.session ? null : path
  }

  // A path core named as this machine opens it; null for one with no spelling here.
  fromBackendPath(path: string): string | null {
    if (this.session instanceof WslSession) return this.session.windowsPath(path)
    return this.session ? null : path
  }

  // The proxy the built-in browser goes out through, so a page reaches what the backend's machine
  // does (a dev server on its localhost); null where it goes out from here.
  async browserProxy(): Promise<string | null> {
    await this.decide()
    const port = this.session instanceof SshSession ? await this.session.socksPort() : null
    return port === null ? null : `socks5://127.0.0.1:${port}`
  }

  // A file of a backend on a server, read over ssh; null when the backend is not on one, and the
  // path is read here (or through WSL) instead.
  readServerFile(path: string, maxBytes: number): Promise<ServerFile> | null {
    const session = this.session
    return session instanceof SshSession ? readServerFile(session.host, session.destination, path, maxBytes) : null
  }

  serverIsDirectory(path: string): Promise<boolean | null> | null {
    const session = this.session
    return session instanceof SshSession ? serverIsDirectory(session.host, session.destination, path) : null
  }

  // A file or folder of this machine put on the server, for core to name; null when the backend is
  // not on one.
  putOnServer(local: string, area: 'drops' | 'downloads' = 'drops'): Promise<Dropped> | null {
    const session = this.session
    const home = session instanceof SshSession ? session.home : null
    return session instanceof SshSession && home ? putOnServer(session.host, session.destination, home, local, area) : null
  }

  // Where a folder dialog opens when the renderer names no place: the distro's home, or the
  // system's own choice.
  dialogStart(): string | undefined {
    return this.session instanceof WslSession ? this.session.homeFolder() ?? undefined : undefined
  }

  async state(): Promise<BackendLocationState> {
    await this.decide()
    const wsl = (await this.archive()) !== null
    const listed = wsl ? await listDistros() : null
    return {
      wsl,
      ssh: await this.sshSupported(),
      chosen: this.chosen,
      running: this.remote()?.kind ?? 'local',
      newerBackend: this.newerBackend(),
      distros: listed?.status === 'ok' ? listed.distros.map(({ name, version, isDefault }) => ({ name, version, isDefault })) : wsl ? null : [],
      problem: this.problem
    }
  }

  // The version of a server's backend newer than this app, which the server kept.
  private newerBackend(): string | null {
    const version = this.session instanceof SshSession ? this.session.coreVersion() : null
    return version && compareVersions(version, this.options.version) > 0 ? version : null
  }

  // Kept for the next start: the app talks to one backend for as long as it runs.
  async choose(location: BackendLocation): Promise<void> {
    await writeBackendLocation(this.options.locationFile, location)
    this.chosen = location
  }

  // Lets go of the tunnel to a backend elsewhere; daemon and core run on wherever they are.
  stop(): void {
    this.session?.stop()
  }
}
