import { afterEach, describe, expect, it } from 'vitest'
import { BACKDROPS, BACKDROP_CSS_VARIABLES, BACKDROP_LABEL, BACKDROP_ORIGIN, backdropCssVariables, isFullWindowBackdrop, resolveActiveBackdrop, type BackdropSettings } from './backdrops'
import { setLocale } from './i18n'

const settings: BackdropSettings = {
  backdropMode: 'preset', backdropPreset: 'aurora', backdropScope: 'full', backdropOpacity: 65,
  backdropBlur: 0, backdropSurfaceOpacity: 68, backdropGlassBlur: 12, backdropFit: 'cover', wallpaper: null
}
const wallpaper = { ext: 'png' as const, version: '123-16', size: 16 }
afterEach(() => setLocale('zh-CN'))

describe('active backdrop', () => {
  it.each(BACKDROPS)('resolves preset %s even outside Electron', (preset) => {
    expect(resolveActiveBackdrop({ ...settings, backdropPreset: preset }, false)).toEqual({ kind: 'preset', preset, scope: 'full' })
  })
  it('resolves an image only with a local asset and a supporting bridge', () => {
    const image: BackdropSettings = { ...settings, backdropMode: 'image', wallpaper, backdropScope: 'frame' }
    expect(resolveActiveBackdrop(image, true)).toEqual({ kind: 'image', scope: 'frame', imageUrl: 'antumi-wallpaper://current/image?v=123-16' })
    expect(resolveActiveBackdrop(image, false)).toEqual({ kind: 'none' })
    expect(resolveActiveBackdrop({ ...image, wallpaper: null }, true)).toEqual({ kind: 'none' })
    expect(resolveActiveBackdrop({ ...image, backdropMode: 'none' }, true)).toEqual({ kind: 'none' })
  })
  it('only makes full-window active backdrops transparent, excluding request popups', () => {
    expect(isFullWindowBackdrop(settings, false)).toBe(true)
    expect(isFullWindowBackdrop(settings, true, true)).toBe(false)
    expect(isFullWindowBackdrop({ ...settings, backdropScope: 'frame' }, true)).toBe(false)
    expect(isFullWindowBackdrop({ ...settings, backdropMode: 'none' }, true)).toBe(false)
    expect(isFullWindowBackdrop({ ...settings, backdropMode: 'image', wallpaper }, false)).toBe(false)
    expect(isFullWindowBackdrop({ ...settings, backdropMode: 'image', wallpaper }, true)).toBe(true)
  })
  it('keeps localized preset labels and origins current', () => {
    expect(BACKDROP_LABEL.aurora).toBe('极光紫蓝')
    expect(BACKDROP_LABEL.sunset).toBe('落日余晖')
    setLocale('en')
    expect(BACKDROP_LABEL.aurora).toBe('Aurora')
    expect(BACKDROP_LABEL['sea-glass']).toBe('Sea Glass')
    expect(BACKDROP_ORIGIN['sea-glass']).toContain('Slack')
    for (const preset of BACKDROPS) expect(BACKDROP_ORIGIN[preset]).not.toBe('')
  })
})

describe('backdrop CSS parameters', () => {
  it('returns no overrides when no supported backdrop is active', () => {
    expect(backdropCssVariables({ ...settings, backdropMode: 'none' }, true)).toEqual({})
    expect(backdropCssVariables({ ...settings, backdropMode: 'image', wallpaper }, false)).toEqual({})
    expect(backdropCssVariables({ ...settings, backdropMode: 'image' }, true)).toEqual({})
  })
  it.each([[0, '1'], [1, '1.004'], [12, '1.048'], [30, '1.120']])('scales blur %s without uncovered edges', (blur, scale) => {
    const css = backdropCssVariables({ ...settings, backdropBlur: blur }, true)
    expect(css['--backdrop-scale']).toBe(scale)
    expect(css['--backdrop-blur']).toBe(`${blur}px`)
  })
  it('derives the six single-layer alphas from one surface value', () => {
    expect(backdropCssVariables(settings, true)).toEqual({
      '--backdrop-opacity': '0.65', '--backdrop-blur': '0px', '--backdrop-scale': '1', '--backdrop-fit': 'cover', '--backdrop-glass-blur': '12px',
      '--backdrop-scrim-alpha': '46%', '--backdrop-sidebar-alpha': '19%', '--backdrop-surface-alpha': '35%',
      '--backdrop-elevated-alpha': '49%', '--backdrop-header-alpha': '82%', '--backdrop-float-alpha': '90%'
    })
  })
  it('clamps all numeric parameters at both ends', () => {
    expect(backdropCssVariables({ ...settings, backdropOpacity: -1, backdropBlur: -1, backdropGlassBlur: -1, backdropSurfaceOpacity: -1 }, true)).toMatchObject({
      '--backdrop-opacity': '0.05', '--backdrop-blur': '0px', '--backdrop-scale': '1', '--backdrop-glass-blur': '0px',
      '--backdrop-scrim-alpha': '8%', '--backdrop-sidebar-alpha': '8%', '--backdrop-surface-alpha': '18%',
      '--backdrop-elevated-alpha': '36%', '--backdrop-header-alpha': '76%', '--backdrop-float-alpha': '84%'
    })
    expect(backdropCssVariables({ ...settings, backdropOpacity: 200, backdropBlur: 200, backdropGlassBlur: 200, backdropSurfaceOpacity: 200 }, true)).toMatchObject({
      '--backdrop-opacity': '1', '--backdrop-blur': '30px', '--backdrop-scale': '1.120', '--backdrop-glass-blur': '24px',
      '--backdrop-scrim-alpha': '73%', '--backdrop-sidebar-alpha': '27%', '--backdrop-surface-alpha': '49%',
      '--backdrop-elevated-alpha': '68%', '--backdrop-header-alpha': '94%', '--backdrop-float-alpha': '96%'
    })
  })
  it('includes an image URL and fit, and exposes every property for cleanup', () => {
    const css = backdropCssVariables({ ...settings, backdropMode: 'image', wallpaper, backdropFit: 'contain' }, true)
    expect(css['--backdrop-custom-image']).toBe('url("antumi-wallpaper://current/image?v=123-16")')
    expect(css['--backdrop-fit']).toBe('contain')
    expect(Object.keys(css).sort()).toEqual([...BACKDROP_CSS_VARIABLES].sort())
    expect(backdropCssVariables(settings, true)).not.toHaveProperty('--backdrop-custom-image')
  })
})
