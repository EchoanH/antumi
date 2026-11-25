import { lstat, mkdir, mkdtemp, rm, symlink, truncate, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { MAX_VISUALIZATION_BYTES } from '@antumi/protocol'
import { readCodexVisualization, type VisualizationScope } from './codex-visualizations'

vi.mock('node:fs/promises', async (importOriginal) => {
  const real = await importOriginal<typeof import('node:fs/promises')>()
  return { ...real, lstat: vi.fn(real.lstat) }
})

describe('Codex visualization files', () => {
  let root: string
  let project: string
  let scope: VisualizationScope
  beforeEach(async () => {
    root = await mkdtemp(path.join(tmpdir(), 'antumi-visualization-'))
    project = path.join(root, 'project')
    await mkdir(project)
    scope = { roots: [project], threadId: 'thread-one', startedAt: Date.UTC(2026, 10, 4), home: path.join(root, 'codex') }
  })
  afterEach(async () => { await rm(root, { recursive: true, force: true }) })

  it('reads a UTF-8 fragment from the owning workspace', async () => {
    const file = path.join(project, 'status-preview.html')
    await writeFile(file, '<div>状态预览</div>')
    expect(await readCodexVisualization(scope, file)).toEqual({ path: file, contents: '<div>状态预览</div>' })
    expect(await readCodexVisualization(scope, path.join(project, 'gone.html'))).toBeNull()
  })

  it('resolves a legacy filename only inside this native thread', async () => {
    const directory = path.join(root, 'codex', 'visualizations', '2026', '11', '04', 'thread-one')
    await mkdir(directory, { recursive: true })
    await writeFile(path.join(directory, 'status-preview.html'), 'native')
    expect(await readCodexVisualization(scope, 'status-preview.html')).toEqual({ path: path.join(directory, 'status-preview.html'), contents: 'native' })
    expect(await readCodexVisualization({ ...scope, threadId: 'another-thread' }, 'status-preview.html')).toBeNull()
  })

  it('rejects outside paths, traversal, non-HTML and a directory masquerading as HTML', async () => {
    await mkdir(path.join(project, 'directory.html'))
    for (const name of [path.join(root, 'outside.html'), `${project}/../outside.html`, path.join(project, 'file.txt'), path.join(project, 'directory.html'), 'sub/page.html']) {
      await expect(readCodexVisualization(scope, name)).rejects.toThrow()
    }
  })

  it('refuses a file reported as a symlink even when the target stays in the project', async () => {
    const target = path.join(project, 'real.html')
    const alias = path.join(project, 'alias.html')
    await writeFile(target, 'page')
    try {
      await symlink(target, alias, 'file')
    } catch (error) {
      if (process.platform !== 'win32' || !(error instanceof Error) || !('code' in error) || error.code !== 'EPERM') throw error
      // Standard Windows users may create junctions, but file symlinks can require a privilege.
      // Keep exercising lstat-based rejection in that environment without changing permissions.
      await writeFile(alias, 'page')
      const info = await lstat(alias)
      const symbolic = vi.spyOn(info, 'isSymbolicLink').mockReturnValue(true)
      const metadata = vi.mocked(lstat).mockResolvedValueOnce(info)
      try {
        await expect(readCodexVisualization(scope, alias)).rejects.toMatchObject({ reason: 'visualization-path-invalid' })
        expect(symbolic).toHaveBeenCalled()
      } finally {
        const real = await vi.importActual<typeof import('node:fs/promises')>('node:fs/promises')
        metadata.mockReset().mockImplementation(real.lstat)
      }
      return
    }
    await expect(readCodexVisualization(scope, alias)).rejects.toMatchObject({ reason: 'visualization-path-invalid' })
  })

  it('refuses symlink directories even when the target stays in the project', async () => {
    const directory = path.join(project, 'real')
    await mkdir(directory)
    await writeFile(path.join(directory, 'page.html'), 'page')
    await symlink(directory, path.join(project, 'alias'), process.platform === 'win32' ? 'junction' : 'dir')
    await expect(readCodexVisualization(scope, path.join(project, 'alias', 'page.html'))).rejects.toMatchObject({ reason: 'visualization-path-invalid' })
  })

  it('bounds file reads and rejects binary content', async () => {
    const file = path.join(project, 'page.html')
    await writeFile(file, '')
    await truncate(file, MAX_VISUALIZATION_BYTES + 1)
    await expect(readCodexVisualization(scope, file)).rejects.toThrow()
    await writeFile(file, Buffer.from([0xff]))
    await expect(readCodexVisualization(scope, file)).rejects.toThrow()
    await writeFile(file, 'a\0b')
    await expect(readCodexVisualization(scope, file)).rejects.toThrow()
  })

  it('does not trust a symbolic link inside the native visualization directory', async () => {
    const home = path.join(root, 'codex')
    const elsewhere = path.join(root, 'elsewhere')
    await mkdir(home)
    await mkdir(path.join(elsewhere, '2026/11/04/thread-one'), { recursive: true })
    await writeFile(path.join(elsewhere, '2026/11/04/thread-one/page.html'), 'outside')
    await symlink(elsewhere, path.join(home, 'visualizations'), process.platform === 'win32' ? 'junction' : 'dir')
    await expect(readCodexVisualization(scope, 'page.html')).rejects.toThrow()
  })
})
