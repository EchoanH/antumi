import { t } from '../i18n'
import { useEffect, useRef, useState, type KeyboardEvent, type PointerEvent, type ReactNode } from 'react'
import { setPreference, usePreferences } from '../preferences'
import { clampSidebarWidth, COLLAPSED_NAVIGATION_WIDTH, DEFAULT_CONVERSATION_LIST_WIDTH, DEFAULT_SIDEBAR_WIDTH, MIN_SIDEBAR_WIDTH, SIDEBAR_WIDTH_STEP, sidebarMaxWidth } from '../sidebar-width'
import { SidebarNavigation } from './SidebarNavigation'

// The lists down the window's left. Its right edge drags to resize it between the limits in
// sidebar-width.ts, the arrow keys nudge it, and a double-click puts it back. While dragging only
// this element re-renders (the lists come in as children); the width is saved on release.
// With the menu collapsed to icons, they stand in a column of their own beside it, with a width
// of its own, and can be put away while the icons stay.
export function Sidebar({ children }: { children: ReactNode }) {
  const collapsed = usePreferences((p) => p.sidebarMenuCollapsed)
  const widthKey = collapsed ? 'conversationListWidth' : 'sidebarWidth'
  const saved = usePreferences((p) => p[widthKey])
  const hidden = usePreferences((p) => p.sidebarHidden) && collapsed
  const navigationWidth = collapsed ? COLLAPSED_NAVIGATION_WIDTH : 0
  const [windowWidth, setWindowWidth] = useState(() => typeof window === 'undefined' ? 1280 : window.innerWidth)
  const [dragged, setDragged] = useState<number | null>(null)
  const sidebar = useRef<HTMLDivElement>(null)
  // Where on the edge it was grabbed, so a click without a move leaves the width as it is.
  const grab = useRef(0)
  const width = dragged ?? saved
  const dragging = dragged !== null
  // What shows: a small window caps the saved width (styles.css does the same as it resizes).
  const shown = clampSidebarWidth(width, windowWidth, navigationWidth)

  useEffect(() => {
    const resize = () => setWindowWidth(window.innerWidth)
    window.addEventListener('resize', resize)
    return () => window.removeEventListener('resize', resize)
  }, [])

  useEffect(() => {
    if (!dragging) {
      return
    }
    document.body.classList.add('side-panel-resizing')
    return () => document.body.classList.remove('side-panel-resizing')
  }, [dragging])

  const pointerOffset = (event: PointerEvent<HTMLDivElement>) => event.clientX - (sidebar.current?.getBoundingClientRect().left ?? 0)
  const commit = () => {
    if (dragged !== null) {
      setPreference(widthKey, dragged)
    }
    setDragged(null)
  }
  const stopDragging = (event: PointerEvent<HTMLDivElement>) => {
    if (event.currentTarget.hasPointerCapture(event.pointerId)) {
      event.currentTarget.releasePointerCapture(event.pointerId)
    }
    commit()
  }
  const handleKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    const next =
      event.key === 'ArrowLeft' ? shown - SIDEBAR_WIDTH_STEP :
      event.key === 'ArrowRight' ? shown + SIDEBAR_WIDTH_STEP :
      event.key === 'Home' ? MIN_SIDEBAR_WIDTH :
      event.key === 'End' ? sidebarMaxWidth(windowWidth, navigationWidth) :
      null
    if (next === null) {
      return
    }
    event.preventDefault()
    setPreference(widthKey, clampSidebarWidth(next, windowWidth, navigationWidth))
  }

  return (
    <aside id="sidebar" className="sidebar" data-menu-collapsed={collapsed} data-list-hidden={hidden} style={{ '--sidebar-width': `${width}px`, '--sidebar-navigation-width': `${navigationWidth}px` }}>
      {collapsed && <SidebarNavigation />}
      <div ref={sidebar} id="sidebar-conversation-panel" className="sidebar-conversations" hidden={hidden}>
      {children}
      <div
        className="sidebar-resizer"
        data-dragging={dragging}
        role="separator"
        aria-label={t('Sidebar.resizeSidebar')}
        aria-orientation="vertical"
        aria-valuemin={MIN_SIDEBAR_WIDTH}
        aria-valuemax={sidebarMaxWidth(windowWidth, navigationWidth)}
        aria-valuenow={shown}
        aria-valuetext={t('Sidebar.sidebarWidthPixels', { shown: shown })}
        title={t('Sidebar.dragToResizeDoubleClickToReset')}
        tabIndex={0}
        onKeyDown={handleKeyDown}
        onDoubleClick={() => setPreference(widthKey, collapsed ? DEFAULT_CONVERSATION_LIST_WIDTH : DEFAULT_SIDEBAR_WIDTH)}
        onPointerDown={(event) => {
          if (event.button !== 0) {
            return
          }
          event.preventDefault()
          event.currentTarget.setPointerCapture(event.pointerId)
          grab.current = pointerOffset(event) - shown
          setDragged(shown)
        }}
        onPointerMove={(event) => dragging && setDragged(clampSidebarWidth(pointerOffset(event) - grab.current, windowWidth, navigationWidth))}
        onPointerUp={stopDragging}
        onPointerCancel={stopDragging}
        onLostPointerCapture={commit}
      />
      </div>
    </aside>
  )
}
