import { mkdtempSync, rmSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { EMPTY_WRITEBACK, pickTransition, Task, type SourceTransitions, type SourceUpdateTarget, type SourceWritebackConfig, type TaskSource } from '@antumi/protocol'
import { Rejection } from './rejection'
import { SourceWriteback } from './source-writeback'
import { SourceWritebackStore } from './source-writeback-store'
import { TaskStore } from './task-store'

const source: TaskSource = { provider: 'demo', instance: 'default', key: 'D-1', name: 'Demo', url: 'https://example.test/D-1' }
const target: SourceUpdateTarget = { kind: 'task', id: 'task-1' }
const task = (status: Task['status']) => Task.parse({ id: 'task-1', title: 'Fix login', details: '', status, repos: [], dependsOn: [], agent: null, source, createdAt: 1, updatedAt: 1 })
const open: SourceTransitions = {
  status: 'Open', statusCategory: 'todo',
  options: [{ id: '21', name: 'In Progress', action: 'Start', category: 'doing' }, { id: '31', name: 'In Review', category: 'doing' }, { id: '41', name: 'Done', category: 'done' }]
}

describe('pickTransition', () => {
  it('takes the first name that matches one option, by status or by action, ignoring case', () => {
    expect(pickTransition(open, 'Missing | in review')).toEqual({ option: open.options[1] })
    expect(pickTransition(open, 'start')).toEqual({ option: open.options[0] })
  })
  it('skips a status the issue is in, or one behind it, and leaves an ambiguous name alone', () => {
    expect(pickTransition(open, 'open')).toEqual({ skip: 'already' })
    expect(pickTransition({ status: 'Closed', statusCategory: 'done', options: [{ id: '1', name: 'In Progress', category: 'doing' }] }, 'In Progress')).toEqual({ skip: 'backwards' })
    expect(pickTransition({ ...open, options: [{ id: '1', name: 'Done', action: 'Resolve', category: 'done' }, { id: '2', name: 'Done', action: 'Close', category: 'done' }] }, 'Done')).toBeNull()
  })
})

describe('source writeback', () => {
  let root: string
  let tasks: TaskStore
  let store: SourceWritebackStore
  let writeback: SourceWriteback
  let rules: SourceWritebackConfig
  let transitions: SourceTransitions
  let comments: { markdown: string; writeId: string }[]
  let moves: string[]
  let commentFailure: Error | null
  let reply: string | null
  let now: number

  const writer = {
    comments: true,
    transitions: async () => transitions,
    transition: async (id: string) => {
      moves.push(id)
      const option = transitions.options.find((each) => each.id === id)!
      transitions = { ...transitions, status: option.name, statusCategory: option.category }
      return { status: option.name, statusCategory: option.category }
    },
    comment: async (markdown: string, writeId: string) => {
      if (commentFailure) throw commentFailure
      comments.push({ markdown, writeId })
      return { id: `c-${comments.length}`, url: `https://example.test/D-1#c-${comments.length}` }
    }
  }
  const settled = async () => { for (let i = 0; i < 5; i++) await new Promise<void>((resolve) => setImmediate(resolve)) }

  beforeEach(() => {
    root = mkdtempSync(path.join(os.tmpdir(), 'antumi-source-writeback-'))
    tasks = new TaskStore(path.join(root, 'test.db'))
    store = new SourceWritebackStore(path.join(root, 'test.db'))
    rules = EMPTY_WRITEBACK
    transitions = open
    comments = []
    moves = []
    commentFailure = null
    reply = 'Fixed the redirect after sign-in.'
    now = 1000
    writeback = new SourceWriteback(store, { writer: () => writer, writebackRules: () => rules }, {
      owner: (ref) => (ref.kind === 'task' && ref.id === 'task-1' ? { target: ref, source, conversationId: 'chat-1' } : null),
      lastReply: () => reply,
      changed: () => {}
    }, () => now++)
  })
  afterEach(() => { store.close(); tasks.close(); rmSync(root, { recursive: true, force: true }) })

  it('moves the issue by hand to a status it offers, and refuses one it no longer does', async () => {
    const write = await writeback.transition(target, '21')
    expect(write).toMatchObject({ kind: 'status', trigger: 'manual', state: 'sent', detail: 'In Progress', result: 'In Progress' })
    await expect(writeback.transition(target, '99')).rejects.toThrow(Rejection)
  })

  it('posts a comment by hand and takes its id as Antumi’s own', async () => {
    const write = await writeback.comment(target, '  Looks good  ')
    expect(write).toMatchObject({ kind: 'comment', state: 'sent', detail: 'Looks good', origin: 'user', result: 'c-1' })
    expect(comments[0]?.writeId).toBe(write.id)
    expect([...writeback.ownComments(source)]).toEqual(['c-1'])
  })

  it('follows the rules as the task starts, goes for review and is accepted', async () => {
    rules = { start: { status: 'In Progress' }, review: { status: 'In Review', comment: true }, done: { status: 'Done', comment: true }, guidance: '' }
    writeback.saveReport(target, 'Fixed the redirect; see PR #12.')
    writeback.taskMoved(task('pending'), task('running'))
    await settled()
    writeback.taskMoved(task('running'), task('review'))
    await settled()
    writeback.taskMoved(task('review'), task('done'))
    await settled()
    expect(moves).toEqual(['21', '31', '41'])
    // Done does not post again what review already did.
    expect(comments.map((comment) => comment.markdown)).toEqual(['Fixed the redirect; see PR #12.'])
    expect(writeback.view(target).writes.find((write) => write.kind === 'comment')).toMatchObject({ trigger: 'review', origin: 'report' })
  })

  it('starts once: going on after review or starting a redo moves nothing', async () => {
    rules = { ...EMPTY_WRITEBACK, start: { status: 'In Progress' } }
    writeback.taskMoved(task('pending'), task('running'))
    await settled()
    transitions = open
    writeback.taskMoved(task('review'), task('running'))
    writeback.taskMoved(task('pending'), task('running'))
    await settled()
    expect(moves).toEqual(['21'])
  })

  it('records a status it cannot reach, or one behind the issue, as skipped', async () => {
    rules = { ...EMPTY_WRITEBACK, start: { status: 'Doing' } }
    writeback.taskMoved(task('pending'), task('running'))
    await settled()
    expect(writeback.view(target).writes[0]).toMatchObject({ state: 'skipped', reason: expect.stringContaining('Doing') })
    rules = { ...EMPTY_WRITEBACK, review: { status: 'In Progress', comment: false } }
    transitions = { status: 'Done', statusCategory: 'done', options: [{ id: '21', name: 'In Progress', category: 'doing' }] }
    writeback.taskMoved(task('running'), task('review'))
    await settled()
    expect(moves).toEqual([])
    expect(writeback.view(target).writes[0]).toMatchObject({ state: 'skipped', reason: expect.stringContaining('不往回改') })
  })

  it('posts the last reply only as the small model condenses it, never as it is', async () => {
    const asked: string[][] = []
    writeback.setCondenser(async (conversationId, platform, text, guidance) => { asked.push([conversationId, platform, text, guidance]); return 'Login returns to the page you were on.' })
    rules = { ...EMPTY_WRITEBACK, review: { status: '', comment: true }, guidance: 'Write in English' }
    writeback.taskMoved(task('running'), task('review'))
    await settled()
    expect(asked).toEqual([['chat-1', 'Demo', 'Fixed the redirect after sign-in.', 'Write in English']])
    expect(comments[0]?.markdown).toBe('Login returns to the page you were on.')
    expect(writeback.view(target).writes[0]).toMatchObject({ origin: 'last-reply' })
  })

  it('posts no comment when the reply cannot be condensed', async () => {
    writeback.setCondenser(async () => null)
    rules = { ...EMPTY_WRITEBACK, review: { status: '', comment: true } }
    writeback.taskMoved(task('running'), task('review'))
    await settled()
    expect(comments).toEqual([])
    expect(writeback.view(target).writes[0]).toMatchObject({ kind: 'comment', state: 'skipped', reason: expect.stringContaining('压缩') })
  })

  it('sends a summary past the limit back to the agent to shorten', () => {
    expect(() => writeback.saveReport(target, 'x'.repeat(601))).toThrow(/601 字/)
    expect(writeback.view(target).report).toBeNull()
  })

  it('posts nothing, and says so, when there is neither a summary nor a reply', async () => {
    reply = null
    rules = { ...EMPTY_WRITEBACK, review: { status: '', comment: true } }
    writeback.taskMoved(task('running'), task('review'))
    await settled()
    expect(comments).toEqual([])
    expect(writeback.view(target).writes[0]).toMatchObject({ kind: 'comment', state: 'skipped' })
  })

  it('does not post a comment twice when its result is unknown, but retries it when asked', async () => {
    commentFailure = new Error('socket hang up')
    const write = await writeback.comment(target, 'Ready for review')
    expect(write).toMatchObject({ state: 'uncertain', reason: 'socket hang up' })
    commentFailure = null
    const again = await writeback.retry(write.id)
    expect(again).toMatchObject({ state: 'sent', detail: 'Ready for review' })
    expect(store.write(write.id)).toMatchObject({ state: 'skipped' })
  })

  it('takes a refusal from the tracker as a failure, and a token without write access as such', async () => {
    commentFailure = new Rejection('source-forbidden', 'token is read-only')
    const write = await writeback.comment(target, 'Ready for review')
    expect(write).toMatchObject({ state: 'failed', reason: '没有写权限：token is read-only' })
  })

  it('skips a rule’s comment, and refuses one by hand, where the tracker takes none', async () => {
    const statusOnly = new SourceWriteback(store, { writer: () => ({ ...writer, comments: false }), writebackRules: () => ({ ...EMPTY_WRITEBACK, review: { status: '', comment: true } }) }, {
      owner: (ref) => ({ target: ref, source, conversationId: 'chat-1' }), lastReply: () => reply, changed: () => {}
    })
    expect(statusOnly.view(target).comments).toBe(false)
    expect(() => statusOnly.comment(target, 'hello')).toThrow(Rejection)
    statusOnly.taskMoved(task('running'), task('review'))
    await settled()
    expect(comments).toEqual([])
    expect(statusOnly.view(target).writes[0]).toMatchObject({ kind: 'comment', state: 'skipped' })
  })

  it('settles a write left pending by a stop as uncertain', () => {
    store.saveWrite({ id: '6f1d3a0e-5d0c-4c1f-8f3a-2f2b8f0b6c11', target, provider: 'demo', instance: 'default', key: 'D-1', kind: 'comment', trigger: 'manual', detail: 'x', origin: 'user', state: 'pending', result: null, url: null, reason: null, createdAt: 1, updatedAt: 1 })
    const restarted = new SourceWriteback(store, { writer: () => writer, writebackRules: () => rules }, { owner: () => null, lastReply: () => null, changed: () => {} })
    expect(restarted).toBeDefined()
    expect(store.write('6f1d3a0e-5d0c-4c1f-8f3a-2f2b8f0b6c11')).toMatchObject({ state: 'uncertain' })
  })
})
