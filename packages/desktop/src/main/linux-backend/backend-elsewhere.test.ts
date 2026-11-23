import { describe, expect, it } from 'vitest'
import type { CoreEndpoint } from '@antumi/protocol'
import type { SshHost } from '../ssh/ssh-command'
import { SshSession, type SshSessionParts } from '../ssh/ssh-session'
import { WslSession, type WslSessionParts } from '../wsl/wsl-session'
import { backendAccess } from './backend-elsewhere'

// What each kind of backend elsewhere says it can do, which is all main and the renderer go by.

const endpoint: CoreEndpoint = { port: 1, token: 't', pid: 1, protocolVersion: 1, version: '1.0.0' }

function parts<P>(place: P) {
  return {
    ensure: async () => ({ ok: true as const, place, endpoint }),
    coreEndpoint: async () => endpoint,
    replaceDaemon: async () => {},
    link: () => ({ connect: async () => true, corePort: () => 1, stop: () => {} }),
    now: () => 0
  }
}

const sshHost: SshHost = { platform: 'darwin', env: {}, isFile: () => true, spawn: () => { throw new Error('not here') }, controlDir: null }

describe('a backend elsewhere', () => {
  it('is this machine, its files here, where there is none', () => {
    expect(backendAccess(null)).toEqual({ where: null, filesHere: true })
  })

  it('in WSL, reaches its files by path and has no files of its own to read', async () => {
    const place = { distro: 'Ubuntu', node: '/usr/bin/node', dir: '/d', home: '/home/me', path: '/usr/bin' }
    const made: WslSessionParts = parts(place)
    const session = new WslSession({ distro: 'Ubuntu', version: '1.0.0', archive: { file: 'a', sha256: 'b' } }, made)
    await session.start()
    expect(backendAccess(session)).toEqual({ where: { kind: 'wsl', distro: 'Ubuntu' }, filesHere: true })
    expect(session.fromBackendPath('/home/me/a.ts')).toBe('\\\\wsl.localhost\\Ubuntu\\home\\me\\a.ts')
    expect(await session.socksPort()).toBeNull()
  })

  it('on a server, reads and puts its files through ssh, and opens them only in editors that reach it', async () => {
    const place = { destination: 'dev@box', node: '/usr/bin/node', dir: '/d', home: '/home/dev', path: '/usr/bin' }
    const made: SshSessionParts = parts(place)
    const session = new SshSession({ destination: 'dev@box', version: '1.0.0', archive: async () => null, host: sshHost }, made)
    await session.start()
    expect(backendAccess(session)).toEqual({ where: { kind: 'ssh', host: 'dev@box' }, filesHere: false })
    expect(session.toBackendPath('/Users/me/a.ts')).toBeNull()
    expect(session.fromBackendPath('/home/dev/a.ts')).toBeNull()
    const files = session.files()
    expect(files.editors).toEqual(['vscode', 'cursor', 'zed'])
    expect(files.editorUrl('cursor', '/home/dev/a.ts', true)).toBe('cursor://vscode-remote/ssh-remote+dev%40box/home/dev/a.ts:1:1')
    expect(files.editorUrl('terminal', '/home/dev', false)).toBeNull()
  })
})
