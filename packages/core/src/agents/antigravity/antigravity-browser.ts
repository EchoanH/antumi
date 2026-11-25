import { accessSync, constants } from 'node:fs'

const WINDOWS_URL_LAUNCHER = '/mnt/c/Windows/System32/rundll32.exe'

function executable(file: string): boolean {
  try { accessSync(file, constants.X_OK); return true } catch { return false }
}

export function antigravityBrowserEnv(platform = process.platform, env = process.env, canRun = executable): Record<string, string> {
  if (platform !== 'linux' || !env.WSL_INTEROP || env.BROWSER?.trim() || !canRun(WINDOWS_URL_LAUNCHER)) return {}
  // Python's webbrowser parses the trailing ampersand itself and launches asynchronously, with the URL as one argument.
  return { BROWSER: `${WINDOWS_URL_LAUNCHER} url.dll,FileProtocolHandler %s &` }
}
