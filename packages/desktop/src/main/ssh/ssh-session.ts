import type { SshBackendProblem } from '../../shared/backend-location'
import { BackendLink } from '../linux-backend/backend-link'
import type { LinuxArch } from '../linux-backend/bundled-archive'
import type { LinuxBackendArchive } from '../linux-backend/linux-backend'
import type { FetchNode } from '../linux-backend/managed-node'
import { BackendSession, type BackendSessionParts } from '../linux-backend/backend-session'
import { ensureSshBackend, replaceOldSshDaemon, sshCoreEndpoint, sshTarget, type SshBackendPlace } from './ssh-backend'
import type { SshHost } from './ssh-command'

// The app's side of a backend on an SSH host. Its paths are the server's, which nothing on this
// machine opens: what a path would be used for here goes through core instead (docs/REMOTE.md 路径和文件).

export type SshSessionOptions = {
  destination: string
  version: string
  archive(arch: LinuxArch): Promise<LinuxBackendArchive | null>
  host: SshHost
  fetchNode?: FetchNode | null
  log?: (line: string) => void
}

export type SshSessionParts = BackendSessionParts<SshSessionOptions, SshBackendPlace, SshBackendProblem>

function realParts(host: SshHost): SshSessionParts {
  return {
    ensure: (options) => ensureSshBackend(options),
    coreEndpoint: (place) => sshCoreEndpoint(host, place),
    replaceDaemon: (place, version) => replaceOldSshDaemon(host, place, version),
    link: (place, log) => new BackendLink(sshTarget(host, place.destination), place, { label: 'ssh', connects: true, ...(log ? { log } : {}) }),
    now: () => Date.now()
  }
}

export class SshSession extends BackendSession<SshSessionOptions, SshBackendPlace, SshBackendProblem> {
  constructor(options: SshSessionOptions, parts: SshSessionParts = realParts(options.host)) {
    super(options, parts)
  }

  get destination(): string {
    return this.options.destination
  }

  get host(): SshHost {
    return this.options.host
  }

  // The user's home on the server, once the backend there was found.
  get home(): string | null {
    return this.place?.home ?? null
  }
}
