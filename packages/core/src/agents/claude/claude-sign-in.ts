import { execFile } from 'node:child_process'
import os from 'node:os'
import { promisify } from 'node:util'
import { z } from 'zod'
import type { AgentAuthentication } from '@antumi/protocol'
import { planLaunch } from '@antumi/protocol/node'
import { agentCliAccess } from '../../agent-cli-access'
import { parseJson } from '../../usage-source'
import { claudeAccounts, copyClaudeSettings } from './claude-account'

const execute = promisify(execFile)
const STATUS_TIMEOUT_MS = 10_000

const AuthStatus = z.object({ loggedIn: z.boolean(), authMethod: z.string().optional().catch(undefined), apiProvider: z.string().optional().catch(undefined) })

// `claude auth status` exits 0 when signed in and 1 when not, its JSON saying the same; anything
// else (another code, a timeout, an older CLI's output) tells nothing.
export function parseClaudeAuthStatus(exitCode: number | null, stdout: string): boolean | null {
  return parseClaudeAuthentication(exitCode, stdout).signedIn
}

export function parseClaudeAuthentication(exitCode: number | null, stdout: string): AgentAuthentication {
  const status = AuthStatus.safeParse(parseJson(stdout.trim()))
  if (!status.success) return { signedIn: null }
  if (exitCode === 0 && status.data.loggedIn) {
    const { authMethod, apiProvider } = status.data
    if (authMethod === 'api_key' || (apiProvider && apiProvider !== 'firstParty')) return { signedIn: true, authSource: 'native-provider' }
    if (authMethod === 'oauth_token' || authMethod === 'claude.ai') return { signedIn: true, authSource: 'account' }
    return { signedIn: true }
  }
  if (exitCode === 1 && !status.data.loggedIn) return { signedIn: false }
  return { signedIn: null }
}

// Whether Claude Code would run here by any sign-in it honors: an API key or a provider's token in
// the environment or settings.json, an apiKeyHelper, a cloud provider. Asked of the CLI so its own
// precedence decides. From the home folder, so no project's settings speak for every project.
// home: an account's own folder; without one, the user's, under the environment as it is.
export async function claudeAuthStatus(home?: string): Promise<boolean | null> {
  return (await readClaudeAuthentication(home)).signedIn
}

export async function readClaudeAuthentication(home?: string): Promise<AgentAuthentication> {
  if (agentCliAccess.blocked('claude')) return { signedIn: null }
  return agentCliAccess.use('claude', async () => {
    // The account's copy of settings.json is otherwise only refreshed when it launches.
    if (home) await copyClaudeSettings(home)
    const env = home ? { ...process.env, ...claudeAccounts.env(home) } : process.env
    const cwd = os.homedir()
    try {
      const launch = planLaunch('claude', ['auth', 'status'], cwd, env)
      const { stdout } = await execute(launch.file, launch.args, { cwd, env: launch.env, timeout: STATUS_TIMEOUT_MS, maxBuffer: 64 * 1024, windowsHide: true })
      return parseClaudeAuthentication(0, stdout)
    } catch (error) {
      return parseClaudeAuthentication(exitCodeOf(error), stdoutOf(error))
    }
  })
}

// A killed process carries a signal and no exit code.
function exitCodeOf(error: unknown): number | null {
  const code = z.object({ code: z.number() }).safeParse(error)
  return code.success ? code.data.code : null
}

function stdoutOf(error: unknown): string {
  const output = z.object({ stdout: z.string() }).safeParse(error)
  return output.success ? output.data.stdout : ''
}
