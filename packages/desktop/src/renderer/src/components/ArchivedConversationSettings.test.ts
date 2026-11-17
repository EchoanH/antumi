import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { StateCreator } from 'zustand'
import { Conversation } from '@antumi/protocol'
import { useCore } from '../core-store'
import { archivedByProject } from '../archived-conversations'
import { projectName } from './ProjectPicker'
import { ArchivedConversationSettings } from './ArchivedConversationSettings'

vi.mock('zustand', async (original) => {
  const actual = await original<typeof import('zustand')>()
  return { ...actual, create: <T>() => (initializer: StateCreator<T>) => {
    const store = actual.create(initializer)
    return Object.assign((selector: (state: T) => unknown) => selector(store.getState()), store)
  } }
})

const id = (n: number) => `${String(n).padStart(8, '0')}-0000-4000-8000-000000000000`
const chat = (n: number, title: string, archivedAt: number | null, projectPaths: string[] = [], extra: Partial<Conversation> = {}) => Conversation.parse({
  id: id(n), title, titleLocked: false, agent: 'claude', workspacePath: '/w', projectPaths, managedWorkspace: false,
  sessionId: null, createdAt: n, updatedAt: n, archivedAt, ...extra
})

describe('archivedByProject', () => {
  it('keeps the archived listed ones, by project, the unprojected last and the latest archived first', () => {
    const groups = archivedByProject([
      chat(1, '在用', null, ['/p/zeta']),
      chat(2, '旧的', 10, ['/p/zeta']),
      chat(3, '新的', 20, ['/p/zeta', '/p/alpha']),
      chat(4, '无项目', 30),
      chat(5, '阿尔法', 5, ['/p/alpha']),
      chat(6, '委派', 40, ['/p/alpha'], { parentConversationId: id(5) })
    ], projectName)
    expect(groups.map((group) => [group.project, group.conversations.map((each) => each.title)])).toEqual([
      ['/p/alpha', ['阿尔法']],
      ['/p/zeta', ['新的', '旧的']],
      [null, ['无项目']]
    ])
  })
})

describe('archived conversations settings', () => {
  beforeEach(() => {
    useCore.setState(useCore.getInitialState(), true)
    useCore.setState({ connection: 'connected', conversations: { [id(1)]: chat(1, '在用的会话', null), [id(2)]: chat(2, '归档的会话', 5, ['/p/app']) } })
  })

  it('lists only the archived ones, with a checkbox for the project and nothing picked', () => {
    const html = renderToStaticMarkup(createElement(ArchivedConversationSettings))
    expect(html).toContain('归档的会话')
    expect(html).not.toContain('在用的会话')
    expect(html).toContain('选择 app 里的全部已归档会话')
    expect(html).toMatch(/<button[^>]*disabled=""[^>]*>删除所选（0）/)
  })

  it('says when there is nothing archived', () => {
    useCore.setState({ conversations: { [id(1)]: chat(1, '在用的会话', null) } })
    expect(renderToStaticMarkup(createElement(ArchivedConversationSettings))).toContain('没有已归档的会话')
  })
})
