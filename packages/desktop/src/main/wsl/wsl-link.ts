import { BackendLink, type BackendLinkEnds, type BackendLinkOptions } from '../linux-backend/backend-link'
import type { WslBackendPlace } from './wsl-backend'
import { nodeWslHost, type WslHost } from './wsl-command'
import { wslTarget } from './wsl-target'

export type WslLinkEnds = BackendLinkEnds

// The tunnel to a backend in a WSL distro, its helper started through wsl.exe.
export class WslLink extends BackendLink {
  constructor(place: WslBackendPlace, options: BackendLinkOptions & { host?: WslHost } = {}) {
    const { host, ...rest } = options
    super(wslTarget(place.distro, host ?? nodeWslHost), place, { label: 'WSL', ...rest })
  }
}
