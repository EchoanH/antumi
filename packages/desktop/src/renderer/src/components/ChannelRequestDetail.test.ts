import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import type { ChannelRequest } from '@antumi/protocol'
import { ChannelRequestDetailContent } from './ChannelRequestDetail'

const request: ChannelRequest = {
  id: 'r', channelId: 'c', asker: 'user', place: 'chat', direct: true, text: '你能读什么项目？', images: 0,
  state: 'failed', refusal: null, redacted: false, conversationId: null, createdAt: 1, startedAt: null, endedAt: 2,
  totalTokens: null, toolCalls: 0
}

describe('channel question details', () => {
  it('explains an old startup failure even when no conversation or error was saved', () => {
    const html = renderToStaticMarkup(createElement(ChannelRequestDetailContent, { request, detail: { answer: '', reads: [] }, error: null }))
    expect(html).toContain('你能读什么项目？')
    expect(html).toContain('智能体未能启动，没有生成回答。')
    expect(html).toContain('没有调用任何工具。')
  })

  it('shows the saved startup diagnostic independently of conversation loading', () => {
    const html = renderToStaticMarkup(createElement(ChannelRequestDetailContent, { request: { ...request, error: 'pi lists no model glm-5.2' }, detail: null, error: '连接断开' }))
    expect(html).toContain('失败原因')
    expect(html).toContain('pi lists no model glm-5.2')
    expect(html).toContain('role="alert">连接断开')
    expect(html).not.toContain('没有读取任何文件。')
  })

  it('explains a failure core named in the owner\'s language instead of its diagnostic', () => {
    const html = renderToStaticMarkup(createElement(ChannelRequestDetailContent, { request: { ...request, error: 'the running daemon predates chat mode; restart it', errorReason: 'daemon-outdated' }, detail: null, error: null }))
    expect(html).toContain('Antumi 后台（daemon）是旧版本')
    expect(html).not.toContain('predates chat mode')
  })

  it('shows the answer and file reads of the selected question', () => {
    const html = renderToStaticMarkup(createElement(ChannelRequestDetailContent, {
      request: { ...request, state: 'answered', conversationId: 'conversation' }, error: null,
      detail: { answer: '可以读取 Antumi。', reads: [{ tool: 'project_read', target: 'docs/CHANNELS.md', bytes: 100, at: 1 }] }
    }))
    expect(html).toContain('可以读取 Antumi。')
    expect(html).toContain('project_read  docs/CHANNELS.md')
    expect(html).not.toContain('没有生成回答')
  })
})
