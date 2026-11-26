import { refreshActiveAgentProxy, buildActiveAgentChildEnv } from '../../agent-proxy'
import { randomUUID } from 'node:crypto'
import { execFile } from 'node:child_process'
import { mkdir, readFile, realpath, stat, writeFile, rename, rm, access, constants } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { promisify } from 'node:util'
import { z } from 'zod'
import { launchFile, nodeLaunchHost } from '@antumi/protocol/node'
import type { AgentCommand } from '../../agent-command'
import type { AgentDetection } from '../agent-adapter'
import { Rejection } from '../../rejection'
import { detectAntigravity } from './antigravity-runtime'
import { antigravityAccountSignedIn } from './antigravity-account'

// Its descriptor's backends (backendModes), and those plus auto, the choices Settings → Agents offers.
export const AntigravityBackend = z.enum(['agy-cli', 'managed-acp'])
export type AntigravityBackend = z.infer<typeof AntigravityBackend>
export const AntigravityRuntimeMode = z.enum(['auto', ...AntigravityBackend.options])
export type AntigravityRuntimeMode = z.infer<typeof AntigravityRuntimeMode>

let runtimeMode: AntigravityRuntimeMode = 'managed-acp'
export const getAntigravityRuntimeMode = (): AntigravityRuntimeMode => runtimeMode
export function setAntigravityRuntimeMode(mode: AntigravityRuntimeMode): void { runtimeMode = mode }
export const MANAGED_APP_DATA_DIR = 'antigravity-acp'
export const AGY_CLI_APP_DATA_DIR = 'antigravity-cli-acp'
export function defaultGeminiHome(): string {
  const home = process.env.GEMINI_HOME || path.join(os.homedir(), '.gemini')
  return home.startsWith('~/') ? path.join(os.homedir(), home.slice(2)) : home
}
export const effectiveGeminiHome = (home?: string): string => home ?? defaultGeminiHome()
export const backendDataDir = (backend: AntigravityBackend, home?: string): string => path.join(effectiveGeminiHome(home), backend === 'agy-cli' ? AGY_CLI_APP_DATA_DIR : MANAGED_APP_DATA_DIR)
export const agyCliTokenFile = (home?: string): string => path.join(backendDataDir('agy-cli', home), 'antigravity-oauth-token')
export const antigravitySettingsFile = (backend: AntigravityBackend, home?: string): string => path.join(backendDataDir(backend, home), 'settings.json')
export const antigravityMetaFile = (home?: string): string => path.join(effectiveGeminiHome(home), 'antigravity-acp-meta.json')
export const ANTIGRAVITY_STRIPPED_ENV = [
  'GEMINI_API_KEY', 'GOOGLE_API_KEY', 'GOOGLE_CLOUD_PROJECT', 'GOOGLE_CLOUD_PROJECT_ID',
  'GOOGLE_CLOUD_LOCATION', 'GOOGLE_CLOUD_QUOTA_PROJECT', 'GOOGLE_APPLICATION_CREDENTIALS',
  'GOOGLE_GENAI_USE_VERTEXAI', 'GCLOUD_PROJECT', 'CLOUDSDK_CORE_PROJECT', 'AGY_ACP_CCPA_PROJECT'
] as const

const accountLocks = new Map<string, Promise<unknown>>()
export async function withAntigravityAccountLock<T>(home: string | undefined, task: () => Promise<T>): Promise<T> {
  const resolved = path.resolve(effectiveGeminiHome(home))
  const key = process.platform === 'win32' ? resolved.toLowerCase() : resolved
  const previous = accountLocks.get(key) ?? Promise.resolve()
  const tail = previous.catch(() => {}).then(task)
  accountLocks.set(key, tail)
  try { return await tail }
  finally { if (accountLocks.get(key) === tail) accountLocks.delete(key) }
}
export async function writePrivateJsonAtomic(file: string, data: unknown): Promise<void> {
  await mkdir(path.dirname(file), { recursive: true, mode: 0o700 })
  const temporary = file + '.' + randomUUID() + '.tmp'
  try {
    await writeFile(temporary, JSON.stringify(data, null, 2) + '\n', { mode: 0o600, flag: 'wx' })
    for (let attempt = 0; ; attempt++) {
      try { await rename(temporary, file); break }
      catch (error) {
        if (process.platform !== 'win32' || attempt >= 2 || !(error instanceof Error && 'code' in error && (error.code === 'EPERM' || error.code === 'EBUSY'))) throw error
        await new Promise(resolve => setTimeout(resolve, 50 * (attempt + 1)))
      }
    }
  } finally { await rm(temporary, { force: true }) }
}
export function ensureOAuthSettings(backend: AntigravityBackend, home?: string): Promise<void> {
  return withAntigravityAccountLock(home, () => ensureOAuthSettingsUnlocked(backend, home))
}
// Call only while holding the account lock.
export async function ensureOAuthSettingsUnlocked(backend: AntigravityBackend, home?: string): Promise<void> {
  const file = antigravitySettingsFile(backend, home)
  const raw = await readFile(file, 'utf8').catch((error: NodeJS.ErrnoException) => { if (error.code === 'ENOENT') return '{}'; throw error })
  const existing = z.record(z.string(), z.unknown()).parse(JSON.parse(raw))
  const auth = z.record(z.string(), z.unknown()).parse(existing.auth ?? {})
  if (auth.type === 'oauth-personal') return
  await writePrivateJsonAtomic(file, { ...existing, auth: { ...auth, type: 'oauth-personal' } })
}
export type AgyCliInfo = { path: string; version: string | null; supportsAcp: boolean; supportsBypass: boolean }
const probes = new Map<string, AgyCliInfo>()
const pendingProbes = new Map<string, Promise<AgyCliInfo>>()
const exec = promisify(execFile)
export function clearAgyCliProbeCache(): void { probes.clear(); pendingProbes.clear() }
async function findExecutableOnPath(name: string, pathEnv: string, platform: NodeJS.Platform): Promise<string | null> {
  const names = platform === 'win32' ? ['.exe', '.cmd', '.bat'].map(extension => name + extension) : [name]
  for (const dir of pathEnv.split(platform === 'win32' ? ';' : ':').filter(Boolean)) {
    for (const executable of names) {
      const candidate = path.join(dir, executable)
      if (await access(candidate, constants.F_OK | constants.X_OK).then(() => true, () => false)) return candidate
    }
  }
  return null
}
const parseCliVersion = (output: string): string | null => /\d+\.\d+\.\d+/.exec(output)?.[0] ?? null
export async function detectAgyCli(pathEnv = process.env.PATH ?? '', platform = process.platform): Promise<AgyCliInfo | null> {
  const found = await findExecutableOnPath('agy', pathEnv, platform)
  const onPath = found && !/\.ps1$/i.test(found) ? [found] : platform === 'win32' ? pathEnv.split(path.delimiter).filter(Boolean).flatMap(dir => ['.exe', '.cmd', '.bat'].map(extension => path.join(dir, 'agy' + extension))) : []
  const candidates = [...onPath, ...(platform === 'win32'
    ? [process.env.LOCALAPPDATA ? path.join(process.env.LOCALAPPDATA, 'agy', 'bin', 'agy.exe') : '', path.join(os.homedir(), '.local', 'bin', 'agy.exe')]
    : [path.join(os.homedir(), '.local', 'bin', 'agy'), '/opt/homebrew/bin/agy', '/usr/local/bin/agy'])]
  for (const candidate of candidates) {
    if (!candidate || (platform === 'win32' && /\.ps1$/i.test(candidate))) continue
    if (!await access(candidate, platform === 'win32' ? constants.F_OK : constants.X_OK).then(() => true, () => false)) continue
    const canonical = await realpath(candidate)
    const info = await stat(canonical)
    const key = canonical + '|' + info.mtimeMs + '|' + info.size
    const cached = probes.get(key)
    if (cached) return cached
    let pending = pendingProbes.get(key)
    if (!pending) {
      pending = (async () => {
        const probe = async (args: string[]) => {
          try {
            await refreshActiveAgentProxy()
            const launch = launchFile(candidate, args, buildActiveAgentChildEnv('antigravity'), { ...nodeLaunchHost, platform })
            const result = await exec(launch.file, launch.args, { env: launch.env, timeout: 5000, windowsHide: true })
            return result.stdout + '\n' + result.stderr
          } catch { return '' }
        }
        const version = parseCliVersion(await probe(['--version']))
        const help = await probe(['acp', '--help'])
        const result = {
          path: candidate,
          version,
          supportsAcp: help.includes('--stdio') && help.includes('--gemini-dir'),
          supportsBypass: help.includes('--dangerously-skip-permissions')
        }
        probes.set(key, result)
        return result
      })().finally(() => pendingProbes.delete(key))
      pendingProbes.set(key, pending)
    }
    return pending
  }
  return null
}
export type ResolvedAntigravityRuntime = { mode: AntigravityRuntimeMode; active: AntigravityBackend | null; available: AntigravityBackend[]; agy: AgyCliInfo | null; managed: { path: string; version: string } | null }
export async function resolveAntigravityRuntime(mode = getAntigravityRuntimeMode(), pathEnv = process.env.PATH ?? '', platform = process.platform): Promise<ResolvedAntigravityRuntime> {
  const [agy, detected] = await Promise.all([detectAgyCli(pathEnv, platform), detectAntigravity(pathEnv, platform)])
  const managed = detected.status === 'ok' && detected.path && detected.version ? { path: detected.path, version: detected.version } : null
  const available: AntigravityBackend[] = []
  if (agy?.supportsAcp) available.push('agy-cli')
  if (managed) available.push('managed-acp')
  const active = mode === 'auto' ? available[0] ?? null : available.includes(mode) ? mode : null
  return { mode, active, available, agy, managed }
}
export async function activeAntigravityBackend(mode = getAntigravityRuntimeMode()): Promise<AntigravityBackend> {
  return (await resolveAntigravityRuntime(mode)).active ?? (mode === 'agy-cli' ? 'agy-cli' : 'managed-acp')
}
export async function requireAgyCli(pathEnv?: string, platform?: NodeJS.Platform): Promise<string> {
  const agy = await detectAgyCli(pathEnv, platform)
  if (agy?.supportsAcp) return agy.path
  throw new Rejection('antigravity-agy-missing', '未检测到支持 ACP 的 agy CLI，请先安装/升级 agy 或在设置 → 外部智能体切换为独立 ACP Server')
}
export async function requireAgyCliInfo(pathEnv?: string, platform?: NodeJS.Platform): Promise<AgyCliInfo> {
  const agy = await detectAgyCli(pathEnv, platform)
  if (agy?.supportsAcp) return agy
  throw new Rejection('antigravity-agy-missing', '未检测到支持 ACP 的 agy CLI，请先安装/升级 agy 或在设置 → 外部智能体切换为独立 ACP Server')
}
export const agyCliEnv = (home?: string): Record<string, string> => ({ GEMINI_HOME: effectiveGeminiHome(home), AGY_CLI_FORCE_FILE_TOKEN_STORAGE: '1', AGY_CLI_DISABLE_AUTO_UPDATE: 'true' })
export const agyCliCommand = (executable: string, home?: string, login = false, bypass = false): AgentCommand => ({
  command: executable,
  args: ['acp', login ? '--login' : '--stdio', '--gemini-dir', effectiveGeminiHome(home), '--app-data-dir', AGY_CLI_APP_DATA_DIR, ...(!login && bypass ? ['--dangerously-skip-permissions'] : [])],
  env: agyCliEnv(home),
  unsetEnv: [...ANTIGRAVITY_STRIPPED_ENV]
})
export async function detectAntigravityRuntime(pathEnv: string, platform: NodeJS.Platform): Promise<AgentDetection> {
  const { mode, active, available, agy, managed } = await resolveAntigravityRuntime(getAntigravityRuntimeMode(), pathEnv, platform)
  if (active === 'agy-cli' && agy) return { status: agy.version ? 'ok' : 'unknown', version: agy.version, path: agy.path, signedIn: await antigravityAccountSignedIn(undefined, active), runtime: { active, available } }
  if (active === 'managed-acp' && managed) return { status: 'ok', version: managed.version, path: managed.path, signedIn: await antigravityAccountSignedIn(undefined, active), runtime: { active, available } }
  if (mode === 'agy-cli' && agy && !agy.supportsAcp) return { status: 'unknown', version: agy.version, path: agy.path, signedIn: null, problem: 'incompatible-version', runtime: { active: 'agy-cli', available } }
  return { status: 'missing', version: null, path: null, signedIn: null, ...(available.length ? { runtime: { active: mode === 'agy-cli' ? 'agy-cli' : 'managed-acp', available } } : {}) }
}
