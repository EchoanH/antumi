import { describe, expect, it } from 'vitest'
import type { ChatItem } from '@antumi/protocol'
import { READ_ONLY_DENIAL, READ_ONLY_PLAN_DENIAL, UNATTENDED_DENIAL, UNATTENDED_QUESTION, unattendedAnswer } from './unattended-answer'

const base = { stageId: 'stage', at: 1, revision: 1 }
const approval = (patch: Partial<Extract<ChatItem, { kind: 'approval' }>> = {}): ChatItem => ({
  ...base, id: 'a', kind: 'approval', requestId: 'r', tool: 'Bash', title: 'rm -rf build', detail: null, toolItemId: null, decisions: ['allow', 'allowForSession', 'deny'], resolution: null, ...patch
})
const choices = [
  { id: 'once', label: 'Allow once', decision: 'allow' as const, grants: [] },
  { id: 'always', label: 'Always allow', decision: 'allowForSession' as const, grants: [{ kind: 'other' as const, values: ['Always allow'], scope: 'agent' as const, behavior: 'allow' as const }] },
  { id: 'never', label: 'Always reject', decision: 'deny' as const, grants: [{ kind: 'other' as const, values: ['Always reject'], scope: 'agent' as const, behavior: 'deny' as const }] },
  { id: 'reject', label: 'Reject', decision: 'deny' as const, grants: [] }
]

describe('unattendedAnswer', () => {
  it('refuses with word to work around it in automatic mode, by the plain no among the choices', () => {
    expect(unattendedAnswer(approval(), 'acceptEdits')).toEqual({ decision: 'deny', message: UNATTENDED_DENIAL })
    expect(unattendedAnswer(approval({ choices }), 'acceptEdits')).toEqual({ decision: 'deny', message: UNATTENDED_DENIAL, choice: 'reject' })
  })

  it('allows once in allow-everything mode, never a yes that outlasts the run', () => {
    expect(unattendedAnswer(approval(), 'bypass')).toEqual({ decision: 'allow' })
    expect(unattendedAnswer(approval({ choices }), 'bypass')).toEqual({ decision: 'allow', choice: 'once' })
  })

  it('approves a plan, as a scheduled run approves the one it finds', () => {
    expect(unattendedAnswer(approval({ tool: 'ExitPlanMode' }), 'acceptEdits')).toEqual({ decision: 'allowForSession' })
  })

  it('refuses a plan in a run that only reads, whatever its mode', () => {
    expect(unattendedAnswer(approval({ tool: 'ExitPlanMode', choices }), 'bypass', 'only')).toEqual({ decision: 'deny', message: READ_ONLY_PLAN_DENIAL, choice: 'reject' })
    expect(unattendedAnswer(approval({ tool: 'ExitPlanMode' }), 'acceptEdits', 'allow')).toEqual({ decision: 'allowForSession' })
  })

  it('lets what only reads through when the run may read, judging a command by its full text', () => {
    expect(unattendedAnswer(approval({ title: 'gh issue view 26', choices }), 'acceptEdits', 'only', 'gh issue view 26')).toEqual({ decision: 'allow', choice: 'once' })
    expect(unattendedAnswer(approval({ title: 'ls' }), 'acceptEdits', 'only', 'ls\nrm -rf build')).toEqual({ decision: 'deny', message: READ_ONLY_DENIAL })
    expect(unattendedAnswer(approval({ title: 'ls' }), 'acceptEdits', 'only', null)).toEqual({ decision: 'deny', message: READ_ONLY_DENIAL })
    expect(unattendedAnswer(approval({ tool: 'commandExecution', title: 'npm test' }), 'acceptEdits', 'allow', 'npm test')).toEqual({ decision: 'deny', message: READ_ONLY_DENIAL })
    expect(unattendedAnswer(approval({ tool: 'WebFetch', title: 'https://docs.test' }), 'acceptEdits', 'only')).toEqual({ decision: 'allow' })
    expect(unattendedAnswer(approval({ tool: 'mcp__jira__get_issue', title: 'D-1' }), 'acceptEdits', 'only')).toEqual({ decision: 'allow' })
    expect(unattendedAnswer(approval({ tool: 'mcp__antumi__browser_click', title: 'Submit' }), 'acceptEdits', 'only')).toEqual({ decision: 'deny', message: READ_ONLY_DENIAL })
    // An investigation the source lets open a task: core checks it, so a planning agent's ask passes.
    expect(unattendedAnswer(approval({ tool: 'mcp__antumi__source_task_create', title: 'Fix login' }), 'acceptEdits', 'allow')).toEqual({ decision: 'allow' })
    expect(unattendedAnswer(approval({ tool: 'Edit', title: 'src/a.ts' }), 'acceptEdits', 'only')).toEqual({ decision: 'deny', message: READ_ONLY_DENIAL })
    expect(unattendedAnswer(approval({ title: 'npm test' }), 'acceptEdits', undefined, 'npm test')).toEqual({ decision: 'deny', message: UNATTENDED_DENIAL })
  })

  it('leaves a question unanswered, telling the agent to assume and go on', () => {
    const question: ChatItem = { ...base, id: 'q', kind: 'question', requestId: 'q', questions: [], answers: null, resolution: null }
    expect(unattendedAnswer(question, 'bypass')).toEqual({ decision: 'deny', message: UNATTENDED_QUESTION })
    expect(unattendedAnswer({ ...question, async: true }, 'bypass')).toBeNull()
  })

  it('answers nothing already answered', () => {
    expect(unattendedAnswer(approval({ resolution: 'denied' }), 'bypass')).toBeNull()
  })
})
