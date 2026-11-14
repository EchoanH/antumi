import { describe, expect, it } from 'vitest'
import { claudeCommand, claudeEditDenials, claudeReadRules } from './claude-command'

describe('Claude permission rules', () => {
  it('lets Claude read exactly those files, and nothing about the folder', () => {
    expect(claudeReadRules(['/home/me/.antumi/attachments/a.png', '/home/me/odd,name/b.png', 'relative.png'])).toEqual([
      'Read(//home/me/.antumi/attachments/a.png)'
    ])
  })

  it('denies edits under each folder, leaving out what a comma would garble', () => {
    expect(claudeEditDenials(['/work/web app', '/work/a,b', 'relative'])).toEqual(['Edit(//work/web app/**)'])
  })

  it('writes a Windows path the way Claude matches it, so a fence there is not dropped', () => {
    expect(claudeEditDenials(['C:\\Users\\me\\.antumi\\worktrees\\t1\\web', 'D:/work/'])).toEqual([
      'Edit(//c/Users/me/.antumi/worktrees/t1/web/**)',
      'Edit(//d/work/**)'
    ])
    expect(claudeReadRules(['C:\\Users\\me\\a.png', '\\\\server\\share\\b.png'])).toEqual(['Read(//c/Users/me/a.png)'])
  })
})

describe('a locked-down Claude', () => {
  it('starts with Antumi\'s named tools and nothing of its own or the user\'s', () => {
    const { args } = claudeCommand({
      providerSessionId: 's1', resume: false, handoffPath: null, extraProjects: [], instructions: 'Answer briefly.',
      mcp: { command: 'node', args: ['mcp.mjs', '--tool-set', 'channel'] },
      lockdown: { tools: ['project_list', 'project_read'] }
    })
    expect(args).toEqual([
      '-p', '--verbose', '--output-format', 'stream-json', '--input-format', 'stream-json',
      '--include-partial-messages', '--permission-prompt-tool', 'stdio',
      '--permission-mode', 'manual',
      '--restricted', '--tools', '', '--strict-mcp-config', '--setting-sources', '', '--disable-slash-commands', '--no-chrome',
      '--session-id', 's1',
      '--system-prompt', 'Answer briefly.',
      '--allowedTools', 'mcp__antumi__project_list,mcp__antumi__project_read',
      '--mcp-config', '{"mcpServers":{"antumi":{"type":"stdio","command":"node","args":["mcp.mjs","--tool-set","channel"]}}}'
    ])
  })

  it('goes on in its own session', () => {
    const { args } = claudeCommand({ providerSessionId: 's1', resume: true, handoffPath: null, extraProjects: [], lockdown: { tools: [] } })
    expect(args.slice(args.indexOf('--resume'), args.indexOf('--resume') + 2)).toEqual(['--resume', 's1'])
    expect(args).not.toContain('--fork-session')
  })
})
