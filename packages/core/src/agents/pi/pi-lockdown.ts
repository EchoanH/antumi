import { link, symlink } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { launchDir, privateDir, writePrivateFile } from '../../stage-launch'
import type { AgentLaunch, AgentStage } from '../agent-adapter'
import { PI_EXTENSION_SOURCE } from './pi-extension'

// The CLI switches and tool-call guard below are verified together on this version.
export const PI_LOCKDOWN_MIN_VERSION = '1.3.0'

export async function preparePiLockdown(stage: AgentStage, launch: AgentLaunch): Promise<{ args: string[]; env: Record<string, string> }> {
  const home = path.join(launchDir(stage), 'pi-home')
  await privateDir(home)
  const env = { PI_CODING_AGENT_DIR: home, HOME: home, ...(process.platform === 'win32' ? { USERPROFILE: home } : {}) }
  if (!launch.provider) {
    const source = path.join(process.env.PI_CODING_AGENT_DIR || path.join(os.homedir(), '.pi', 'agent'), 'auth.json')
    const target = path.join(home, 'auth.json')
    // Share only credentials, so OAuth refreshes still reach the user's own sign-in.
    await link(source, target).catch(async (error: NodeJS.ErrnoException) => {
      if (error.code === 'ENOENT') return
      if (error.code !== 'EXDEV') throw error
      await symlink(source, target, 'file')
    })
  }
  const sessions = path.join(stage.sessionsRoot, stage.conversationId, 'pi-sessions')
  await privateDir(sessions)
  const extension = path.join(launchDir(stage), 'pi-channel.mjs')
  await writePrivateFile(extension, PI_EXTENSION_SOURCE)
  return { env, args: ['--extension', extension, '--session-dir', sessions] }
}
