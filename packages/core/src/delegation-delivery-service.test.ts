import { randomUUID } from 'node:crypto'
import { mkdtempSync, rmSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { Conversation } from '@antumi/protocol'
import { DelegationDeliveryService, type DelegationEntry, type DelegationResultSource } from './delegation-delivery-service'
import type { ConversationService } from './conversation-service'
import { TaskStore } from './task-store'

describe('durable delegation result delivery', () => {
  let root: string
  let tasks: TaskStore
  let delivery: DelegationDeliveryService
  let parent: Conversation
  let chats: Pick<ConversationService, 'get' | 'turnOver' | 'capacityAvailable' | 'resumeDelegation' | 'send' | 'sentRef' | 'agentIdle' | 'stop'>
  let entries: DelegationEntry[]
  let acknowledgeFails: boolean
  let accepted: Map<string, string>
  const result = (source: string): DelegationEntry => {
    const id = randomUUID()
    return { source, key: id, version: 1, body: { callId: id, name: source, state: 'review', result: 'done' } }
  }
  const source = (name: string): DelegationResultSource => ({
    name, parents: () => [parent.id], pending: () => entries.filter((entry) => entry.source === name),
    acknowledge: (given) => {
      if (acknowledgeFails) throw new Error('simulated crash after send')
      const ids = new Set(given.map((entry) => entry.key))
      entries = entries.filter((entry) => !ids.has(entry.key))
    }, active: () => false, writing: () => false
  })
  beforeEach(() => {
    root = mkdtempSync(path.join(os.tmpdir(), 'antumi-delegation-delivery-'))
    tasks = new TaskStore(path.join(root, 'antumi.db'))
    parent = Conversation.parse({ id: randomUUID(), title: 'Parent', titleLocked: false, agent: 'claude', workspacePath: root,
      projectPaths: [root], managedWorkspace: false, sessionId: 'session', createdAt: 1, updatedAt: 1, chat: { turn: 'idle' } })
    entries = []; accepted = new Map(); acknowledgeFails = false
    chats = { get: () => parent, turnOver: () => true, capacityAvailable: () => true, resumeDelegation: async () => parent,
      send: vi.fn(async (_id, text, _images, _bypass, _interrupt, ref) => { if (ref && !accepted.has(ref)) accepted.set(ref, text); }),
      sentRef: (_id, ref) => accepted.has(ref), agentIdle: () => true, stop: vi.fn(async () => parent) }
    delivery = new DelegationDeliveryService(path.join(root, 'antumi.db'), chats)
    delivery.register(source('agent')); delivery.register(source('squad'))
  })
  afterEach(async () => { await delivery.close(); tasks.close(); rmSync(root, { recursive: true, force: true }) })
  it('batches agent and team results into one caller turn through the same source interface', async () => {
    entries = [result('agent'), result('squad')]
    delivery.tick()
    await expect.poll(() => accepted.size).toBe(1)
    expect([...accepted.values()][0]).toContain('squad')
    expect([...accepted.values()][0]).toContain('agent')
    expect(entries).toEqual([])
    delivery.tick(); await delivery.close()
    expect(accepted.size).toBe(1)
  })
  it('replays a frozen batch after restart before including newer results', async () => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => {})
    entries = [result('squad')]; acknowledgeFails = true
    delivery.tick()
    await expect.poll(() => error.mock.calls.length).toBe(1)
    const firstRef = [...accepted.keys()][0]!
    const firstText = accepted.get(firstRef)
    await delivery.close()
    entries.push(result('agent')); acknowledgeFails = false
    delivery = new DelegationDeliveryService(path.join(root, 'antumi.db'), chats)
    delivery.register(source('agent')); delivery.register(source('squad'))
    delivery.tick()
    await expect.poll(() => entries.length).toBe(1)
    expect(accepted.size).toBe(1)
    expect(accepted.get(firstRef)).toBe(firstText)
    delivery.tick()
    await expect.poll(() => accepted.size).toBe(2)
    expect(entries).toEqual([])
    error.mockRestore()
  })
  it('holds results while the parent is busy, archived, or has a shared writer', async () => {
    entries = [result('squad')]
    parent.chat = { turn: 'running' }; chats.turnOver = () => false
    delivery.tick(); await new Promise((resolve) => setTimeout(resolve, 20))
    expect(accepted.size).toBe(0)
    parent.chat = { turn: 'idle' }; parent.archivedAt = Date.now()
    delivery.tick(); await new Promise((resolve) => setTimeout(resolve, 20))
    expect(accepted.size).toBe(0)
    parent.archivedAt = null
    delivery.register({ ...source('agent'), writing: () => true })
    delivery.tick(); await new Promise((resolve) => setTimeout(resolve, 20))
    expect(accepted.size).toBe(0)
    delivery.register(source('agent')); delivery.tick()
    await expect.poll(() => accepted.size).toBe(1)
  })
  it('does not replay an unsent result read while the caller could not resume', async () => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => {})
    parent.sessionId = null
    entries = [result('squad')]
    chats.resumeDelegation = async () => { throw new Error('temporarily unavailable') }
    delivery.tick()
    await expect.poll(() => error.mock.calls.length).toBe(1)
    entries = []
    chats.resumeDelegation = vi.fn(async () => parent)
    delivery.tick()
    await new Promise((resolve) => setTimeout(resolve, 20))
    expect(chats.resumeDelegation).not.toHaveBeenCalled()
    expect(accepted.size).toBe(0)
    error.mockRestore()
  })
  it('accepts another outcome source without changing the delivery algorithm', async () => {
    entries = [result('another')]
    delivery.register(source('another')); delivery.tick()
    await expect.poll(() => accepted.size).toBe(1)
    expect(entries).toEqual([])
  })
})
