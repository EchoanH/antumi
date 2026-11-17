import { setSettingsOpen, useCore } from '../core-store'
import { t } from '../i18n'
import { useShortcutLabel } from '../keyboard-shortcuts'
import { setPreference, usePreferences } from '../preferences'
import { ChatIcon, GearIcon, SidebarIcon } from './icons'
import { InboxEntry } from './InboxEntry'
import { OverviewEntry } from './OverviewEntry'
import { RoutinesEntry } from './RoutinesEntry'
import { SidebarTasks } from './SidebarTasks'
import { SquadsEntry } from './Squads'
import './sidebar-navigation.css'

export function openSidebarConversations(): void {
  setPreference('sidebarHidden', false)
  // Return without clearing the selected chat, draft or split panes.
  useCore.setState((s) => ({
    section: s.section === 'discussions' ? 'discussions' : 'conversations',
    settingsOpen: false, overviewOpen: false, inboxOpen: false, worktreesOpen: false, routinesOpen: false
  }))
}

export function SidebarNavigation() {
  const hidden = usePreferences((s) => s.sidebarHidden)
  const open = useCore((s) => (s.section === 'conversations' || s.section === 'discussions')
    && !s.settingsOpen && !s.overviewOpen && !s.inboxOpen && !s.worktreesOpen && !s.routinesOpen)
  const shortcut = useShortcutLabel('open-settings')
  const listLabel = t(hidden ? 'Sidebar.showConversations' : 'Sidebar.hideConversations')
  return <nav id="sidebar-navigation" className="sidebar-navigation" aria-label={t('Sidebar.mainMenu')}>
    <div className="sidebar-navigation-items">
      <OverviewEntry />
      <InboxEntry />
      <RoutinesEntry />
      <SquadsEntry />
      <div className="sidebar-navigation-separator" role="separator" />
      <SidebarTasks />
      <button type="button" className="inbox-entry" aria-current={open} aria-label={t('sidebar.conversations')} data-tooltip={t('sidebar.conversations')} data-tooltip-side="right" onClick={openSidebarConversations}>
        <ChatIcon /><span className="sidebar-navigation-label">{t('sidebar.conversations')}</span>
      </button>
    </div>
    <div className="sidebar-navigation-footer">
      <button type="button" className="inbox-entry" aria-label={listLabel} aria-expanded={!hidden} aria-controls="sidebar-conversation-panel" data-tooltip={listLabel} data-tooltip-side="right" onClick={() => setPreference('sidebarHidden', !hidden)}>
        <SidebarIcon /><span className="sidebar-navigation-label">{listLabel}</span>
      </button>
      <button type="button" className="inbox-entry" aria-label={t('StatusBar.settings')} data-tooltip={[t('StatusBar.settings'), shortcut].filter(Boolean).join(' · ')} data-tooltip-side="right" onClick={() => setSettingsOpen(true)}>
        <GearIcon /><span className="sidebar-navigation-label">{t('StatusBar.settings')}</span>
      </button>
    </div>
  </nav>
}
