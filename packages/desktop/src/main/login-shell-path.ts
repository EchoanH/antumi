import { spawn } from 'node:child_process'
import { homedir } from 'node:os'
import { posix, win32 } from 'node:path'
import { AGENT_KINDS, agentDescriptor } from '@antumi/protocol'

const PATH_MARK = '__ANTUMI_PATH__'
const SHELL_TIMEOUT_MS = 3000
const PRINT_PATH = `printf '${PATH_MARK}%s${PATH_MARK}' "$PATH"`

// What a shell printed to stdout, by the deadline at the latest.
export type ShellRun = (shell: string, args: string[]) => Promise<string>

// A shell's rc files may print lines of their own, so the PATH comes between marks.
export function markedPath(stdout: string): string | null {
  const parts = stdout.split(PATH_MARK)
  return parts.length >= 3 ? parts[1] ?? null : null
}

// A GUI app inherits launchd's PATH, which has no homebrew or ~/.local: the agents and the
// user's shell live there, so ask the login shell once and pass the result down. Interactive,
// because nvm, bun and the like add themselves in ~/.zshrc or ~/.bashrc, which only such a shell
// reads; a login shell alone when that one fails or hangs.
export async function loginShellPath(platform: NodeJS.Platform = process.platform, env: NodeJS.ProcessEnv = process.env, run: ShellRun = runShell, home = homedir()): Promise<string> {
  if (platform === 'win32') {
    const parts = (env.PATH ?? '').split(';').filter(Boolean)
    const local = env.LOCALAPPDATA
    const installed = local ? AGENT_KINDS.flatMap((kind) => agentDescriptor(kind).windowsPathDirs ?? []).map((dir) => win32.join(local, dir)) : []
    for (const dir of installed) {
      if (!parts.some((part) => part.toLowerCase() === dir.toLowerCase())) parts.push(dir)
    }
    return parts.join(';')
  }
  const shell = env.SHELL || (platform === 'linux' ? '/bin/sh' : '/bin/zsh')
  const found = markedPath(await run(shell, ['-i', '-l', '-c', PRINT_PATH])) ?? markedPath(await run(shell, ['-l', '-c', PRINT_PATH]))
  const parts = (found ?? env.PATH ?? '').split(':').filter(Boolean)
  // Where CLIs land that a Finder-launched app's minimal PATH misses.
  for (const dir of ['/opt/homebrew/bin', '/usr/local/bin', posix.join(home, '.local/bin')]) {
    if (!parts.includes(dir)) parts.push(dir)
  }
  return parts.join(':')
}

// In a session of its own, so an interactive shell cannot take over the terminal the app was
// started from. The deadline does not wait for the pipe to close: something an rc file started
// in the background may hold it open long after the shell is gone.
function runShell(shell: string, args: string[]): Promise<string> {
  return new Promise((resolve) => {
    let stdout = ''
    const child = spawn(shell, args, { stdio: ['ignore', 'pipe', 'ignore'], detached: true })
    const timer = setTimeout(() => {
      try {
        if (child.pid) process.kill(-child.pid, 'SIGKILL')
      } catch {
        // Already gone.
      }
      resolve(stdout)
    }, SHELL_TIMEOUT_MS)
    child.stdout.setEncoding('utf8').on('data', (chunk: string) => { stdout += chunk })
    child.on('error', () => { clearTimeout(timer); resolve(stdout) })
    child.on('close', () => { clearTimeout(timer); resolve(stdout) })
  })
}
