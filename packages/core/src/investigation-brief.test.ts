import { describe, expect, it } from 'vitest'
import { DEFAULT_INVESTIGATION_PROMPT } from '@antumi/protocol'
import { automaticInstructions, investigationBrief } from './investigation-brief'

const source = { provider: 'demo', instance: 'default', name: 'Demo', key: 'D-1', url: 'https://example.test/D-1' }
const snapshot = { markdown: 'It breaks', fetchedAt: 0, images: [] }

describe('investigationBrief', () => {
  it('stops at a finding when opened by hand', () => {
    const brief = investigationBrief(source, snapshot, [])
    expect(brief).toContain('缺什么信息就问我')
    expect(brief).toContain('到这里停下，不要修改代码')
  })

  it('hands over only the issue when automatic, leaving what to do to the prompt', () => {
    const brief = investigationBrief(source, snapshot, [], 0, true)
    expect(brief).toContain('It breaks')
    expect(brief).not.toContain('请这样排查')
  })
})

describe('automaticInstructions', () => {
  it('sends the default prompt when the user wrote none, and their own otherwise', () => {
    expect(automaticInstructions('', false).startsWith(DEFAULT_INVESTIGATION_PROMPT['zh-CN'])).toBe(true)
    expect(automaticInstructions('  只给结论  ', false).startsWith('只给结论\n\n')).toBe(true)
  })

  it('tells how to open a task only where the source allows one', () => {
    const allowed = automaticInstructions('', true)
    expect(allowed).toContain('source_task_create')
    expect(allowed).toContain('PR 类事项不能新建任务')
    const refused = automaticInstructions('', false)
    expect(refused).not.toContain('source_task_create')
    expect(refused).toContain('不允许新建任务')
    for (const text of [allowed, refused]) expect(text).toContain('source_report')
  })
})
