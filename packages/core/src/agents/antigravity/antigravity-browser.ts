import { accessSync, constants } from 'node:fs'

const WINDOWS_EXPLORER = '/mnt/c/Windows/explorer.exe'

function executable(file: string): boolean {
  try { accessSync(file, constants.X_OK); return true } catch { return false }
}

export function antigravityBrowserEnv(platform = process.platform, env = process.env, canRun = executable): Record<string, string> {
  if (platform !== 'linux' || !env.WSL_INTEROP || env.BROWSER?.trim() || !canRun(WINDOWS_EXPLORER)) return {}
  // Python's webbrowser parses the trailing ampersand itself and launches asynchronously, with the URL as one argument.
  return { BROWSER: `${WINDOWS_EXPLORER} %s &` }
}
