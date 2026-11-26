import { describe, expect, it } from 'vitest'
import { backendChoice, backendChoices, freshBackends } from './agent-backend'

describe('agent backends', () => {
  it('offers auto and the descriptor\'s backends, only to an agent with several', () => {
    expect(backendChoices('antigravity')).toEqual(['auto', 'agy-cli', 'managed-acp'])
    expect(backendChoices('claude')).toEqual([])
    expect(freshBackends()).toEqual({ antigravity: 'auto' })
  })

  it('keeps an install from before on its legacy backend until the user picks', () => {
    expect(backendChoice({}, 'antigravity')).toBe('managed-acp')
    expect(backendChoice(null, 'antigravity')).toBe('managed-acp')
    expect(backendChoice({ agentBackends: { antigravity: 'agy-cli' } }, 'antigravity')).toBe('agy-cli')
    expect(backendChoice({ agentBackends: { antigravity: 'gone' } }, 'antigravity')).toBe('managed-acp')
    expect(backendChoice({ agentBackends: { antigravity: 'auto' } }, 'claude')).toBeNull()
  })
})
