import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import type { StateCreator } from 'zustand'
import { beforeEach, expect, it, vi } from 'vitest'
import { AgentProfile, Conversation, Task, RpcRequest, createRpcClient, type ChatImage, type RpcConnection } from '@antumi/protocol'
import { useCore } from '../core-store'
import { proposeHandoff, useHandoffs } from '../chat-handoff'
import { useComposerHandoff, type ComposerHandoff } from './ChatHandoff'

vi.mock('zustand', async (load) => {
  const zustand = await load<typeof import('zustand')>()
  return { ...zustand, create: <T>() => (initializer: StateCreator<T>) => {
    const store = zustand.create(initializer)
    return Object.assign((selector: (state: T) => unknown) => selector(store.getState()), store)
  } }
})

beforeEach(() => {
  useCore.setState(useCore.getInitialState(), true)
  useHandoffs.setState({}, true)
})

it('offers no handoff for profile conversations, including an already pending handoff', () => {
  const profile = AgentProfile.parse({ id: '11111111-1111-4111-8111-111111111111', name: 'Reviewer', agent: 'claude', archivedAt: null, createdAt: 1, updatedAt: 1 })
  const conversation = Conversation.parse({ id: '22222222-2222-4222-8222-222222222222', title: 'Review', titleLocked: false, agent: 'claude', profile, workspacePath: '/project', projectPaths: ['/project'], managedWorkspace: false, sessionId: null, createdAt: 1, updatedAt: 1 })
  proposeHandoff(conversation.id, 'codex')
  const render = (chat: Conversation) => renderToStaticMarkup(createElement(() => {
    const handoff = useComposerHandoff(chat)
    return JSON.stringify({ targets: handoff.targets, target: handoff.target })
  }))
  expect(render(conversation)).toBe('{&quot;targets&quot;:[],&quot;target&quot;:null}')
  expect(render({ ...conversation, profile: null })).toContain('codex')
})

function readHandoff(conversation: Conversation, images: ChatImage[]): ComposerHandoff {
  const results: ComposerHandoff[] = []
  renderToStaticMarkup(createElement(() => {
    results.push(useComposerHandoff(conversation, images))
    return null
  }))
  const result = results[0]
  if (!result) throw new Error('handoff did not render')
  return result
}

it.each([false, true])('sends composer images in a handoff (task: %s) and keeps a failed handoff ready to retry', async (taskChat) => {
  const conversation = Conversation.parse({ id: '22222222-2222-4222-8222-222222222222', title: 'Review', titleLocked: false, agent: 'claude', workspacePath: '/project', projectPaths: ['/project'], managedWorkspace: false, sessionId: null, createdAt: 1, updatedAt: 1 })
  const task = Task.parse({ id: conversation.id, title: 'Review', details: 'Review this', agent: 'claude', status: 'running', repos: [{ path: '/project', worktreePath: '/project', branch: 'review', startRef: 'HEAD' }], dependsOn: [], conversationId: conversation.id, createdAt: 1, updatedAt: 1 })
  const chat = taskChat ? { ...conversation, taskId: task.id } : conversation
  const sent: ReturnType<typeof RpcRequest.parse>[] = []
  const client = createRpcClient((wire) => sent.push(RpcRequest.parse(JSON.parse(wire))))
  const rpc: RpcConnection = { ...client, features: ['handoff-images', 'task-handoff'], close() {}, closed: new Promise(() => {}) }
  useCore.setState({ rpc, tasks: taskChat ? { [task.id]: task } : {} })
  proposeHandoff(chat.id, 'codex')
  const images = [{ id: `${'a'.repeat(64)}.png`, width: 4, height: 3 }]
  const handoff = readHandoff(chat, images)
  expect(handoff.blocker).toBeNull()
  const sending = handoff.send('Look here')
  await vi.waitFor(() => expect(sent).toHaveLength(1))
  const request = sent[0]!
  expect(request).toMatchObject({ method: taskChat ? 'tasks.handoff' : 'conversations.handoff', params: { note: 'Look here', images: [images[0]!.id] } })
  client.receive(JSON.stringify({ jsonrpc: '2.0', id: request.id, error: { code: -32000, message: 'failed to start' } }))
  expect(await sending).toBe(false)
  expect(useHandoffs.getState()[chat.id]?.agent).toBe('codex')
  const retrying = handoff.send('')
  await vi.waitFor(() => expect(sent).toHaveLength(2))
  expect(sent[1]).toMatchObject({ params: { note: '', images: [images[0]!.id] } })
  client.receive(JSON.stringify({ jsonrpc: '2.0', id: sent[1]!.id, result: taskChat ? { ...task, agent: 'codex' } : { ...chat, agent: 'codex' } }))
  expect(await retrying).toBe(true)
  expect(useHandoffs.getState()[chat.id]).toBeUndefined()
})

it('blocks image handoffs on older cores while still allowing a text-only handoff', async () => {
  const conversation = Conversation.parse({ id: '22222222-2222-4222-8222-222222222222', title: 'Review', titleLocked: false, agent: 'claude', workspacePath: '/project', projectPaths: ['/project'], managedWorkspace: false, sessionId: null, createdAt: 1, updatedAt: 1 })
  const sent = vi.fn()
  const client = createRpcClient(sent)
  const rpc: RpcConnection = { ...client, features: ['chat-images'], close() {}, closed: new Promise(() => {}) }
  useCore.setState({ rpc })
  proposeHandoff(conversation.id, 'codex')
  const handoff = readHandoff(conversation, [{ id: `${'a'.repeat(64)}.png`, width: 4, height: 3 }])
  expect(handoff.blocker).toContain('不支持带图片移交')
  expect(await handoff.send('Look here')).toBe(false)
  expect(sent).not.toHaveBeenCalled()
  expect(readHandoff(conversation, []).blocker).toBeNull()
})
