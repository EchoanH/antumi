import { rm } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { antigravitySessionsRoot, antigravityTranscripts } from './antigravity-transcripts'
import type { ChatCatalog } from '@antumi/protocol'
import { probeChatCatalog } from '../../chat-catalog'
import type { AgentAdapter } from '../agent-adapter'
import { AcpDriver } from '../acp/acp-driver'
import { antigravityDialect } from './antigravity-dialect'
import { readAntigravityUsage } from './antigravity-usage'
import { antigravityInstallation, antigravityServer, antigravitySignedIn, detectAntigravity, requireAntigravity } from './antigravity-runtime'

const CATALOG_TIMEOUT_MS = 60_000

// The registry's Linux launch: started as root without it, the server drops to nobody.
const args = (): string[] => process.platform === 'linux' ? ['--uid='] : []
// Its sign-in goes to a file Antumi can read for usage (antigravity-usage.ts), not the keychain.
const command = () => ({ command: antigravityServer() ?? 'agy_acp_server', args: args(), env: { PYTHONUNBUFFERED: '1', AGY_ACP_FORCE_FILE_STORAGE: '1' } })

// Its models come only with a session, which needs its Google sign-in: signed out, a probe would
// open the sign-in page in the browser with nobody having asked.
async function antigravityCatalog(cwd: string): Promise<ChatCatalog | null> {
  if (!await antigravitySignedIn()) return null
  const driver = new AcpDriver(antigravityDialect, 'catalog', { cwd, extraDirs: [], resume: null }, true)
  try {
    return await probeChatCatalog(driver, { ...command(), command: await requireAntigravity() }, cwd, CATALOG_TIMEOUT_MS)
  } finally {
    const sessionId = driver.providerSessionId()
    if (sessionId && /^[\w-]+$/.test(sessionId)) {
      await Promise.all(['.db', '.db-wal', '.db-shm', '.meta'].map((suffix) => rm(path.join(antigravitySessionsRoot(), sessionId + suffix), { force: true, maxRetries: 3, retryDelay: 100 }).catch(() => {})))
    }
  }
}

export const antigravity: AgentAdapter = {
  kind: 'antigravity',
  // The folders its docs name (antigravity.google/docs/skills); a plugin's skills are not read here.
  globalSkillDirs: () => [path.join('.gemini', 'config', 'skills'), path.join('.gemini', 'antigravity-cli', 'skills'), path.join('.gemini', 'skills')].map((dir) => path.join(os.homedir(), dir)),
  transcripts: antigravityTranscripts(),
  createDriver: (stageId, options) => new AcpDriver(antigravityDialect, stageId, options),
  // Antumi's MCP servers and the user's go in session/new; extra projects ride in the first
  // prompt's note, as its session takes no additional directories.
  command,
  permissionModes: Object.keys(antigravityDialect.modes),
  fallbackMode: 'ask',
  session: { preassignedId: false, folderBound: true, nativeFork: 'none' },
  // Its first start unpacks itself, and a first sign-in waits up to five minutes on the browser.
  startTimeoutMs: 360_000,
  mcpApproval: 'antumi',
  catalog: antigravityCatalog,
  partialStageCatalog: true,
  detect: detectAntigravity,
  usage: readAntigravityUsage,
  installation: antigravityInstallation,
  installWithoutApplication: true,
  launch: {
    mcp: (server) => server,
    prepare: async () => ({ command: await requireAntigravity() }),
    ready: async () => {}
  },
  turns: { serialized: true, stopAfterCancel: { cancelGraceMs: 3000, termGraceMs: 2000 }, retryByRestart: true, denialAsMessage: true },
  optionsFromState: true,
  discovery: { commands: [], applications: { darwin: ['Antigravity.app'] } }
}
