import { describe, expect, it } from 'vitest'
import { AGENT_KINDS, agentDescriptor } from '@antumi/protocol'
import { adapterOf } from './index'
import type { AgentLaunch } from './agent-adapter'

// What every agent that says it can be locked down (capabilities.lockdown) must hold to, whatever
// its command line looks like: nothing a launch carries that would widen it reaches the command.
const HOSTILE = {
  extraProject: '/hostile/extra-project',
  readable: '/hostile/readable.png',
  reference: '/hostile/reference',
  handoff: '/hostile/handoff.md',
  vault: '/hostile/vault',
  skills: '/hostile/skills',
  userMcp: 'hostile-user-mcp',
  fenced: '/hostile/fenced'
}

function hostileLaunch(): AgentLaunch {
  return {
    providerSessionId: 's1', resume: false, instructions: 'Answer briefly.',
    handoffPath: HOSTILE.handoff, extraProjects: [HOSTILE.extraProject], readable: [HOSTILE.readable], references: [HOSTILE.reference],
    readOnly: { dirs: [HOSTILE.fenced] }, allowBypass: true, preferred: { permissionMode: 'bypass' }, userBrowser: true, todos: true,
    knowledgeBase: { kind: 'obsidian', path: HOSTILE.vault, write: true },
    skills: { dir: HOSTILE.skills },
    userMcp: [{ name: HOSTILE.userMcp, type: 'stdio', command: 'hostile-command', args: [] }],
    mcp: { command: 'node', args: ['mcp.mjs'] },
    lockdown: { tools: ['project_read'] }
  }
}

describe('agents that can be locked down', () => {
  const able = AGENT_KINDS.filter((kind) => agentDescriptor(kind).capabilities.lockdown)

  it('has at least one', () => {
    expect(able).toContain('claude')
  })

  for (const kind of able) {
    it(`${kind} passes on nothing of a launch that would widen it`, () => {
      const command = adapterOf(kind).command(hostileLaunch())
      const said = JSON.stringify([command.command, command.args, command.env ?? {}])
      for (const value of [...Object.values(HOSTILE), 'hostile-command']) expect(said, value).not.toContain(value)
      expect(said).not.toMatch(/bypass|dangerously/i)
      expect(said).toContain('project_read')
    })
  }
})
