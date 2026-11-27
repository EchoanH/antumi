import { readFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { inflateSync } from 'node:zlib'

export const MAX_RCEDIT_ICON_ENTRY_BYTES = 0xffff
export const REQUIRED_WINDOWS_ICON_SIZES = [16, 24, 32, 48, 64, 128, 256]

const pngSignature = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])

function crc32(buffer) {
  let crc = 0xffffffff
  for (const byte of buffer) {
    crc ^= byte
    for (let bit = 0; bit < 8; bit++) crc = (crc >>> 1) ^ ((crc & 1) ? 0xedb88320 : 0)
  }
  return (crc ^ 0xffffffff) >>> 0
}

function requireBytes(buffer, offset, length, label) {
  if (offset < 0 || length < 0 || offset + length > buffer.length) {
    throw new Error(`${label}: truncated or out-of-bounds data`)
  }
}

function parseIconPayload(payload, width, height, label, directoryBitCount = 0) {
  if (payload.subarray(0, 8).equals(pngSignature)) {
    requireBytes(payload, 0, 33, `${label} PNG IHDR`)
    if (payload.readUInt32BE(8) !== 13 || payload.toString('ascii', 12, 16) !== 'IHDR') {
      throw new Error(`${label}: invalid PNG IHDR chunk`)
    }
    const ihdrWidth = payload.readUInt32BE(16)
    const ihdrHeight = payload.readUInt32BE(20)
    const pngBitDepth = payload[24]
    const pngColorType = payload[25]
    if (ihdrWidth !== width || ihdrHeight !== height) {
      throw new Error(`${label}: PNG IHDR dimensions ${ihdrWidth}x${ihdrHeight} do not match ${width}x${height}`)
    }
    if (pngBitDepth !== 8 || pngColorType !== 6) {
      throw new Error(`${label}: PNG must be 8-bit RGBA (colorType=6), got depth=${pngBitDepth} colorType=${pngColorType}`)
    }
    const idatChunks = []
    let sawIend = false
    let offset = 8
    while (offset < payload.length) {
      requireBytes(payload, offset, 12, `${label} PNG chunk`)
      const length = payload.readUInt32BE(offset)
      const type = payload.toString('ascii', offset + 4, offset + 8)
      requireBytes(payload, offset, 12 + length, `${label} PNG ${type} chunk`)
      const expectedCrc = payload.readUInt32BE(offset + 8 + length)
      if (crc32(payload.subarray(offset + 4, offset + 8 + length)) !== expectedCrc) {
        throw new Error(`${label}: invalid PNG ${type} CRC`)
      }
      if (type === 'IDAT') idatChunks.push(payload.subarray(offset + 8, offset + 8 + length))
      offset += 12 + length
      if (type === 'IEND') {
        sawIend = true
        break
      }
    }
    if (!idatChunks.length) throw new Error(`${label}: PNG has no IDAT chunk`)
    if (!sawIend || offset !== payload.length) throw new Error(`${label}: PNG is missing a terminating IEND chunk`)
    let scanlines
    try {
      scanlines = inflateSync(Buffer.concat(idatChunks))
    } catch {
      throw new Error(`${label}: PNG IDAT zlib stream is corrupt`)
    }
    const expectedBytes = (width * 4 + 1) * height
    if (scanlines.length !== expectedBytes) {
      throw new Error(`${label}: PNG decoded ${scanlines.length} bytes, expected ${expectedBytes}`)
    }
    return { format: 'png', pngColorType, pngBitDepth }
  }

  requireBytes(payload, 0, 40, `${label} DIB header`)
  const biSize = payload.readUInt32LE(0)
  const biWidth = payload.readInt32LE(4)
  const biHeight = payload.readInt32LE(8)
  const biPlanes = payload.readUInt16LE(12)
  const biBitCount = payload.readUInt16LE(14)
  const biCompression = payload.readUInt32LE(16)
  if (biSize < 40) throw new Error(`${label}: invalid DIB header size ${biSize}`)
  if (biWidth !== width || Math.abs(biHeight) !== height * 2) {
    throw new Error(`${label}: DIB dimensions ${biWidth}x${biHeight} do not match ${width}x${height} with an AND mask`)
  }
  if (biPlanes !== 1 || biCompression !== 0) {
    throw new Error(`${label}: DIB must use biPlanes=1 and BI_RGB (0), got planes=${biPlanes} compression=${biCompression}`)
  }
  if (biBitCount !== 32) throw new Error(`${label}: DIB must be 32bpp, got ${biBitCount}bpp`)
  if (directoryBitCount !== 0 && directoryBitCount !== biBitCount) {
    throw new Error(`${label}: directory bitCount ${directoryBitCount} does not match DIB ${biBitCount}bpp`)
  }
  const bitmapBytes = width * height * (biBitCount / 8)
  const maskStride = Math.ceil(width / 32) * 4
  const maskBytes = maskStride * height
  requireBytes(payload, 0, biSize + bitmapBytes + maskBytes, `${label} DIB pixels and AND mask`)
  const maskOffset = biSize + bitmapBytes
  for (let row = 0; row < height; row++) {
    for (let col = 0; col < width; col++) {
      const alpha = payload[biSize + (row * width + col) * 4 + 3]
      const masked = Boolean(payload[maskOffset + row * maskStride + (col >> 3)] & (0x80 >> (col & 7)))
      if (masked !== (alpha === 0)) {
        throw new Error(`${label}: DIB AND mask disagrees with pixel alpha at (${col}, ${row})`)
      }
    }
  }
  return { format: 'dib', biBitCount }
}

function parseIconHeader(buffer, label) {
  requireBytes(buffer, 0, 6, `${label} header`)
  if (buffer.readUInt16LE(0) !== 0 || buffer.readUInt16LE(2) !== 1) {
    throw new Error(`${label}: expected reserved=0 and type=1`)
  }
  const count = buffer.readUInt16LE(4)
  if (count < 1) throw new Error(`${label}: icon count must be at least 1`)
  return count
}

function parseIconEntry(buffer, offset, index) {
  return {
    index,
    width: buffer[offset] || 256,
    height: buffer[offset + 1] || 256,
    colorCount: buffer[offset + 2],
    planes: buffer.readUInt16LE(offset + 4),
    bitCount: buffer.readUInt16LE(offset + 6),
    bytesInRes: buffer.readUInt32LE(offset + 8)
  }
}

export function parseIco(buffer) {
  const count = parseIconHeader(buffer, 'ICO')
  const directoryBytes = 6 + count * 16
  requireBytes(buffer, 0, directoryBytes, 'ICO directory')
  const entries = []
  for (let index = 0; index < count; index++) {
    const entryOffset = 6 + index * 16
    const entry = parseIconEntry(buffer, entryOffset, index)
    const offset = buffer.readUInt32LE(entryOffset + 12)
    const label = `ICO entry ${index} (${entry.width}x${entry.height})`
    if (offset < directoryBytes) throw new Error(`${label}: payload offset overlaps the ICO directory`)
    if (entry.bytesInRes === 0) throw new Error(`${label}: bytesInRes must be greater than zero`)
    requireBytes(buffer, offset, entry.bytesInRes, label)
    const payload = buffer.subarray(offset, offset + entry.bytesInRes)
    entries.push({ ...entry, offset, payload, ...parseIconPayload(payload, entry.width, entry.height, label, entry.bitCount) })
  }
  return entries
}

function assertIconSizes(entries, requiredSizes, label) {
  const dimensions = new Set()
  for (const entry of entries) {
    const dimension = `${entry.width}x${entry.height}`
    if (dimensions.has(dimension)) throw new Error(`${label}: duplicate icon dimensions ${dimension}`)
    dimensions.add(dimension)
  }
  const missing = requiredSizes.filter((size) => !dimensions.has(`${size}x${size}`))
  if (missing.length) throw new Error(`${label}: missing required icon sizes: ${missing.join(', ')}`)
}

export function assertWindowsIconValid(buffer, {
  requiredSizes = REQUIRED_WINDOWS_ICON_SIZES,
  maxEntryBytes = MAX_RCEDIT_ICON_ENTRY_BYTES
} = {}) {
  const entries = parseIco(buffer)
  for (const entry of entries) {
    if (entry.bytesInRes > maxEntryBytes) {
      throw new Error(`ICO entry ${entry.index} (${entry.width}x${entry.height}): ${entry.bytesInRes} bytes exceeds ${maxEntryBytes}; app-builder rcedit's 16-bit dwBytesInRes truncation limit is ${MAX_RCEDIT_ICON_ENTRY_BYTES} bytes`)
    }
  }
  assertIconSizes(entries, requiredSizes, 'ICO')
  return entries
}

// Resource IDs and language IDs stay separate: localized groups can reuse the same icon ID.
export function parsePeIconResources(exeBuffer) {
  requireBytes(exeBuffer, 0, 64, 'PE DOS header')
  if (exeBuffer.toString('ascii', 0, 2) !== 'MZ') throw new Error('PE: missing MZ signature')
  const peOffset = exeBuffer.readUInt32LE(0x3c)
  requireBytes(exeBuffer, peOffset, 24, 'PE header')
  if (exeBuffer.toString('ascii', peOffset, peOffset + 4) !== 'PE\0\0') {
    throw new Error('PE: missing PE signature')
  }
  const sectionCount = exeBuffer.readUInt16LE(peOffset + 6)
  const optionalSize = exeBuffer.readUInt16LE(peOffset + 20)
  const optionalOffset = peOffset + 24
  requireBytes(exeBuffer, optionalOffset, optionalSize, 'PE optional header')
  const optional = exeBuffer.subarray(optionalOffset, optionalOffset + optionalSize)
  requireBytes(optional, 0, 2, 'PE optional header magic')
  const magic = optional.readUInt16LE(0)
  if (magic !== 0x10b && magic !== 0x20b) throw new Error('PE: expected PE32 or PE32+ optional header')
  const directoryOffset = magic === 0x20b ? 112 : 96
  requireBytes(optional, 0, directoryOffset, 'PE data directory count')
  const sectionOffset = optionalOffset + optionalSize
  requireBytes(exeBuffer, sectionOffset, sectionCount * 40, 'PE section table')
  const sections = []
  for (let index = 0; index < sectionCount; index++) {
    const offset = sectionOffset + index * 40
    sections.push({
      rva: exeBuffer.readUInt32LE(offset + 12),
      rawSize: exeBuffer.readUInt32LE(offset + 16),
      rawOffset: exeBuffer.readUInt32LE(offset + 20)
    })
  }

  function rvaToOffset(rva, length) {
    const section = sections.find((candidate) => rva >= candidate.rva && rva - candidate.rva + length <= candidate.rawSize)
    if (!section) throw new Error(`PE resource RVA ${rva}: outside section raw data`)
    const offset = section.rawOffset + rva - section.rva
    requireBytes(exeBuffer, offset, length, 'PE resource payload')
    return offset
  }

  const groups = []
  const icons = []
  if (optional.readUInt32LE(directoryOffset - 4) <= 2) return { groups, icons }
  requireBytes(optional, directoryOffset + 16, 8, 'PE resource data directory')
  const resourceRva = optional.readUInt32LE(directoryOffset + 16)
  const resourceSize = optional.readUInt32LE(directoryOffset + 20)
  if (resourceRva === 0 || resourceSize === 0) return { groups, icons }
  const resourceOffset = rvaToOffset(resourceRva, resourceSize)
  const resources = exeBuffer.subarray(resourceOffset, resourceOffset + resourceSize)

  function readDirectory(offset) {
    requireBytes(resources, offset, 16, 'PE resource directory')
    const count = resources.readUInt16LE(offset + 12) + resources.readUInt16LE(offset + 14)
    requireBytes(resources, offset + 16, count * 8, 'PE resource directory entries')
    const entries = []
    for (let index = 0; index < count; index++) {
      const entryOffset = offset + 16 + index * 8
      const name = resources.readUInt32LE(entryOffset)
      let id = name
      if (name & 0x80000000) {
        const nameOffset = name & 0x7fffffff
        requireBytes(resources, nameOffset, 2, 'PE resource name')
        const nameBytes = resources.readUInt16LE(nameOffset) * 2
        requireBytes(resources, nameOffset + 2, nameBytes, 'PE resource name')
        id = resources.toString('utf16le', nameOffset + 2, nameOffset + 2 + nameBytes)
      }
      const target = resources.readUInt32LE(entryOffset + 4)
      entries.push({ id, offset: target & 0x7fffffff, directory: Boolean(target & 0x80000000) })
    }
    return entries
  }

  for (const type of readDirectory(0)) {
    if (type.id !== 3 && type.id !== 14) continue
    if (!type.directory) throw new Error(`PE resource type ${type.id}: expected a directory`)
    for (const name of readDirectory(type.offset)) {
      if (!name.directory) throw new Error(`PE resource ${name.id}: expected a language directory`)
      for (const language of readDirectory(name.offset)) {
        if (language.directory) throw new Error(`PE resource ${name.id}: expected a data entry`)
        requireBytes(resources, language.offset, 16, 'PE resource data entry')
        const rva = resources.readUInt32LE(language.offset)
        const length = resources.readUInt32LE(language.offset + 4)
        const offset = rvaToOffset(rva, length)
        const payload = exeBuffer.subarray(offset, offset + length)
        if (type.id === 3) {
          icons.push({ id: name.id, language: language.id, payload })
          continue
        }
        const label = `PE RT_GROUP_ICON ${name.id}`
        const count = parseIconHeader(payload, label)
        requireBytes(payload, 0, 6 + count * 14, `${label} entries`)
        const entries = []
        for (let index = 0; index < count; index++) {
          const entryOffset = 6 + index * 14
          entries.push({ ...parseIconEntry(payload, entryOffset, index), nID: payload.readUInt16LE(entryOffset + 12) })
        }
        groups.push({ id: name.id, language: language.id, entries })
      }
    }
  }
  return { groups, icons }
}

export function assertPeIconResourcesValid(exeBuffer, { requiredSizes = REQUIRED_WINDOWS_ICON_SIZES } = {}) {
  const summary = parsePeIconResources(exeBuffer)
  const primary = summary.groups[0]
  if (!primary) throw new Error('PE: no RT_GROUP_ICON resource found')
  for (const entry of primary.entries) {
    const candidates = summary.icons.filter((icon) => icon.id === entry.nID)
    const icon = candidates.find((candidate) => candidate.language === primary.language)
      ?? candidates.find((candidate) => candidate.language === 0)
      ?? candidates[0]
    const label = `PE RT_GROUP_ICON ${primary.id} entry ${entry.index} (${entry.width}x${entry.height}), RT_ICON ${entry.nID}`
    if (!icon) throw new Error(`${label}: referenced RT_ICON is missing`)
    if (entry.bytesInRes !== icon.payload.length) {
      throw new Error(`${label}: dwBytesInRes mismatch: group declares ${entry.bytesInRes} bytes, RT_ICON contains ${icon.payload.length} bytes; possible 16-bit dwBytesInRes truncation`)
    }
    parseIconPayload(icon.payload, entry.width, entry.height, label, entry.bitCount)
  }
  assertIconSizes(primary.entries, requiredSizes, 'PE primary RT_GROUP_ICON')
  return summary
}

const invoked = process.argv[1] ? path.resolve(process.argv[1]) : ''
const current = fileURLToPath(import.meta.url)
if (process.platform === 'win32' ? current.toLowerCase() === invoked.toLowerCase() : current === invoked) {
  try {
    const filename = process.argv[2]
    if (!filename) throw new Error('Usage: node windows-icon-integrity.mjs <icon.ico|app.exe>')
    const extension = path.extname(filename).toLowerCase()
    if (extension !== '.ico' && extension !== '.exe') throw new Error('Expected an .ico or .exe file')
    const buffer = readFileSync(filename)
    const entries = extension === '.ico'
      ? assertWindowsIconValid(buffer)
      : assertPeIconResourcesValid(buffer).groups[0].entries
    console.log(`OK: ${filename}: ${entries.map((entry) => `${entry.width}x${entry.height}`).join(', ')}`)
  } catch (error) {
    console.error(error.message)
    process.exitCode = 1
  }
}
