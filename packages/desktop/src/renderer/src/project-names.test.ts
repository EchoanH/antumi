import { beforeEach, describe, expect, it } from 'vitest'
import { setPreference, usePreferences } from './preferences'
import { projectName, renameProject } from './project-names'

beforeEach(() => setPreference('projectNames', {}))

describe('projectName', () => {
  it("is the folder's name until the user gives the project one", () => {
    expect(projectName('/work/api/')).toBe('api')
    renameProject('/work/api', '  Billing API ')
    expect(projectName('/work/api/')).toBe('Billing API')
    expect(projectName('C:\\work\\api')).toBe('api')
  })

  it("goes back to the folder's name when renamed to it or to nothing", () => {
    renameProject('/work/api', 'Billing')
    renameProject('/work/api', 'api')
    expect(usePreferences.getState().projectNames).toEqual({})
    renameProject('/work/api', 'Billing')
    renameProject('/work/api', '   ')
    expect(projectName('/work/api')).toBe('api')
  })
})
