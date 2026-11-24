import { expect, it } from 'vitest'
import { applicableWriteback, EMPTY_WRITEBACK, WritebackRuleHints } from './source-writeback-rules'
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
