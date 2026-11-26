import { canManageWallpaper, getWallpaper, setNativeTheme } from './desktop-bridge'
import { BACKDROP_CSS_VARIABLES, backdropCssVariables, isFullWindowBackdrop, resolveActiveBackdrop } from './backdrops'
import { setPreference, usePreferences, type Preferences } from './preferences'

const systemDark = window.matchMedia('(prefers-color-scheme: dark)')
const isRequestPopup = () => document.documentElement.dataset.window === 'request-popup'
const appearanceKeys = ['theme', 'palette', 'backdropMode', 'backdropPreset', 'backdropScope', 'backdropOpacity', 'backdropBlur', 'backdropSurfaceOpacity', 'backdropGlassBlur', 'backdropFit', 'wallpaper'] as const
const themeKeys = ['theme', 'palette', 'backdropMode', 'backdropPreset', 'backdropScope', 'backdropSurfaceOpacity', 'wallpaper'] as const
const themeListeners = new Set<() => void>()

function apply(preferences: Preferences): void {
  const root = document.documentElement
  if (preferences.theme === 'system') delete root.dataset.theme
  else root.dataset.theme = preferences.theme
  root.dataset.palette = preferences.palette
  setNativeTheme(preferences.theme)

  const active = isRequestPopup() ? { kind: 'none' as const } : resolveActiveBackdrop(preferences, canManageWallpaper())
  for (const name of BACKDROP_CSS_VARIABLES) root.style.removeProperty(name)
  if (active.kind === 'none') {
    delete root.dataset.backdrop
    delete root.dataset.backdropScope
  } else {
    root.dataset.backdrop = active.kind === 'preset' ? active.preset : 'custom'
    root.dataset.backdropScope = active.scope
    for (const [name, value] of Object.entries(backdropCssVariables(preferences, canManageWallpaper()))) root.style.setProperty(name, value)
  }
}

export function startAppearance(): void {
  apply(usePreferences.getState())
  usePreferences.subscribe((next, previous) => {
    if (appearanceKeys.some((key) => next[key] !== previous[key])) {
      apply(next)
      if (themeKeys.some((key) => next[key] !== previous[key])) {
        for (const listener of themeListeners) listener()
      }
    }
  })
  if (!isRequestPopup() && canManageWallpaper()) {
    void getWallpaper().then((diskWallpaper) => {
      const saved = usePreferences.getState().wallpaper
      if (saved?.ext !== diskWallpaper?.ext || saved?.version !== diskWallpaper?.version || saved?.size !== diskWallpaper?.size) {
        setPreference('wallpaper', diskWallpaper)
      }
    })
  }
}

export function isDarkTheme(): boolean {
  return getComputedStyle(document.documentElement).colorScheme === 'dark'
}

export function isTransparentTerminalSurface(): boolean {
  return isFullWindowBackdrop(usePreferences.getState(), canManageWallpaper(), isRequestPopup())
}

// Tokens are applied before subscribers re-read the terminal and editor colours.
export function onThemeChange(listener: () => void): () => void {
  systemDark.addEventListener('change', listener)
  themeListeners.add(listener)
  return () => {
    systemDark.removeEventListener('change', listener)
    themeListeners.delete(listener)
  }
}
