import { createElement, isValidElement, type ReactElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { StateCreator } from 'zustand'
import { BACKDROPS, BACKDROP_LABEL } from '../backdrops'
import { setLocale, t } from '../i18n'
import { DEFAULT_PREFERENCES, usePreferences } from '../preferences'
import { wallpaperUrl, type WallpaperAsset } from '../../../shared/wallpaper'
import { canManageWallpaper, clearWallpaper, pickWallpaper, setWallpaperFromDrop } from '../desktop-bridge'
import { AppearanceSettings } from './AppearanceSettings'
import { BackdropPicker } from './BackdropPicker'

const captured = vi.hoisted(() => {
  vi.stubGlobal('window', { antumi: undefined, matchMedia: () => ({ matches: false, addEventListener() {}, removeEventListener() {} }), addEventListener() {}, removeEventListener() {} })
  vi.stubGlobal('navigator', { userAgent: 'Mac', platform: 'MacIntel' })
  vi.stubGlobal('localStorage', { getItem: () => null, setItem() {} })
  return new Array<unknown>()
})

// Keep the live Zustand snapshot in SSR, as in FontSettings.test.ts.
vi.mock('zustand', async (importOriginal) => {
  const zustand = await importOriginal<typeof import('zustand')>()
  return { ...zustand, create: <T>() => (initializer: StateCreator<T>) => {
    const store = zustand.create(initializer)
    return Object.assign((selector?: (state: T) => unknown) => selector ? selector(store.getState()) : store.getState(), store)
  } }
})

// Preserve real rendering and retain elements to exercise their emitted event handlers.
vi.mock('react/jsx-runtime', async (importOriginal) => {
  const runtime = await importOriginal<typeof import('react/jsx-runtime')>()
  return { ...runtime,
    jsx: (...args: Parameters<typeof runtime.jsx>) => { const element = runtime.jsx(...args); captured.push(element); return element },
    jsxs: (...args: Parameters<typeof runtime.jsxs>) => { const element = runtime.jsxs(...args); captured.push(element); return element }
  }
})
vi.mock('react/jsx-dev-runtime', async (importOriginal) => {
  const runtime = await importOriginal<typeof import('react/jsx-dev-runtime')>()
  return { ...runtime, jsxDEV: (...args: Parameters<typeof runtime.jsxDEV>) => { const element = runtime.jsxDEV(...args); captured.push(element); return element } }
})
vi.mock('../core-store', () => ({ useCore: (selector: (state: { rpc: null }) => unknown) => selector({ rpc: null }) }))
vi.mock('../desktop-bridge', () => ({ canManageWallpaper: vi.fn(), pickWallpaper: vi.fn(), setWallpaperFromDrop: vi.fn(), clearWallpaper: vi.fn() }))
vi.mock('./ChatFontPicker', () => ({ ChatFontPicker: () => null }))
vi.mock('./CodeFontPicker', () => ({ CodeFontPicker: () => null }))
vi.mock('./CjkFontPicker', () => ({ CjkFontPicker: () => null }))
vi.mock('./MarkdownThemeLibrary', () => ({ MarkdownThemeLibrary: () => null }))
vi.mock('./MarkdownThemePreview', () => ({ MarkdownThemePreview: () => null }))

const wallpaper: WallpaperAsset = { ext: 'png', version: 'image-123', size: 2048 }
const render = () => { captured.length = 0; return renderToStaticMarkup(createElement(AppearanceSettings)) }
function find<P>(predicate: (element: ReactElement<P>) => boolean): ReactElement<P> {
  const element = captured.find((each) => isValidElement<P>(each) && predicate(each))
  if (!isValidElement<P>(element)) throw new Error('Expected rendered element')
  return element
}
function click(label: string) {
  find<{ 'aria-label'?: string; children?: unknown; onClick: () => void }>((each) => each.type === 'button' && (each.props['aria-label'] === label || each.props.children === label)).props.onClick()
}

beforeEach(() => {
  vi.resetAllMocks()
  setLocale('zh-CN')
  usePreferences.setState(DEFAULT_PREFERENCES, true)
  vi.mocked(canManageWallpaper).mockReturnValue(true)
})

describe('custom background settings', () => {
  it('starts off and switches modes without discarding the chosen image', () => {
    usePreferences.setState({ wallpaper })
    expect(render()).toContain('自定义背景')
    expect(render()).not.toContain('wallpaper-dropzone')
    expect(render()).not.toContain('type="range"')
    click(t('Backdrop.modePreset'))
    expect(usePreferences.getState().backdropMode).toBe('preset')
    expect(render()).toContain('backdrop-picker')
    click(t('Backdrop.modeImage'))
    expect(render()).toContain('wallpaper-thumb')
    click(t('common.off'))
    expect(usePreferences.getState()).toMatchObject({ backdropMode: 'none', wallpaper })
    expect(render()).not.toContain('backdrop-scope=')
  })

  it('keeps default comparison and group reset disabled until styling changes', () => {
    usePreferences.setState({ wallpaper })
    render()
    expect(find<{ className: string; disabled: boolean }>((each) => each.props.className === 'button appearance-compare').props.disabled).toBe(true)
    const footer = find<{ className: string; children: unknown }>((each) => each.props.className === 'appearance-group-footer')
    if (!Array.isArray(footer.props.children)) throw new Error('Expected footer actions')
    const reset = footer.props.children.find((each) => isValidElement<{ disabled: boolean }>(each) && each.type === 'button')
    if (!isValidElement<{ disabled: boolean }>(reset)) throw new Error('Expected reset group')
    expect(reset.props.disabled).toBe(true)
  })

  it('renders exactly six presets and selecting one activates preset mode', () => {
    captured.length = 0
    const html = renderToStaticMarkup(createElement(BackdropPicker, { labelId: 'presets' }))
    expect(html).toContain('role="radiogroup" aria-labelledby="presets"')
    expect(html.match(/role="radio"/g)).toHaveLength(6)
    expect(html).not.toContain('关闭')
    for (const preset of BACKDROPS) expect(html).toContain('data-backdrop="' + preset + '"')
    click(BACKDROP_LABEL.forest)
    expect(usePreferences.getState()).toMatchObject({ backdropMode: 'preset', backdropPreset: 'forest' })
  })

  it('offers all five live parameters, their ranges, scope and individual resets', () => {
    usePreferences.setState({ backdropMode: 'preset', backdropScope: 'frame', backdropOpacity: 80, backdropBlur: 20, backdropSurfaceOpacity: 90, backdropGlassBlur: 24, backdropFit: 'contain' })
    const html = render()
    expect(html.match(/type="range"/g)).toHaveLength(4)
    for (const [label, min, max, value] of [[t('Backdrop.opacity'), 5, 100, 80], [t('Backdrop.blur'), 0, 30, 20], [t('Backdrop.surfaceOpacity'), 30, 95, 90], [t('Backdrop.glassBlur'), 0, 24, 24]] as const) {
      expect(html).toContain('min="' + min + '" max="' + max + '" step="1"')
      expect(html).toContain('value="' + value + '"')
      click(t('SettingsControls.resetToDefault', { label }))
    }
    click(t('SettingsControls.resetToDefault', { label: t('Backdrop.fit') }))
    click(t('SettingsControls.resetToDefault', { label: t('Backdrop.scope') }))
    expect(usePreferences.getState()).toMatchObject({ backdropOpacity: 65, backdropBlur: 0, backdropSurfaceOpacity: 68, backdropGlassBlur: 12, backdropFit: 'cover', backdropScope: 'full' })
  })

  it('writes slider changes and scope/fit selections to preferences immediately', () => {
    usePreferences.setState({ backdropMode: 'preset' })
    render()
    find<{ type: string; min: number; onChange: (event: { target: { value: string } }) => void }>((each) => each.type === 'input' && each.props.type === 'range' && each.props.min === 5).props.onChange({ target: { value: '42' } })
    click(t('Backdrop.scopeFrame'))
    click(t('Backdrop.fitContain'))
    expect(usePreferences.getState()).toMatchObject({ backdropOpacity: 42, backdropScope: 'frame', backdropFit: 'contain' })
  })

  it('shows the upload target with supported formats and size limit', async () => {
    usePreferences.setState({ backdropMode: 'image' })
    const html = render()
    expect(html).toContain('wallpaper-dropzone')
    expect(html).toContain('20 MB')
    expect(html).toContain('AVIF')
    vi.mocked(pickWallpaper).mockResolvedValue({ ok: true, wallpaper })
    await find<{ className: string; onClick: () => Promise<void> }>((each) => each.props.className === 'wallpaper-dropzone').props.onClick()
    expect(usePreferences.getState().wallpaper).toEqual(wallpaper)
    expect(render()).toContain('wallpaper-thumb')
  })

  it('handles file drops locally and keeps the existing wallpaper after a rejected upload', async () => {
    usePreferences.setState({ backdropMode: 'image', wallpaper })
    render()
    const file = new File(['image'], 'image.png', { type: 'image/png' })
    const event = { preventDefault: vi.fn(), stopPropagation: vi.fn(), dataTransfer: { files: [file] } }
    vi.mocked(setWallpaperFromDrop).mockResolvedValue({ ok: false, reason: 'too-large' })
    await find<{ className: string; onDrop: (drop: typeof event) => Promise<void> }>((each) => each.props.className === 'wallpaper-card').props.onDrop(event)
    expect(event.preventDefault).toHaveBeenCalledOnce()
    expect(event.stopPropagation).toHaveBeenCalledOnce()
    expect(setWallpaperFromDrop).toHaveBeenCalledWith(file)
    expect(usePreferences.getState().wallpaper).toEqual(wallpaper)
  })

  it('renders a thumbnail and replaces/clears the image through the desktop bridge', async () => {
    usePreferences.setState({ backdropMode: 'image', wallpaper })
    const html = render()
    expect(html).toContain(wallpaperUrl(wallpaper))
    expect(html).toContain('PNG · 2.0 KB')
    const replacement = { ...wallpaper, version: 'replacement' }
    vi.mocked(pickWallpaper).mockResolvedValue({ ok: true, wallpaper: replacement })
    await find<{ children: unknown; onClick: () => Promise<void> }>((each) => each.props.children === t('Backdrop.replaceImage')).props.onClick()
    expect(usePreferences.getState().wallpaper).toEqual(replacement)
    render()
    vi.mocked(clearWallpaper).mockResolvedValue(false)
    await find<{ children: unknown; onClick: () => Promise<void> }>((each) => each.type === 'button' && Array.isArray(each.props.children) && each.props.children.includes(t('Backdrop.clearImage'))).props.onClick()
    expect(clearWallpaper).toHaveBeenCalledTimes(1)
    expect(usePreferences.getState().wallpaper).toEqual(replacement)
    render()
    vi.mocked(clearWallpaper).mockResolvedValue(true)
    await find<{ children: unknown; onClick: () => Promise<void> }>((each) => each.type === 'button' && Array.isArray(each.props.children) && each.props.children.includes(t('Backdrop.clearImage'))).props.onClick()
    expect(clearWallpaper).toHaveBeenCalledTimes(2)
    expect(usePreferences.getState().wallpaper).toBeNull()
  })

  it('degrades image upload and preview outside Electron while retaining presets', () => {
    vi.mocked(canManageWallpaper).mockReturnValue(false)
    usePreferences.setState({ backdropMode: 'image', wallpaper })
    const html = render()
    expect(html).toContain(t('Backdrop.desktopOnly'))
    expect(html).not.toContain('wallpaper-dropzone')
    expect(html).not.toContain('wallpaper-thumb')
    expect(html).not.toContain('data-backdrop="custom"')
    usePreferences.setState({ backdropMode: 'preset' })
    expect(render()).toContain('data-backdrop="aurora"')
  })

  it.each(['full', 'frame'] as const)('mirrors the %s scope, palette, wallpaper parameters and heading in the preview', (scope) => {
    usePreferences.setState({ palette: 'nord', theme: 'dark', backdropMode: 'preset', backdropPreset: 'forest', backdropScope: scope, backdropOpacity: 80, backdropBlur: 8, backdropGlassBlur: 18, backdropFit: 'contain' })
    const html = render()
    expect(html).toContain('data-palette="nord" data-backdrop="forest" data-backdrop-scope="' + scope + '"')
    expect(html).toContain('--backdrop-opacity:0.8;--backdrop-blur:8px;--backdrop-scale:1.032;--backdrop-fit:contain;--backdrop-glass-blur:18px')
    expect(html).toContain(' · ' + BACKDROP_LABEL.forest)
    expect(html).toContain('color-scheme:dark')
  })

  it('previews custom image URL and labels it as an image', () => {
    usePreferences.setState({ backdropMode: 'image', wallpaper })
    const html = render()
    expect(html).toContain('data-backdrop="custom" data-backdrop-scope="full"')
    expect(html).toContain('--backdrop-custom-image:url(&quot;' + wallpaperUrl(wallpaper) + '&quot;)')
    expect(html).toContain(' · ' + t('Backdrop.modeImage'))
  })

  it('compares defaults without changing preferences and resets only the current group', () => {
    usePreferences.setState({ backdropMode: 'image', wallpaper, backdropBlur: 12, chatFontSize: 18 })
    render()
    const preview = find<{ comparing: boolean; onCompare: () => void; section: string }>((each) => typeof each.type === 'function' && each.type.name === 'AppearancePreview')
    const defaults = renderToStaticMarkup(createElement(preview.type, { ...preview.props, comparing: true }))
    expect(defaults).toContain('data-comparing="true"')
    expect(defaults).not.toContain('data-backdrop=')
    expect(defaults).toContain(t('SettingsPage.showCurrent'))
    expect(usePreferences.getState()).toMatchObject({ backdropMode: 'image', wallpaper, backdropBlur: 12 })
    render()
    const footer = find<{ className: string; children: unknown }>((each) => each.props.className === 'appearance-group-footer')
    if (!Array.isArray(footer.props.children)) throw new Error('Expected footer actions')
    const reset = footer.props.children.find((each) => isValidElement<{ onClick: () => void }>(each) && each.type === 'button')
    if (!isValidElement<{ onClick: () => void }>(reset)) throw new Error('Expected reset group')
    reset.props.onClick()
    expect(usePreferences.getState()).toMatchObject({ backdropMode: 'none', backdropBlur: 0, wallpaper, chatFontSize: 18 })
  })

  it('renders complete English background controls', () => {
    setLocale('en')
    usePreferences.setState({ backdropMode: 'preset' })
    const html = render()
    for (const label of ['Custom background', 'Wallpaper visibility', 'Background blur', 'Surface opacity', 'Glass blur', 'Image fit', 'Full window', 'Frame only']) expect(html).toContain(label)
  })
})
