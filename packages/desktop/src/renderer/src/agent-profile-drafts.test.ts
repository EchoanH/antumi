import { beforeEach, afterEach, describe, expect, it, vi } from 'vitest'

const values = new Map<string, string>()
beforeEach(() => {
  vi.resetModules()
  values.clear()
  vi.stubGlobal('localStorage', {
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => values.set(key, value)
  })
})
afterEach(() => vi.unstubAllGlobals())

const fields = { name: 'Researcher', agent: 'codex', instructions: 'Keep this draft' } as const

describe('agent profile drafts', () => {
  it('retains independent profiles and incomplete new drafts across renderer reloads', async () => {
    const first = await import('./agent-profile-drafts')
    first.saveProfileDraft('profile-a', fields)
    first.saveProfileDraft('new:blank', { ...fields, name: '' })
    vi.resetModules()
    const reloaded = await import('./agent-profile-drafts')
    expect(reloaded.readProfileDraft('profile-a')).toMatchObject(fields)
    expect(reloaded.readProfileDraft('new:blank')).toMatchObject({ name: '', instructions: fields.instructions })
    expect(reloaded.readProfileDraft('profile-b')).toBeNull()
  })

  it('clears only the saved or discarded draft and keeps other work', async () => {
    const drafts = await import('./agent-profile-drafts')
    drafts.saveProfileDraft('a', fields)
    drafts.saveProfileDraft('b', { ...fields, name: 'Other' })
    drafts.saveProfileDraft('a', null)
    vi.resetModules()
    const reloaded = await import('./agent-profile-drafts')
    expect(reloaded.readProfileDraft('a')).toBeNull()
    expect(reloaded.readProfileDraft('b')?.name).toBe('Other')
  })

  it('ignores malformed entries without losing valid drafts', async () => {
    values.set('antumi.agent-profile-drafts', JSON.stringify({ invalid: { name: 1 }, valid: fields }))
    const drafts = await import('./agent-profile-drafts')
    expect(drafts.readProfileDraft('invalid')).toBeNull()
    expect(drafts.readProfileDraft('valid')).toMatchObject(fields)
  })

  it('retains work in memory and reports blocked persistence', async () => {
    vi.stubGlobal('localStorage', { getItem: () => { throw Error('blocked') }, setItem: () => { throw Error('blocked') } })
    const drafts = await import('./agent-profile-drafts')
    expect(drafts.saveProfileDraft('a', fields)).toBe(false)
    expect(drafts.readProfileDraft('a')).toMatchObject(fields)
  })

  it('does not replace a newer memory draft with stale disk data when writes fail', async () => {
    values.set('antumi.agent-profile-drafts', JSON.stringify({ a: fields }))
    vi.stubGlobal('localStorage', {
      getItem: (key: string) => values.get(key) ?? null,
      setItem: () => { throw Error('quota exceeded') }
    })
    const drafts = await import('./agent-profile-drafts')
    expect(drafts.readProfileDraft('a')).toMatchObject(fields)
    expect(drafts.saveProfileDraft('a', { ...fields, instructions: 'New unsaved work' })).toBe(false)
    expect(drafts.readProfileDraft('a')?.instructions).toBe('New unsaved work')
    drafts.saveProfileDraft('a', null)
    expect(drafts.readProfileDraft('a')).toBeNull()
  })

  it('compares configuration with canonical defaults, ignoring server metadata', async () => {
    const drafts = await import('./agent-profile-drafts')
    const saved = { ...fields, audience: 'user', callableSquads: [], updatedAt: 123 } as const
    expect(drafts.profileFieldsEqual(fields, { ...saved, callableSquads: [] })).toBe(true)
    expect(drafts.profileFieldsEqual(fields, { ...fields, instructions: 'Changed' })).toBe(false)
  })
})
