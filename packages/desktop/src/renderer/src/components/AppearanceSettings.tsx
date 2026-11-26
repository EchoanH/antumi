import { useCallback, useEffect, useId, useState, type DragEvent } from 'react'
import { t } from '../i18n'
import { useCore } from '../core-store'
import { DEFAULT_PREFERENCES, setPreference, usePreferences } from '../preferences'
import { useChatTypeface } from '../chat-typeface'
import { readingStyle } from '../reading-style'
import { changedAppearancePreferences, withAppearanceDefaults, type AppearanceSection } from '../appearance-preferences'
import { codeFontStack } from '../code-font'
import { PALETTE_LABEL } from '../palettes'
import { BACKDROP_LABEL, backdropCssVariables, resolveActiveBackdrop } from '../backdrops'
import { canManageWallpaper, clearWallpaper, pickWallpaper, setWallpaperFromDrop } from '../desktop-bridge'
import { wallpaperUrl, type WallpaperErrorReason, type WallpaperResult } from '../../../shared/wallpaper'
import { formatBytes } from '../wire-entries'
import { Resettable, Segmented, SettingsGroup, SettingsRow, Stepper, Toggle } from './SettingsControls'
import { ChatFontPicker } from './ChatFontPicker'
import { CodeFontPicker } from './CodeFontPicker'
import { CjkFontPicker } from './CjkFontPicker'
import { PalettePicker } from './PalettePicker'
import { BackdropPicker } from './BackdropPicker'
import { MarkdownThemePicker } from './MarkdownThemePicker'
import { MarkdownThemePreview } from './MarkdownThemePreview'
import { resolveMarkdownTheme, type MarkdownThemePack } from '../markdown-theme-packs'
import { MarkdownThemeLibrary } from './MarkdownThemeLibrary'
import { ArrowUpIcon, BookIcon, CheckIcon, ChatIcon, ImageIcon, TrashIcon, ContrastIcon, DocumentIcon, GlobeIcon, RobotIcon, RotateLeftIcon, TerminalIcon } from './icons'

function WallpaperUploadRow() {
  const wallpaper = usePreferences((s) => s.wallpaper)
  const [dragging, setDragging] = useState(false)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<WallpaperErrorReason | 'clear-failed' | null>(null)
  const applyWallpaperResult = (result: WallpaperResult) => {
    if (result.ok) {
      setPreference('wallpaper', result.wallpaper)
      setError(null)
    } else if (result.reason !== 'canceled') setError(result.reason)
  }
  const handlePick = async () => {
    if (busy) return
    setBusy(true)
    try { applyWallpaperResult(await pickWallpaper()) } finally { setBusy(false) }
  }
  const handleClear = async () => {
    if (busy) return
    setBusy(true)
    try {
      if (await clearWallpaper()) { setPreference('wallpaper', null); setError(null) }
      else setError('clear-failed')
    } finally { setBusy(false) }
  }
  const drag = (event: DragEvent<HTMLElement>) => { event.preventDefault(); event.stopPropagation() }
  const dropHandlers = {
    onDragEnter: (event: DragEvent<HTMLElement>) => { drag(event); if (!busy) setDragging(true) },
    onDragOver: (event: DragEvent<HTMLElement>) => { drag(event); event.dataTransfer.dropEffect = busy ? 'none' : 'copy' },
    onDragLeave: (event: DragEvent<HTMLElement>) => {
      drag(event)
      if (!(event.relatedTarget instanceof Node) || !event.currentTarget.contains(event.relatedTarget)) setDragging(false)
    },
    onDrop: async (event: DragEvent<HTMLElement>) => {
      drag(event); setDragging(false)
      const file = event.dataTransfer.files[0]
      if (busy || !file) return
      setBusy(true)
      try { applyWallpaperResult(await setWallpaperFromDrop(file)) } finally { setBusy(false) }
    }
  }
  const errorText = error === 'too-large' ? t('Backdrop.errorTooLarge')
    : error === 'unsupported-format' ? t('Backdrop.errorUnsupportedFormat')
    : error === 'clear-failed' ? t('Backdrop.errorClearFailed') : t('Backdrop.errorReadFailed')
  return <SettingsRow label={t('Backdrop.image')} description={!canManageWallpaper() ? t('Backdrop.desktopOnly') : undefined} control={(labelId) => !canManageWallpaper() ? null : <div className="wallpaper-upload" aria-busy={busy}>
    {wallpaper === null ? <button type="button" className="wallpaper-dropzone" aria-labelledby={labelId} data-dragging={dragging || undefined} disabled={busy} onClick={handlePick} {...dropHandlers}>
      <ImageIcon /><span className="wallpaper-dropzone-title">{t('Backdrop.uploadPrompt')}</span><span className="wallpaper-dropzone-hint">{t('Backdrop.uploadHint')}</span>
    </button> : <div className="wallpaper-card" data-dragging={dragging || undefined} {...dropHandlers}>
      <img className="wallpaper-thumb" src={wallpaperUrl(wallpaper)} alt="" />
      <div className="wallpaper-meta"><strong>{wallpaper.ext.toUpperCase()} · {formatBytes(wallpaper.size)}</strong><span>{t('Backdrop.dropReplaceHint')}</span></div>
      <div className="wallpaper-actions"><button type="button" className="button" disabled={busy} onClick={handlePick}>{t('Backdrop.replaceImage')}</button><button type="button" className="button ghost" disabled={busy} onClick={handleClear}><TrashIcon />{t('Backdrop.clearImage')}</button></div>
    </div>}
    {error !== null && <p className="wallpaper-error" role="alert">{errorText}</p>}
  </div>} />
}

function ThemeMiniature({ scheme }: { scheme: 'light' | 'dark' }) {
  return (
    <span className="theme-miniature" data-scheme={scheme}>
      <span className="theme-miniature-nav"><i /><i /><i /></span>
      <span className="theme-miniature-body"><i /><i /><i /><b /></span>
    </span>
  )
}

function ThemePicker() {
  const name = useId()
  const theme = usePreferences((s) => s.theme)
  const options = [
    { value: 'light', label: t('SettingsPage.light') },
    { value: 'dark', label: t('SettingsPage.dark') },
    { value: 'system', label: t('SettingsPage.system') }
  ] as const
  return (
    <fieldset className="theme-picker">
      <legend>{t('SettingsPage.theme')}</legend>
      <p>{t('SettingsPage.withSystemSelectedFollowsTheSystemSLight')}</p>
      <div className="theme-options">
        {options.map((option) => (
          <label key={option.value} className="theme-option">
            <input type="radio" name={name} value={option.value} checked={theme === option.value} onChange={() => setPreference('theme', option.value)} />
            <span className="theme-option-image" aria-hidden="true">
              {option.value !== 'dark' && <ThemeMiniature scheme="light" />}
              {option.value !== 'light' && <ThemeMiniature scheme="dark" />}
            </span>
            <span className="theme-option-label">{option.label}<CheckIcon /></span>
          </label>
        ))}
      </div>
    </fieldset>
  )
}

function AppearancePreview({ section, comparing, onCompare, draft }: { section: AppearanceSection; comparing: boolean; onCompare: () => void; draft: MarkdownThemePack | null }) {
  const typeface = useChatTypeface()
  const current = usePreferences()
  const preview = comparing ? withAppearanceDefaults(current, DEFAULT_PREFERENCES, section) : current
  const markdownPacks = draft && !comparing ? [...preview.markdownThemePacks.filter((each) => each.id !== draft.id), draft] : preview.markdownThemePacks
  const markdownSelection = draft && !comparing ? `user:${draft.id}` : preview.markdownTheme
  const { palette, theme, chatWidth, foldTurns, terminalFontSize, terminalLineHeight, colorPrompt } = preview
  const backdrop = resolveActiveBackdrop(preview, canManageWallpaper())
  const codeStyle = { fontFamily: codeFontStack(preview.codeFontFamily, preview.codeCjkFontFamily) }
  const [systemDark, setSystemDark] = useState(() => window.matchMedia('(prefers-color-scheme: dark)').matches)
  useEffect(() => {
    const media = window.matchMedia('(prefers-color-scheme: dark)')
    const changed = () => setSystemDark(media.matches)
    media.addEventListener('change', changed)
    return () => media.removeEventListener('change', changed)
  }, [])
  const scheme = theme === 'system' ? (systemDark ? 'dark' : 'light') : theme
  const previewTypeface = comparing && section === 'chat'
    ? { 'data-font-size': DEFAULT_PREFERENCES.chatFontSize, 'data-font': DEFAULT_PREFERENCES.chatFont }
    : typeface
  return (
    <aside className="appearance-preview" aria-label={t('SettingsPage.livePreview')}>
      <div className="appearance-preview-heading"><h3>{t('SettingsPage.livePreview')}</h3><span>{section === 'markdown' ? resolveMarkdownTheme(markdownSelection, markdownPacks).name : backdrop.kind === 'none' ? PALETTE_LABEL[palette].name : `${PALETTE_LABEL[palette].name} · ${backdrop.kind === 'preset' ? BACKDROP_LABEL[backdrop.preset] : t('Backdrop.modeImage')}`}</span></div>
      {section !== 'language' && <button type="button" className="button appearance-compare" disabled={!comparing && !(section === 'markdown' && draft) && changedAppearancePreferences(current, DEFAULT_PREFERENCES, section).length === 0} aria-pressed={comparing} onClick={onCompare}>{comparing ? t('SettingsPage.showCurrent') : t('SettingsPage.compareDefaults')}</button>}
      <div className="appearance-preview-window" data-palette={palette} data-backdrop={backdrop.kind === 'none' ? undefined : backdrop.kind === 'preset' ? backdrop.preset : 'custom'} data-backdrop-scope={backdrop.kind === 'none' ? undefined : backdrop.scope} data-section={section} data-comparing={comparing || undefined} style={{ colorScheme: scheme, ...{ '--md-color-scheme': scheme }, ...backdropCssVariables(preview, canManageWallpaper()) }}>
        <div className="appearance-preview-toolbar"><ChatIcon /><span>Antumi</span><span className="appearance-preview-sample">{t('SettingsPage.sample')}</span></div>
        {section === 'markdown' ? <MarkdownThemePreview theme={markdownSelection} packs={markdownPacks} reading={preview} /> : <>
        <div className="appearance-preview-chat chat-view" {...previewTypeface}>
          <div className="appearance-preview-thread" data-width={chatWidth} style={readingStyle(preview)}>
            <p className="appearance-preview-user">{t('SettingsPage.previewPrompt')}</p>
            <div className="appearance-preview-agent"><span className="appearance-preview-mark"><RobotIcon /></span><strong>Agent</strong></div>
            <details className="appearance-preview-work" key={String(foldTurns)} open={!foldTurns}>
              <summary>{t('SettingsPage.previewWork')}</summary>
              <p>{t('SettingsPage.previewWorkDetail')}</p>
            </details>
            <p className="appearance-preview-answer">{t('SettingsPage.previewAnswer')}</p>
            <pre className="appearance-preview-code" style={codeStyle}><code><span className="code-keyword">const</span> task = {'{'}{'\n'}  title: <span className="code-string">'Antumi'</span>,{'\n'}  status: <span className="code-string">'pending'</span>{'\n'}{'}'}</code></pre>
          </div>
          <div className="appearance-preview-composer" aria-hidden="true"><span>{t('SettingsPage.previewReply')}</span><ArrowUpIcon /></div>
        </div>
        <div className="appearance-preview-terminal" style={{ ...codeStyle, fontSize: terminalFontSize, lineHeight: terminalLineHeight * 1.33 }}>
          <div><TerminalIcon /><span>{t('SettingsPage.terminal')}</span></div>
          <p><span className="appearance-preview-prompt" data-colored={colorPrompt}>$</span> pnpm dev</p>
          <p className="appearance-preview-terminal-comment">{t('SettingsPage.previewTerminal')}</p>
          {section === 'terminal' && <pre className="appearance-preview-code"><code><span className="code-keyword">const</span> title ={'\n'}  <span className="code-string">'{t('SettingsPage.previewCodeTitle')}'</span>{'\n'}<span className="code-keyword">const</span> task = {'{'}{'\n'}  title,{'\n'}  status: <span className="code-string">'pending'</span>{'\n'}{'}'}</code></pre>}
        </div>
        </>}
      </div>
      <p className="appearance-preview-caption" role="status">{comparing ? t('SettingsPage.comparingDefaults') : section === 'markdown' ? t('MarkdownTheme.previewHint') : t('SettingsPage.previewHint')}</p>
    </aside>
  )
}

export function AppearanceSettings() {
  const sectionLabelId = useId()
  const [section, setSection] = useState<AppearanceSection>('colors')
  const [comparing, setComparing] = useState(false)
  const [markdownDraft, setMarkdownDraft] = useState<MarkdownThemePack | null>(null)
  const previewMarkdownDraft = useCallback((pack: MarkdownThemePack | null) => { setMarkdownDraft(pack); setComparing(false) }, [])
  const current = usePreferences()
  const changed = changedAppearancePreferences(current, DEFAULT_PREFERENCES, section)
  const resetGroup = () => {
    for (const key of changed) setPreference(key, DEFAULT_PREFERENCES[key])
    setComparing(false)
  }
  const {
    backdropMode, backdropScope, backdropOpacity, backdropBlur, backdropSurfaceOpacity, backdropGlassBlur, backdropFit,
    language, terminalFontSize, terminalLineHeight, colorPrompt, chatFontSize, chatLineHeight, chatParagraphSpacing, chatWidth, foldTurns
  } = current
  const colorPromptSupported = useCore((s) => s.rpc?.features.includes('terminal-color-prompt') ?? false)
  return (
    <div className="appearance-workspace">
      <div className="appearance-sections">
        <span id={sectionLabelId} hidden>{t('SettingsPage.appearanceSections')}</span>
        <Segmented labelId={sectionLabelId} value={section} onChange={(next) => { setSection(next); setComparing(false) }} options={[
          { value: 'colors', label: t('SettingsPage.theme') },
          { value: 'chat', label: t('MarkdownTheme.reading') },
          { value: 'markdown', label: 'Markdown' },
          { value: 'terminal', label: t('SettingsPage.terminal') },
          { value: 'language', label: t('SettingsPage.language') }
        ]} />
      </div>
      <div className="appearance-layout">
      <div className="appearance-controls">
        <div hidden={section !== 'colors'}>
        <SettingsGroup title={t('SettingsPage.colors')} icon={<ContrastIcon />}>
          <ThemePicker />
          <SettingsRow
            label={t('SettingsPage.palette')}
            description={t('SettingsPage.colorsForTheEntireInterfaceWithLightAnd')}
            control={(labelId) => <PalettePicker labelId={labelId} />}
          />
        </SettingsGroup>
        <SettingsGroup title={t('Backdrop.title')} icon={<ImageIcon />}>
          <SettingsRow label={t('Backdrop.mode')} description={t('Backdrop.modeDescription')} control={(labelId) => <Resettable label={t('Backdrop.mode')} changed={backdropMode !== DEFAULT_PREFERENCES.backdropMode} onReset={() => setPreference('backdropMode', DEFAULT_PREFERENCES.backdropMode)}>
            <Segmented labelId={labelId} value={backdropMode} onChange={(value) => setPreference('backdropMode', value)} options={[
              { value: 'none', label: t('common.off') }, { value: 'preset', label: t('Backdrop.modePreset') }, { value: 'image', label: t('Backdrop.modeImage') }
            ]} />
          </Resettable>} />
          {backdropMode === 'preset' && <SettingsRow label={t('Backdrop.preset')} description={t('Backdrop.presetDescription')} control={(labelId) => <BackdropPicker labelId={labelId} />} />}
          {backdropMode === 'image' && <WallpaperUploadRow />}
          {backdropMode !== 'none' && <>
            <SettingsRow label={t('Backdrop.scope')} description={t('Backdrop.scopeDescription')} control={(labelId) => <Resettable label={t('Backdrop.scope')} changed={backdropScope !== DEFAULT_PREFERENCES.backdropScope} onReset={() => setPreference('backdropScope', DEFAULT_PREFERENCES.backdropScope)}>
              <Segmented labelId={labelId} value={backdropScope} onChange={(value) => setPreference('backdropScope', value)} options={[
                { value: 'full', label: t('Backdrop.scopeFull') }, { value: 'frame', label: t('Backdrop.scopeFrame') }
              ]} />
            </Resettable>} />
            <SettingsRow label={t('Backdrop.opacity')} description={t('Backdrop.opacityDescription')} control={(labelId) => <Resettable label={t('Backdrop.opacity')} changed={backdropOpacity !== DEFAULT_PREFERENCES.backdropOpacity} onReset={() => setPreference('backdropOpacity', DEFAULT_PREFERENCES.backdropOpacity)}>
              <span className="appearance-slider"><input type="range" min={5} max={100} step={1} value={backdropOpacity} aria-labelledby={labelId} onChange={(e) => setPreference('backdropOpacity', Number(e.target.value))} /><output>{backdropOpacity}%</output></span>
            </Resettable>} />
            <SettingsRow label={t('Backdrop.blur')} description={t('Backdrop.blurDescription')} control={(labelId) => <Resettable label={t('Backdrop.blur')} changed={backdropBlur !== DEFAULT_PREFERENCES.backdropBlur} onReset={() => setPreference('backdropBlur', DEFAULT_PREFERENCES.backdropBlur)}>
              <span className="appearance-slider"><input type="range" min={0} max={30} step={1} value={backdropBlur} aria-labelledby={labelId} onChange={(e) => setPreference('backdropBlur', Number(e.target.value))} /><output>{backdropBlur} px</output></span>
            </Resettable>} />
            <SettingsRow label={t('Backdrop.surfaceOpacity')} description={t('Backdrop.surfaceOpacityDescription')} control={(labelId) => <Resettable label={t('Backdrop.surfaceOpacity')} changed={backdropSurfaceOpacity !== DEFAULT_PREFERENCES.backdropSurfaceOpacity} onReset={() => setPreference('backdropSurfaceOpacity', DEFAULT_PREFERENCES.backdropSurfaceOpacity)}>
              <span className="appearance-slider"><input type="range" min={30} max={95} step={1} value={backdropSurfaceOpacity} aria-labelledby={labelId} onChange={(e) => setPreference('backdropSurfaceOpacity', Number(e.target.value))} /><output>{backdropSurfaceOpacity}%</output></span>
            </Resettable>} />
            <SettingsRow label={t('Backdrop.glassBlur')} description={t('Backdrop.glassBlurDescription')} control={(labelId) => <Resettable label={t('Backdrop.glassBlur')} changed={backdropGlassBlur !== DEFAULT_PREFERENCES.backdropGlassBlur} onReset={() => setPreference('backdropGlassBlur', DEFAULT_PREFERENCES.backdropGlassBlur)}>
              <span className="appearance-slider"><input type="range" min={0} max={24} step={1} value={backdropGlassBlur} aria-labelledby={labelId} onChange={(e) => setPreference('backdropGlassBlur', Number(e.target.value))} /><output>{backdropGlassBlur} px</output></span>
            </Resettable>} />
            <SettingsRow label={t('Backdrop.fit')} description={t('Backdrop.fitDescription')} control={(labelId) => <Resettable label={t('Backdrop.fit')} changed={backdropFit !== DEFAULT_PREFERENCES.backdropFit} onReset={() => setPreference('backdropFit', DEFAULT_PREFERENCES.backdropFit)}>
              <Segmented labelId={labelId} value={backdropFit} onChange={(value) => setPreference('backdropFit', value)} options={[
                { value: 'cover', label: t('Backdrop.fitCover') }, { value: 'contain', label: t('Backdrop.fitContain') }
              ]} />
            </Resettable>} />
          </>}
        </SettingsGroup>
        </div>
        <div hidden={section !== 'chat'}>
        <SettingsGroup title={t('MarkdownTheme.reading')} icon={<BookIcon />}>
          <p className="settings-note">{t('MarkdownTheme.readingHint')}</p>
          <SettingsRow
            label={t('SettingsPage.fontSize')}
            description={t('SettingsPage.textSizeForMessagesWorkDetailsAndComposer')}
            control={(labelId) => (
              <Resettable label={t('SettingsPage.chatFontSize')} changed={chatFontSize !== DEFAULT_PREFERENCES.chatFontSize} onReset={() => setPreference('chatFontSize', DEFAULT_PREFERENCES.chatFontSize)}>
                <Stepper
                  labelId={labelId}
                  value={chatFontSize}
                  min={10}
                  max={20}
                  unit="px"
                  onChange={(next) => setPreference('chatFontSize', next)}
                />
              </Resettable>
            )}
          />
          <SettingsRow
            label={t('SettingsPage.lineHeight')}
            description={t('MarkdownTheme.lineHeightHint')}
            control={(labelId) => <Resettable label={t('SettingsPage.lineHeight')} changed={chatLineHeight !== DEFAULT_PREFERENCES.chatLineHeight} onReset={() => setPreference('chatLineHeight', DEFAULT_PREFERENCES.chatLineHeight)}>
              <Stepper labelId={labelId} value={chatLineHeight} min={1.4} max={2.4} step={0.1} unit="" onChange={(next) => setPreference('chatLineHeight', next)} />
            </Resettable>}
          />
          <SettingsRow
            label={t('MarkdownTheme.spacing')}
            control={(labelId) => <Resettable label={t('MarkdownTheme.spacing')} changed={chatParagraphSpacing !== DEFAULT_PREFERENCES.chatParagraphSpacing} onReset={() => setPreference('chatParagraphSpacing', DEFAULT_PREFERENCES.chatParagraphSpacing)}>
              <Stepper labelId={labelId} value={chatParagraphSpacing} min={0.2} max={1.6} step={0.1} unit="em" onChange={(next) => setPreference('chatParagraphSpacing', next)} />
            </Resettable>}
          />
          <SettingsRow
            label={t('SettingsPage.font')}
            description={t('SettingsPage.serifChangesProseOnlyLeavingCodeUnchanged')}
            control={(labelId) => <ChatFontPicker labelId={labelId} />}
          />
          <SettingsRow
            label={t('SettingsPage.chineseFont')}
            description={t('SettingsPage.chineseTextInChatUsesThisFontEnglish')}
            control={(labelId) => <CjkFontPicker labelId={labelId} preference="chatCjkFontFamily" title={t('SettingsPage.chooseChineseChatFont')} />}
          />
          <SettingsRow
            label={t('SettingsPage.pageWidth')}
            description={t('SettingsPage.maximumMessageAndComposerWidthNarrow800pxMedium')}
            control={(labelId) => (
              <Segmented
                labelId={labelId}
                value={chatWidth}
                onChange={(next) => setPreference('chatWidth', next)}
                options={[
                  { value: 'narrow', label: t('SettingsPage.narrow') },
                  { value: 'medium', label: t('SettingsPage.medium') },
                  { value: 'full', label: t('SettingsPage.fullWidth') }
                ]}
              />
            )}
          />
          <SettingsRow
            label={t('SettingsPage.foldCompletedTurns')}
            description={t('SettingsPage.foldReasoningCommandsAndInterimRepliesUnderWorked')}
            control={(labelId) => (
              <Toggle labelId={labelId} checked={foldTurns} onChange={(next) => setPreference('foldTurns', next)} />
            )}
          />
        </SettingsGroup>
        </div>
        <div hidden={section !== 'markdown'}>
          <SettingsGroup title="Markdown" icon={<DocumentIcon />}><MarkdownThemePicker />
            <p className="settings-note">{t('MarkdownTheme.readingHint')} <button type="button" className="link-button" onClick={() => setSection('chat')}>{t('MarkdownTheme.adjustReading')}</button></p>
          </SettingsGroup>
          <MarkdownThemeLibrary onPreview={previewMarkdownDraft} />
        </div>
        <div hidden={section !== 'terminal'}>
        <SettingsGroup title={t('SettingsPage.terminalAndCode')} icon={<TerminalIcon />}>
          <SettingsRow
            label={t('SettingsPage.codeFont')}
            description={t('SettingsPage.fontForTerminalsCodeBlocksChangesAndFile')}
            control={(labelId) => <CodeFontPicker labelId={labelId} />}
          />
          <SettingsRow
            label={t('SettingsPage.chineseCodeFont')}
            description={t('SettingsPage.fallbackForChineseInTerminalsCodeAndPreviews')}
            control={(labelId) => <CjkFontPicker labelId={labelId} preference="codeCjkFontFamily" title={t('SettingsPage.chooseChineseCodeFont')} />}
          />
          <SettingsRow
            label={t('SettingsPage.terminalFontSize')}
            description={t('SettingsPage.appliesImmediatelyToOpenTerminals')}
            control={(labelId) => (
              <Resettable label={t('SettingsPage.terminalFontSize')} changed={terminalFontSize !== DEFAULT_PREFERENCES.terminalFontSize} onReset={() => setPreference('terminalFontSize', DEFAULT_PREFERENCES.terminalFontSize)}>
                <Stepper
                  labelId={labelId}
                  value={terminalFontSize}
                  min={10}
                  max={20}
                  unit="px"
                  onChange={(next) => setPreference('terminalFontSize', next)}
                />
              </Resettable>
            )}
          />
          <SettingsRow
            label={t('SettingsPage.terminalLineHeight')}
            description={t('SettingsPage.multiplierOfTheFontSOwnLineHeight')}
            control={(labelId) => (
              <Resettable label={t('SettingsPage.terminalLineHeight')} changed={terminalLineHeight !== DEFAULT_PREFERENCES.terminalLineHeight} onReset={() => setPreference('terminalLineHeight', DEFAULT_PREFERENCES.terminalLineHeight)}>
                <Segmented
                  labelId={labelId}
                  value={String(terminalLineHeight)}
                  onChange={(next) => setPreference('terminalLineHeight', Number(next))}
                  options={[
                    { value: '1', label: '1.0' },
                    { value: '1.2', label: '1.2' },
                    { value: '1.4', label: '1.4' }
                  ]}
                />
              </Resettable>
            )}
          />
          {colorPromptSupported && (
            <SettingsRow
              label={t('SettingsPage.coloredPrompt')}
              description={t('SettingsPage.forZshWithoutACustomPromptUseColors')}
              control={(labelId) => <Toggle labelId={labelId} checked={colorPrompt} onChange={(next) => setPreference('colorPrompt', next)} />}
            />
          )}
        </SettingsGroup>
        </div>
        <div hidden={section !== 'language'}>
        <SettingsGroup title={t('language.interfaceLanguage')} icon={<GlobeIcon />}>
          <SettingsRow label={t('language.interfaceLanguage')} description={t('language.description')}
            control={(labelId) => <Segmented labelId={labelId} value={language} onChange={(value) => setPreference('language', value)}
              options={[{ value: 'system', label: t('SettingsPage.system') }, { value: 'zh-CN', label: '简体中文' }, { value: 'en', label: 'English' }]} />} />
        </SettingsGroup>
        </div>
        <footer className="appearance-group-footer">
          <span role="status">{changed.length ? t('SettingsPage.customizedCount', { count: changed.length }) : t('SettingsPage.usingDefaults')}</span>
          <button type="button" className="button ghost" disabled={changed.length === 0} onClick={resetGroup}><RotateLeftIcon />{t('SettingsPage.resetGroup')}</button>
        </footer>
      </div>
      <AppearancePreview section={section} comparing={comparing} onCompare={() => setComparing(!comparing)} draft={markdownDraft} />
      </div>
    </div>
  )
}
