import { z } from 'zod'

export const WALLPAPER_SCHEME = 'antumi-wallpaper'
export const MAX_WALLPAPER_BYTES = 20 * 1024 * 1024
export const WALLPAPER_EXTENSIONS = ['png', 'jpg', 'webp', 'gif', 'avif'] as const
export type WallpaperExtension = (typeof WALLPAPER_EXTENSIONS)[number]
export const WALLPAPER_DIALOG_EXTENSIONS = ['png', 'jpg', 'jpeg', 'webp', 'gif', 'avif'] as const
export const WALLPAPER_MIME: Record<WallpaperExtension, string> = {
  png: 'image/png', jpg: 'image/jpeg', webp: 'image/webp', gif: 'image/gif', avif: 'image/avif'
}

export const WallpaperAsset = z.object({
  ext: z.enum(WALLPAPER_EXTENSIONS),
  version: z.string().min(1).max(80),
  size: z.number().int().positive().max(MAX_WALLPAPER_BYTES)
})
export type WallpaperAsset = z.infer<typeof WallpaperAsset>
export const WallpaperErrorReason = z.enum(['canceled', 'too-large', 'unsupported-format', 'invalid-file', 'read-failed'])
export type WallpaperErrorReason = z.infer<typeof WallpaperErrorReason>
export const WallpaperResult = z.discriminatedUnion('ok', [
  z.object({ ok: z.literal(true), wallpaper: WallpaperAsset }),
  z.object({ ok: z.literal(false), reason: WallpaperErrorReason })
])
export type WallpaperResult = z.infer<typeof WallpaperResult>

export function detectWallpaperExtension(bytes: Uint8Array): WallpaperExtension | null {
  if (bytes.byteLength < 12) return null
  const matches = (offset: number, text: string) => [...text].every((char, index) => bytes[offset + index] === char.charCodeAt(0))
  if ([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a].every((byte, index) => bytes[index] === byte)) return 'png'
  if (bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return 'jpg'
  if (matches(0, 'GIF87a') || matches(0, 'GIF89a')) return 'gif'
  if (matches(0, 'RIFF') && matches(8, 'WEBP')) return 'webp'
  if (matches(4, 'ftyp')) {
    const boxSize = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength).getUint32(0)
    const end = Math.min(boxSize, bytes.byteLength, 64)
    if (end < 16) return null
    const avif = (offset: number) => matches(offset, 'avif') || matches(offset, 'avis')
    if (avif(8)) return 'avif'
    for (let offset = 16; offset + 4 <= end; offset += 4) if (avif(offset)) return 'avif'
  }
  return null
}

export function wallpaperUrl(asset: WallpaperAsset): string {
  return `${WALLPAPER_SCHEME}://current/image?v=${encodeURIComponent(asset.version)}`
}
