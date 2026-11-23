import { findLinuxExecutable as findOn, loginEnvironment as askLogin, type AskOptions, type LinuxExecutable, type LoginEnvironment } from '../linux-backend/login-environment'
import { nodeWslHost, type WslHost } from './wsl-command'
import { wslTarget } from './wsl-target'

export { parseLoginEnvironment } from '../linux-backend/login-environment'

export type WslAskOptions = AskOptions & { host?: WslHost }

// The distro's login PATH and HOME, which `--exec` does not have. Null when it could not be asked.
export function loginEnvironment(distro: string | null, options: WslAskOptions = {}): Promise<LoginEnvironment | null> {
  return askLogin(wslTarget(distro, options.host ?? nodeWslHost), options)
}

// The PATH to search in the distro: WSL appends the Windows PATH under /mnt/, and a Windows
// program found there must not stand in for a Linux one; relative entries would give no
// absolute path.
export function linuxSearchPath(path: string): string {
  return path.split(':').filter((dir) => dir.startsWith('/') && dir !== '/mnt' && !dir.startsWith('/mnt/')).join(':')
}

export function findLinuxExecutable(distro: string | null, name: string, path: string, options: WslAskOptions = {}): Promise<LinuxExecutable> {
  return findOn(wslTarget(distro, options.host ?? nodeWslHost), name, linuxSearchPath(path), options)
}
