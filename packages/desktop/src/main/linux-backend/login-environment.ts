import { randomBytes } from 'node:crypto'
import type { LinuxTarget } from './linux-target'

// What a login shell on the backend's machine sees, which a program run there directly does not:
// a WSL distro's `--exec` and an SSH host's non-interactive shell both skip ~/.profile and
// ~/.bashrc, where nvm and the like add themselves.

export type LoginEnvironment = { path: string; home: string; shell: string }

export type AskOptions = { timeoutMs?: number }

// A first ask may boot a distro or open an SSH connection, and a login shell may load nvm.
const LOGIN_TIMEOUT_MS = 20_000

// Finds the user's shell and runs it as a login shell; bash and zsh read ~/.bashrc or ~/.zshrc,
// where nvm and the like add themselves, only when interactive too. $1 marks the shell's line,
// $2 is what the shell runs.
const LOGIN_SCRIPT = [
  'shell=$(getent passwd "$(id -u)" 2>/dev/null | cut -d: -f7)',
  '[ -x "$shell" ] || shell=/bin/sh',
  'printf \'%s%s\\n\' "$1" "$shell"',
  'case "${shell##*/}" in',
  '  bash|zsh) exec "$shell" -ilc "$2" ;;',
  '  *) exec "$shell" -lc "$2" ;;',
  'esac'
].join('\n')

// Unique per ask: a banner or rc file printing to stdout cannot fake one.
const newMark = () => `__ANTUMI_${randomBytes(8).toString('hex')}_`

// The command each shell runs: echo and printenv read the same in sh, bash, zsh and fish, where
// "$PATH" would not ($PATH is a list in fish).
function printing(mark: string): string {
  return `echo ${mark}path; printenv PATH; echo ${mark}home; printenv HOME; echo ${mark}end`
}

// What sits between two marker lines, or null when either is missing.
function between(lines: string[], from: string, to: string): string | null {
  const start = lines.indexOf(from)
  const end = lines.indexOf(to, start + 1)
  return start === -1 || end === -1 ? null : lines.slice(start + 1, end).join('\n')
}

export function parseLoginEnvironment(stdout: string, mark: string): LoginEnvironment | null {
  const lines = stdout.split(/\r?\n/)
  const shell = lines.find((line) => line.startsWith(`${mark}/`))?.slice(mark.length)
  const path = between(lines, `${mark}path`, `${mark}home`)
  const home = between(lines, `${mark}home`, `${mark}end`)
  return shell && path && home ? { path, home, shell } : null
}

// The login PATH and HOME there, asked afresh on each call. Null when it could not be asked.
export async function loginEnvironment(target: LinuxTarget, options: AskOptions = {}): Promise<LoginEnvironment | null> {
  const mark = newMark()
  const result = await target.run(['/bin/sh', '-c', LOGIN_SCRIPT, 'sh', mark, printing(mark)], { timeoutMs: options.timeoutMs ?? LOGIN_TIMEOUT_MS })
  // An rc file's failing last line sets the exit code; the markers say whether it got through.
  return result.timedOut ? null : parseLoginEnvironment(result.stdout, mark)
}

// "Missing" only when the shell said so; anything else is "could not ask".
export type LinuxExecutable = { status: 'found'; path: string } | { status: 'missing' } | { status: 'unknown' }

// How sh's `command -v` says it found nothing (bash 1, dash and busybox 127); wsl.exe's and ssh's
// own failures exit otherwise.
const NOT_FOUND_CODES = new Set([1, 127])

// The absolute path of `name` on `path` there. `command -v` is a shell builtin, so it runs under
// /bin/sh, with the name as an argument rather than in the script.
export async function findLinuxExecutable(target: LinuxTarget, name: string, path: string, options: AskOptions = {}): Promise<LinuxExecutable> {
  if (!name || name.includes('/') || name.startsWith('-')) return { status: 'missing' }
  const result = await target.run(['/bin/sh', '-c', 'command -v "$1"', 'sh', name], {
    timeoutMs: options.timeoutMs ?? LOGIN_TIMEOUT_MS,
    env: { PATH: path }
  })
  const found = result.stdout.trim()
  if (result.code === 0 && found.startsWith('/') && !found.includes('\n')) return { status: 'found', path: found }
  return result.code !== null && NOT_FOUND_CODES.has(result.code) && !found ? { status: 'missing' } : { status: 'unknown' }
}
