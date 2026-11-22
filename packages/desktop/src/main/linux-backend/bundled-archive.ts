import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { z } from 'zod'
import type { LinuxBackendArchive } from './linux-backend'

// The archives pack-linux-backend made, one per architecture, where the installer put them
// (resources/linux-backend). A build without them runs its backend on this machine only.

export type LinuxArch = 'x64' | 'arm64'

const Manifest = z.object({ file: z.string(), sha256: z.string().regex(/^[a-f0-9]{64}$/) })

// What `uname -m` says, as the archive names it; null for one there is none for.
export function linuxArch(machine: string): LinuxArch | null {
  if (machine === 'x86_64') return 'x64'
  if (machine === 'aarch64' || machine === 'arm64') return 'arm64'
  return null
}

export async function bundledLinuxBackend(resources: string, arch: LinuxArch): Promise<LinuxBackendArchive | null> {
  const folder = join(resources, 'linux-backend')
  try {
    const manifest = Manifest.parse(JSON.parse(await readFile(join(folder, `backend-linux-${arch}.json`), 'utf8')))
    return { file: join(folder, manifest.file), sha256: manifest.sha256 }
  } catch {
    return null
  }
}
