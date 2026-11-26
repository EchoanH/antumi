import { describe, expect, it } from 'vitest'
import { DEFAULT_PREFERENCES } from './preferences'
import { changedAppearancePreferences, withAppearanceDefaults } from './appearance-preferences'

describe('appearance group defaults', () => {
  const customized = {
    ...DEFAULT_PREFERENCES,
    theme: 'dark' as const,
    palette: 'nord' as const,
    chatFontSize: 18,
    chatLineHeight: 2,
    chatParagraphSpacing: 0.8,
    chatFontFamily: 'Custom family',
    terminalFontSize: 16,
    language: 'en' as const,
    notifications: false
  }

  it('compares a copy of one group without changing saved settings', () => {
    const preview = withAppearanceDefaults(customized, DEFAULT_PREFERENCES, 'chat')
    expect(preview.chatFontSize).toBe(DEFAULT_PREFERENCES.chatFontSize)
    expect(preview.chatFontFamily).toBe(DEFAULT_PREFERENCES.chatFontFamily)
    expect(preview.chatLineHeight).toBe(1.7)
    expect(preview.chatParagraphSpacing).toBe(0.4)
    expect(preview.palette).toBe('nord')
    expect(preview.terminalFontSize).toBe(16)
    expect(preview.notifications).toBe(false)
    expect(customized.chatFontSize).toBe(18)
    expect(customized.chatFontFamily).toBe('Custom family')
  })

  it('keeps language and chat preferences when resetting theme and palette', () => {
    const preview = withAppearanceDefaults(customized, DEFAULT_PREFERENCES, 'colors')
    expect(preview.theme).toBe(DEFAULT_PREFERENCES.theme)
    expect(preview.palette).toBe(DEFAULT_PREFERENCES.palette)
    expect(preview.language).toBe('en')
    expect(preview.chatFontSize).toBe(18)
    expect(preview.chatLineHeight).toBe(2)
  })

  it('offers only the selected group’s customized fields for a reset', () => {
    expect(changedAppearancePreferences(customized, DEFAULT_PREFERENCES, 'terminal')).toEqual(['terminalFontSize'])
    expect(changedAppearancePreferences(customized, DEFAULT_PREFERENCES, 'language')).toEqual(['language'])
    expect(changedAppearancePreferences(DEFAULT_PREFERENCES, DEFAULT_PREFERENCES, 'chat')).toEqual([])
  })

  it('compares and resets Markdown without changing the workspace palette or chat', () => {
    const current = { ...customized, markdownTheme: 'newsprint' as const }
    expect(changedAppearancePreferences(current, DEFAULT_PREFERENCES, 'markdown')).toEqual(['markdownTheme'])
    const preview = withAppearanceDefaults(current, DEFAULT_PREFERENCES, 'markdown')
    expect(preview.markdownTheme).toBe('default')
    expect(preview.palette).toBe('nord')
    expect(preview.chatFontSize).toBe(18)
    expect(current.markdownTheme).toBe('newsprint')
  })
})

describe('backdrop and glass group defaults', () => {
  const wallpaper = { ext: 'png' as const, version: '123-16', size: 16 }
  const current = {
    ...DEFAULT_PREFERENCES, backdropMode: 'image' as const, backdropPreset: 'forest' as const, backdropScope: 'frame' as const,
    backdropOpacity: 80, backdropBlur: 20, backdropSurfaceOpacity: 90, backdropGlassBlur: 24, backdropFit: 'contain' as const,
    wallpaper, chatFontSize: 18, terminalFontSize: 16, language: 'en' as const, notifications: false
  }
  it('compares every backdrop style knob and excludes the asset stamp', () => {
    expect(changedAppearancePreferences(current, DEFAULT_PREFERENCES, 'colors')).toEqual([
      'backdropMode', 'backdropPreset', 'backdropScope', 'backdropOpacity', 'backdropBlur', 'backdropSurfaceOpacity', 'backdropGlassBlur', 'backdropFit'
    ])
    expect(changedAppearancePreferences({ ...DEFAULT_PREFERENCES, wallpaper }, DEFAULT_PREFERENCES, 'colors')).toEqual([])
  })
  it('resets styling without deleting uploaded image metadata or other sections', () => {
    const reset = withAppearanceDefaults(current, DEFAULT_PREFERENCES, 'colors')
    expect(changedAppearancePreferences(reset, DEFAULT_PREFERENCES, 'colors')).toEqual([])
    expect(reset.backdropMode).toBe('none')
    expect(reset.wallpaper).toBe(wallpaper)
    expect(reset).toMatchObject({ chatFontSize: 18, terminalFontSize: 16, language: 'en', notifications: false })
    expect(current.backdropMode).toBe('image')
    expect(current.backdropBlur).toBe(20)
  })
  it('keeps every backdrop parameter and image while resetting another section', () => {
    for (const section of ['chat', 'terminal', 'markdown', 'language'] as const) {
      const reset = withAppearanceDefaults(current, DEFAULT_PREFERENCES, section)
      expect(changedAppearancePreferences(reset, current, 'colors')).toEqual([])
      expect(reset.wallpaper).toBe(wallpaper)
    }
  })
})
