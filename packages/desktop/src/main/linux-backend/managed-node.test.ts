import { createHash } from 'node:crypto'
import { mkdtempSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import type { LinuxResult, LinuxRunOptions, LinuxTarget } from './linux-target'
import { ensureManagedNode, fetchNodeInto, MANAGED_NODE, NODE_SOURCES } from './managed-node'

type Run = { argv: readonly string[]; options: LinuxRunOptions | undefined }

function target(answer: (run: Run) => Partial<LinuxResult>) {
  const runs: Run[] = []
  const linux: LinuxTarget = {
    run: async (argv, options) => {
      const run = { argv, options }
      runs.push(run)
      return { code: 0, stdout: '', stderr: '', timedOut: false, ...answer(run) }
    },
    spawn: () => { throw new Error('not here') },
    launch: () => {}
  }
  return { linux, runs }
}

const NODE = `/home/dev/.antumi/node/${MANAGED_NODE.version}/node`

describe('ensureManagedNode', () => {
  it('has the machine download the pinned archive from each source in turn, checked by its hash', async () => {
    const { linux, runs } = target(() => ({ stdout: `${NODE}\n` }))
    expect(await ensureManagedNode(linux, '/home/dev', 'x64', null)).toEqual({ ok: true, node: NODE })
    const args = runs[0]?.argv ?? []
    expect(args.slice(4, 7)).toEqual([`/home/dev/.antumi/node/${MANAGED_NODE.version}`, MANAGED_NODE.files.x64.name, MANAGED_NODE.files.x64.sha256])
    expect(args.slice(7)).toEqual(NODE_SOURCES.map((source) => `${source}/${MANAGED_NODE.version}/${MANAGED_NODE.files.x64.name}`))
  })

  it('sends the archive this app fetched when the machine could not download it', async () => {
    const archive = Buffer.from('archive')
    const { linux, runs } = target((run) => (run.argv.at(-1) === '-' ? { stdout: `${NODE}\n` } : { code: 11 }))
    expect(await ensureManagedNode(linux, '/home/dev', 'arm64', async (arch) => (arch === 'arm64' ? archive : null))).toEqual({ ok: true, node: NODE })
    expect(runs[1]?.options?.input).toBe(archive)
  })

  it('says why when neither could get it, or the install failed', async () => {
    expect(await ensureManagedNode(target(() => ({ code: 11 })).linux, '/h', 'x64', async () => null)).toMatchObject({ ok: false, detail: expect.stringContaining('could not download') })
    expect(await ensureManagedNode(target(() => ({ code: 13, stderr: 'tar: Not found in archive' })).linux, '/h', 'x64', null)).toEqual({ ok: false, detail: 'installing Node: tar: Not found in archive' })
  })
})

describe('fetchNodeInto', () => {
  it('keeps an archive only when its hash is the pinned one, and reads it from the cache next time', async () => {
    const cache = mkdtempSync(join(tmpdir(), 'antumi-node-'))
    const good = Buffer.from('pretend archive')
    const pinned = createHash('sha256').update(good).digest('hex')
    const asked: string[] = []
    // A first source that serves something else, a second that serves the right bytes.
    const download = async (url: string) => {
      asked.push(url)
      return url.startsWith(NODE_SOURCES[0]) ? Buffer.from('tampered') : good
    }
    const release = { version: MANAGED_NODE.version, files: { ...MANAGED_NODE.files, x64: { name: MANAGED_NODE.files.x64.name, sha256: pinned } } }
    const fetch = fetchNodeInto(cache, download, release)
    expect(await fetch('x64')).toEqual(good)
    expect(asked).toHaveLength(2)
    expect(readFileSync(join(cache, MANAGED_NODE.files.x64.name))).toEqual(good)
    expect(await fetch('x64')).toEqual(good)
    expect(asked).toHaveLength(2)
  })
})
