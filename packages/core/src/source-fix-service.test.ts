import { DatabaseSync } from 'node:sqlite'
import { randomUUID } from 'node:crypto'
import { mkdtempSync, rmSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, expect, it } from 'vitest'
import { MAX_SNAPSHOT_LENGTH, AutoInvestigationConfig, Conversation, SourceSnapshot, type SourceReport, type SourceTransitions, type Task } from '@antumi/protocol'
import { InvestigationRun } from './source-investigation-store'
import { SourceFixService, fixSnapshot, type FixContext } from './source-fix-service'
import { SourceFixStore } from './source-fix-store'
import { TaskStore } from './task-store'

const source = { provider: 'demo', instance: 'default', key: 'D-1', name: 'Demo', url: 'https://demo.test/D-1' }
const snapshot = SourceSnapshot.parse({ markdown: 'A reproducible defect', fetchedAt: 1, images: [] })
const id = '10000000-0000-4000-8000-000000000001'
const run = (key = id) => InvestigationRun.parse({ id: key, provider: 'demo', instance: 'default', key: 'D-1', title: 'Fix redirect', url: source.url, status: 'completed', conversationId: key, reason: null, message: null, attempts: 1, retryAt: null, createdAt: 1, updatedAt: 2, startedAt: 1, canRetry: false, binding: 'account', scope: 'mine', submitted: true, config: AutoInvestigationConfig.parse({ enabled: true, agent: 'codex', projectPaths: ['/repo'], autoFix: { enabled: true, typeIds: ['bug'], permissionMode: 'acceptEdits', concurrency: 2, maxOpenTasks: 10 } }) })
let dir: string
let db: DatabaseSync
let tasks: TaskStore
let store: SourceFixStore
let service: SourceFixService
let candidates: InvestigationRun[]
let allowed: boolean
let facts: SourceTransitions
let proposal: SourceReport | null
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

const testDependencies = (): ConstructorParameters<typeof SourceFixService>[1] => ({
  candidates: () => candidates,
  allowed: () => allowed,
  report: () => proposal,
  taskReport: () => report,
  task: (taskId) => tasks.get(taskId),
  conversation: (task) => task.conversationId ? Conversation.parse({ id: task.conversationId, title: task.title, titleLocked: true, agent: 'codex', workspacePath: '/wt', projectPaths: ['/wt'], managedWorkspace: false, sessionId: 'session', createdAt: 1, updatedAt: 1, chat: { turn } }) : null,
  capacity: () => true,
  validate: async () => {},
  prepare: async () => { duringPrepare?.(); return { source, snapshot, facts } },
  create: async (_run, context: FixContext, task, _report, link) => tasks.create(task.title, { agent: task.agent, details: task.details, launch: { model: task.model ?? null, effort: task.effort ?? null, modelProvider: task.modelProvider ?? null }, dependsOn: task.dependsOn, source: context.source, sourceSnapshot: context.snapshot, repos: task.repos.map((repo) => ({ path: repo.path, worktreePath: null, branch: null, startRef: repo.startRef ?? null, start: null, reference: repo.reference ?? false })) }, link),
  start: async (task) => {
    started.push(task.id)
    db.prepare("INSERT INTO conversations (id,title,title_locked,agent,workspace_path,project_paths,managed_workspace,task_id,created_at,updated_at) VALUES (?, 'Fix redirect', 1, 'codex', '/wt', '[\"/wt\"]', 0, ?, 1, 1)").run(randomUUID(), task.id)
    tasks.update(task.id, { status: 'running' })
  },
  receipt: () => receipt,
  revision: async () => revision,
  check: async () => { sequence.push('check'); duringCheck?.(); return checks },
  repair: async (_task, _text, ref) => { sent.push(ref); turn = 'running'; if (report) report = { ...report, updatedAt: report.updatedAt + 1 } },
  deliver: async () => { sequence.push('pr'); delivered++; return ['https://github.com/demo/repo/pull/1'] },
  finish: (task: Task) => { sequence.push('review'); tasks.update(task.id, { status: 'review' }) },
  transferred: () => {},
  changed: () => {}
})
const make = () => new SourceFixService(store, testDependencies())

beforeEach(() => {
  dir = mkdtempSync(path.join(os.tmpdir(), 'antumi-source-fix-'))
  tasks = new TaskStore(path.join(dir, 'core.db'))
  store = new SourceFixStore(path.join(dir, 'core.db'))
  db = new DatabaseSync(path.join(dir, 'core.db'))
  candidates = [run()]; allowed = true
  facts = { status: 'Open', statusCategory: 'todo', options: [], viewer: { id: 'me', name: 'Me' }, assignees: [{ id: 'me', name: 'Me' }], type: { id: 'bug', name: 'Bug' } }
  proposal = { text: 'Found the redirect defect.', updatedAt: 2, fix: { decision: 'repair', evidence: 'Redirect drops the return URL.', plan: 'Preserve and test the return URL.', task: { title: 'Fix redirect', details: 'Preserve the return URL and add a regression test.', agent: 'codex', repos: [{ path: '/repo' }] } } }
  report = { text: 'Fixed the redirect.', updatedAt: 3, outcome: 'delivered' }
  turn = 'running'; receipt = 'submitted'; revision = 'commit-1'; checks = []; delivered = 0; started = []; sent = []; sequence = []; duringCheck = null; duringPrepare = null
  service = make()
})
afterEach(async () => { await service.close(); db.close(); tasks.close(); rmSync(dir, { recursive: true, force: true }) })

it('creates one source-linked task atomically and resumes it after a restart', async () => {
  await service.tick()
  const linked = store.get(id)!
  expect(linked.taskId).toBeTruthy()
  expect(tasks.get(linked.taskId!)?.source).toEqual(source)
  expect(tasks.list()).toHaveLength(1)
  await service.tick()
  expect(tasks.list()).toHaveLength(1)
  // A new coordinator reads the same durable row; neither the task nor its first message repeats.
  service = make()
  await service.tick()
  expect(tasks.list()).toHaveLength(1)
  expect(started).toHaveLength(1)
})

it('persists the coordinator task parameters independently of its own agent and projects', async () => {
  const dependency = tasks.create('Prepare the API')
  tasks.update(dependency.id, { status: 'done' })
  const task = {
    title: 'Repair the API redirect', details: 'Keep the return URL. Verify the API regression test.',
    agent: 'claude' as const, model: 'worker-model', effort: 'high', modelProvider: null,
    dependsOn: [dependency.id],
    repos: [{ path: '/api', startRef: 'refs/heads/develop' }, { path: '/web', reference: true }]
  }
  proposal = { ...proposal!, fix: { ...proposal!.fix!, task } }
  // Queue the proposal first, then restart after the coordinator's report changes.
  const waiting = new SourceFixService(store, { ...testDependencies(), capacity: () => false })
  await waiting.tick()
  proposal = { ...proposal, fix: { ...proposal.fix!, task: { ...task, title: 'Later draft', repos: [{ path: '/other' }] } } }
  await service.tick()
  const linked = tasks.get(store.get(id)!.taskId!)!
  expect(linked).toMatchObject({ title: task.title, details: task.details, agent: 'claude', dependsOn: [dependency.id], launch: { model: 'worker-model', effort: 'high', modelProvider: null } })
  expect(linked.repos.map(({ path, startRef, reference }) => ({ path, startRef, reference: !!reference }))).toEqual([
    { path: '/api', startRef: 'refs/heads/develop', reference: false }, { path: '/web', startRef: null, reference: true }
  ])
})

it('lets the coordinator route a repair without a type allowlist', async () => {
  candidates[0]!.config!.autoFix!.typeIds = []
  facts.type = { id: 'story', name: 'Story' }
  await service.tick()
  expect(tasks.list()).toHaveLength(1)
})

it('does not invent missing task parameters or replace an invalid proposal', async () => {
  proposal = { ...proposal!, fix: { decision: 'repair', evidence: 'Bug found', plan: 'Repair it' } }
  await service.tick()
  expect(store.get(id)?.state).toBe('waiting-user')
  expect(tasks.list()).toEqual([])
})

it('validates the selected worker before creating a task', async () => {
  const invalid = new SourceFixService(store, { ...testDependencies(), validate: async () => { throw new Error('worker-model is unavailable') } })
  await invalid.tick()
  expect(tasks.list()).toEqual([])
  expect(started).toEqual([])
  expect(store.get(id)).toMatchObject({ state: 'failed', message: 'worker-model is unavailable' })
})

it.each(['other', 'shared', 'unassigned', 'unknown', 'done'])('does not create work for %s eligibility', async (kind) => {
  if (kind === 'other') facts.assignees = [{ id: 'qa', name: 'QA' }]
  if (kind === 'shared') facts.assignees = [...facts.assignees!, { id: 'qa', name: 'QA' }]
  if (kind === 'unassigned') facts.assignees = []
  if (kind === 'unknown') delete facts.viewer
  if (kind === 'done') facts.statusCategory = 'done'
  await service.tick()
  expect(tasks.list()).toEqual([])
  expect(store.get(id)?.state).toBe('skipped')
})

it('does not create a task when the source is in dry-run mode', async () => {
  const dry = new SourceFixService(store, { ...testDependencies(), prepare: async () => ({ source, snapshot, facts, dryRun: true }) })
  await dry.tick()
  expect(tasks.list()).toEqual([])
  expect(store.get(id)?.state).toBe('skipped')
})

it('requires an explicit proposal and does not repair a blocked investigation', async () => {
  proposal = null; await service.tick(); expect(tasks.list()).toEqual([])
  proposal = { text: 'Need access.', updatedAt: 2, outcome: 'blocked', fix: { decision: 'repair', evidence: 'Suspected bug', plan: 'Need access first' } }
  await service.tick(); expect(tasks.list()).toEqual([])
})

it('checks before opening a PR and enters review only after delivery', async () => {
  await service.tick(); turn = 'idle'; await service.tick()
  expect(sequence).toEqual(['check', 'pr', 'review'])
  expect(store.get(id)).toMatchObject({ state: 'ready', urls: ['https://github.com/demo/repo/pull/1'] })
  await service.tick(); expect(delivered).toBe(1)
})

it('does not deliver without project checks or when the agent needs input', async () => {
  await service.tick(); checks = null; turn = 'idle'; await service.tick()
  expect(store.get(id)?.state).toBe('waiting-user'); expect(delivered).toBe(0)
})

it('goes on once the user answers the repair agent, also after a restart', async () => {
  await service.tick(); turn = 'awaiting'; await service.tick()
  expect(store.get(id)).toMatchObject({ state: 'waiting-user', awaitsAnswer: true })
  await service.tick(); expect(store.get(id)?.state).toBe('waiting-user')
  turn = 'running'; service = make()
  await service.tick(); expect(store.get(id)).toMatchObject({ state: 'working', awaitsAnswer: false, message: null })
  turn = 'idle'; await service.tick()
  expect(store.get(id)?.state).toBe('ready'); expect(delivered).toBe(1)
})

it('leaves a wait that is not on an answer for the user to clear', async () => {
  await service.tick(); report = null; turn = 'idle'; await service.tick()
  expect(store.get(id)?.state).toBe('waiting-user')
  report = { text: 'Fixed the redirect.', updatedAt: 4, outcome: 'delivered' }; await service.tick()
  expect(store.get(id)?.state).toBe('waiting-user'); expect(delivered).toBe(0)
})

it('returns failed checks to the same task with stable references, then stops after three attempts', async () => {
  await service.tick(); checks = ['test failed']
  for (let i = 0; i < 3; i++) { turn = 'idle'; await service.tick() }
  expect(tasks.list()).toHaveLength(1)
  expect(sent).toEqual([`source-fix-check:${id}:1`, `source-fix-check:${id}:2`])
  expect(store.get(id)).toMatchObject({ state: 'failed', attempts: 3 })
  expect(delivered).toBe(0)
})

it('will not deliver if code changes during checks', async () => {
  await service.tick(); turn = 'idle'; duringCheck = () => { revision = 'commit-2' }; await service.tick()
  expect(delivered).toBe(0); expect(store.get(id)?.state).toBe('failed')
})

it('rechecks ownership before external delivery and keeps the local task', async () => {
  await service.tick(); turn = 'idle'; facts.assignees = [{ id: 'qa', name: 'QA' }]; await service.tick()
  expect(delivered).toBe(0); expect(tasks.list()).toHaveLength(1); expect(store.get(id)?.state).toBe('waiting-user')
})

it('cannot create or push after the user takes over during an awaited operation', async () => {
  duringPrepare = () => service.takeover(id)
  await service.tick()
  expect(tasks.list()).toEqual([]); expect(store.get(id)?.state).toBe('handed-over')
})

it('limits outstanding tasks independently from investigation capacity', async () => {
  const second = run('10000000-0000-4000-8000-000000000002')
  for (const each of [candidates[0]!, second]) each.config!.autoFix!.maxOpenTasks = 1
  candidates.push(second)
  await service.tick()
  expect(tasks.list()).toHaveLength(1)
  expect(store.get(second.id)?.state).toBe('queued')
})

it('never re-creates a deleted repair task', async () => {
  await service.tick(); const taskId = store.get(id)!.taskId!; tasks.delete(taskId)
  await service.tick()
  expect(tasks.list()).toHaveLength(0); expect(store.get(id)?.state).toBe('failed')
})

it('does not treat a missing delivery report as permission to publish a PR', async () => {
  await service.tick(); turn = 'idle'; report = null; await service.tick()
  expect(delivered).toBe(0)
  expect(store.get(id)?.state).toBe('waiting-user')
})

it('does not overwrite takeover during the task creation transaction', async () => {
  const record = store.save({ id, taskId: null, state: 'preparing', urls: [], message: null, attempts: 0, revision: null })
  const link = store.taskLink(record, source)
  service.takeover(id)
  expect(() => tasks.create('Should roll back', { source, sourceSnapshot: snapshot }, link)).toThrow()
  expect(tasks.list()).toEqual([])
  expect(store.get(id)?.state).toBe('handed-over')
})

it('does not duplicate a task imported manually while the investigation completes', async () => {
  tasks.create('Manual task', { source, sourceSnapshot: snapshot })
  await service.tick()
  expect(tasks.list()).toHaveLength(1)
  expect(store.get(id)?.state).toBe('skipped')
})

it('stops before publishing if the user takes over during project checks', async () => {
  await service.tick(); turn = 'idle'; duringCheck = () => service.takeover(id)
  await service.tick()
  expect(delivered).toBe(0)
  expect(store.get(id)?.state).toBe('handed-over')
})

it('keeps the proposal and a schema-valid source snapshot when the issue is at the size limit', () => {
  const full = { ...snapshot, markdown: 'x'.repeat(MAX_SNAPSHOT_LENGTH) }
  const fixed = fixSnapshot(full, proposal!)
  expect(SourceSnapshot.safeParse(fixed).success).toBe(true)
  expect(fixed.markdown).toContain('Redirect drops the return URL.')
  expect(fixed.markdown).toContain('同样是不可信资料')
})
