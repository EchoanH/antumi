import { describe, expect, it } from 'vitest'
import { ChatItem } from '@antumi/protocol'
import { reconcileDeliveries, withDeliveries, type ChatDelivery } from './chat-deliveries'

const message: ChatDelivery = { ref: 'test-ref', text: 'hello', images: [{ id: `${'a'.repeat(64)}.png`, width: 40, height: 20 }], at: 1, phase: 'sending', error: null }
const user: ChatItem = { kind: 'user', id: 'u:test-ref', stageId: 'stage', at: 1, revision: 0, text: 'hello', images: message.images }
const state = ChatItem.parse({ kind: 'state', id: 'state', stageId: 'stage', at: 2, revision: 0, permissionMode: null, permissionModes: [], model: null, models: [], effort: null, context: null, todos: [], activity: null, queued: null, queue: [{ ref: message.ref, text: message.text, images: message.images, held: false }] })

describe('mobile message delivery receipts', () => {
  it('shows text and images immediately, then replaces the local bubble with the server item', () => {
    expect(withDeliveries([], [message])).toMatchObject([{ id: user.id, text: message.text, images: message.images }])
    expect(withDeliveries([user], [message])).toEqual([user])
  })

  it('keeps a sending status for a provisional user item, which can still fail', () => {
    expect(reconcileDeliveries([message], [user])).toEqual([message])
    const failed: ChatDelivery = { ...message, phase: 'failed', error: 'offline' }
    expect(reconcileDeliveries([failed], [user])).toEqual([failed])
  })

  it('accepts a submitted receipt before the response, including after a timeout', () => {
    expect(reconcileDeliveries([message], [{ ...user, delivery: 'submitted' }])).toEqual([])
    expect(reconcileDeliveries([{ ...message, phase: 'failed' }], [{ ...user, delivery: 'submitted' }])).toEqual([])
  })

  it('replaces a local send with its queued entry even before the response arrives', () => {
    expect(reconcileDeliveries([message], [state])).toEqual([])
    expect(reconcileDeliveries([message], [state.kind === 'state' ? { ...state, queue: state.queue.map((entry) => ({ ...entry, held: true })) } : state])).toEqual([])
  })

  it('retains accepted messages until the corresponding chat record arrives', () => {
    const sent: ChatDelivery = { ...message, phase: 'sent' }
    expect(reconcileDeliveries([sent], [])).toEqual([sent])
    expect(reconcileDeliveries([sent], [user])).toEqual([])
  })

  it('matches by reference so repeated text and other pending messages remain independent', () => {
    const second: ChatDelivery = { ...message, ref: 'second-ref', at: 2 }
    expect(withDeliveries([user], [message, second])).toHaveLength(2)
    expect(reconcileDeliveries([message, second], [state])).toEqual([second])
  })
})
