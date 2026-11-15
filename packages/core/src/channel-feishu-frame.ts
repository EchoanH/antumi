// The one message Feishu's long connection carries (pbbp2.Frame in its SDKs), read and written by
// hand: nine fields of protobuf are less than a protobuf library. SeqID and LogID are uint64 and go
// back unchanged in the acknowledgement, so they are kept as bigints.

export type FeishuFrame = {
  seqId: bigint
  logId: bigint
  service: number
  // 0: control (ping, pong) · 1: data (an event)
  method: number
  headers: { key: string; value: string }[]
  payloadEncoding?: string
  payloadType?: string
  payload?: Uint8Array
  logIdNew?: string
}

export const FRAME_CONTROL = 0
export const FRAME_DATA = 1

export function frameHeader(frame: FeishuFrame, key: string): string | undefined {
  return frame.headers.find((header) => header.key === key)?.value
}

class Reader {
  private at = 0
  constructor(private readonly bytes: Uint8Array) {}

  get done(): boolean {
    return this.at >= this.bytes.length
  }

  varint(): bigint {
    let value = 0n
    for (let shift = 0n; shift < 70n; shift += 7n) {
      const byte = this.bytes[this.at++]
      if (byte === undefined) throw new Error('frame ends inside a number')
      value |= BigInt(byte & 0x7f) << shift
      if (byte < 0x80) return value
    }
    throw new Error('number too long')
  }

  chunk(): Uint8Array {
    const length = Number(this.varint())
    if (this.at + length > this.bytes.length) throw new Error('frame ends inside a field')
    const out = this.bytes.subarray(this.at, this.at + length)
    this.at += length
    return out
  }

  skip(wire: number): void {
    if (wire === 0) this.varint()
    else if (wire === 2) this.chunk()
    else if (wire === 1) this.at += 8
    else if (wire === 5) this.at += 4
    else throw new Error(`unknown wire type ${wire}`)
  }
}

const text = new TextDecoder()

function readHeader(bytes: Uint8Array): { key: string; value: string } {
  const reader = new Reader(bytes)
  const header = { key: '', value: '' }
  while (!reader.done) {
    const tag = Number(reader.varint())
    if (tag === 10) header.key = text.decode(reader.chunk())
    else if (tag === 18) header.value = text.decode(reader.chunk())
    else reader.skip(tag & 7)
  }
  return header
}

export function decodeFrame(bytes: Uint8Array): FeishuFrame {
  const reader = new Reader(bytes)
  const frame: FeishuFrame = { seqId: 0n, logId: 0n, service: 0, method: 0, headers: [] }
  while (!reader.done) {
    const tag = Number(reader.varint())
    switch (tag) {
      case 8: frame.seqId = reader.varint(); break
      case 16: frame.logId = reader.varint(); break
      case 24: frame.service = Number(BigInt.asIntN(32, reader.varint())); break
      case 32: frame.method = Number(BigInt.asIntN(32, reader.varint())); break
      case 42: frame.headers.push(readHeader(reader.chunk())); break
      case 50: frame.payloadEncoding = text.decode(reader.chunk()); break
      case 58: frame.payloadType = text.decode(reader.chunk()); break
      case 66: frame.payload = reader.chunk(); break
      case 74: frame.logIdNew = text.decode(reader.chunk()); break
      default: reader.skip(tag & 7)
    }
  }
  return frame
}

const utf8 = new TextEncoder()

function varint(value: bigint): number[] {
  // A negative int32 goes as its 64-bit two's complement, as protobuf writes it.
  let rest = BigInt.asUintN(64, value)
  const out: number[] = []
  while (rest >= 0x80n) {
    out.push(Number(rest & 0x7fn) | 0x80)
    rest >>= 7n
  }
  out.push(Number(rest))
  return out
}

function field(tag: number, bytes: Uint8Array): number[] {
  return [...varint(BigInt(tag)), ...varint(BigInt(bytes.length)), ...bytes]
}

export function encodeFrame(frame: FeishuFrame): Uint8Array {
  const out: number[] = [
    ...varint(8n), ...varint(frame.seqId),
    ...varint(16n), ...varint(frame.logId),
    ...varint(24n), ...varint(BigInt(frame.service)),
    ...varint(32n), ...varint(BigInt(frame.method))
  ]
  for (const header of frame.headers) out.push(...field(42, Uint8Array.from([...field(10, utf8.encode(header.key)), ...field(18, utf8.encode(header.value))])))
  if (frame.payloadEncoding !== undefined) out.push(...field(50, utf8.encode(frame.payloadEncoding)))
  if (frame.payloadType !== undefined) out.push(...field(58, utf8.encode(frame.payloadType)))
  if (frame.payload !== undefined) out.push(...field(66, frame.payload))
  if (frame.logIdNew !== undefined) out.push(...field(74, utf8.encode(frame.logIdNew)))
  return Uint8Array.from(out)
}
