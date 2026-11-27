import { readFileSync } from 'node:fs'
import { deflateSync } from 'node:zlib'
import { describe, expect, it } from 'vitest'
import {
  MAX_RCEDIT_ICON_ENTRY_BYTES,
  REQUIRED_WINDOWS_ICON_SIZES,
  assertPeIconResourcesValid,
  assertWindowsIconValid,
  parseIco,
  parsePeIconResources
} from './windows-icon-integrity.mjs'

function pngChunk(type, data) {
  const chunk = Buffer.alloc(data.length + 12)
  chunk.writeUInt32BE(data.length, 0)
  chunk.write(type, 4, 'ascii')
  data.copy(chunk, 8)
  let crc = 0xffffffff
  for (const byte of chunk.subarray(4, -4)) {
    crc ^= byte
    for (let bit = 0; bit < 8; bit++) crc = (crc >>> 1) ^ ((crc & 1) ? 0xedb88320 : 0)
  }
  chunk.writeUInt32BE((crc ^ 0xffffffff) >>> 0, chunk.length - 4)
  return chunk
}

function png(size, byteLength) {
  const header = Buffer.alloc(13)
  header.writeUInt32BE(size, 0)
  header.writeUInt32BE(size, 4)
  header[8] = 8
  header[9] = 6
  const chunks = [pngChunk('IHDR', header), pngChunk('IDAT', deflateSync(Buffer.alloc((size * 4 + 1) * size)))]
  if (byteLength !== undefined) {
    // An ancillary chunk keeps oversized regression fixtures valid PNGs, including their CRCs.
    const padding = byteLength - 8 - chunks.reduce((sum, chunk) => sum + chunk.length, 0) - 24
    chunks.push(pngChunk('tEXt', Buffer.concat([Buffer.from('padding\0'), Buffer.alloc(padding - 8, 0x78)])))
  }
  return Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), ...chunks, pngChunk('IEND', Buffer.alloc(0))])
}

function dib(size) {
  const bitmapBytes = size * size * 4
  const maskStride = Math.ceil(size / 32) * 4
  const payload = Buffer.alloc(40 + bitmapBytes + maskStride * size)
  payload.writeUInt32LE(40, 0)
  payload.writeInt32LE(size, 4)
  payload.writeInt32LE(size * 2, 8)
  payload.writeUInt16LE(1, 12)
  payload.writeUInt16LE(32, 14)
  // Fill opaque alpha so the zeroed AND mask matches every pixel.
  for (let i = 3; i < bitmapBytes; i += 4) payload[40 + i] = 255
  return payload
}

const frame = (size, payload = size <= 64 ? dib(size) : png(size)) => ({ width: size, height: size, payload })
const frames = () => REQUIRED_WINDOWS_ICON_SIZES.map((size) => frame(size))

function writeEntry(buffer, offset, entry) {
  buffer[offset] = entry.width === 256 ? 0 : entry.width
  buffer[offset + 1] = entry.height === 256 ? 0 : entry.height
  buffer.writeUInt16LE(1, offset + 4)
  buffer.writeUInt16LE(32, offset + 6)
  buffer.writeUInt32LE(entry.bytesInRes ?? entry.payload.length, offset + 8)
}

function ico(entries) {
  const directory = Buffer.alloc(6 + entries.length * 16)
  directory.writeUInt16LE(1, 2)
  directory.writeUInt16LE(entries.length, 4)
  let offset = directory.length
  for (const [index, entry] of entries.entries()) {
    writeEntry(directory, 6 + index * 16, entry)
    directory.writeUInt32LE(offset, 18 + index * 16)
    offset += entry.payload.length
  }
  return Buffer.concat([directory, ...entries.map((entry) => entry.payload)])
}

function pe(entries, {
  pe32 = false,
  includeGroup = true,
  groupName = 1,
  namedType = false,
  language = 1033,
  iconLanguage = language,
  resourcePrefix = 0
} = {}) {
  const sectionRva = 0x1000
  const resourceRva = sectionRva + resourcePrefix
  const chunks = []
  let length = 0
  function append(buffer) {
    const padding = (4 - length % 4) % 4
    chunks.push(Buffer.alloc(padding), buffer)
    const offset = length + padding
    length = offset + buffer.length
    return offset
  }
  function directory(nodes) {
    const named = nodes.filter((node) => typeof node.id === 'string')
    const numeric = nodes.filter((node) => typeof node.id === 'number')
    const buffer = Buffer.alloc(16 + nodes.length * 8)
    const offset = append(buffer)
    buffer.writeUInt16LE(named.length, 12)
    buffer.writeUInt16LE(numeric.length, 14)
    for (const [index, node] of [...named, ...numeric].entries()) {
      let id = node.id
      if (typeof id === 'string') {
        const name = Buffer.from(id, 'utf16le')
        const buffer = Buffer.alloc(2 + name.length)
        buffer.writeUInt16LE(name.length / 2, 0)
        name.copy(buffer, 2)
        id = (append(buffer) | 0x80000000) >>> 0
      }
      buffer.writeUInt32LE(id, 16 + index * 8)
      let target
      if (node.children) {
        target = (directory(node.children) | 0x80000000) >>> 0
      } else {
        const data = Buffer.alloc(16)
        target = append(data)
        data.writeUInt32LE(resourceRva + append(node.payload), 0)
        data.writeUInt32LE(node.payload.length, 4)
      }
      buffer.writeUInt32LE(target, 20 + index * 8)
    }
    return offset
  }

  const group = Buffer.alloc(6 + entries.length * 14)
  group.writeUInt16LE(1, 2)
  group.writeUInt16LE(entries.length, 4)
  for (const [index, entry] of entries.entries()) {
    writeEntry(group, 6 + index * 14, entry)
    group.writeUInt16LE(entry.nID ?? index + 1, 18 + index * 14)
  }
  const types = [{
    id: 3,
    children: entries.map((entry, index) => ({ id: index + 1, children: [{ id: iconLanguage, payload: entry.payload }] }))
  }]
  if (includeGroup) types.push({ id: 14, children: [{ id: groupName, children: [{ id: language, payload: group }] }] })
  if (namedType) types.push({ id: 'CUSTOM', children: [] })
  directory(types)
  const resources = Buffer.concat(chunks)
  const headers = Buffer.alloc(0x200)
  headers.write('MZ', 0, 'ascii')
  headers.writeUInt32LE(0x80, 0x3c)
  headers.write('PE\0\0', 0x80, 'ascii')
  headers.writeUInt16LE(pe32 ? 0x14c : 0x8664, 0x84)
  headers.writeUInt16LE(1, 0x86)
  const optionalSize = pe32 ? 0xe0 : 0xf0
  headers.writeUInt16LE(optionalSize, 0x94)
  headers.writeUInt16LE(pe32 ? 0x10b : 0x20b, 0x98)
  const dataDirectory = 0x98 + (pe32 ? 96 : 112)
  headers.writeUInt32LE(16, dataDirectory - 4)
  headers.writeUInt32LE(resourceRva, dataDirectory + 16)
  headers.writeUInt32LE(resources.length, dataDirectory + 20)
  const section = 0x98 + optionalSize
  headers.write('.rsrc', section, 'ascii')
  headers.writeUInt32LE(resourcePrefix + resources.length, section + 8)
  headers.writeUInt32LE(sectionRva, section + 12)
  headers.writeUInt32LE(resourcePrefix + resources.length, section + 16)
  headers.writeUInt32LE(headers.length, section + 20)
  return Buffer.concat([headers, Buffer.alloc(resourcePrefix), resources])
}

describe('Windows icon integrity', () => {
  it('uses the prebuilt ICO on Windows and keeps the PNG on Linux', () => {
    const config = readFileSync(new URL('../electron-builder.yml', import.meta.url), 'utf8')
    const windows = config.match(/^win:\r?\n((?:[ \t].*\r?\n|#.*\r?\n|\r?\n)*)/m)?.[1]
    const linux = config.match(/^linux:\r?\n((?:[ \t].*\r?\n|#.*\r?\n|\r?\n)*)/m)?.[1]
    expect(windows).toMatch(/^  icon: build\/icon-win\.ico\r?$/m)
    expect(linux).toMatch(/^  icon: build\/icon-win\.png\r?$/m)
  })

  it('ships all seven sizes below the rcedit truncation limit', () => {
    const entries = assertWindowsIconValid(readFileSync(new URL('../build/icon-win.ico', import.meta.url)))
    expect(MAX_RCEDIT_ICON_ENTRY_BYTES).toBe(65535)
    expect(REQUIRED_WINDOWS_ICON_SIZES).toEqual([16, 24, 32, 48, 64, 128, 256])
    expect(entries.map((entry) => entry.width).sort((a, b) => a - b)).toEqual(REQUIRED_WINDOWS_ICON_SIZES)
    expect(entries.every((entry) => entry.bytesInRes <= 65535)).toBe(true)
    expect(entries.every((entry) => entry.width === entry.height)).toBe(true)
  })

  it('parses DIB and RGBA PNG metadata, including the 256px zero encoding', () => {
    const entries = parseIco(ico([frame(16), frame(256)]))
    expect(entries[0]).toMatchObject({ index: 0, width: 16, height: 16, colorCount: 0, planes: 1, bitCount: 32, format: 'dib', biBitCount: 32 })
    expect(entries[1]).toMatchObject({ index: 1, width: 256, height: 256, format: 'png', pngColorType: 6, pngBitDepth: 8 })
    expect(entries[1].payload.length).toBe(entries[1].bytesInRes)
  })

  it('rejects a 65536-byte frame with the explicit 16-bit truncation warning', () => {
    const buffer = ico([frame(256, png(256, 65536))])
    expect(() => assertWindowsIconValid(buffer)).toThrow(/65536.*65535.*16-bit dwBytesInRes truncation/)
  })

  it('accepts exactly 65535 bytes and supports explicit size and byte limits', () => {
    const buffer = ico([frame(256, png(256, 65535))])
    expect(assertWindowsIconValid(buffer, { requiredSizes: [256] })).toHaveLength(1)
    expect(() => assertWindowsIconValid(buffer, { requiredSizes: [256], maxEntryBytes: 65534 })).toThrow('exceeds 65534')
  })

  it('rejects a single 256px frame missing the smaller required sizes', () => {
    expect(() => assertWindowsIconValid(ico([frame(256)]))).toThrow('missing required icon sizes: 16, 24, 32, 48, 64, 128')
  })

  it('rejects duplicate dimensions', () => {
    expect(() => assertWindowsIconValid(ico([frame(16), frame(16)]), { requiredSizes: [16] })).toThrow('duplicate icon dimensions 16x16')
  })

  it.each([
    ['short header', Buffer.alloc(5), 'ICO header'],
    ['empty directory', Buffer.from([0, 0, 1, 0, 0, 0]), 'icon count'],
    ['wrong type', Buffer.from([0, 0, 2, 0, 1, 0]), 'reserved=0 and type=1'],
    ['reserved field', Buffer.from([1, 0, 1, 0, 1, 0]), 'reserved=0 and type=1'],
    ['short directory', Buffer.from([0, 0, 1, 0, 1, 0]), 'ICO directory']
  ])('rejects an ICO with %s', (_name, buffer, message) => {
    expect(() => parseIco(buffer)).toThrow(message)
  })

  it.each([
    ['overlapping offset', (buffer) => buffer.writeUInt32LE(6, 18), 'overlaps'],
    ['empty payload', (buffer) => buffer.writeUInt32LE(0, 14), 'greater than zero'],
    ['out-of-bounds payload', (buffer) => buffer.writeUInt32LE(buffer.length, 18), 'out-of-bounds']
  ])('rejects an ICO with %s', (_name, corrupt, message) => {
    const buffer = ico([frame(16)])
    corrupt(buffer)
    expect(() => parseIco(buffer)).toThrow(message)
  })

  it.each([
    ['short header', () => dib(16).subarray(0, 20), 'DIB header'],
    ['short pixels or mask', () => dib(16).subarray(0, -1), 'DIB pixels and AND mask'],
    ['short declared header', () => { const payload = dib(16); payload.writeUInt32LE(12, 0); return payload }, 'DIB header size'],
    ['wrong dimensions', () => dib(24), 'DIB dimensions'],
    ['invalid planes', () => { const payload = dib(16); payload.writeUInt16LE(2, 12); return payload }, 'biPlanes=1'],
    ['invalid compression', () => { const payload = dib(16); payload.writeUInt32LE(3, 16); return payload }, 'BI_RGB'],
    ['wrong bit depth', () => { const payload = dib(16); payload.writeUInt16LE(24, 14); return payload }, '32bpp'],
    ['mismatched AND mask', () => { const payload = dib(16); payload[40 + 16 * 16 * 4] = 0x80; return payload }, 'AND mask disagrees']
  ])('rejects a DIB with %s', (_name, payload, message) => {
    expect(() => assertWindowsIconValid(ico([frame(16, payload())]), { requiredSizes: [16] })).toThrow(message)
  })

  it('rejects a directory bitCount disagreeing with a 32bpp DIB payload', () => {
    const buffer = ico([frame(16)])
    buffer.writeUInt16LE(24, 12)
    expect(() => assertWindowsIconValid(buffer, { requiredSizes: [16] })).toThrow('directory bitCount 24 does not match DIB 32bpp')
  })

  it.each([
    ['short IHDR', () => png(16).subarray(0, 24), 'PNG IHDR'],
    ['wrong chunk type', () => { const payload = png(16); payload.write('IDAT', 12); return payload }, 'invalid PNG IHDR'],
    ['wrong IHDR length', () => { const payload = png(16); payload.writeUInt32BE(12, 8); return payload }, 'invalid PNG IHDR'],
    ['wrong dimensions', () => png(24), 'PNG IHDR dimensions 24x24 do not match 16x16'],
    ['non-RGBA format', () => { const payload = png(16); payload[25] = 2; return payload }, '8-bit RGBA'],
    ['broken CRC', () => { const payload = png(16); payload[29] ^= 0xff; return payload }, 'invalid PNG IHDR CRC'],
    ['missing IDAT and IEND', () => png(16).subarray(0, 33), 'PNG has no IDAT chunk'],
    ['corrupt IDAT zlib', () => { const payload = png(16); const header = Buffer.alloc(13); header.writeUInt32BE(16, 0); header.writeUInt32BE(16, 4); header[8] = 8; header[9] = 6; return Buffer.concat([payload.subarray(0, 8), pngChunk('IHDR', header), pngChunk('IDAT', Buffer.from([1, 2, 3])), pngChunk('IEND', Buffer.alloc(0))]) }, 'IDAT zlib stream is corrupt']
  ])('rejects a PNG with %s', (_name, payload, message) => {
    expect(() => assertWindowsIconValid(ico([frame(16, payload())]), { requiredSizes: [16] })).toThrow(message)
  })
})

describe('Windows PE icon resources', () => {
  it.each([false, true])('accepts matching group and icon lengths (PE32: %s)', (pe32) => {
    const summary = assertPeIconResourcesValid(pe(frames(), { pe32 }))
    expect(summary.groups).toHaveLength(1)
    expect(summary.icons).toHaveLength(7)
    expect(summary.groups[0].entries.map((entry) => entry.width)).toEqual(REQUIRED_WINDOWS_ICON_SIZES)
    for (const entry of summary.groups[0].entries) {
      expect(entry.bytesInRes).toBe(summary.icons.find((icon) => icon.id === entry.nID).payload.length)
    }
  })

  it('accepts a full 86182-byte RT_ICON when the group records its actual length', () => {
    const entries = frames()
    entries[6] = frame(256, png(256, 86182))
    const summary = assertPeIconResourcesValid(pe(entries))
    expect(summary.icons[6].payload.length).toBe(86182)
    expect(summary.groups[0].entries[6].bytesInRes).toBe(86182)
  })

  it('rejects the rcedit regression: 86182 bytes truncated to 20646 in dwBytesInRes', () => {
    const entries = frames()
    entries[6] = { ...frame(256, png(256, 86182)), bytesInRes: 86182 & 0xffff }
    expect(() => assertPeIconResourcesValid(pe(entries))).toThrow(/dwBytesInRes mismatch: group declares 20646 bytes, RT_ICON contains 86182 bytes.*16-bit/)
  })

  it('handles named resources and a resource root after the start of the section', () => {
    const summary = assertPeIconResourcesValid(pe(frames(), { groupName: 'MAIN', namedType: true, language: 'English', resourcePrefix: 32 }))
    expect(summary.groups[0]).toMatchObject({ id: 'MAIN', language: 'English' })
  })

  it('can resolve a neutral-language icon for a localized group', () => {
    expect(() => assertPeIconResourcesValid(pe(frames(), { iconLanguage: 0 }))).not.toThrow()
  })

  it('rejects a missing group icon', () => {
    const buffer = pe(frames(), { includeGroup: false })
    expect(parsePeIconResources(buffer).groups).toEqual([])
    expect(() => assertPeIconResourcesValid(buffer)).toThrow('no RT_GROUP_ICON')
  })

  it('rejects a missing referenced icon ID', () => {
    expect(() => assertPeIconResourcesValid(pe([{ ...frame(16), nID: 99 }]), { requiredSizes: [16] })).toThrow('RT_ICON 99: referenced RT_ICON is missing')
  })

  it('rejects missing required sizes', () => {
    expect(() => assertPeIconResourcesValid(pe([frame(256)]))).toThrow('missing required icon sizes: 16, 24, 32, 48, 64, 128')
  })

  it.each([
    ['PNG dimensions', png(24), 'PNG IHDR dimensions'],
    ['DIB dimensions', dib(24), 'DIB dimensions'],
    ['truncated DIB', dib(16).subarray(0, -1), 'DIB pixels and AND mask']
  ])('rejects invalid RT_ICON payloads: %s', (_name, payload, message) => {
    expect(() => assertPeIconResourcesValid(pe([frame(16, payload)]), { requiredSizes: [16] })).toThrow(message)
  })

  it.each([
    ['DOS header', (buffer) => buffer.fill(0, 0, 2), 'MZ signature'],
    ['PE header offset', (buffer) => buffer.writeUInt32LE(buffer.length, 0x3c), 'PE header'],
    ['optional header', (buffer) => buffer.writeUInt16LE(0xffff, 0x94), 'optional header'],
    ['resource RVA', (buffer) => buffer.writeUInt32LE(0x7fffffff, 0x118), 'outside section raw data'],
    ['resource directory offset', (buffer) => buffer.writeUInt32LE(0xffffffff, 0x214), 'resource directory'],
    ['resource name offset', (buffer) => buffer.writeUInt32LE(0xffffffff, 0x210), 'resource name'],
    ['resource data entry offset', (buffer) => {
      const type = buffer.readUInt32LE(0x214) & 0x7fffffff
      const name = buffer.readUInt32LE(0x200 + type + 20) & 0x7fffffff
      buffer.writeUInt32LE(0x7fffffff, 0x200 + name + 20)
    }, 'resource data entry']
  ])('bounds-checks a corrupt %s', (_name, corrupt, message) => {
    const buffer = pe([frame(16)])
    corrupt(buffer)
    expect(() => parsePeIconResources(buffer)).toThrow(message)
  })

  it('rejects a truncated resource section', () => {
    const buffer = pe(frames()).subarray(0, -1)
    expect(() => parsePeIconResources(buffer)).toThrow('PE resource payload: truncated or out-of-bounds')
  })
})
