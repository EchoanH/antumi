import { createConnection, createServer, type Socket } from 'node:net'
import { afterEach, describe, expect, it } from 'vitest'
import { parseRequest, startSocksEntry } from './socks-entry'

const cleanup: (() => void)[] = []
afterEach(() => {
  for (const each of cleanup.splice(0)) each()
})

// What a browser sends: the greeting offering no authentication, then CONNECT to a name.
function request(host: string, port: number): Buffer {
  const name = Buffer.from(host)
  const tail = Buffer.alloc(2)
  tail.writeUInt16BE(port)
  return Buffer.concat([Buffer.from([5, 1, 0]), Buffer.from([5, 1, 0, 3, name.length]), name, tail])
}

function read(socket: Socket, bytes: number): Promise<Buffer> {
  return new Promise((resolve) => {
    let got = Buffer.alloc(0)
    const onData = (chunk: Buffer) => {
      got = Buffer.concat([got, chunk])
      if (got.length >= bytes) {
        socket.off('data', onData)
        resolve(got)
      }
    }
    socket.on('data', onData)
  })
}

describe('socks entry', () => {
  it('hands on the name and port the browser asked for, then only the bytes', async () => {
    const echo = createServer((socket) => socket.pipe(socket))
    await new Promise<void>((resolve) => echo.listen(0, '127.0.0.1', resolve))
    cleanup.push(() => echo.close())
    const address = echo.address()
    const echoPort = address && typeof address === 'object' ? address.port : 0
    const asked: [string, number][] = []
    const entry = await startSocksEntry((host, port, socket) => {
      asked.push([host, port])
      const out = createConnection({ host: '127.0.0.1', port: echoPort })
      socket.pipe(out).pipe(socket)
    })
    cleanup.push(() => entry.close())
    const client = createConnection({ host: '127.0.0.1', port: entry.port })
    cleanup.push(() => client.destroy())
    // The request comes with the greeting, before the answer: the entry must read it all the same.
    client.write(request('localhost', 3000))
    const answers = await read(client, 12)
    expect([...answers.subarray(0, 2)]).toEqual([5, 0])
    expect([...answers.subarray(2, 4)]).toEqual([5, 0])
    client.write('hello')
    expect((await read(client, 5)).toString()).toBe('hello')
    expect(asked).toEqual([['localhost', 3000]])
  })

  it('reads every kind of address, and says what it will not serve', () => {
    expect(parseRequest(Buffer.from([5, 1, 0, 1, 127, 0, 0, 1, 0x0b, 0xb8]))).toEqual({ host: '127.0.0.1', port: 3000, length: 10 })
    const v6 = Buffer.concat([Buffer.from([5, 1, 0, 4]), Buffer.alloc(15), Buffer.from([1, 0, 80])])
    expect(parseRequest(v6)).toEqual({ host: '0:0:0:0:0:0:0:1', port: 80, length: 22 })
    expect(parseRequest(Buffer.from([5, 1, 0, 3, 9, 0x6c]))).toBeNull()
    expect(parseRequest(Buffer.from([5, 2, 0, 1, 0, 0, 0, 0, 0, 0]))).toBe(7)
    expect(parseRequest(Buffer.from([5, 1, 0, 9, 0, 0]))).toBe(8)
  })

  it('refuses a browser that will not go without authentication', async () => {
    const entry = await startSocksEntry(() => {})
    cleanup.push(() => entry.close())
    const client = createConnection({ host: '127.0.0.1', port: entry.port })
    cleanup.push(() => client.destroy())
    client.write(Buffer.from([5, 1, 2]))
    expect([...(await read(client, 2))]).toEqual([5, 0xff])
  })
})
