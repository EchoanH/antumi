import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { lstat, mkdir, mkdtemp, readFile, readdir, rm, symlink, truncate, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { detectWallpaperExtension, MAX_WALLPAPER_BYTES, WallpaperAsset, WALLPAPER_MIME, wallpaperUrl, type WallpaperExtension } from '../shared/wallpaper'
import { WallpaperStore } from './wallpaper-store'

vi.mock('node:fs/promises', async (importOriginal) => ({ ...await importOriginal<typeof import('node:fs/promises')>() }))

const png = Uint8Array.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 0, 0, 0, 0, 0])
const jpg = Uint8Array.from([0xff, 0xd8, 0xff, 0xe0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0])
const ascii = (text: string) => new TextEncoder().encode(text)
function avif(major = 'avif', compatible = 'mif1', size = 24): Uint8Array {
  const bytes = new Uint8Array(24)
  new DataView(bytes.buffer).setUint32(0, size)
  bytes.set(ascii('ftyp'), 4)
  bytes.set(ascii(major), 8)
  bytes.set(ascii(compatible), 16)
  return bytes
}
const images: [WallpaperExtension, Uint8Array][] = [
  ['png', png], ['jpg', jpg], ['webp', ascii('RIFF0000WEBP0000')], ['gif', ascii('GIF89a0000000000')], ['avif', avif()]
]

describe('wallpaper magic bytes', () => {
  it.each(images)('identifies %s by bytes rather than a filename', (ext, bytes) => {
    expect(detectWallpaperExtension(bytes)).toBe(ext)
  })
  it('accepts GIF87a and AVIF sequences and compatible brands', () => {
    expect(detectWallpaperExtension(ascii('GIF87a0000000000'))).toBe('gif')
    expect(detectWallpaperExtension(avif('avis'))).toBe('avif')
    expect(detectWallpaperExtension(avif('mif1', 'avif'))).toBe('avif')
    expect(detectWallpaperExtension(avif('mif1', 'avis'))).toBe('avif')
    const padded = new Uint8Array(32)
    padded.set(avif(), 4)
    expect(detectWallpaperExtension(padded.subarray(4, 28))).toBe('avif')
  })
  it('bounds AVIF brand reads to the box, available bytes and 64 bytes', () => {
    expect(detectWallpaperExtension(avif('avif', 'mif1', 12))).toBeNull()
    expect(detectWallpaperExtension(avif('mif1', 'avif', 16))).toBeNull()
    expect(detectWallpaperExtension(avif('mif1', 'avif').subarray(0, 19))).toBeNull()
    const bytes = new Uint8Array(80)
    bytes.set(avif('mif1', 'mif1', 80))
    bytes.set(ascii('avif'), 64)
    expect(detectWallpaperExtension(bytes)).toBeNull()
    bytes.set(ascii('avis'), 60)
    expect(detectWallpaperExtension(bytes)).toBe('avif')
  })
  it('rejects short, mismatched, and non-raster content', () => {
    for (const bytes of [new Uint8Array(), png.subarray(0, 11), ascii('<svg>vector</svg>'), ascii('<html>hello</html>'), ascii('BM00000000000000'), ascii('RIFF0000WAVE0000'), avif('heic', 'mif1')]) {
      expect(detectWallpaperExtension(bytes)).toBeNull()
    }
  })
  it('validates asset metadata and escapes only the cache version in its URL', () => {
    const asset = { ext: 'png' as const, version: '1 &?#/雪', size: png.length }
    expect(WallpaperAsset.safeParse(asset).success).toBe(true)
    expect(wallpaperUrl(asset)).toBe('antumi-wallpaper://current/image?v=1%20%26%3F%23%2F%E9%9B%AA')
    for (const patch of [{ ext: 'svg' }, { version: '' }, { version: 'x'.repeat(81) }, { size: 0 }, { size: MAX_WALLPAPER_BYTES + 1 }]) {
      expect(WallpaperAsset.safeParse({ ...asset, ...patch }).success).toBe(false)
    }
  })
})

describe('wallpaper store', () => {
  let dir: string
  let store: WallpaperStore
  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'antumi-wallpaper-'))
    store = new WallpaperStore(join(dir, 'wallpaper'))
  })
  afterEach(async () => {
    vi.restoreAllMocks()
    await rm(dir, { recursive: true, force: true })
  })

  it('starts empty and keeps controlled filenames and restart-stable metadata', async () => {
    expect(await store.getState()).toBeNull()
    for (const [ext, bytes] of images) {
      const result = await store.setFromBytes(bytes)
      expect(result.ok).toBe(true)
      if (!result.ok) throw new Error(result.reason)
      expect(result.wallpaper).toMatchObject({ ext, size: bytes.length })
      expect(await new WallpaperStore(join(dir, 'wallpaper')).getState()).toEqual(result.wallpaper)
      expect(await readdir(join(dir, 'wallpaper'))).toEqual([`current.${ext}`])
      expect(new Uint8Array(await readFile(join(dir, 'wallpaper', `current.${ext}`)))).toEqual(bytes)
    }
    await store.clear()
    await store.clear()
    expect(await store.getState()).toBeNull()
    expect(await readdir(join(dir, 'wallpaper'))).toEqual([])
  })

  it('reads local files by their magic bytes, including ordinary picked symlinks', async (context) => {
    const photo = join(dir, 'photo.svg')
    await writeFile(photo, jpg)
    expect(await store.setFromFile(photo)).toMatchObject({ ok: true, wallpaper: { ext: 'jpg' } })
    const link = join(dir, 'picked.jpg')
    try { await symlink(photo, link, 'file') } catch (error) {
      if (error instanceof Error && 'code' in error && error.code === 'EPERM') context.skip()
      throw error
    }
    expect(await store.setFromFile(link)).toMatchObject({ ok: true, wallpaper: { ext: 'jpg' } })
  })

  it('rejects invalid paths, directories, empty files and read failures', async () => {
    for (const path of ['', 'relative.png', join(dir, 'bad\0.png'), dir]) expect(await store.setFromFile(path)).toEqual({ ok: false, reason: 'invalid-file' })
    const empty = join(dir, 'empty.png')
    await writeFile(empty, '')
    expect(await store.setFromFile(empty)).toEqual({ ok: false, reason: 'invalid-file' })
    expect(await store.setFromFile(join(dir, 'missing.png'))).toEqual({ ok: false, reason: 'read-failed' })
    expect(await store.setFromBytes(new Uint8Array())).toEqual({ ok: false, reason: 'invalid-file' })
    expect(await store.setFromBytes(ascii('<svg>not an image</svg>'))).toEqual({ ok: false, reason: 'unsupported-format' })
  })

  it('accepts exactly 20 MB and rejects larger byte buffers and files', async () => {
    const bytes = new Uint8Array(MAX_WALLPAPER_BYTES)
    bytes.set(png)
    expect(await store.setFromBytes(bytes)).toMatchObject({ ok: true, wallpaper: { size: MAX_WALLPAPER_BYTES } })
    expect(await store.setFromBytes(new Uint8Array(MAX_WALLPAPER_BYTES + 1))).toEqual({ ok: false, reason: 'too-large' })
    const large = join(dir, 'large.png')
    await writeFile(large, png)
    await truncate(large, MAX_WALLPAPER_BYTES + 1)
    expect(await store.setFromFile(large)).toEqual({ ok: false, reason: 'too-large' })
    expect((await store.getState())?.size).toBe(MAX_WALLPAPER_BYTES)
  })

  it('changes the version even for same-size writes in the same millisecond', async () => {
    await store.setFromBytes(png)
    const target = join(dir, 'wallpaper', 'current.png')
    const mtime = Math.trunc((await lstat(target)).mtimeMs)
    const previous = { ext: 'png' as const, size: png.length, version: `${mtime}-${png.length}` }
    const filesystem = await import('node:fs/promises')
    const realRename = filesystem.rename
    vi.spyOn(filesystem, 'rename').mockImplementation(async (from, to) => {
      await realRename(from, to)
      await filesystem.utimes(to, mtime / 1000, mtime / 1000)
    })
    const bump = vi.spyOn(filesystem, 'utimes')
    const next = await store.setFromBytes(png)
    expect(bump).toHaveBeenLastCalledWith(target, expect.any(Date), new Date(mtime + 2))
    if (!next.ok) throw new Error(next.reason)
    expect(next.wallpaper.version).not.toBe(previous.version)
    expect(await new WallpaperStore(join(dir, 'wallpaper')).getState()).toEqual(next.wallpaper)
  })

  it('does not expose or overwrite a symlink target', async (context) => {
    const outside = join(dir, 'original.png')
    await writeFile(outside, png)
    await mkdir(join(dir, 'wallpaper'))
    const target = join(dir, 'wallpaper', 'current.png')
    try { await symlink(outside, target, 'file') } catch (error) {
      if (error instanceof Error && 'code' in error && error.code === 'EPERM') context.skip()
      throw error
    }
    expect(await store.getState()).toBeNull()
    expect((await store.serve(new Request('antumi-wallpaper://current/image'))).status).toBe(404)
    const replacement = png.slice()
    replacement[15] = 1
    expect(await store.setFromBytes(replacement)).toMatchObject({ ok: true })
    expect((await lstat(target)).isSymbolicLink()).toBe(false)
    expect(new Uint8Array(await readFile(outside))).toEqual(png)
  })

  it('ignores directories, empty and oversized controlled files', async () => {
    await mkdir(join(dir, 'wallpaper', 'current.png'), { recursive: true })
    await writeFile(join(dir, 'wallpaper', 'current.jpg'), '')
    const huge = join(dir, 'wallpaper', 'current.webp')
    await writeFile(huge, png)
    await truncate(huge, MAX_WALLPAPER_BYTES + 1)
    expect(await store.getState()).toBeNull()
    expect((await store.serve(new Request('antumi-wallpaper://current/image'))).status).toBe(404)
  })

  it('cleans up a temporary file on replacement failure and retains the previous image', async () => {
    await store.setFromBytes(jpg)
    await mkdir(join(dir, 'wallpaper', 'current.png'))
    expect(await store.setFromBytes(png)).toEqual({ ok: false, reason: 'read-failed' })
    expect(await readdir(join(dir, 'wallpaper'))).toEqual(['current.jpg', 'current.png'])
    expect(await store.getState()).toMatchObject({ ext: 'jpg' })
  })

  it.each(images)('serves %s with safe headers and a bounded cache', async (ext, bytes) => {
    const result = await store.setFromBytes(bytes)
    if (!result.ok) throw new Error(result.reason)
    const response = await store.serve(new Request(wallpaperUrl(result.wallpaper)))
    expect(response.status).toBe(200)
    expect(new Uint8Array(await response.arrayBuffer())).toEqual(bytes)
    expect(response.headers.get('content-type')).toBe(WALLPAPER_MIME[ext])
    expect(response.headers.get('content-security-policy')).toBe("default-src 'none'")
    expect(response.headers.get('x-content-type-options')).toBe('nosniff')
    expect(response.headers.get('referrer-policy')).toBe('no-referrer')
    expect(response.headers.get('cache-control')).toBe('private, max-age=3600')
    expect((await store.serve(new Request('antumi-wallpaper://current/'))).headers.get('cache-control')).toBe('no-store')
  })

  it('rejects non-GET methods and hosts, schemes, filenames, and traversal paths', async () => {
    await store.setFromBytes(png)
    for (const method of ['POST', 'PUT', 'DELETE', 'HEAD', 'OPTIONS']) {
      expect((await store.serve(new Request('antumi-wallpaper://current/image', { method }))).status).toBe(404)
    }
    for (const url of [
      'https://current/image', 'antumi-wallpaper://other/image', 'antumi-wallpaper://current:80/image',
      'antumi-wallpaper://current.evil/image', 'antumi-wallpaper://user@current/image',
      'antumi-wallpaper://current/current.png', 'antumi-wallpaper://current/image/extra',
      'antumi-wallpaper://current/%2e%2e', 'antumi-wallpaper://current/%2Fimage', 'antumi-wallpaper://current/%5cimage',
      'antumi-wallpaper://current/../image', 'antumi-wallpaper://current/a/../../image',
      'antumi-wallpaper://current/%2E%2e/image', 'antumi-wallpaper://current/..\\image', 'invalid url'
    ]) {
      // Preserve the transport spelling: Request/URL normally normalize dot segments first.
      const request = new Request('antumi-wallpaper://current/image')
      Object.defineProperty(request, 'url', { value: url })
      const response = await store.serve(request)
      expect(response.status, url).toBe(404)
      expect(response.headers.get('cache-control')).toBe('no-store')
      expect(response.headers.get('x-content-type-options')).toBe('nosniff')
    }
    expect((await store.serve(new Request('antumi-wallpaper://current/image?v=%2e%2f%5c'))).status).toBe(200)
    await store.clear()
    expect((await store.serve(new Request('antumi-wallpaper://current/image'))).status).toBe(404)
  })
})
