import { describe, expect, it } from 'vitest'
import { PluginInfo } from '@antumi/protocol'
import { availablePluginPages, findPluginPage, pluginPageLabel, pluginPageStateKey } from './plugin-pages'

const plugin = (id: string, enabled: boolean, pages: string[]) => PluginInfo.parse({
  id, version: '2.0.0', enabled, sources: [], versions: ['2.0.0'], origin: { kind: 'bundled' }, problem: null,
  pages: pages.map((page) => ({ id: page, label: `页 ${page}`, translations: { en: { label: `Page ${page}` } }, entry: `${page}/index.html` }))
})

describe('plugin pages', () => {
  it('lists the pages of enabled plugins in order', () => {
    const plugins = [plugin('dev.a.one', true, ['forum', 'news']), plugin('dev.a.two', false, ['hidden']), plugin('dev.a.three', true, [])]
    expect(availablePluginPages(plugins).map((entry) => `${entry.plugin}/${entry.page}@${entry.version}`)).toEqual(['dev.a.one/forum@2.0.0', 'dev.a.one/news@2.0.0'])
    expect(findPluginPage(plugins, { plugin: 'dev.a.two', page: 'hidden' })).toBeNull()
    expect(findPluginPage(null, { plugin: 'dev.a.one', page: 'forum' })).toBeNull()
  })

  it('labels a page in the interface language and keys its state by plugin and page', () => {
    const [page] = plugin('dev.a.one', true, ['forum']).pages
    if (!page) throw new Error('no page')
    expect(pluginPageLabel(page, 'zh-CN')).toBe('页 forum')
    expect(pluginPageLabel(page, 'en')).toBe('Page forum')
    expect(pluginPageLabel({ ...page, translations: { en: { label: '' } } }, 'en')).toBe('页 forum')
    expect(pluginPageStateKey({ plugin: 'dev.a.one', page: 'forum' })).not.toBe(pluginPageStateKey({ plugin: 'dev.a.one', page: 'news' }))
  })
})
