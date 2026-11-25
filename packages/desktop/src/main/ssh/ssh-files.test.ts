import { ChildProcess } from 'node:child_process'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { PassThrough } from 'node:stream'
import { describe, expect, it } from 'vitest'
import { nodeSshHost, shellQuote, type SshHost } from './ssh-command'
import { putOnServer, readServerFile, remoteEditorUrl, serverIsDirectory } from './ssh-files'

class FakeChild extends ChildProcess {
  readonly out = new PassThrough()
  readonly err = new PassThrough()
  constructor() {
    super()
    this.stdin = new PassThrough()
    this.stdout = this.out
    this.stderr = this.err
  }
}

type Call = { script: string; argv: string[]; input: Buffer }

// A server that answers each program from what it was asked and fed: the script sh would unpack,
// and its simple (unquoted-quote) words.
function server(answer: (call: Call) => { code: number; stdout?: Buffer | string; stderr?: string }) {
  const calls: Call[] = []
  const host: SshHost = {
    ...nodeSshHost(null),
    isFile: () => true,
    spawn(_file, args) {
      const encoded = /echo ([A-Za-z0-9+/=]+) \|/.exec(args.at(-1) ?? '')?.[1] ?? ''
      const script = Buffer.from(encoded, 'base64').toString('utf8')
      const argv = [...script.matchAll(/'([^']*)'/g)].map((match) => match[1] ?? '')
      const child = new FakeChild()
      const chunks: Buffer[] = []
      child.stdin?.on('data', (chunk: Buffer) => chunks.push(chunk))
      child.stdin?.on('finish', () => {
        const call = { script, argv, input: Buffer.concat(chunks) }
        calls.push(call)
        const reply = answer(call)
        child.out.end(reply.stdout ?? '')
        child.err.end(reply.stderr ?? '')
        child.emit('exit', reply.code, null)
      })
      return child
    }
  }
  return { host, calls }
}

describe('readServerFile', () => {
  it('reads the bytes after the real path, and says why when it cannot', async () => {
    const png = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0a, 0x00, 0xff])
    const { host, calls } = server(() => ({ code: 0, stdout: Buffer.concat([Buffer.from('/home/dev/real.png\n'), png]) }))
    const found = await readServerFile(host, 'box', '/home/dev/link.png', 1024)
    expect(found).toEqual({ kind: 'file', real: '/home/dev/real.png', bytes: png })
    expect(calls[0]?.argv.slice(-2)).toEqual(['/home/dev/link.png', '1024'])
    for (const [code, kind] of [[3, 'missing'], [4, 'not-a-file'], [5, 'too-large'], [255, 'unreachable']] as const) {
      expect((await readServerFile(server(() => ({ code })).host, 'box', '/x', 1)).kind).toBe(kind)
    }
    expect((await readServerFile(host, 'box', 'relative', 1)).kind).toBe('missing')
  })

  it('tells a folder from a file', async () => {
    expect(await serverIsDirectory(server(() => ({ code: 0 })).host, 'box', '/home')).toBe(true)
    expect(await serverIsDirectory(server(() => ({ code: 1 })).host, 'box', '/etc/hosts')).toBe(false)
    expect(await serverIsDirectory(server(() => ({ code: 255 })).host, 'box', '/x')).toBeNull()
  })
})

describe('putOnServer', () => {
  it('sends a file as itself into a folder of its own under ~/.antumi/drops', async () => {
    const folder = mkdtempSync(join(tmpdir(), 'antumi-drop-'))
    const file = join(folder, "it's notes.txt")
    writeFileSync(file, 'hello')
    const { host, calls } = server(() => ({ code: 0 }))
    const put = await putOnServer(host, 'box', '/home/dev', file)
    expect(put).toMatchObject({ kind: 'ok', path: expect.stringMatching(/^\/home\/dev\/\.antumi\/drops\/[0-9a-f-]{36}\/it's notes\.txt$/) })
    expect(calls[0]?.input.toString()).toBe('hello')
    expect(calls[0]?.script.endsWith(` ${shellQuote("it's notes.txt")}`)).toBe(true)
  })

  it('sends a folder as a tar of it', async () => {
    const folder = mkdtempSync(join(tmpdir(), 'antumi-drop-'))
    writeFileSync(join(folder, 'a.txt'), 'a')
    const { host, calls } = server(() => ({ code: 0 }))
    const put = await putOnServer(host, 'box', '/home/dev', folder)
    expect(put.kind).toBe('ok')
    // A tar's first header names its first member.
    expect(calls[0]?.input.subarray(0, 100).toString()).toContain('antumi-drop-')
  })

  it('says what the server said when it fails', async () => {
    const folder = mkdtempSync(join(tmpdir(), 'antumi-drop-'))
    const file = join(folder, 'x')
    writeFileSync(file, 'x')
    expect(await putOnServer(server(() => ({ code: 1, stderr: 'No space left on device' })).host, 'box', '/home/dev', file)).toEqual({ kind: 'failed', detail: 'No space left on device' })
  })
})

describe('remoteEditorUrl', () => {
  it('opens a file at its first line and a folder as a workspace, in each editor\'s own URL', () => {
    expect(remoteEditorUrl('vscode', 'dev@box', '/home/dev/a b.ts', true)).toBe('vscode://vscode-remote/ssh-remote+dev%40box/home/dev/a%20b.ts:1:1')
    expect(remoteEditorUrl('cursor', 'my-alias', '/home/dev/project', false)).toBe('cursor://vscode-remote/ssh-remote+my-alias/home/dev/project')
    expect(remoteEditorUrl('zed', 'dev@box', '/home/dev/project', false)).toBe('zed://ssh/dev@box/home/dev/project')
  })
})
