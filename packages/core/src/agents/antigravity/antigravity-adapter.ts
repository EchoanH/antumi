import { rm } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { antigravityTranscripts } from './antigravity-transcripts'
import type { AntigravityBackend, ChatCatalog } from '@antumi/protocol'
import { probeChatCatalog } from '../../chat-catalog'
import type { AgentAdapter, AgentLaunch } from '../agent-adapter'
import { antigravityAccounts, antigravityAccountSignedIn } from './antigravity-account'
import { AcpDriver } from '../acp/acp-driver'
import { antigravityAgyCliDialect, antigravityDialect, dialectForBackend } from './antigravity-dialect'
import { readAntigravityUsage } from './antigravity-usage'
import { antigravityInstallation, antigravityServer, requireAntigravity } from './antigravity-runtime'
import { antigravityBrowserEnv } from './antigravity-browser'
import { ANTIGRAVITY_STRIPPED_ENV, activeAntigravityBackend, agyCliCommand, agyCliEnv, backendDataDir, detectAntigravityRuntime, ensureOAuthSettings, requireAgyCli, requireAgyCliInfo } from './antigravity-backend'
import { syncForAntigravityBackendSwitch } from './antigravity-credentials'
import { Rejection } from '../../rejection'

const CATALOG_TIMEOUT_MS = 60_000

// The registry's Linux launch: started as root without it, the server drops to nobody.
const args = (): string[] => process.platform === 'linux' ? ['--uid='] : []
const wantAgyBypass = (launch?: AgentLaunch): boolean => Boolean(
  launch?.backend === 'agy-cli'
  && launch.allowBypass
  && !launch.planOnly
  && !launch.readOnly
  && !launch.lockdown
  && launch.preferred?.permissionMode === 'bypass'
)
// Its sign-in goes to a file Antumi can read for usage (antigravity-usage.ts), not the keychain.
const command = (launch?: AgentLaunch) => {
  if (launch?.backend === 'agy-cli') {
    const home = launch.account?.env.GEMINI_HOME
    return { ...agyCliCommand('agy', home, false, wantAgyBypass(launch)), env: { ...launch.account?.env, ...agyCliEnv(home) }, unsetEnv: [...ANTIGRAVITY_STRIPPED_ENV] }
  }
  return { command: antigravityServer() ?? 'agy_acp_server', args: args(), env: { ...launch?.account?.env, PYTHONUNBUFFERED: '1', AGY_ACP_FORCE_FILE_STORAGE: '1' }, unsetEnv: [...ANTIGRAVITY_STRIPPED_ENV] }
}

async function antigravityCatalog(cwd: string, account?: { id: string; home?: string; env?: Record<string, string> }): Promise<ChatCatalog | null> {
  const backend = await activeAntigravityBackend()
  const home = account?.home
  if (!await antigravityAccountSignedIn(home, backend)) return null
  await syncForAntigravityBackendSwitch(home, backend)
  await ensureOAuthSettings(backend, home)
  const driver = new AcpDriver(dialectForBackend(backend), 'catalog', { cwd, extraDirs: [], resume: null, backend }, true)
  const env = { ...account?.env, ...(home ? { GEMINI_HOME: home } : {}) }
  try {
    const cmd = backend === 'agy-cli' ? agyCliCommand(await requireAgyCli(), home) : { command: await requireAntigravity(), args: args(), env: { ...env, PYTHONUNBUFFERED: '1', AGY_ACP_FORCE_FILE_STORAGE: '1' } }
    return await probeChatCatalog(driver, { ...cmd, unsetEnv: [...ANTIGRAVITY_STRIPPED_ENV], env: { ...env, ...cmd.env } }, cwd, CATALOG_TIMEOUT_MS)
  } finally {
    const sessionId = driver.providerSessionId()
    if (sessionId && /^[\w-]+$/.test(sessionId)) {
      const data = backendDataDir(backend, home)
      await Promise.all([
        ...['.db', '.db-wal', '.db-shm', '.meta'].map(suffix => rm(path.join(data, 'conversations', sessionId + suffix), { force: true, maxRetries: 3, retryDelay: 100 })),
        rm(path.join(data, 'brain', sessionId), { force: true, recursive: true, maxRetries: 3, retryDelay: 100 }),
        rm(path.join(data, 'annotations', sessionId + '.pbtxt'), { force: true, maxRetries: 3, retryDelay: 100 })
      ].map(removal => removal.catch(() => {})))
    }
  }
}

export const antigravity: AgentAdapter = {
  kind: 'antigravity',
  defaultBackend: 'managed-acp',
  resolveBackend: () => activeAntigravityBackend(),
  // The folders its docs name (antigravity.google/docs/skills); a plugin's skills are not read here.
  globalSkillDirs: () => [path.join('.gemini', 'config', 'skills'), path.join('.gemini', 'antigravity-cli', 'skills'), path.join('.gemini', 'skills')].map((dir) => path.join(os.homedir(), dir)),
  transcripts: antigravityTranscripts(),
  createDriver: (stageId, options) => new AcpDriver(dialectForBackend(options.backend), stageId, options),
  // Antumi's MCP servers and the user's go in session/new; extra projects ride in the first
  // prompt's note, as its session takes no additional directories.
  command,
  permissionModes: [...new Set([...Object.keys(antigravityAgyCliDialect.modes), ...Object.keys(antigravityDialect.modes)])],
  permissionModesFor: (backend) => backend === 'agy-cli' ? [...Object.keys(antigravityAgyCliDialect.modes), 'bypass'] : Object.keys(antigravityDialect.modes),
  restartForModes: (backend) => backend === 'agy-cli' ? ['bypass'] : [],
  accountScopedSessions: (backend) => backend === 'agy-cli',
  fallbackMode: 'ask',
  session: { preassignedId: false, folderBound: true, nativeFork: 'none' },
  // Its first start unpacks itself, and a first sign-in waits up to five minutes on the browser.
  startTimeoutMs: 360_000,
  mcpApproval: 'antumi',
  catalog: antigravityCatalog,
  partialStageCatalog: true,
  detect: detectAntigravityRuntime,
  usage: readAntigravityUsage,
  accounts: antigravityAccounts,
  signedIn: (home) => antigravityAccountSignedIn(home),
  installation: antigravityInstallation,
  maintenance: { managedRuntime: true },
  installWithoutApplication: true,
  launch: {
    mcp: (server) => server,
    // Catalog probes are passive and must not opt in to the Windows browser.
    prepare: async (_stage, _mcp, launch) => {
      const backend: AntigravityBackend = launch.backend === 'agy-cli' ? 'agy-cli' : 'managed-acp'
      const home = launch.account?.env.GEMINI_HOME
      await syncForAntigravityBackendSwitch(home, backend)
      await ensureOAuthSettings(backend, home)
      if (backend === 'agy-cli') {
        if (wantAgyBypass(launch)) {
          const info = await requireAgyCliInfo()
          if (!info.supportsBypass) throw new Rejection('chat-option-invalid', '当前版本的 agy CLI 不支持 --dangerously-skip-permissions，请升级 agy 或切换其他权限模式')
          return { command: info.path, env: antigravityBrowserEnv() }
        }
        return { command: await requireAgyCli(), env: antigravityBrowserEnv() }
      }
      return { command: await requireAntigravity(), env: antigravityBrowserEnv() }
    },
    ready: async () => {}
  },
  turns: { serialized: true, stopAfterCancel: { cancelGraceMs: 3000, termGraceMs: 2000 }, retryByRestart: true, denialAsMessage: true },
  optionsFromState: true,
  discovery: { commands: [], applications: { darwin: ['Antigravity.app'] } }
}
