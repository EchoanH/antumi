import type { Conversation } from '@antumi/protocol'
import { getLocale } from './i18n'
import { isListedConversation } from './search-palette'

// `project` is the primary project's path, null for those with none; they go last.
export type ArchivedGroup = { key: string; project: string | null; conversations: Conversation[] }

// The archived conversations the sidebar lists, by primary project, the latest archived first.
export function archivedByProject(conversations: readonly Conversation[], name: (path: string) => string): ArchivedGroup[] {
  const groups = new Map<string, ArchivedGroup>()
  const archived = conversations.filter((each) => each.archivedAt != null && isListedConversation(each))
    .sort((a, b) => (b.archivedAt ?? 0) - (a.archivedAt ?? 0))
  for (const conversation of archived) {
    const project = conversation.projectPaths[0] ?? null
    const key = project ?? ''
    const group = groups.get(key) ?? { key, project, conversations: [] }
    group.conversations.push(conversation)
    groups.set(key, group)
  }
  return [...groups.values()].sort((a, b) => a.project === null ? 1 : b.project === null ? -1 : name(a.project).localeCompare(name(b.project), getLocale()))
}
