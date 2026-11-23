import { spawn } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { lstat, readdir, readFile, stat } from 'node:fs/promises'
import path from 'node:path'
import { envValue } from '@antumi/protocol/node'
import type { BackendFilePut, BackendFileRead, BackendFiles, PutArea } from '../linux-backend/backend-elsewhere'
import { runOverSsh, runOverSshBytes, type SshHost } from './ssh-command'

// The server's files where this machine needs them, and this machine's where the server does
// (docs/REMOTE.md 路径和文件): a preview or a file opened here is read over ssh, a file dropped into
// the composer is put on the server. Main is as trusted as on this machine, where it reads any file
// the user can; only the user's own server account is reached.


// $1 is the path, $2 the most bytes taken. The real path goes first, on a line of its own, so a link
// is served under its target's type; then the bytes.
const READ_SCRIPT = [
  'f=$(realpath -- "$1" 2> /dev/null) && [ -e "$f" ] || exit 3',
  '[ -f "$f" ] || exit 4',
  '[ "$(stat -c %s -- "$f")" -le "$2" ] || exit 5',
  'printf "%s\\n" "$f"',
  'exec cat -- "$f"'
].join('\n')

const READ_TIMEOUT_MS = 120_000

export async function readServerFile(host: SshHost, destination: string, file: string, maxBytes: number): Promise<BackendFileRead> {
  if (!file.startsWith('/') || file.includes('\0')) return { kind: 'missing' }
  const result = await runOverSshBytes(host, destination, ['/bin/sh', '-c', READ_SCRIPT, 'sh', file, String(maxBytes)], { timeoutMs: READ_TIMEOUT_MS })
  if (result.code === 3) return { kind: 'missing' }
  if (result.code === 4) return { kind: 'not-a-file' }
  if (result.code === 5) return { kind: 'too-large' }
  const line = result.stdout.indexOf(10)
  if (result.code !== 0 || line < 0) return { kind: 'unreachable', detail: result.timedOut ? 'timed out' : result.stderr.trim() }
  return { kind: 'file', real: result.stdout.subarray(0, line).toString('utf8'), bytes: result.stdout.subarray(line + 1) }
}

// Whether the path is a folder on the server; null when it could not be asked.
export async function serverIsDirectory(host: SshHost, destination: string, file: string): Promise<boolean | null> {
  const result = await runOverSsh(host, destination, ['/bin/sh', '-c', 'test -d "$1"', 'sh', file])
  return result.code === 0 ? true : result.code === 1 ? false : null
}

// A file or folder dropped from this machine, at most this many bytes: enough for documents, logs
// and a small project, not a disk.
export const MAX_DROP_BYTES = 100 * 1024 * 1024


// $1 is the folder made for this drop, $2 the name inside it. A file comes as itself, a folder as a
// tar of it.
const PUT_FILE_SCRIPT = 'umask 077 && mkdir -p -- "$1" && cat > "$1/$2"'
const PUT_FOLDER_SCRIPT = 'umask 077 && mkdir -p -- "$1" && tar -xf - -C "$1"'

// The system's tar by its absolute path: bsdtar on macOS, Windows' own since 10 1803.
function tarExecutable(host: SshHost): string {
  return host.platform === 'win32' ? path.win32.join(envValue(host.env, 'SystemRoot', 'win32') ?? 'C:\\Windows', 'System32', 'tar.exe') : '/usr/bin/tar'
}

async function folderSize(folder: string, limit: number): Promise<number> {
  let total = 0
  const walk = async (dir: string): Promise<void> => {
    for (const entry of await readdir(dir, { withFileTypes: true })) {
      if (total > limit) return
      const at = path.join(dir, entry.name)
      if (entry.isDirectory()) await walk(at)
      else if (entry.isFile()) total += (await lstat(at)).size
    }
  }
  await walk(folder)
  return total
}

function tarOf(host: SshHost, folder: string, limit: number): Promise<Buffer | null> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = []
    let size = 0
    const child = spawn(tarExecutable(host), ['-cf', '-', '-C', path.dirname(folder), path.basename(folder)], { stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true })
    let said = ''
    child.stderr.on('data', (chunk: Buffer) => { said += chunk.toString() })
    child.stdout.on('data', (chunk: Buffer) => {
      size += chunk.length
      if (size > limit) child.kill()
      else chunks.push(chunk)
    })
    child.on('error', reject)
    child.on('close', (code) => {
      if (size > limit) resolve(null)
      else if (code === 0) resolve(Buffer.concat(chunks))
      else reject(new Error(said.trim() || `tar exited ${String(code)}`))
    })
  })
}

// Puts a file or folder of this machine on the server under ~/.antumi/<area>/<id>/ (what was
// dropped into the composer, what the built-in browser downloaded), for the agent to read by the
// path this answers. Each gets a folder of its own, so two of the same name do not collide.
export async function putOnServer(host: SshHost, destination: string, home: string, local: string, area: PutArea = 'drops'): Promise<BackendFilePut> {
  const name = path.basename(local)
  const folder = `${home}/.antumi/${area}/${randomUUID()}`
  try {
    const info = await stat(local)
    if (info.isFile()) {
      if (info.size > MAX_DROP_BYTES) return { kind: 'too-large' }
      const done = await runOverSsh(host, destination, ['/bin/sh', '-c', PUT_FILE_SCRIPT, 'sh', folder, name], { input: await readFile(local), timeoutMs: READ_TIMEOUT_MS })
      return done.code === 0 ? { kind: 'ok', path: `${folder}/${name}` } : { kind: 'failed', detail: done.stderr.trim() || `exit ${String(done.code)}` }
    }
    if (!info.isDirectory()) return { kind: 'failed', detail: 'not a file or folder' }
    if (await folderSize(local, MAX_DROP_BYTES) > MAX_DROP_BYTES) return { kind: 'too-large' }
    const archive = await tarOf(host, local, MAX_DROP_BYTES * 2)
    if (!archive) return { kind: 'too-large' }
    const done = await runOverSsh(host, destination, ['/bin/sh', '-c', PUT_FOLDER_SCRIPT, 'sh', folder], { input: archive, timeoutMs: READ_TIMEOUT_MS })
    return done.code === 0 ? { kind: 'ok', path: `${folder}/${name}` } : { kind: 'failed', detail: done.stderr.trim() || `exit ${String(done.code)}` }
  } catch (error) {
    return { kind: 'failed', detail: error instanceof Error ? error.message : String(error) }
  }
}

// Editors that open a folder or file on an SSH host themselves, by the open-with app's id.
const REMOTE_EDITORS: Readonly<Record<string, 'vscode' | 'cursor' | 'zed'>> = { vscode: 'vscode', cursor: 'cursor', zed: 'zed' }

// The URL that opens `file` on the server in that editor: VS Code's Remote-SSH and its forks
// resolve the destination as ssh does, an alias of ~/.ssh/config included; a file is opened at its
// first line, a folder as a workspace. Zed reads its own ssh URL.
export function remoteEditorUrl(editor: 'vscode' | 'cursor' | 'zed', destination: string, file: string, isFile: boolean): string {
  const encodedPath = file.split('/').map(encodeURIComponent).join('/')
  if (editor === 'zed') return `zed://ssh/${destination.split('@').map(encodeURIComponent).join('@')}${encodedPath}`
  return `${editor}://vscode-remote/ssh-remote+${encodeURIComponent(destination)}${encodedPath}${isFile ? ':1:1' : ''}`
}

// A server's files as main reaches them: over the same ssh. `home` is the user's there, null until
// the backend was found, when nothing can be put.
export function sshFiles(host: SshHost, destination: string, home: () => string | null): BackendFiles {
  return {
    read: (file, maxBytes) => readServerFile(host, destination, file, maxBytes),
    isDirectory: (file) => serverIsDirectory(host, destination, file),
    put: async (local, area) => {
      const there = home()
      return there ? putOnServer(host, destination, there, local, area) : { kind: 'failed', detail: 'the server is not reached yet' }
    },
    editors: Object.keys(REMOTE_EDITORS),
    editorUrl: (app, file, isFile) => {
      const editor = REMOTE_EDITORS[app]
      return editor ? remoteEditorUrl(editor, destination, file, isFile) : null
    }
  }
}
