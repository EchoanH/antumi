import type { CoreEndpoint } from '@antumi/protocol'
import type { BackendAccess, BackendProblem, RemoteBackend } from '../../shared/backend-location'

// A backend that runs on another machine (a WSL distro, an SSH host), as main uses it: by what it
// can do from here, never by which kind it is (docs/REMOTE.md). Each kind's session says.

// A file read off the backend's machine.
export type BackendFileRead = { kind: 'file'; real: string; bytes: Buffer } | { kind: 'missing' } | { kind: 'not-a-file' } | { kind: 'too-large' } | { kind: 'unreachable'; detail: string }

// A file or folder of this machine put on the backend's, by the path core names it there.
export type BackendFilePut = { kind: 'ok'; path: string } | { kind: 'too-large' } | { kind: 'failed'; detail: string }

// Where on the backend's machine what this one puts there goes: what was dropped into the
// composer, what the built-in browser downloaded.
export type PutArea = 'drops' | 'downloads'

// The backend's files where this machine has no path to them: read and written through the way it
// reaches that machine.
export type BackendFiles = {
  read(path: string, maxBytes: number): Promise<BackendFileRead>
  isDirectory(path: string): Promise<boolean | null>
  put(local: string, area: PutArea): Promise<BackendFilePut>
  // The open-with apps that open a path there themselves, by id, and the URL each takes for it.
  editors: readonly string[]
  editorUrl(app: string, path: string, isFile: boolean): string | null
}

export interface BackendElsewhere {
  readonly where: RemoteBackend
  // Installs and starts the backend there if it is not yet; null once core answers.
  start(): Promise<BackendProblem | null>
  endpoint(): Promise<CoreEndpoint | null>
  replaceOldDaemon(): Promise<void>
  setBrowserHost(host: { port: number; token: string } | null): void
  stop(): void
  // A path chosen here as core names it, and one core named as this machine opens it; null where
  // there is none.
  toBackendPath(local: string): string | null
  fromBackendPath(path: string): string | null
  // Where a folder dialog here opens when nothing names a place.
  dialogStart(): string | undefined
  // Null where this machine opens the backend's files by a path of its own.
  files(): BackendFiles | null
  // The proxy port here whose connections are made from there, for the built-in browser; null
  // where this machine reaches the backend's network itself.
  socksPort(): Promise<number | null>
  coreVersion(): string | null
}

// What the renderer is told: where the backend runs, and whether this machine reaches its files.
export function backendAccess(elsewhere: BackendElsewhere | null): BackendAccess {
  return { where: elsewhere?.where ?? null, filesHere: !elsewhere || elsewhere.files() === null }
}
