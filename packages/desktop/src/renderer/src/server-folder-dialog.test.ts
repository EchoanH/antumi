import { describe, expect, it } from 'vitest'
import { askServerFolder, choosable, parentFolder, pathSteps, useServerFolderDialog } from './server-folder-dialog'

describe('server folder dialog', () => {
  it('goes up to the root and no further', () => {
    expect(parentFolder('/home/dev/project')).toBe('/home/dev')
    expect(parentFolder('/home/dev/')).toBe('/home')
    expect(parentFolder('/home')).toBe('/')
    expect(parentFolder('/')).toBeNull()
    expect(parentFolder('relative')).toBeNull()
  })

  it('names every folder from the root down', () => {
    expect(pathSteps('/home/dev')).toEqual([['/', '/'], ['home', '/home'], ['dev', '/home/dev']])
    expect(pathSteps('/')).toEqual([['/', '/']])
  })

  it('chooses files only of the extensions asked for', () => {
    expect(choosable('plugin.ZIP', ['zip'])).toBe(true)
    expect(choosable('plugin.tar', ['zip'])).toBe(false)
    expect(choosable('plugin.zip', undefined)).toBe(false)
  })

  it('answers with the path chosen, and declines a question asked over', async () => {
    const first = askServerFolder({ title: 'a' })
    const second = askServerFolder({ files: ['zip'] })
    expect(await first).toBeNull()
    expect(useServerFolderDialog.getState().asking?.files).toEqual(['zip'])
    useServerFolderDialog.getState().asking?.answer('/home/dev/plugin.zip')
    expect(await second).toBe('/home/dev/plugin.zip')
    expect(useServerFolderDialog.getState().asking).toBeNull()
  })
})
