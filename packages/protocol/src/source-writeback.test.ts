import { expect, it } from 'vitest'
import { sourceOwnership, SourceReport, SourceTransitions, SourceWrite } from './source-writeback'

const me = { id: 'u-1', name: 'Ann' }
const qa = { id: 'u-2', name: 'Bo' }

it('says whose an issue is from who it is assigned to', () => {
  expect(sourceOwnership({ viewer: me, assignees: [me] })).toBe('sole')
  expect(sourceOwnership({ viewer: me, assignees: [] })).toBe('unassigned')
  expect(sourceOwnership({ viewer: me, assignees: [qa, me] })).toBe('shared')
  expect(sourceOwnership({ viewer: me, assignees: [qa] })).toBe('other')
  // Ids are the tracker's own, compared as they are: a name that matches means nothing.
  expect(sourceOwnership({ viewer: me, assignees: [{ id: 'U-1', name: 'Ann' }] })).toBe('other')
})

it('cannot say whose it is when the plugin leaves out who is asking or who has it', () => {
  expect(sourceOwnership({})).toBe('unknown')
  expect(sourceOwnership({ assignees: [me] })).toBe('unknown')
  expect(sourceOwnership({ viewer: me })).toBe('unknown')
})

it('reads what a plugin from before the facts answers, and drops nothing an older record holds', () => {
  const old = { status: 'Open', statusCategory: 'todo', options: [{ id: '1', name: 'Doing', category: 'doing' }] }
  expect(SourceTransitions.parse(old)).toEqual(old)
  expect(SourceTransitions.safeParse({ ...old, viewer: { id: '', name: 'Ann' } }).success).toBe(false)
  expect(SourceReport.parse({ text: 'Fixed.', updatedAt: 1 })).toEqual({ text: 'Fixed.', updatedAt: 1 })
  const write = { id: '6f1d3a0e-5d0c-4c1f-8f3a-2f2b8f0b6c11', target: { kind: 'task', id: 't' }, provider: 'demo', instance: 'default', key: 'D-1', kind: 'status', trigger: 'start', detail: 'Doing', origin: null, state: 'sent', result: 'Doing', url: null, reason: null, createdAt: 1, updatedAt: 1 }
  expect(SourceWrite.parse(write)).toEqual(write)
})
