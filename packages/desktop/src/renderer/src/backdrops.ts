import { wallpaperUrl, type WallpaperAsset } from '../../shared/wallpaper'
import { localized, t } from './i18n'

export const BACKDROPS = ['sea-glass', 'funky-fresh', 'aurora', 'sunset', 'nebula', 'forest'] as const
export type Backdrop = (typeof BACKDROPS)[number]
export const BACKDROP_MODES = ['none', 'preset', 'image'] as const
export type BackdropMode = (typeof BACKDROP_MODES)[number]
export const BACKDROP_SCOPES = ['full', 'frame'] as const
export type BackdropScope = (typeof BACKDROP_SCOPES)[number]
export const BACKDROP_FITS = ['cover', 'contain'] as const
export type BackdropFit = (typeof BACKDROP_FITS)[number]

export const BACKDROP_LABEL: Record<Backdrop, string> = localized(() => ({
  'sea-glass': 'Sea Glass',
  'funky-fresh': 'Funky Fresh',
  aurora: t('Backdrop.presetAurora'),
  sunset: t('Backdrop.presetSunset'),
  nebula: t('Backdrop.presetNebula'),
  forest: t('Backdrop.presetForest')
}))

export const BACKDROP_ORIGIN: Record<Backdrop, string> = localized(() => ({
  'sea-glass': t('BackdropPicker.fromSlackSTheme', { name: 'Sea Glass' }),
  'funky-fresh': t('BackdropPicker.fromSlackSTheme', { name: 'Funky Fresh' }),
  aurora: t('Backdrop.originAurora'),
  sunset: t('Backdrop.originSunset'),
  nebula: t('Backdrop.originNebula'),
  forest: t('Backdrop.originForest')
}))

export type BackdropSettings = {
  backdropMode: BackdropMode
  backdropPreset: Backdrop
  backdropScope: BackdropScope
  backdropOpacity: number
  backdropBlur: number
  backdropSurfaceOpacity: number
  backdropGlassBlur: number
  backdropFit: BackdropFit
  wallpaper: WallpaperAsset | null
}

type ActiveBackdrop = { kind: 'none' } | { kind: 'preset'; preset: Backdrop; scope: BackdropScope } | { kind: 'image'; imageUrl: string; scope: BackdropScope }

export function resolveActiveBackdrop(settings: BackdropSettings, wallpaperSupported: boolean): ActiveBackdrop {
  if (settings.backdropMode === 'preset') return { kind: 'preset', preset: settings.backdropPreset, scope: settings.backdropScope }
  if (settings.backdropMode === 'image' && wallpaperSupported && settings.wallpaper !== null) {
    return { kind: 'image', imageUrl: wallpaperUrl(settings.wallpaper), scope: settings.backdropScope }
  }
  return { kind: 'none' }
}

export function isFullWindowBackdrop(settings: BackdropSettings, wallpaperSupported: boolean, isRequestPopup = false): boolean {
  return !isRequestPopup && resolveActiveBackdrop(settings, wallpaperSupported).kind !== 'none' && settings.backdropScope === 'full'
}

export const BACKDROP_CSS_VARIABLES = [
  '--backdrop-opacity', '--backdrop-blur', '--backdrop-scale', '--backdrop-fit', '--backdrop-glass-blur',
  '--backdrop-scrim-alpha', '--backdrop-sidebar-alpha', '--backdrop-surface-alpha', '--backdrop-elevated-alpha',
  '--backdrop-header-alpha', '--backdrop-float-alpha', '--backdrop-custom-image'
] as const

export function backdropCssVariables(settings: BackdropSettings, wallpaperSupported: boolean): Record<string, string> {
  const active = resolveActiveBackdrop(settings, wallpaperSupported)
  if (active.kind === 'none') return {}
  const clamp = (value: number, min: number, max: number) => Math.min(Math.max(value, min), max)
  const opacity = Number((clamp(settings.backdropOpacity, 5, 100) / 100).toFixed(2))
  const blur = clamp(settings.backdropBlur, 0, 30)
  const surface = clamp(settings.backdropSurfaceOpacity, 30, 95)
  return {
    '--backdrop-opacity': String(opacity),
    '--backdrop-blur': `${blur}px`,
    '--backdrop-scale': blur > 0 ? (1 + blur * 0.004).toFixed(3) : '1',
    '--backdrop-fit': settings.backdropFit,
    '--backdrop-glass-blur': `${clamp(settings.backdropGlassBlur, 0, 24)}px`,
    '--backdrop-scrim-alpha': `${Math.max(surface - 22, 8)}%`,
    '--backdrop-sidebar-alpha': `${clamp(Math.round(surface * 0.28), 8, 44)}%`,
    '--backdrop-surface-alpha': `${clamp(Math.round(surface * 0.52), 18, 72)}%`,
    '--backdrop-elevated-alpha': `${clamp(Math.round(surface * 0.72), 36, 86)}%`,
    '--backdrop-header-alpha': `${clamp(surface + 14, 76, 94)}%`,
    '--backdrop-float-alpha': `${clamp(surface + 22, 84, 96)}%`,
    ...(active.kind === 'image' ? { '--backdrop-custom-image': `url("${active.imageUrl}")` } : {})
  }
}
