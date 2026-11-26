import { mkdtempSync, rmSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { ProjectRegistry } from './project-registry'
import { TaskStore } from './task-store'

describe('ProjectRegistry', () => {
  let dir: string
  let tasks: TaskStore
  let projects: ProjectRegistry

  beforeEach(() => {
    dir = mkdtempSync(path.join(os.tmpdir(), 'antumi-projects-'))
    const file = path.join(dir, 'antumi.db')
    // Creates the table the registry reads.
    tasks = new TaskStore(file)
    let now = 1
    projects = new ProjectRegistry(file, () => now++)
  })

  afterEach(() => {
    projects.close()
    tasks.close()
    rmSync(dir, { recursive: true, force: true })
  })

  it('lists projects most recent first, a repeat moving to the front', () => {
    projects.remember(['/a', '/b'])
    projects.remember(['/a'])
    expect(projects.recent()).toEqual([path.normalize('/a'), path.normalize('/b')])
  })

  it('keeps source and copy identities across restarts without inspecting their folders', () => {
    const source = path.normalize('/code/app')
    const copy = path.normalize('/worktrees/app')
    const unknown = path.normalize('/unknown')
    projects.remember([source, copy, unknown])
    const choices = [
      { path: source, source: null, branch: null, worktree: false },
      { path: copy, source, branch: 'feature', worktree: true }
    ]
    projects.rememberChoices(choices)
    projects.close()
    projects = new ProjectRegistry(path.join(dir, 'antumi.db'))
    expect(projects.suggestions()).toEqual({ paths: [source, copy, unknown], choices })
    projects.forget(copy)
    expect(projects.suggestions()).toEqual({ paths: [source, unknown], choices: [choices[0]] })
    // A late background response cannot bring a forgotten path back to the recent list.
    projects.rememberChoices([choices[1]!])
    expect(projects.suggestions().paths).not.toContain(copy)
  })

  it('stores and forgets paths in their normal form', () => {
    projects.remember(['/code/tmp/../app'])
    projects.remember(['/code/./lib'])
    expect(projects.recent()).toEqual(['/code/lib', '/code/app'].map((file) => path.normalize(file)))
    projects.forget('/code/lib/../app')
    expect(projects.recent()).toEqual([path.normalize('/code/lib')])
  })
})
