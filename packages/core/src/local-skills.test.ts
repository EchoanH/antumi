import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { adapterOf } from './agents'
import { localSkillFolders } from './local-skills'

describe('localSkillFolders', () => {
  let root: string
  beforeEach(() => { root = mkdtempSync(path.join(os.tmpdir(), 'antumi-local-skills-')) })
  afterEach(() => rmSync(root, { recursive: true, force: true }))

  const skill = (dir: string, name: string, text: string | null) => {
    mkdirSync(path.join(dir, name), { recursive: true })
    if (text !== null) writeFileSync(path.join(dir, name, 'SKILL.md'), text)
  }

  it('lists the skills one level down, by their frontmatter, skipping hidden folders and ones with no SKILL.md', async () => {
    const claude = path.join(root, 'claude', 'skills')
    skill(claude, 'review', '---\nname: code-review\ndescription: |\n  Reviews a diff\n  for bugs.\n---\nBody')
    skill(claude, 'bare', 'No frontmatter')
    skill(claude, '.hidden', '---\nname: hidden\n---')
    skill(claude, 'empty', null)
    writeFileSync(path.join(claude, 'notes.md'), 'not a skill')
    const folders = await localSkillFolders((agent) => (agent === 'claude' ? [claude, path.join(root, 'missing')] : []))
    expect(folders).toEqual([{ dir: claude, agents: ['claude'], skills: [
      { name: 'bare', description: '', dir: path.join(claude, 'bare') },
      { name: 'code-review', description: 'Reviews a diff for bugs.', dir: path.join(claude, 'review') }
    ] }])
  })

  it('names a folder once, with every agent that loads it, however it is linked', async () => {
    const shared = path.join(root, 'agents', 'skills')
    skill(shared, 'deploy', '---\nname: deploy\ndescription: Ships it\n---')
    symlinkSync(shared, path.join(root, 'linked'), process.platform === 'win32' ? 'junction' : 'dir')
    const folders = await localSkillFolders((agent) => (agent === 'codex' ? [shared] : agent === 'opencode' ? [path.join(root, 'linked')] : []))
    expect(folders).toHaveLength(1)
    expect(folders[0]).toMatchObject({ dir: shared, agents: ['codex', 'opencode'] })
  })

  it('takes Claude Code\'s and Codex\'s folders from their homes as the environment sets them', () => {
    const env = { CLAUDE_CONFIG_DIR: path.join(root, 'c'), CODEX_HOME: path.join(root, 'x') }
    expect(adapterOf('claude').globalSkillDirs?.(env)).toEqual([path.join(env.CLAUDE_CONFIG_DIR, 'skills')])
    expect(adapterOf('codex').globalSkillDirs?.(env)).toEqual([path.join(env.CODEX_HOME, 'skills'), path.join(os.homedir(), '.agents', 'skills'), '/etc/codex/skills'])
  })

  it('follows the variables that move OpenCode\'s, Pi\'s and Gemini CLI\'s folders, and OpenCode\'s switch for Claude Code\'s', () => {
    const home = os.homedir()
    const opencode = path.join(root, 'oc')
    const xdg = path.join(root, 'xdg')
    const pi = path.join(root, 'pi')
    const gemini = path.join(root, 'g')
    expect(adapterOf('opencode').globalSkillDirs?.({ OPENCODE_CONFIG_DIR: opencode })).toEqual([path.join(opencode, 'skill'), path.join(opencode, 'skills'), path.join(home, '.claude', 'skills'), path.join(home, '.agents', 'skills')])
    expect(adapterOf('opencode').globalSkillDirs?.({ XDG_CONFIG_HOME: xdg, OPENCODE_DISABLE_CLAUDE_CODE_SKILLS: '1' })).toEqual([path.join(xdg, 'opencode', 'skill'), path.join(xdg, 'opencode', 'skills'), path.join(home, '.agents', 'skills')])
    expect(adapterOf('pi').globalSkillDirs?.({ PI_CODING_AGENT_DIR: pi })).toEqual([path.join(pi, 'skills'), path.join(home, '.agents', 'skills')])
    expect(adapterOf('gemini').globalSkillDirs?.({ GEMINI_CLI_HOME: gemini })).toEqual([path.join(gemini, '.gemini', 'skills'), path.join(gemini, '.agents', 'skills')])
  })
})
