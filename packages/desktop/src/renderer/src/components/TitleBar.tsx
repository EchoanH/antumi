import { useRef, useState } from 'react'
import { t } from '../i18n'
import { openOverview, openSearch, setNewTaskOpen, useOverview } from '../core-store'
import { useShortcutLabel } from '../keyboard-shortcuts'
import { ContextMenu, MenuItem, type MenuPoint } from './ContextMenu'
import { newConversation } from './ConversationActions'
import { AgentIcon, BoardIcon, ChatIcon, PlusIcon, SearchIcon } from './icons'
import { UtilityPanelButtons } from './StatusBar'
import './window-frame.css'

// The row beside the traffic lights while the menu is collapsed to icons, when the pages sit on a
// card below it: the search, who is at work or waiting, new chats and tasks, and the dock's panels.
// After the workspace and before the brand: where drag regions overlap, the later one wins.
export function TitleBar() {
  return (
    <header className="title-bar">
      <SearchField />
      <div className="title-bar-end">
        <Activity />
        <NewMenu />
        <span className="title-bar-divider" aria-hidden="true" />
        <UtilityPanelButtons />
      </div>
    </header>
  )
}

function SearchField() {
  const shortcut = useShortcutLabel('search')
  return (
    <button type="button" className="title-bar-search" aria-label={t('SearchPalette.placeholder')} onClick={() => openSearch()}>
      <SearchIcon />
      <span className="title-bar-search-label">{t('SearchPalette.placeholder')}</span>
      {shortcut && <kbd>{shortcut}</kbd>}
    </button>
  )
}

// What the overview counts as running and as waiting on the user; it opens the overview.
function Activity() {
  const { running, counts } = useOverview()
  if (counts.running === 0 && counts.mine === 0) return null
  const agents = [...new Set(running.map((row) => row.agent))].slice(0, 3)
  const working = counts.running > 0 ? t('TitleBar.running', { count: counts.running }) : null
  const waiting = counts.mine > 0 ? t('TitleBar.waiting', { count: counts.mine }) : null
  return (
    <button type="button" className="title-bar-activity" aria-label={[working, waiting, t('TitleBar.openOverview')].filter(Boolean).join(' · ')}
      data-tooltip={t('TitleBar.openOverview')} onClick={openOverview}>
      {working && <span className="working-summary" data-state="running">
        <span className="working-stack" aria-hidden="true">{agents.map((agent, index) => <AgentIcon key={agent ?? index} agent={agent} />)}</span>
        <span className="working-label">{working}</span>
      </span>}
      {working && waiting && <span className="title-bar-activity-divider" aria-hidden="true" />}
      {waiting && <span className="working-summary" data-state="awaiting"><span className="working-label">{waiting}</span></span>}
    </button>
  )
}

function NewMenu() {
  const trigger = useRef<HTMLButtonElement>(null)
  const [at, setAt] = useState<MenuPoint | null>(null)
  const taskShortcut = useShortcutLabel('new-task')
  const select = (action: () => void) => { setAt(null); action() }
  return (
    <>
      <button ref={trigger} type="button" className="tool-button title-bar-new" aria-label={t('TitleBar.new')} aria-haspopup="menu" aria-expanded={at !== null}
        data-tooltip={t('TitleBar.new')}
        onClick={(event) => {
          const box = event.currentTarget.getBoundingClientRect()
          setAt(at ? null : { x: box.right, y: box.bottom + 4 })
        }}>
        <PlusIcon />
      </button>
      {at && <ContextMenu at={at} align="end" trigger={trigger.current} label={t('TitleBar.new')} onClose={() => setAt(null)}>
        <MenuItem icon={<ChatIcon />} label={t('ConversationList.newConversation')} onSelect={() => select(() => newConversation())} />
        <MenuItem icon={<BoardIcon />} label={t('SettingsPage.newTask')} hint={taskShortcut} onSelect={() => select(() => setNewTaskOpen(true))} />
      </ContextMenu>}
    </>
  )
}
