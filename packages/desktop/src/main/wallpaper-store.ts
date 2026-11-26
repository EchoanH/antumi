import { lstat, mkdir, readFile, rename, stat, unlink, utimes, writeFile } from 'node:fs/promises'
import { isAbsolute, join } from 'node:path'
import { detectWallpaperExtension, MAX_WALLPAPER_BYTES, WALLPAPER_EXTENSIONS, WALLPAPER_MIME, WALLPAPER_SCHEME, type WallpaperAsset, type WallpaperExtension, type WallpaperResult } from '../shared/wallpaper'

const HEADERS = { 'content-security-policy': "default-src 'none'", 'x-content-type-options': 'nosniff', 'referrer-policy': 'no-referrer' }
const notFound = () => new Response('not found', { status: 404, headers: { 'cache-control': 'no-store', ...HEADERS } })
const versionOf = (info: { mtimeMs: number; size: number }) => `${Math.trunc(info.mtimeMs)}-${info.size}`
const missing = (error: unknown) => error instanceof Error && 'code' in error && error.code === 'ENOENT'

export class WallpaperStore {
  // Writes and clears run one at a time: each removes the other formats' files, so two saves of
  // different formats side by side could delete each other's new image.
  private queue: Promise<unknown> = Promise.resolve()

  constructor(private readonly dir: string) {}

  private serial<T>(work: () => Promise<T>): Promise<T> {
    const run = this.queue.then(work, work)
    this.queue = run.catch(() => {})
    return run
  }

  private path(ext: WallpaperExtension): string {
    return join(this.dir, `current.${ext}`)
  }

  async getState(): Promise<WallpaperAsset | null> {
    for (const ext of WALLPAPER_EXTENSIONS) {
      try {
        const info = await lstat(this.path(ext))
        if (!info.isFile() || info.isSymbolicLink() || info.size <= 0 || info.size > MAX_WALLPAPER_BYTES) continue
        return { ext, version: versionOf(info), size: info.size }
      } catch { /* Missing or unreadable files are not assets. */ }
    }
    return null
  }

  async setFromFile(filePath: string): Promise<WallpaperResult> {
    if (!filePath || !isAbsolute(filePath) || filePath.includes('\0')) return { ok: false, reason: 'invalid-file' }
    try {
      const info = await stat(filePath)
      if (!info.isFile() || info.size <= 0) return { ok: false, reason: 'invalid-file' }
      if (info.size > MAX_WALLPAPER_BYTES) return { ok: false, reason: 'too-large' }
      return await this.setFromBytes(await readFile(filePath))
    } catch { return { ok: false, reason: 'read-failed' } }
  }

  setFromBytes(bytes: Uint8Array): Promise<WallpaperResult> {
    return this.serial(() => this.write(bytes))
  }

  private async write(bytes: Uint8Array): Promise<WallpaperResult> {
    if (bytes.byteLength <= 0) return { ok: false, reason: 'invalid-file' }
    if (bytes.byteLength > MAX_WALLPAPER_BYTES) return { ok: false, reason: 'too-large' }
    const ext = detectWallpaperExtension(bytes)
    if (!ext) return { ok: false, reason: 'unsupported-format' }
    const target = this.path(ext)
    const temp = join(this.dir, `.current.${ext}.${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}.tmp`)
    try {
      const previous = await this.getState()
      await mkdir(this.dir, { recursive: true })
      const existing = await lstat(target).catch(() => null)
      if (existing?.isSymbolicLink()) await unlink(target)
      await writeFile(temp, bytes)
      await rename(temp, target)
      for (const other of WALLPAPER_EXTENSIONS) if (other !== ext) await unlink(this.path(other)).catch(() => {})
      let info = await lstat(target)
      // Advance past filesystem rounding without changing the stamp after a restart.
      const previousTime = previous ? Number.parseInt(previous.version, 10) : null
      if (previousTime !== null && Math.trunc(info.mtimeMs) <= previousTime) {
        await utimes(target, info.atime, new Date(previousTime + 2))
        info = await lstat(target)
      }
      return { ok: true, wallpaper: { ext, version: versionOf(info), size: info.size } }
    } catch {
      await unlink(temp).catch(() => {})
      return { ok: false, reason: 'read-failed' }
    }
  }

  // Throws when a file stays behind, so the user is not told it was cleared.
  clear(): Promise<void> {
    return this.serial(async () => {
      for (const ext of WALLPAPER_EXTENSIONS) {
        await unlink(this.path(ext)).catch((error: unknown) => { if (!missing(error)) throw error })
      }
    })
  }

  async serve(request: Request): Promise<Response> {
    if (request.method !== 'GET') return notFound()
    let url: URL
    try {
      url = new URL(request.url)
      const pathname = request.url.match(/^[^:]+:\/\/[^/?#]*([^?#]*)/)?.[1] ?? ''
      if (url.protocol !== `${WALLPAPER_SCHEME}:` || url.host !== 'current' || url.username || url.password || (url.pathname !== '/image' && url.pathname !== '/')) return notFound()
      if (/%2e|%2f|%5c/i.test(pathname) || /(?:^|[\/\\])\.\.?(?:[\/\\]|$)/.test(pathname)) return notFound()
    } catch { return notFound() }
    for (const ext of WALLPAPER_EXTENSIONS) {
      try {
        const target = this.path(ext)
        const info = await lstat(target)
        if (!info.isFile() || info.isSymbolicLink() || info.size <= 0 || info.size > MAX_WALLPAPER_BYTES) continue
        const body = await readFile(target)
        return new Response(new Uint8Array(body), { headers: { 'content-type': WALLPAPER_MIME[ext], 'cache-control': url.searchParams.has('v') ? 'private, max-age=3600' : 'no-store', ...HEADERS } })
      } catch { /* Try the remaining controlled filenames. */ }
    }
    return notFound()
  }
}
