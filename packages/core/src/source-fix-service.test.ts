import { DatabaseSync } from 'node:sqlite'
import { randomUUID } from 'node:crypto'
import { mkdtempSync, rmSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, expect, it } from 'vitest'
import { AutoInvestigationConfig, Conversation, SourceSnapshot, type SourceReport, type SourceTaskProposal, type SourceTransitions, type Task } from '@antumi/protocol'
import { InvestigationRun } from './source-investigation-store'
import { SourceFixService, type FixContext } from './source-fix-service'
import { SourceFixStore } from './source-fix-store'
import { TaskStore } from './task-store'

const source = { provider: 'demo', instance: 'default', key: 'D-1', name: 'Demo', url: 'https://demo.test/D-1' }
const snapshot = SourceSnapshot.parse({ markdown: 'A reproducible defect', fetchedAt: 1, images: [] })
const id = '10000000-0000-4000-8000-000000000001'
const run = (key = id) => InvestigationRun.parse({ id: key, provider: 'demo', instance: 'default', key: 'D-1', title: 'Fix redirect', url: source.url, status: 'completed', conversationId: key, reason: null, message: null, attempts: 1, retryAt: null, createdAt: 1, updatedAt: 2, startedAt: 1, canRetry: false, binding: 'account', scope: 'mine', submitted: true, config: AutoInvestigationConfig.parse({ enabled: true, agent: 'codex', projectPaths: ['/repo'], autoFix: { enabled: true } }) })
let dir: string
let db: DatabaseSync
let tasks: TaskStore
let store: SourceFixStore
let service: SourceFixService
let candidates: InvestigationRun[]
let allowed: boolean
let facts: SourceTransitions | null
let proposal: SourceTaskProposal
let report: SourceReport | null
let turn: 'running' | 'idle' | 'awaiting'
let receipt: 'submitted' | 'uncertain' | null
let revision: string
let checks: string[] | null
let delivered: number
let started: string[]
let sent: string[]
let sequence: string[]
let duringCheck: (() => void) | null
let duringPrepare: (() => void) | null
let capacity: boolean

const testDependencies = (): ConstructorParameters<typeof SourceFixService>[1] => ({
  candidates: () => candidates,
  allowed: () => allowed,
  taskReport: () => report,
  task: (taskId) => tasks.get(taskId),
  conversation: (task) => task.conversationId ? Conversation.parse({ id: task.conversationId, title: task.title, titleLocked: true, agent: 'codex', workspacePath: '/wt', projectPaths: ['/wt'], managedWorkspace: false, sessionId: 'session', createdAt: 1, updatedAt: 1, chat: { turn } }) : null,
  capacity: () => capacity,
  validate: async () => {},
  prepare: async () => { duringPrepare?.(); return { source, snapshot, facts } },
  create: async (_run, context: FixContext, task, link) => tasks.create(task.title, { agent: task.agent, details: task.details, launch: { model: task.model ?? null, effort: task.effort ?? null, modelProvider: task.modelProvider ?? null }, dependsOn: task.dependsOn, source: context.source, sourceSnapshot: context.snapshot, repos: task.repos.map((repo) => ({ path: repo.path, worktreePath: null, branch: null, startRef: repo.startRef ?? null, start: null, reference: repo.reference ?? false })) }, link),
  start: async (task) => {
    started.push(task.id)
    db.prepare("INSERT INTO conversations (id,title,title_locked,agent,workspace_path,project_paths,managed_workspace,task_id,created_at,updated_at) VALUES (?, 'Fix redirect', 1, 'codex', '/wt', '[\"/wt\"]', 0, ?, 1, 1)").run(randomUUID(), task.id)
    tasks.update(task.id, { status: 'running' })
  },
  receipt: () => receipt,
  revision: async () => revision,
  check: async () => { sequence.push('check'); duringCheck?.(); return checks },
  repair: async (_task, _text, ref) => { sent.push(ref); turn = 'running'; if (report) report = { ...report, updatedAt: report.updatedAt + 1 } },
  deliver: async () => { sequence.push('pr'); delivered++; return { urls: ['https://github.com/demo/repo/pull/1'], local: [] } },
  finish: (task: Task) => { sequence.push('review'); tasks.update(task.id, { status: 'review' }) },
  transferred: () => {},
  changed: () => {}
})
const make = () => new SourceFixService(store, testDependencies())
// The investigation opening its task, then core taking it from there.
const open = async (fixes = service) => { const task = await fixes.create(run(), proposal); await fixes.tick(); return task }

beforeEach(() => {
  dir = mkdtempSync(path.join(os.tmpdir(), 'antumi-source-fix-'))
  tasks = new TaskStore(path.join(dir, 'core.db'))
  store = new SourceFixStore(path.join(dir, 'core.db'))
  db = new DatabaseSync(path.join(dir, 'core.db'))
  candidates = [run()]; allowed = true
  facts = { status: 'Open', statusCategory: 'todo', options: [], viewer: { id: 'me', name: 'Me' }, assignees: [{ id: 'me', name: 'Me' }], type: { id: 'bug', name: 'Bug' } }
  proposal = { title: 'Fix redirect', details: 'Preserve the return URL and add a regression test.', agent: 'codex', repos: [{ path: '/repo' }] }
  report = { text: 'Fixed the redirect.', updatedAt: 3, outcome: 'delivered' }
  capacity = true; turn = 'running'; receipt = 'submitted'; revision = 'commit-1'; checks = []; delivered = 0; started = []; sent = []; sequence = []; duringCheck = null; duringPrepare = null
  service = make()
})
afterEach(async () => { await service.close(); db.close(); tasks.close(); rmSync(dir, { recursive: true, force: true }) })

it('creates one source-linked task atomically, refuses a second, and resumes after a restart', async () => {
  const task = await open()
  expect(store.get(id)?.taskId).toBe(task.id)
  expect(tasks.get(task.id)?.source).toEqual(source)
  await expect(service.create(run(), proposal)).rejects.toMatchObject({ reason: 'source-already-imported' })
  await service.tick()
  expect(tasks.list()).toHaveLength(1)
  // A new service reads the same durable row; neither the task nor its first message repeats.
  service = make()
  await service.tick()
  expect(tasks.list()).toHaveLength(1)
  expect(started).toHaveLength(1)
})

it('keeps the task parameters the investigation chose', async () => {
  const dependency = tasks.create('Prepare the API')
  tasks.update(dependency.id, { status: 'done' })
  proposal = {
    title: 'Repair the API redirect', details: 'Keep the return URL. Verify the API regression test.',
    agent: 'claude', model: 'worker-model', effort: 'high', modelProvider: null,
    dependsOn: [dependency.id],
    repos: [{ path: '/api', startRef: 'refs/heads/develop' }, { path: '/web', reference: true }]
  }
  const linked = await open()
  expect(linked).toMatchObject({ title: proposal.title, details: proposal.details, agent: 'claude', dependsOn: [dependency.id], launch: { model: 'worker-model', effort: 'high', modelProvider: null } })
  expect(linked.repos.map(({ path, startRef, reference }) => ({ path, startRef, reference: !!reference }))).toEqual([
    { path: '/api', startRef: 'refs/heads/develop', reference: false }, { path: '/web', startRef: null, reference: true }
  ])
})

it('opens a task whoever the issue is assigned to, and for any type but a pull request', async () => {
  facts = { ...facts!, assignees: [{ id: 'qa', name: 'QA' }], type: { id: 'story', name: 'Story' } }
  await open()
  expect(tasks.list()).toHaveLength(1)
})

it.each([
  ['a pull request', () => { facts = { ...facts!, type: { id: 'pull-request', name: 'Pull Request' } } }, 'source-pull-request'],
  ['a finished issue', () => { facts = { ...facts!, statusCategory: 'done' } }, 'source-done'],
  ['a source not allowing tasks', () => { allowed = false }, 'invalid-configuration']
])('refuses %s with why, and creates nothing', async (_name, arrange, reason) => {
  arrange()
  await expect(service.create(run(), proposal)).rejects.toMatchObject({ reason })
  expect(tasks.list()).toEqual([])
})

it('goes ahead for a source that says nothing of the issue', async () => {
  facts = null
  await open()
  expect(tasks.list()).toHaveLength(1)
})

it('returns what the worker check refuses, so the investigation can correct it', async () => {
  const invalid = new SourceFixService(store, { ...testDependencies(), validate: async () => { throw new Error('worker-model is unavailable') } })
  await expect(invalid.create(run(), proposal)).rejects.toThrow('worker-model is unavailable')
  expect(tasks.list()).toEqual([])
  expect(started).toEqual([])
})

it('does not create a task when the source is in dry-run mode', async () => {
  const dry = new SourceFixService(store, { ...testDependencies(), prepare: async () => ({ source, snapshot, facts, dryRun: true }) })
  await expect(dry.create(run(), proposal)).rejects.toMatchObject({ reason: 'source-dry-run' })
  expect(tasks.list()).toEqual([])
})

it('creates the task at once and starts it when its agent has room', async () => {
  capacity = false
  const task = await open()
  expect(started).toEqual([])
  expect(store.get(id)).toMatchObject({ taskId: task.id, state: 'preparing' })
  capacity = true; await service.tick()
  expect(started).toEqual([task.id])
})

it('checks before opening a PR and enters review only after delivery', async () => {
  await open(); turn = 'idle'; await service.tick()
  expect(sequence).toEqual(['check', 'pr', 'review'])
  expect(store.get(id)).toMatchObject({ state: 'ready', urls: ['https://github.com/demo/repo/pull/1'] })
  await service.tick(); expect(delivered).toBe(1)
})

it('does not deliver without project checks or when the agent needs input', async () => {
  await open(); checks = null; turn = 'idle'; await service.tick()
  expect(store.get(id)?.state).toBe('waiting-user'); expect(delivered).toBe(0)
})

it('goes on once the user answers the task agent, also after a restart', async () => {
  await open(); turn = 'awaiting'; await service.tick()
  expect(store.get(id)).toMatchObject({ state: 'waiting-user', awaitsAnswer: true })
  await service.tick(); expect(store.get(id)?.state).toBe('waiting-user')
  turn = 'running'; service = make()
  await service.tick(); expect(store.get(id)).toMatchObject({ state: 'working', awaitsAnswer: false, message: null })
  turn = 'idle'; await service.tick()
  expect(store.get(id)?.state).toBe('ready'); expect(delivered).toBe(1)
})

it('leaves a wait that is not on an answer for the user to clear', async () => {
  await open(); report = null; turn = 'idle'; await service.tick()
  expect(store.get(id)?.state).toBe('waiting-user')
  report = { text: 'Fixed the redirect.', updatedAt: 4, outcome: 'delivered' }; await service.tick()
  expect(store.get(id)?.state).toBe('waiting-user'); expect(delivered).toBe(0)
})

it('returns failed checks to the same task with stable references, then stops after three attempts', async () => {
  await open(); checks = ['test failed']
  for (let i = 0; i < 3; i++) { turn = 'idle'; await service.tick() }
  expect(tasks.list()).toHaveLength(1)
  expect(sent).toEqual([`source-fix-check:${id}:1`, `source-fix-check:${id}:2`])
  expect(store.get(id)).toMatchObject({ state: 'failed', attempts: 3 })
  expect(delivered).toBe(0)
})

it('will not deliver if code changes during checks', async () => {
  await open(); turn = 'idle'; duringCheck = () => { revision = 'commit-2' }; await service.tick()
  expect(delivered).toBe(0); expect(store.get(id)?.state).toBe('failed')
})

it('rechecks the issue before external delivery and keeps the local task', async () => {
  await open(); turn = 'idle'; facts = { ...facts!, statusCategory: 'done' }; await service.tick()
  expect(delivered).toBe(0); expect(tasks.list()).toHaveLength(1); expect(store.get(id)?.state).toBe('waiting-user')
})

it('stops when the user takes the task over, not when they take over the investigation', async () => {
  const task = await open()
  service.takeover(id)
  expect(store.get(id)?.state).toBe('working')
  service.takeover(tasks.get(task.id)!.conversationId!)
  expect(store.get(id)?.state).toBe('handed-over')
})

it('never re-creates a deleted task', async () => {
  const task = await open(); tasks.delete(task.id)
  await service.tick()
  expect(tasks.list()).toHaveLength(0); expect(store.get(id)?.state).toBe('failed')
})

it('does not treat a missing delivery report as permission to publish a PR', async () => {
  await open(); turn = 'idle'; report = null; await service.tick()
  expect(delivered).toBe(0)
  expect(store.get(id)?.state).toBe('waiting-user')
})

it('does not overwrite takeover during the task creation transaction', async () => {
  const record = store.save({ id, taskId: null, state: 'preparing', urls: [], message: null, attempts: 0, revision: null })
  const link = store.taskLink(record, source)
  store.save({ ...record, state: 'handed-over' })
  expect(() => tasks.create('Should roll back', { source, sourceSnapshot: snapshot }, link)).toThrow()
  expect(tasks.list()).toEqual([])
  expect(store.get(id)?.state).toBe('handed-over')
})

it('refuses a second task for an issue imported by hand, and lets the investigation try again', async () => {
  const manual = tasks.create('Manual task', { source, sourceSnapshot: snapshot })
  await expect(service.create(run(), proposal)).rejects.toMatchObject({ reason: 'source-already-imported' })
  expect(store.get(id)?.state).toBe('failed')
  tasks.delete(manual.id)
  await open()
  expect(tasks.list()).toHaveLength(1)
})

it('marks a record core stopped before its task as failed, for the investigation to open again', async () => {
  store.save({ id, taskId: null, state: 'preparing', urls: [], message: null, attempts: 0, revision: null })
  await service.tick()
  expect(store.get(id)?.state).toBe('failed')
  await open()
  expect(tasks.list()).toHaveLength(1)
})

it('stops before publishing if the user takes over during project checks', async () => {
  const task = await open(); turn = 'idle'; duringCheck = () => service.takeover(tasks.get(task.id)!.conversationId!)
  await service.tick()
  expect(delivered).toBe(0)
  expect(store.get(id)?.state).toBe('handed-over')
})
