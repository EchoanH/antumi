import { execFile } from 'node:child_process'
import { link, symlink } from 'node:fs/promises'
import path from 'node:path'
import { promisify } from 'node:util'
import { RESERVED_MCP_SERVER_NAME } from '@antumi/protocol'
import type { AgentCommand } from '../../agent-command'
import { Rejection } from '../../rejection'
import { launchDir, privateDir, type CommandRunner } from '../../stage-launch'
import type { AgentLaunch, AgentStage } from '../agent-adapter'
import { codexDefaultHome } from './codex-account'
import { codexProviderLaunch } from './codex-provider'

// Verified against 0.160.1, including the absence of shell, patch, image and delegation tools.
const DISABLED_FEATURES = [
  'shell_tool', 'unified_exec', 'shell_snapshot', 'apps', 'plugins', 'remote_plugin', 'hooks',
  'multi_agent', 'multi_agent_v2', 'browser_use', 'computer_use', 'image_generation', 'view_image',
  'memories', 'skill_search', 'skill_mcp_dependency_install', 'goals', 'code_mode', 'code_mode_host',
  'sleep_tool', 'tool_suggest', 'recommended_plugins', 'request_permissions_tool'
]

export function lockedCodexCommand(launch: AgentLaunch, lockdown: NonNullable<AgentLaunch['lockdown']>): AgentCommand {
  const { mcp, provider, preferred } = launch
  const onProvider = provider ? codexProviderLaunch(provider, preferred?.model) : null
  const server = mcp ? {
    command: mcp.command, args: mcp.args, ...(mcp.env ? { env: mcp.env } : {}), enabled_tools: lockdown.tools
  } : null
  const serverEnv = server?.env
    ? `,env={${Object.entries(server.env).map(([key, value]) => `${JSON.stringify(key)}=${JSON.stringify(value)}`).join(',')}}`
    : ''
  const serverConfig = server
    ? `{command=${JSON.stringify(server.command)},args=${JSON.stringify(server.args)},enabled_tools=${JSON.stringify(server.enabled_tools)}${serverEnv}}`
    : null
  // No account environment here: prepare supplies a private home containing only its credentials.
  return { command: 'codex', ...(onProvider ? { env: onProvider.env } : {}), args: [
    'app-server', '--strict-config',
    ...DISABLED_FEATURES.flatMap((name) => ['-c', `features.${name}=false`]),
    '-c', 'features.skip_host_skill_discovery=true',
    '-c', 'web_search="disabled"',
    '-c', 'project_doc_max_bytes=0',
    '-c', 'cli_auth_credentials_store="file"',
    '-c', 'approval_policy="never"',
    '-c', 'sandbox_mode="read-only"',
    '-c', 'developer_instructions=""',
    ...(serverConfig ? ['-c', `mcp_servers.${RESERVED_MCP_SERVER_NAME}=${serverConfig}`] : []),
    ...(onProvider?.args ?? [])
  ] }
}

const execute = promisify(execFile)
const run: CommandRunner = async (command, args) => (await execute(command, [...args], { timeout: 10_000, windowsHide: true })).stdout

export async function prepareCodexLockdown(stage: AgentStage, launch: AgentLaunch, version: CommandRunner = run): Promise<{ env?: Record<string, string> }> {
  if (!launch.lockdown) return {}
  const printed = await version('codex', ['--version'])
  const match = /^codex-cli (\d+)\.(\d+)\.(\d+)(?:\s|$)/.exec(printed.trim())
  const major = Number(match?.[1]), minor = Number(match?.[2]), patch = Number(match?.[3])
  if (!match || !(major > 0 || minor > 160 || (minor === 160 && patch >= 1))) {
    throw new Rejection('agent-no-lockdown', '聊天平台需要 Codex CLI 0.160.1 或更新版本')
  }
  const home = path.join(launchDir(stage), 'codex-home')
  await privateDir(home)
  // Keep only this conversation's history across process restarts, never the user's other chats.
  const sessions = path.join(stage.sessionsRoot, stage.conversationId, 'codex-sessions')
  await privateDir(sessions)
  await symlink(sessions, path.join(home, 'sessions'), process.platform === 'win32' ? 'junction' : 'dir')
  if (!launch.provider) {
    const auth = path.join(launch.account?.env.CODEX_HOME ?? codexDefaultHome(), 'auth.json')
    const target = path.join(home, 'auth.json')
    // Codex writes credentials in place: refreshes reach the selected account too. Hard links
    // need no Windows symlink privilege; across volumes, a file link preserves the same behavior.
    await link(auth, target).catch(async (error: NodeJS.ErrnoException) => {
      if (error.code === 'ENOENT') return
      if (error.code !== 'EXDEV') throw error
      await symlink(auth, target, 'file')
    })
  }
  return { env: { CODEX_HOME: home, HOME: home, ...(process.platform === 'win32' ? { USERPROFILE: home } : {}) } }
}
