import type { PluginInfo } from '@antumi/protocol'
import { getLocale } from './i18n'
import { pluginPageLabel } from './plugin-pages'

export function pluginName(plugin: PluginInfo): string {
  const names = plugin.sources.length > 0 ? plugin.sources.map((source) => source.name) : plugin.pages.map((page) => pluginPageLabel(page, getLocale()))
  return names.join('、') || plugin.id
}
