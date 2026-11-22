import type { WslBackendProblem } from '../../shared/backend-location'
import { BackendSession, type BackendSessionParts } from '../linux-backend/backend-session'
import { ensureWslBackend, replaceOldWslDaemon, wslCoreEndpoint, type WslBackendArchive, type WslBackendPlace } from './wsl-backend'
import { isDistroRunning } from './wsl-distros'
import { WslLink } from './wsl-link'
import { linuxPathForBackend, windowsPathForLinux, wslUncPath } from './wsl-paths'

// The app's side of a backend in a WSL distro: a backend session whose Linux paths are told from
// this machine's.

export type WslSessionOptions = { distro: string; version: string; archive: WslBackendArchive; log?: (line: string) => void }

export type WslSessionParts = BackendSessionParts<WslSessionOptions, WslBackendPlace, WslBackendProblem>

const realParts: WslSessionParts = {
  ensure: (options) => ensureWslBackend(options),
  coreEndpoint: (place) => wslCoreEndpoint(place),
  // A check on a timer must not start a distro the user stopped: only one that runs is asked.
  replaceDaemon: async (place, version) => {
    if ((await isDistroRunning(place.distro)) === 'running') await replaceOldWslDaemon(place, version)
  },
  link: (place, log) => new WslLink(place, log ? { log } : {}),
  now: () => Date.now()
}

export class WslSession extends BackendSession<WslSessionOptions, WslBackendPlace, WslBackendProblem> {
  constructor(options: WslSessionOptions, parts: WslSessionParts = realParts) {
    super(options, parts)
  }

  get distro(): string {
    return this.place?.distro ?? this.options.distro
  }

  // A path chosen on this machine as core names it; null for one the distro cannot reach.
  linuxPath(windowsPath: string): string | null {
    return linuxPathForBackend(this.distro, windowsPath)
  }

  // A path core named as this machine opens it, `~` being the distro's home; null for one with no
  // spelling here.
  windowsPath(linuxPath: string): string | null {
    const home = this.place?.home
    const absolute = home && (linuxPath === '~' || linuxPath.startsWith('~/')) ? `${home}${linuxPath.slice(1)}` : linuxPath
    return windowsPathForLinux(this.distro, absolute)
  }

  // Where a folder dialog starts: the distro's home, as Windows reaches it.
  homeFolder(): string | null {
    return this.place ? wslUncPath(this.place.distro, this.place.home) : null
  }
}
