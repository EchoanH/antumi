import { describe, expect, it, vi } from 'vitest'

vi.hoisted(() => {
  vi.stubGlobal('window', { antumi: undefined, matchMedia: () => ({ matches: false, addEventListener() {}, removeEventListener() {} }) })
  vi.stubGlobal('navigator', { userAgent: 'Mac', platform: 'MacIntel' })
})

const { availableProjects, plainProject, sourceProjects } = await import('./project-choices')

describe('source project suggestions', () => {
  it('offers the source of an already selected copy, and a copy of an already selected source', () => {
    const copy = { path: '/worktrees/copy/magi', source: '/code/magi', worktree: true, branch: 'feature' }
    expect(availableProjects([copy], [copy.path])).toEqual({ sources: [plainProject('/code/magi')], copies: [] })
    expect(availableProjects([copy, plainProject('/code/magi')], ['/code/magi'])).toEqual({ sources: [], copies: [copy] })
    expect(availableProjects([copy], [copy.path, '/code/magi'])).toEqual({ sources: [], copies: [] })
  })
  it('offers the source once when recent entries include multiple copies, keeping recency', () => {
    const copies = [
      { path: '/worktrees/one/magi', source: '/code/magi', worktree: true, branch: 'one' },
      plainProject('/code/orca'),
      { path: '/worktrees/two/magi', source: '/code/magi', worktree: true, branch: 'two' },
      plainProject('/code/magi')
    ]
    expect(sourceProjects(copies)).toEqual([plainProject('/code/magi'), plainProject('/code/orca')])
    expect(copies[0]?.path).toBe('/worktrees/one/magi')
  })

  it('keeps independent projects with the same name and never treats an unresolved copy as a source', () => {
    expect(sourceProjects([
      plainProject('/work/magi'), plainProject('/personal/magi'),
      { path: '/worktrees/copy/magi', source: null, worktree: true, branch: null }
    ])).toEqual([plainProject('/work/magi'), plainProject('/personal/magi')])
  })
})
