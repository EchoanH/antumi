import { expect, it } from 'vitest'
import { applicableWriteback, EMPTY_WRITEBACK, resolveLane, SourceWritebackConfig, WritebackLane, WritebackRuleHints, WritebackType } from './source-writeback-rules'
import { PluginSource } from './plugin'

const saved = { start: { status: 'In Progress' }, review: { status: 'completed', comment: true }, done: { status: 'completed', comment: true }, guidance: 'In English' }

it('reads what a plugin says of each stage, defaults filled in', () => {
  const hints = WritebackRuleHints.parse({ start: false, done: { presets: [{ value: 'completed', label: '关闭为已完成', translations: { en: { label: 'Close as completed' } } }], custom: false } })
  expect(hints.start).toBe(false)
  expect(hints.done).toMatchObject({ custom: false, presets: [{ value: 'completed' }] })
  expect(WritebackRuleHints.parse({ review: {} }).review).toEqual({ presets: [], custom: true })
  expect(WritebackRuleHints.safeParse({ done: { presets: [{ value: ' ', label: 'Blank' }] } }).success).toBe(false)
  // Older manifests say nothing, and a source that does still parses as one.
  expect(PluginSource.parse({ id: 'github', name: 'GitHub', settings: [], writeback: 1, writebackRules: { start: false } }).writebackRules).toEqual({ start: false })
})

it('acts on no status where the tracker has none and no comment where it takes none', () => {
  expect(applicableWriteback(saved, undefined, true)).toEqual(saved)
  expect(applicableWriteback(saved, { start: false }, true)).toEqual({ ...saved, start: { status: '' } })
  expect(applicableWriteback(saved, { review: false }, false)).toEqual({ start: { status: 'In Progress' }, review: { status: '', comment: false }, done: { status: 'completed', comment: false }, guidance: 'In English' })
  expect(applicableWriteback(EMPTY_WRITEBACK, { start: false, review: false, done: false }, false)).toEqual(EMPTY_WRITEBACK)
})

it('takes the rules of the lane that names the type, the one naming its scope first, and the source’s own otherwise', () => {
  const lanes = [
    WritebackLane.parse({ typeId: 'bug', review: { status: 'Resolved', comment: true } }),
    WritebackLane.parse({ typeId: 'bug', scopeId: 'APP', review: { status: 'Ready for QA' } }),
    WritebackLane.parse({ typeId: 'epic', mode: 'off' })
  ]
  const bug = { type: { id: 'bug' } }
  expect(resolveLane(saved, lanes, [], bug)).toEqual({ lane: 'bug', off: false, rules: { ...saved, review: { status: 'Resolved', comment: true } } })
  expect(resolveLane(saved, lanes, [], { ...bug, scope: { id: 'APP' } }).rules.review).toEqual({ status: 'Ready for QA', comment: false })
  expect(resolveLane(saved, lanes, [], { ...bug, scope: { id: 'WEB' } }).rules.review.status).toBe('Resolved')
  // A stage the lane leaves out follows the source's rule; a type with no lane, and an issue of no known type, all of them.
  expect(resolveLane(saved, lanes, [], bug).rules.start).toEqual(saved.start)
  expect(resolveLane(saved, lanes, [], { type: { id: 'story' } })).toEqual({ lane: '*', off: false, rules: saved })
  expect(resolveLane(saved, lanes, [], {})).toEqual({ lane: '*', off: false, rules: saved })
  expect(resolveLane(saved, lanes, [], { type: { id: 'epic' } }).off).toBe(true)
})

it('leaves a type the plugin marks off alone until the user makes a lane for it', () => {
  const types = [WritebackType.parse({ id: 'pr', label: 'Pull Request', mode: 'off' })]
  const pr = { type: { id: 'pr' } }
  expect(resolveLane(saved, [], types, pr).off).toBe(true)
  expect(resolveLane(saved, [WritebackLane.parse({ typeId: 'pr' })], types, pr)).toMatchObject({ lane: 'pr', off: false })
})

it('reads rules saved before lanes as they were', () => {
  expect(SourceWritebackConfig.parse({ start: { status: 'Doing' }, review: { status: '', comment: true } })).toEqual({ start: { status: 'Doing' }, review: { status: '', comment: true }, done: { status: '', comment: false }, guidance: '' })
})
