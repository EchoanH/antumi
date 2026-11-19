import { translatedText, type PluginInfo, type PluginPage, type UiLocale } from '@antumi/protocol'

// A page a plugin ships, by its plugin's id and its own.
export type PluginPageRef = { plugin: string; page: string }

// The pages there are to open: those of the enabled plugins, in the order core lists them.
export function availablePluginPages(plugins: readonly PluginInfo[] | null): Array<PluginPageRef & { version: string; info: PluginPage }> {
  return (plugins ?? []).filter((plugin) => plugin.enabled).flatMap((plugin) => plugin.pages.map((info) => ({ plugin: plugin.id, page: info.id, version: plugin.version, info })))
}

export function findPluginPage(plugins: readonly PluginInfo[] | null, ref: PluginPageRef): (PluginPageRef & { version: string; info: PluginPage }) | null {
  return availablePluginPages(plugins).find((entry) => entry.plugin === ref.plugin && entry.page === ref.page) ?? null
}

export function pluginPageLabel(page: PluginPage, locale: UiLocale): string {
  return translatedText(page, locale).label || page.label
}

// Where a page keeps what it asked to between visits, on this computer.
export function pluginPageStateKey(ref: PluginPageRef): string {
  return `antumi.pluginPage:${ref.plugin}:${ref.page}`
}
